// Near-field meshes on the GPU: uploads mesh job outputs (src/mesh/output.ts) into
// storage buffers, culls clusters in compute (cull.wgsl), and draws the survivors
// with one drawIndirect by vertex pulling (near.wgsl).
//
// Memory (plan-rendering phase 2): the quad arena and the cluster table are
// fixed-size buffers sized from a budget and the device limits; RangeAllocator
// hands out a quad range and a cluster range per chunk mesh. A replaced mesh
// frees its old ranges once the new ones are written; an evicted chunk frees its
// ranges. Freed descriptors are zeroed (count 0), which the cull pass skips. Writes
// and draws share one queue, so a range freed and reused this frame never changes
// what an already submitted frame reads. When an allocation fails the chunk keeps
// its previous mesh, if any (`stats.dropped`).
//
// Culling (plan-rendering phases 3-4): two phases per frame (cull.wgsl). Phase A
// culls and draws what was drawn last frame (the `seen` bits); the Hi-Z pyramid is
// built from that depth (hiz.ts); phase B culls everything, adds the Hi-Z test,
// draws what A didn't, and writes next frame's `seen` bits. The CPU's per-frame
// work is constant: one uniform per phase, a few buffer resets, two dispatches,
// two drawIndirect. Counters come back frames later through a readback ring.
// encodeCullCheck() compares the frame's culled draw against an unculled one and
// counts differing pixels (`?cullCheck`).

import nearWgsl from "./near.wgsl" with { type: "text" };
import shadingWgsl from "./shading.wgsl" with { type: "text" };
import skyColorWgsl from "./sky-color.wgsl" with { type: "text" };
import cullWgsl from "./cull.wgsl" with { type: "text" };
import checkWgsl from "./cull-check.wgsl" with { type: "text" };
import "../gpu/globals.ts";
import type { Caps } from "../gpu/caps.ts";
import { CounterReadback } from "../gpu/counters.ts";
import { compileShader, createRenderPipeline, type Report, type ShaderSource } from "../gpu/shader.ts";
import type { MeshJobOutput } from "../mesh/job.ts";
import { readMeshOutput } from "../mesh/output.ts";
import { BLOCK_TABLE_FLOATS, blockColorTable, blockFaceTable, MAX_BLOCK_TYPES } from "../world/blocks.ts";
import { createBlockTextures } from "./textures.ts";
import { ChunkTable } from "../world/chunk-table.ts";
import { keyX, keyY, keyZ } from "../world/keys.ts";
import {
  CULL_ALL_CLUSTERS,
  CULL_FACE,
  CULL_FRUSTUM,
  CULL_OCCLUSION,
  CULL_WRITE_SEEN,
  frustumPlanes,
} from "./cull.ts";
import { HiZPyramid } from "./hiz.ts";
import { RangeAllocator } from "./range-allocator.ts";

export const CULL_ALL = CULL_FRUSTUM | CULL_FACE | CULL_OCCLUSION;

const QUAD_BYTES = 8;
const CLUSTER_BYTES = 16;
const CHUNK_BYTES = 16;
const CULL_UNIFORM_BYTES = 208;
const CULL_WORKGROUP = 64;
const MAX_GROUPS_X = 65535;
const NONE = -1;

export interface NearFieldOptions {
  quadMiB: number; // quad arena budget; clamped to the device's buffer limits
  slots: number; // chunks with a mesh at once (chunk table entries)
  clusterQuads: number; // cluster size of every mesh this session
  ao: boolean; // shade with baked AO (?ao); off must match the mesher's option
  textured: boolean; // sample block textures (?tex=0 draws flat block colors)
  emissive: boolean; // add each block's emission (?glow=0 leaves surfaces to the sun)
  animated: boolean; // blow blocks with a sway amount about in the wind (?wind=0)
}

export const DEFAULT_NEAR_OPTIONS: NearFieldOptions = {
  quadMiB: 64,
  slots: 32768,
  clusterQuads: 32,
  ao: true,
  textured: true,
  emissive: true,
  animated: true,
};

export interface NearFieldStats {
  chunks: number; // chunks with a mesh on the GPU
  clusters: number; // cluster slots below the high-water mark (tested by the cull pass)
  liveClusters: number; // clusters of live chunks
  realQuads: number; // live quads without padding
  paddedQuads: number; // live quads including padding
  capacityQuads: number;
  capacityClusters: number;
  dropped: number; // meshes not uploaded: arena, cluster table, or slots full
  pending: number; // meshes waiting for upload budget
  uploadBytes: number; // this frame
  // Cull counters, a few frames old (GPU readback).
  visibleClusters: number; // drawn: phase A plus phase B
  drawnPhaseA: number; // drawn again from last frame's visible set
  drawnPhaseB: number; // newly visible this frame
  alreadyDrawn: number; // passed phase B's tests but phase A had drawn them
  faceCulled: number; // phase B, which tests every cluster
  frustumCulled: number;
  occludedClusters: number; // culled by the Hi-Z test in phase B
  skippedClusters: number; // empty (freed) or translucent slots
  translucentDrawn: number; // translucent clusters drawn this frame
  translucentOccluded: number; // translucent clusters the Hi-Z test dropped
  // Cull checks (`?cullCheck`): frames compared, frames with a depth difference
  // (a cull bug), the most depth-differing pixels in one frame, pixels culled away
  // in total, and color-only differences at equal depth (edge ties, not bugs).
  cullChecks: number;
  cullCheckFailures: number;
  cullCheckMaxDiff: number;
  cullCheckMissing: number;
  cullCheckTies: number;
  // Allocator state, refreshed by refreshStats() (walks free lists).
  quadFreeBlocks: number;
  quadLargestFree: number;
  quadFragmentation: number; // 1 - largest free run / free quads
  clusterFreeBlocks: number;
  clusterFragmentation: number;
}

// Targets for the unculled reference draw of a cull check. The culled image is
// the frame's own color and depth, passed in per check.
interface CheckTargets {
  width: number;
  height: number;
  color: GPUTexture;
  depth: GPUTexture;
  pass: GPURenderPassDescriptor;
}

export class NearField {
  readonly stats: NearFieldStats = {
    chunks: 0,
    clusters: 0,
    liveClusters: 0,
    realQuads: 0,
    paddedQuads: 0,
    capacityQuads: 0,
    capacityClusters: 0,
    dropped: 0,
    pending: 0,
    uploadBytes: 0,
    visibleClusters: 0,
    drawnPhaseA: 0,
    drawnPhaseB: 0,
    alreadyDrawn: 0,
    faceCulled: 0,
    frustumCulled: 0,
    occludedClusters: 0,
    skippedClusters: 0,
    translucentDrawn: 0,
    translucentOccluded: 0,
    cullChecks: 0,
    cullCheckFailures: 0,
    cullCheckMaxDiff: 0,
    cullCheckMissing: 0,
    cullCheckTies: 0,
    quadFreeBlocks: 0,
    quadLargestFree: 0,
    quadFragmentation: 0,
    clusterFreeBlocks: 0,
    clusterFragmentation: 0,
  };
  cullFlags = CULL_ALL;
  // Read by the cull and draw passes; COPY_SRC for tests that read them back.
  readonly quadBuffer: GPUBuffer;
  readonly clusterBuffer: GPUBuffer;
  private readonly device: GPUDevice;
  private readonly recycle: (buffer: ArrayBuffer) => void;
  private readonly clusterQuads: number;
  private readonly drawConstants: Record<string, number>;
  private readonly faceBuffer: GPUBuffer;
  private readonly blockTextures: GPUTexture;
  private readonly blockSampler: GPUSampler;
  private readonly chunkBuffer: GPUBuffer;
  private readonly colorBuffer: GPUBuffer;
  // One visible list and one set of draw arguments per phase.
  private readonly visibleBuffers: GPUBuffer[] = [];
  private readonly argsBuffers: GPUBuffer[] = [];
  private readonly argsReset: GPUBuffer; // [6 * clusterQuads, 0, 0, 0], copied over args
  private readonly countsBuffer: GPUBuffer;
  private readonly cullUniforms: GPUBuffer[] = []; // phase A, phase B
  private readonly checkUniform: GPUBuffer; // same camera, culling off
  private readonly diffBuffer: GPUBuffer;
  // Clusters drawn last frame, one bit per slot, swapped each frame.
  private readonly seenBuffers: GPUBuffer[] = [];
  private seenParity = 0;
  private readonly drawLayout: GPUBindGroupLayout;
  private readonly drawBindGroups: GPUBindGroup[] = []; // per phase
  private readonly cullLayout: GPUBindGroupLayout;
  // [phase][parity] for the frame's passes, plus the unculled reference.
  private readonly cullBindGroups: GPUBindGroup[][] = [[], []];
  private readonly sortedBuffer: GPUBuffer;
  private translucentCullBindGroup: GPUBindGroup | null = null;
  private translucentSort: GPUComputePipeline | null = null;
  private translucentPipeline: GPUComputePipeline | null = null;
  private translucentDraw: GPURenderPipeline | null = null;
  private readonly checkCullBindGroups: GPUBindGroup[] = [];
  private readonly hiz: HiZPyramid;
  private drawPipeline: GPURenderPipeline | null = null;
  private readonly cullPipelines: (GPUComputePipeline | null)[] = [null, null];
  private comparePipeline: GPUComputePipeline | null = null;
  private readonly counters: CounterReadback;
  private readonly diffReadback: CounterReadback;
  private diffSamples = 0;
  private checkTargets: CheckTargets | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private depthFormat: GPUTextureFormat = "depth32float";
  private readonly quads: RangeAllocator;
  private readonly clusters: RangeAllocator;
  private readonly cullData = new ArrayBuffer(CULL_UNIFORM_BYTES);
  private readonly cullF32 = new Float32Array(this.cullData);
  private readonly cullI32 = new Int32Array(this.cullData);
  private readonly cullU32 = new Uint32Array(this.cullData);
  private readonly computeDescriptor: GPUComputePassDescriptor = { label: "cull" };
  private readonly sortDescriptor: GPUComputePassDescriptor = { label: "sort t" };
  private readonly checkComputeDescriptor: GPUComputePassDescriptor = { label: "cull check" };
  private groupsX = 0;
  private groupsY = 0;
  // Chunk slots: key -> slot, and the slot's ranges.
  private readonly slotOf: ChunkTable;
  private readonly slotKey: Float64Array;
  private readonly slotQuadBlock: Int32Array;
  private readonly slotClusterBlock: Int32Array;
  private readonly slotRealQuads: Int32Array;
  private readonly freeSlots: Int32Array;
  private freeCount: number;
  // Upload queue: keys in arrival order; the latest output per key.
  private readonly pendingKeys: number[] = [];
  private pendingHead = 0;
  private readonly pendingOut = new Map<number, MeshJobOutput>();
  // Scratch for uploads.
  private descScratch = new Uint32Array(1024);
  private zeroScratch = new Uint32Array(1024);
  private readonly chunkScratch = new Int32Array(4);

  constructor(
    device: GPUDevice,
    caps: Caps,
    recycle: (buffer: ArrayBuffer) => void,
    options: NearFieldOptions = DEFAULT_NEAR_OPTIONS,
  ) {
    this.device = device;
    this.recycle = recycle;
    const cq = options.clusterQuads;
    this.clusterQuads = cq;
    this.drawConstants = {
      AO_ENABLED: options.ao ? 1 : 0,
      TEXTURED: options.textured ? 1 : 0,
      EMISSIVE: options.emissive ? 1 : 0,
      ANIMATED: options.animated ? 1 : 0,
    };
    const limit = Math.min(caps.limits.maxStorageBufferBindingSize, caps.limits.maxBufferSize);
    // Whole clusters of quads, so every quad slot can be used.
    const quadBytes = Math.floor(Math.min(options.quadMiB * 1048576, limit) / (cq * QUAD_BYTES)) * cq * QUAD_BYTES;
    const capacityQuads = quadBytes / QUAD_BYTES;
    // Every cluster takes exactly `cq` quad slots, so this many can never run out
    // before the quad arena does.
    const capacityClusters = capacityQuads / cq;
    this.stats.capacityQuads = capacityQuads;
    this.stats.capacityClusters = capacityClusters;
    const slots = options.slots;
    // Blocks: at most one used range per slot plus a free run between each pair.
    this.quads = new RangeAllocator(capacityQuads, 2 * slots + 2);
    this.clusters = new RangeAllocator(capacityClusters, 2 * slots + 2);

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const arena = storage | GPUBufferUsage.COPY_SRC;
    this.quadBuffer = device.createBuffer({ label: "near quads", size: quadBytes, usage: arena });
    this.clusterBuffer = device.createBuffer({
      label: "near clusters",
      size: capacityClusters * CLUSTER_BYTES,
      usage: arena,
    });
    this.chunkBuffer = device.createBuffer({ label: "near chunks", size: slots * CHUNK_BYTES, usage: storage });
    this.colorBuffer = device.createBuffer({ label: "block colors", size: BLOCK_TABLE_FLOATS * 4, usage: storage });
    const colors = new Float32Array(BLOCK_TABLE_FLOATS);
    blockColorTable(colors, 0);
    device.queue.writeBuffer(this.colorBuffer, 0, colors);
    this.faceBuffer = device.createBuffer({ label: "block faces", size: MAX_BLOCK_TYPES * 6 * 4, usage: storage });
    const faces = new Uint32Array(MAX_BLOCK_TYPES * 6);
    blockFaceTable(faces);
    device.queue.writeBuffer(this.faceBuffer, 0, faces);
    this.blockTextures = createBlockTextures(device);
    this.blockSampler = device.createSampler({
      label: "block textures",
      addressModeU: "repeat",
      addressModeV: "repeat",
      // Blocky on purpose: a tile is 32 texels across one voxel, and magnifying it
      // with linear filtering would smear the look every other part of the renderer
      // keeps hard. That rules out anisotropy, which WebGPU allows only when every
      // filter is linear; minification still goes through the mip chain.
      magFilter: "nearest",
      minFilter: "linear",
      mipmapFilter: "linear",
    });
    // A third list for the translucent pass, which culls once and draws after the
    // background (plan-rendering phase 5). It has no seen bits: it is not part of the
    // two-phase scheme.
    // COPY_SRC on the visible lists and draw arguments so tests can read them back;
    // a missing COPY_SRC makes a readback return zeros rather than fail loudly
    // (gotchas.md "A readback needs COPY_SRC").
    this.sortedBuffer = device.createBuffer({
      label: "near visible t sorted",
      size: capacityClusters * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    for (const phase of ["a", "b", "t"]) {
      this.visibleBuffers.push(device.createBuffer({
        label: `near visible ${phase}`,
        size: capacityClusters * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      }));
      this.argsBuffers.push(device.createBuffer({
        label: `near draw args ${phase}`,
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC,
      }));
      if (phase === "t") continue;
      this.seenBuffers.push(device.createBuffer({
        label: `near seen ${phase}`,
        size: Math.ceil(capacityClusters / 32) * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }));
    }
    this.argsReset = device.createBuffer({
      label: "near draw args reset",
      size: 16,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    // firstInstance stays 0: nonzero needs "indirect-first-instance".
    device.queue.writeBuffer(this.argsReset, 0, new Uint32Array([6 * cq, 0, 0, 0]));
    this.countsBuffer = device.createBuffer({ label: "near cull counts", size: 18 * 4, usage: arena });
    this.diffBuffer = device.createBuffer({ label: "near cull check", size: 12, usage: arena });
    const uniform = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    for (const phase of ["a", "b"]) {
      this.cullUniforms.push(device.createBuffer({
        label: `near cull ${phase}`,
        size: CULL_UNIFORM_BYTES,
        usage: uniform,
      }));
    }
    this.checkUniform = device.createBuffer({ label: "near cull off", size: CULL_UNIFORM_BYTES, usage: uniform });
    this.hiz = new HiZPyramid(device);
    this.counters = new CounterReadback(device, "near cull counts", 18);
    this.diffReadback = new CounterReadback(device, "near cull check", 3);

    const readOnly = { type: "read-only-storage" as const };
    const VERTEX = GPUShaderStage.VERTEX, FRAGMENT = GPUShaderStage.FRAGMENT, COMPUTE = GPUShaderStage.COMPUTE;
    this.drawLayout = device.createBindGroupLayout({
      label: "near draw",
      entries: [
        { binding: 0, visibility: VERTEX, buffer: readOnly },
        { binding: 1, visibility: VERTEX, buffer: readOnly },
        { binding: 2, visibility: VERTEX, buffer: readOnly },
        // The block table is read in both stages: the fragment shader for colour and
        // emission, the vertex shader for how far the block sways.
        { binding: 3, visibility: VERTEX | FRAGMENT, buffer: readOnly },
        { binding: 4, visibility: VERTEX, buffer: readOnly },
        { binding: 5, visibility: FRAGMENT, buffer: readOnly },
        { binding: 6, visibility: FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
        { binding: 7, visibility: FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    // The translucent draw reads the sorted list, not the order the cull appended.
    for (const visible of [this.visibleBuffers[0], this.visibleBuffers[1], this.sortedBuffer]) {
      this.drawBindGroups.push(device.createBindGroup({
        label: "near draw",
        layout: this.drawLayout,
        entries: [
          ...[this.quadBuffer, this.clusterBuffer, this.chunkBuffer, this.colorBuffer, visible, this.faceBuffer].map(
            (buffer, binding) => ({ binding, resource: { buffer } }),
          ),
          { binding: 6, resource: this.blockTextures.createView({ dimension: "2d-array" }) },
          { binding: 7, resource: this.blockSampler },
        ],
      }));
    }
    this.cullLayout = device.createBindGroupLayout({
      label: "near cull",
      entries: [
        { binding: 0, visibility: COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: COMPUTE, buffer: readOnly },
        { binding: 2, visibility: COMPUTE, buffer: readOnly },
        { binding: 3, visibility: COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: COMPUTE, buffer: { type: "storage" } },
        { binding: 5, visibility: COMPUTE, buffer: { type: "storage" } },
        { binding: 6, visibility: COMPUTE, buffer: readOnly },
        { binding: 7, visibility: COMPUTE, buffer: { type: "storage" } },
        { binding: 8, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 9, visibility: COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.slotOf = new ChunkTable(slots);
    this.slotKey = new Float64Array(slots);
    this.slotQuadBlock = new Int32Array(slots).fill(NONE);
    this.slotClusterBlock = new Int32Array(slots).fill(NONE);
    this.slotRealQuads = new Int32Array(slots);
    this.freeSlots = new Int32Array(slots);
    for (let i = 0; i < slots; i++) this.freeSlots[i] = slots - 1 - i;
    this.freeCount = slots;
  }

  async init(
    camera: ShaderSource,
    format: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    frameLayout: GPUBindGroupLayout,
    report: Report,
  ): Promise<boolean> {
    const device = this.device;
    this.format = format;
    this.depthFormat = depthFormat;
    const [drawModule, cullModule, checkModule, hizReady] = await Promise.all([
      compileShader(device, "near", [
        camera,
        { name: "sky-color.wgsl", code: skyColorWgsl },
        { name: "shading.wgsl", code: shadingWgsl },
        { name: "render/near.wgsl", code: nearWgsl },
      ], report),
      compileShader(device, "near cull", [{ name: "render/cull.wgsl", code: cullWgsl }], report),
      compileShader(device, "near cull check", [{ name: "render/cull-check.wgsl", code: checkWgsl }], report),
      this.hiz.init(report),
    ]);
    if (!drawModule || !cullModule || !checkModule || !hizReady) return false;
    this.drawPipeline = await createRenderPipeline(device, {
      label: "near",
      layout: device.createPipelineLayout({ label: "near", bindGroupLayouts: [frameLayout, this.drawLayout] }),
      vertex: { module: drawModule, entryPoint: "vs_cluster", constants: this.drawConstants },
      fragment: { module: drawModule, entryPoint: "fs", targets: [{ format }], constants: this.drawConstants },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: "greater" },
    }, report);
    // Translucent: the same shader, blended over what is there, and no depth write,
    // so two translucent surfaces do not hide each other and the pass leaves the
    // opaque depth alone. Back faces are still culled, so a water volume shows its
    // top surface once rather than twice.
    this.translucentDraw = await createRenderPipeline(device, {
      label: "near translucent",
      layout: device.createPipelineLayout({ label: "near", bindGroupLayouts: [frameLayout, this.drawLayout] }),
      vertex: { module: drawModule, entryPoint: "vs_cluster", constants: this.drawConstants },
      fragment: {
        module: drawModule,
        entryPoint: "fs",
        constants: this.drawConstants,
        targets: [{
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: "greater" },
    }, report);
    try {
      const cullLayout = device.createPipelineLayout({ label: "near cull", bindGroupLayouts: [this.cullLayout] });
      [this.cullPipelines[0], this.cullPipelines[1]] = await Promise.all([false, true].map((phaseB) =>
        device.createComputePipelineAsync({
          label: `near cull ${phaseB ? "b" : "a"}`,
          layout: cullLayout,
          compute: { module: cullModule, entryPoint: "cull_clusters", constants: { PHASE_B: phaseB ? 1 : 0 } },
        })
      ));
      this.translucentPipeline = await device.createComputePipelineAsync({
        label: "near cull t",
        layout: cullLayout,
        compute: { module: cullModule, entryPoint: "cull_clusters", constants: { PHASE_B: 1, TRANSLUCENT: 1 } },
      });
      this.translucentSort = await device.createComputePipelineAsync({
        label: "near sort t",
        layout: cullLayout,
        compute: { module: cullModule, entryPoint: "sort_translucent" },
      });
      this.comparePipeline = await device.createComputePipelineAsync({
        label: "near cull check",
        layout: "auto", // private to this debug pass
        compute: { module: checkModule, entryPoint: "compare" },
      });
    } catch (err) {
      report(`near cull pipelines: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    return this.drawPipeline !== null;
  }

  get ready(): boolean {
    return this.drawPipeline !== null && this.cullPipelines[1] !== null && this.cullBindGroups[0].length > 0;
  }

  // Rebuilds the Hi-Z pyramid and the cull bind groups for a new depth target.
  // Not per frame.
  resize(width: number, height: number, depth: GPUTexture): void {
    this.hiz.resize(width, height, depth);
    const device = this.device;
    const group = (uniform: GPUBuffer, phase: number, parity: number, label: string) =>
      device.createBindGroup({
        label,
        layout: this.cullLayout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: this.clusterBuffer } },
          { binding: 2, resource: { buffer: this.chunkBuffer } },
          { binding: 3, resource: { buffer: this.visibleBuffers[phase] } },
          { binding: 4, resource: { buffer: this.argsBuffers[phase] } },
          { binding: 5, resource: { buffer: this.countsBuffer } },
          { binding: 6, resource: { buffer: this.seenBuffers[parity] } },
          { binding: 7, resource: { buffer: this.seenBuffers[1 - parity] } },
          { binding: 8, resource: this.hiz.view },
          { binding: 9, resource: { buffer: this.sortedBuffer } },
        ],
      });
    for (const phase of [0, 1]) {
      this.cullBindGroups[phase] = [0, 1].map((parity) =>
        group(this.cullUniforms[phase], phase, parity, `near cull ${phase === 0 ? "a" : "b"} ${parity}`)
      );
    }
    // The translucent cull reuses phase B's uniform: the same planes and flags, and
    // the shader ignores the seen bits when TRANSLUCENT, so the parity does not
    // matter. Its own visible list and draw arguments come from index 2.
    this.translucentCullBindGroup = group(this.cullUniforms[1], 2, 0, "near cull t");
    // The reference draw of the cull check: phase A pipeline over every cluster,
    // into phase B's list so the frame's own phase A result stays put.
    this.checkCullBindGroups.length = 0;
    for (const parity of [0, 1]) {
      this.checkCullBindGroups.push(group(this.checkUniform, 1, parity, `near cull off ${parity}`));
    }
  }

  // Queues a chunk's mesh for upload. Keeps the buffer (recycled after upload).
  add(key: number, out: MeshJobOutput): boolean {
    const previous = this.pendingOut.get(key);
    if (previous) this.recycle(previous.mesh!);
    else this.pendingKeys.push(key);
    this.pendingOut.set(key, out);
    this.stats.pending = this.pendingOut.size;
    return true;
  }

  remove(key: number): void {
    const pending = this.pendingOut.get(key);
    if (pending) {
      this.recycle(pending.mesh!);
      this.pendingOut.delete(key); // its key stays queued and is skipped
      this.stats.pending = this.pendingOut.size;
    }
    const slot = this.slotOf.get(key);
    if (slot === -1) return;
    this.releaseRanges(slot);
    this.slotOf.delete(key);
    this.freeSlots[this.freeCount++] = slot;
    this.stats.chunks--;
  }

  // Uploads queued meshes until `budgetBytes` is spent. Returns bytes written.
  upload(budgetBytes: number): number {
    const queue = this.device.queue;
    let bytes = 0;
    const keys = this.pendingKeys;
    while (this.pendingHead < keys.length && bytes < budgetBytes) {
      const key = keys[this.pendingHead++];
      const out = this.pendingOut.get(key);
      if (!out) continue;
      this.pendingOut.delete(key);
      bytes += this.uploadChunk(queue, key, out);
      this.recycle(out.mesh!);
    }
    if (this.pendingHead === keys.length) {
      keys.length = 0;
      this.pendingHead = 0;
    }
    this.stats.pending = this.pendingOut.size;
    this.stats.uploadBytes = bytes;
    return bytes;
  }

  // Writes this frame's cull uniforms: frustum planes from the column-major
  // view_proj (render space), the eye and camera chunk, the matrix and Hi-Z size
  // for the occlusion test. Phase A redraws last frame's visible set; phase B adds
  // the Hi-Z test and writes next frame's bits. With `check`, also the
  // culling-off copy for encodeCullCheck(). Call once per frame, before cullA().
  prepare(viewProj: ArrayLike<number>, eye: ArrayLike<number>, chunk: ArrayLike<number>, check: boolean): void {
    const f = this.cullF32, i = this.cullI32, u = this.cullU32;
    frustumPlanes(viewProj, f, 0);
    f[20] = eye[0];
    f[21] = eye[1];
    f[22] = eye[2];
    f[23] = 0;
    i[24] = chunk[0];
    i[25] = chunk[1];
    i[26] = chunk[2];
    i[27] = 0;
    for (let k = 0; k < 16; k++) f[28 + k] = viewProj[k];
    f[44] = this.hiz.width;
    f[45] = this.hiz.height;
    f[46] = this.hiz.levels;
    f[47] = 0;
    const count = this.clusters.highWater;
    u[48] = count;
    this.stats.clusters = count;
    const queue = this.device.queue;
    // Phase A: frustum and face only, over last frame's visible set.
    u[49] = this.cullFlags & (CULL_FRUSTUM | CULL_FACE);
    queue.writeBuffer(this.cullUniforms[0], 0, this.cullData);
    u[49] = this.cullFlags | CULL_WRITE_SEEN;
    queue.writeBuffer(this.cullUniforms[1], 0, this.cullData);
    if (check) {
      u[49] = CULL_ALL_CLUSTERS; // every cluster, no tests, no bits written
      queue.writeBuffer(this.checkUniform, 0, this.cullData);
    }
    const groups = Math.ceil(count / CULL_WORKGROUP);
    this.groupsX = Math.min(groups, MAX_GROUPS_X);
    this.groupsY = this.groupsX === 0 ? 0 : Math.ceil(groups / this.groupsX);
  }

  // Phase A cull: last frame's visible clusters, frustum and face tests. Resets
  // the counters and next frame's bits for the whole frame.
  cullA(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void {
    encoder.clearBuffer(this.countsBuffer);
    encoder.clearBuffer(this.seenBuffers[1 - this.seenParity]);
    this.computeDescriptor.timestampWrites = timestampWrites;
    this.encodeCull(encoder, 0, 0, this.cullBindGroups[0][this.seenParity], this.computeDescriptor);
  }

  get occlusionEnabled(): boolean {
    return (this.cullFlags & CULL_OCCLUSION) !== 0;
  }

  // Rebuilds the Hi-Z pyramid from the depth phase A drew.
  buildHiZ(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void {
    this.hiz.build(encoder, timestampWrites);
  }

  // Phase B cull: every cluster, plus the Hi-Z test; appends what A did not draw.
  cullB(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void {
    this.computeDescriptor.timestampWrites = timestampWrites;
    this.encodeCull(encoder, 1, 1, this.cullBindGroups[1][this.seenParity], this.computeDescriptor);
  }

  // Translucent cull: every translucent cluster, against the finished opaque depth.
  cullTranslucent(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void {
    this.computeDescriptor.timestampWrites = timestampWrites;
    this.encodeCull(encoder, 2, 2, this.translucentCullBindGroup!, this.computeDescriptor);
    this.encodeSort(encoder);
    this.counters.copy(encoder, this.countsBuffer);
  }

  // Orders the translucent list back to front. Same pass as the cull would need a
  // barrier between dispatches, which WebGPU gives between dispatches in one pass.
  private encodeSort(encoder: GPUCommandEncoder): void {
    if (!this.translucentSort) return;
    const pass = encoder.beginComputePass(this.sortDescriptor);
    pass.setPipeline(this.translucentSort);
    pass.setBindGroup(0, this.translucentCullBindGroup!);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  // Draws the translucent clusters the pass kept, blended over what is already there.
  drawTranslucent(pass: GPURenderPassEncoder): void {
    if (!this.translucentDraw) return;
    pass.setPipeline(this.translucentDraw);
    pass.setBindGroup(1, this.drawBindGroups[2]);
    pass.drawIndirect(this.argsBuffers[2], 0);
  }

  // Draws the clusters phase `phase` (0 A, 1 B) kept.
  draw(pass: GPURenderPassEncoder, phase: number): void {
    pass.setPipeline(this.drawPipeline!);
    pass.setBindGroup(1, this.drawBindGroups[phase]);
    pass.drawIndirect(this.argsBuffers[phase], 0);
  }

  // After the frame's submit: starts the readbacks encoded this frame and swaps
  // the visibility bitsets.
  afterSubmit(): void {
    this.counters.afterSubmit();
    this.diffReadback.afterSubmit();
    this.seenParity = 1 - this.seenParity;
  }

  // Draws the near field once more with nothing culled, offscreen, and counts the
  // pixels where it differs from what the frame drew (read back frames later into
  // stats.cullCheck*). Call right after the frame's own near-field passes, before
  // anything else paints over them; `color` and `depth` are what they drew into.
  encodeCullCheck(
    encoder: GPUCommandEncoder,
    frameBindGroup: GPUBindGroup,
    width: number,
    height: number,
    color: GPUTextureView,
    depth: GPUTextureView,
  ): void {
    if (!this.comparePipeline) return;
    const t = this.checkTargetsFor(width, height);
    // Every cluster, no tests, no visibility bits: the phase A variant (phase B
    // would skip what phase A drew) filling phase B's list.
    this.encodeCull(encoder, 0, 1, this.checkCullBindGroups[this.seenParity], this.checkComputeDescriptor);
    const pass = encoder.beginRenderPass(t.pass);
    pass.setBindGroup(0, frameBindGroup);
    this.draw(pass, 1);
    pass.end();
    encoder.clearBuffer(this.diffBuffer);
    const compute = encoder.beginComputePass(this.checkComputeDescriptor);
    compute.setPipeline(this.comparePipeline);
    // The canvas texture changes every frame, so this bind group is per check.
    compute.setBindGroup(
      0,
      this.device.createBindGroup({
        label: "cull check",
        layout: this.comparePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: color },
          { binding: 1, resource: t.color.createView() },
          { binding: 2, resource: depth },
          { binding: 3, resource: t.depth.createView() },
          { binding: 4, resource: { buffer: this.diffBuffer } },
        ],
      }),
    );
    compute.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    compute.end();
    this.diffReadback.copy(encoder, this.diffBuffer);
  }

  // Fills the counter and allocator fields of `stats`. Walks free lists: call for
  // the overlay or a bench result, not every frame.
  refreshStats(): NearFieldStats {
    const s = this.stats;
    // Phase A's counters are words 0-5, phase B's 6-11, the translucent pass's 12-17;
    // B tested every opaque cluster.
    const c = this.counters.latest;
    s.drawnPhaseA = c[0];
    s.drawnPhaseB = c[6];
    s.alreadyDrawn = c[11];
    s.visibleClusters = c[0] + c[6];
    s.faceCulled = c[7];
    s.frustumCulled = c[8];
    s.skippedClusters = c[9];
    s.occludedClusters = c[10];
    s.translucentDrawn = c[12];
    s.translucentOccluded = c[16];
    if (this.diffReadback.samples !== this.diffSamples) {
      this.diffSamples = this.diffReadback.samples;
      const d = this.diffReadback.latest;
      s.cullChecks++;
      if (d[0] > 0 || d[1] > 0) s.cullCheckFailures++;
      s.cullCheckMaxDiff = Math.max(s.cullCheckMaxDiff, d[0]);
      s.cullCheckMissing += d[1];
      s.cullCheckTies += d[2];
    }
    s.quadFreeBlocks = this.quads.freeBlocks;
    s.quadLargestFree = this.quads.largestFree();
    s.quadFragmentation = this.quads.fragmentation();
    s.clusterFreeBlocks = this.clusters.freeBlocks;
    s.clusterFragmentation = this.clusters.fragmentation();
    return s;
  }

  // A live chunk's slot and ranges into `out`: [slot, quad offset, quad count,
  // cluster offset, cluster count]. False when the chunk has no mesh on the GPU.
  rangesOf(key: number, out: Int32Array): boolean {
    const slot = this.slotOf.get(key);
    if (slot === -1) return false;
    const qb = this.slotQuadBlock[slot], cb = this.slotClusterBlock[slot];
    out[0] = slot;
    out[1] = this.quads.offsetOf(qb);
    out[2] = this.quads.sizeOf(qb);
    out[3] = this.clusters.offsetOf(cb);
    out[4] = this.clusters.sizeOf(cb);
    return true;
  }

  get clusterHighWater(): number {
    return this.clusters.highWater;
  }

  // `pipeline` picks the phase A or B variant, `buffers` which visible list and
  // draw arguments it fills (the cull check runs the A variant into B's buffers).
  private encodeCull(
    encoder: GPUCommandEncoder,
    pipeline: number,
    buffers: number,
    bindGroup: GPUBindGroup,
    descriptor: GPUComputePassDescriptor,
  ): void {
    encoder.copyBufferToBuffer(this.argsReset, 0, this.argsBuffers[buffers], 0, 16);
    if (this.groupsX === 0) return;
    const pass = encoder.beginComputePass(descriptor);
    pass.setPipeline(pipeline === 2 ? this.translucentPipeline! : this.cullPipelines[pipeline]!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(this.groupsX, this.groupsY);
    pass.end();
  }

  // The translucent pass's lists and draw arguments, for tests: `sorted` must be a
  // permutation of the first `args` instance count entries of `visible`.
  get translucentBuffers(): { visible: GPUBuffer; sorted: GPUBuffer; args: GPUBuffer } {
    return { visible: this.visibleBuffers[2], sorted: this.sortedBuffer, args: this.argsBuffers[2] };
  }

  // The unculled reference of the last cull check (tests and debugging).
  get checkTextures(): { color: GPUTexture; depth: GPUTexture } | null {
    return this.checkTargets;
  }

  // Offscreen color and depth for the unculled reference, remade on resize.
  private checkTargetsFor(width: number, height: number): CheckTargets {
    const existing = this.checkTargets;
    if (existing && existing.width === width && existing.height === height) return existing;
    if (existing) {
      existing.color.destroy();
      existing.depth.destroy();
    }
    const device = this.device;
    // COPY_SRC so tests can read the reference back.
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const color = device.createTexture({ label: "cull check color", size: [width, height], format: this.format, usage });
    const depth = device.createTexture({
      label: "cull check depth",
      size: [width, height],
      format: this.depthFormat,
      usage,
    });
    this.checkTargets = {
      width,
      height,
      color,
      depth,
      pass: {
        label: "cull check",
        colorAttachments: [{
          view: color.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      },
    };
    return this.checkTargets;
  }

  private uploadChunk(queue: GPUQueue, key: number, out: MeshJobOutput): number {
    const view = readMeshOutput(out.mesh!);
    const nq = view.quadCount;
    const nc = view.clusterCount;
    if (nq !== nc * this.clusterQuads) {
      this.stats.dropped++; // meshed with another cluster size (not this session's)
      return 0;
    }
    let slot = this.slotOf.get(key);
    const replacing = slot !== -1;
    if (!replacing && this.freeCount === 0) {
      this.stats.dropped++;
      return 0;
    }
    const quadBlock = this.quads.alloc(nq);
    const clusterBlock = quadBlock === NONE ? NONE : this.clusters.alloc(nc);
    if (clusterBlock === NONE) {
      if (quadBlock !== NONE) this.quads.free(quadBlock);
      this.stats.dropped++; // a replaced chunk keeps its old mesh
      return 0;
    }
    if (!replacing) {
      slot = this.freeSlots[--this.freeCount];
      this.slotOf.set(key, slot);
      this.slotKey[slot] = key;
      this.stats.chunks++;
      const c = this.chunkScratch;
      c[0] = keyX(key);
      c[1] = keyY(key);
      c[2] = keyZ(key);
      c[3] = 1;
      queue.writeBuffer(this.chunkBuffer, slot * CHUNK_BYTES, c);
    } else {
      this.releaseRanges(slot); // after the new ranges are taken: never shared
    }
    const quadBase = this.quads.offsetOf(quadBlock);
    const clusterBase = this.clusters.offsetOf(clusterBlock);
    queue.writeBuffer(this.quadBuffer, quadBase * QUAD_BYTES, out.mesh!, 16, nq * QUAD_BYTES);
    // Descriptors: arena base added to the offset, chunk slot filled in.
    if (this.descScratch.length < nc * 4) this.descScratch = new Uint32Array(nc * 8);
    const d = this.descScratch;
    for (let i = 0; i < nc; i++) {
      d[i * 4] = view.clusters[i * 4] + quadBase;
      d[i * 4 + 1] = (view.clusters[i * 4 + 1] | slot) >>> 0;
      d[i * 4 + 2] = view.clusters[i * 4 + 2];
      d[i * 4 + 3] = 0;
    }
    queue.writeBuffer(this.clusterBuffer, clusterBase * CLUSTER_BYTES, d, 0, nc * 4);
    this.slotQuadBlock[slot] = quadBlock;
    this.slotClusterBlock[slot] = clusterBlock;
    this.slotRealQuads[slot] = view.realQuads;
    const s = this.stats;
    s.liveClusters += nc;
    s.realQuads += view.realQuads;
    s.paddedQuads += nq;
    return nq * QUAD_BYTES + nc * CLUSTER_BYTES + (replacing ? 0 : CHUNK_BYTES);
  }

  // Frees a slot's quad and cluster ranges and zeroes its descriptors, so the
  // cull pass skips them until they are reused.
  private releaseRanges(slot: number): void {
    const cb = this.slotClusterBlock[slot];
    if (cb === NONE) return;
    const nc = this.clusters.sizeOf(cb);
    if (this.zeroScratch.length < nc * 4) this.zeroScratch = new Uint32Array(nc * 8);
    this.device.queue.writeBuffer(this.clusterBuffer, this.clusters.offsetOf(cb) * CLUSTER_BYTES, this.zeroScratch, 0, nc * 4);
    this.clusters.free(cb);
    this.quads.free(this.slotQuadBlock[slot]);
    this.slotClusterBlock[slot] = NONE;
    this.slotQuadBlock[slot] = NONE;
    const s = this.stats;
    s.liveClusters -= nc;
    s.realQuads -= this.slotRealQuads[slot];
    s.paddedQuads -= nc * this.clusterQuads;
  }
}
