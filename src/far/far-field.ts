// Far-field pass (plan-far-field phases 1-3): owns the clipmap's GPU buffers, samples
// brick slabs from the world SDF as the camera scrolls, marches them in compute into
// an rgba16float target, and blits that behind the near field.
//
// The blit uses the same depth state as the sky (`greater-equal` at depth 0, no
// write), so it covers only what the near pass left cleared, and discards where the
// march missed so the sky still shows through. That is the composite the plan's
// phase 4 refines; this needs no mask of its own.
//
// Where the pieces are: src/far/clipmap.ts decides what to build and tracks which pool
// slot each grid cell holds, src/far/far-build.wgsl samples a slab and takes slots for
// the bricks it finds occupied, src/far/far.wgsl marches, and src/far/edits.ts patches
// bricks over chunks an edit has changed.

import "../gpu/globals.ts";
import { compileShader, createRenderPipeline, type Report } from "../gpu/shader.ts";
import { BLOCK_TABLE_FLOATS, farColorTable } from "../world/blocks.ts";
import { CHUNK_SIZE } from "../world/coords.ts";
import { BRICK_WORDS, entrySlot } from "./reduce.ts";
import { Clipmap, type ClipmapOptions, DEFAULT_CLIPMAP_OPTIONS, MAX_LEVELS, type Slab } from "./clipmap.ts";
import { type BrushGrid, GRID_CELLS, MAX_GRID_OP_WORDS, MAX_GRID_RECORDS } from "../brush/grid.ts";
import { INSTANCE_WORDS } from "../brush/format.ts";
import brushWgsl from "../brush/brush.wgsl" with { type: "text" };
import { worldSources } from "../sdf/sources.ts";
import type { WorldProgram } from "../worlds/index.ts";
import type { TextureData } from "../render/textures.ts";
import { CoverageMask, COVERAGE_WORDS } from "./coverage.ts";
import { PROBE_WORDS, WORLD_PROBE_SAMPLES, WORLD_PROBE_WORDS } from "./probe.ts";
import skyColorWgsl from "../render/sky-color.wgsl" with { type: "text" };
import { fogHorizonVoxels, skyConstantsWgsl } from "../render/sky.ts";
import shadingWgsl from "../render/shading.wgsl" with { type: "text" };
import farWgsl from "./far.wgsl" with { type: "text" };
import buildWgsl from "./far-build.wgsl" with { type: "text" };
import blitWgsl from "./far-blit.wgsl" with { type: "text" };

export const DEBUG_NONE = 0;
export const DEBUG_STEPS = 1;
export const DEBUG_BRICKS = 2;
export const DEBUG_LEVELS = 3;

const LEVEL_BYTES = 48; // offset, wrap, info
const LEVELS_AT = 36; // words before the level array: mat4, eye, grid, counts, camera chunk, mask origin
const PARAMS_BYTES = LEVELS_AT * 4 + MAX_LEVELS * LEVEL_BYTES;
const BUILD_PARAMS_BYTES = 16 * 5; // origin, plane, grid, brush origin, reduce range
// Coarse-brick rebuilds a dispatch can carry, in step with far-build.wgsl.
const REDUCE_MAX = 256;
const REDUCE_WORDS = 8;
const REDUCE_PER_FRAME = 32;
const REDUCE_NONE = 0xFFFFFFFF;
// One params slot per ring slot, so every slab in a frame can be dispatched from one
// pass with a dynamic offset. queue.writeBuffer lands between submits, not between
// dispatches, so a single slot would give every dispatch the last slab's params.
const BUILD_PARAMS_STRIDE = 256; // minUniformBufferOffsetAlignment at default limits
const COLOR_BYTES = BLOCK_TABLE_FLOATS * 4;
const DROPPED = 0xFFFFFFFF; // a brick the pool had no slot for, in a slab report

// Slab builds that can be in flight. A report takes a few frames to map, so the ring
// is what bounds throughput while a level catches up after a teleport; 16 slots is
// 128 KiB of staging.
const RING = 16;
// Slabs whose cells can be blanked in one frame, on top of the builds. A slab that has
// just scrolled in holds bricks from a window away, and waiting for its turn to be
// sampled would show them (a frame of terrain from somewhere else).
const CLEARS = 16;
const DEFAULT_SLABS_PER_FRAME = 2;
// Full resolution. Below it a terrace's top face is thinner than the march's sampling,
// and the contour lines across distant terrain break up and double
// (gotchas.md "Half-resolution marching eats the thin face"). The adaptive controller
// gives this up when the frame cannot pay for it, after the reach (src/far/adapt.ts).
export const DEFAULT_FAR_SCALE = 1.0;
// March pixels per beam tile, in step with far.wgsl.
const BEAM_TILE = 8;

const SLOT_FREE = 0;
const SLOT_ENCODED = 1; // dispatched, report copy encoded but not yet submitted
const SLOT_MAPPING = 2;

interface RingSlot {
  readonly read: GPUBuffer;
  readonly slots: Uint32Array; // what the CPU offered this build
  readonly upload: Uint32Array; // [0] the cursor reset, then the slots
  readonly slab: Slab;
  state: number;
  taken: number;
}

export interface FarFieldStats {
  bricks: number; // pool slots in use
  poolBytes: number;
  slabs: number; // slabs built
  queued: number; // slabs waiting
  inFlight: number;
  dropped: number; // bricks the pool had no room for
  patched: number; // bricks written by the edited-chunk path
  coarse: number; // coarse bricks rebuilt from the level under them
  coarseQueued: number;
  uploadBytes: number; // last frame, slot lists and patches
}

export interface FarFieldOptions {
  clipmap?: ClipmapOptions;
  slabsPerFrame?: number;
  // Fraction of the frame's resolution the march runs at (plan-far-field phase 5).
  // Far-field detail is under a pixel by construction, so the cost of a full-resolution
  // march buys very little; the blit upsamples (far-blit.wgsl).
  scale?: number;
  textures?: TextureData | null;
}

export class FarField {
  readonly map: Clipmap;
  readonly stats: FarFieldStats = {
    bricks: 0,
    poolBytes: 0,
    slabs: 0,
    queued: 0,
    inFlight: 0,
    dropped: 0,
    patched: 0,
    coarse: 0,
    coarseQueued: 0,
    uploadBytes: 0,
  };
  // The brush grid whose field the sampled bricks include, or null when nothing
  // places brushes. Uploaded by updateBrushes(), like the preview does.
  brushes: BrushGrid | null = null;
  // Which chunks the near field is drawing, so the march can leave those to it
  // (plan-far-field phase 4). MeshScheduler sets the bits.
  readonly coverage = new CoverageMask();
  // 0 normal, 1 step heatmap, 2 brick heatmap, 3 level index.
  debug = DEBUG_NONE;
  // Run the beam pre-pass: one coarse ray per tile gives the march a start distance.
  beam = true;
  // Skip a brick's cell walk when its axes word says the ray's rows are empty
  // (`brick_can_hit` in far.wgsl). A switch so the two can be diffed at runtime: they
  // must render the same pixels.
  axes = true;
  // The fog horizon in voxels, from the world's sky; set with the world.
  private readonly horizon: number;
  // Told when a slab's bricks have been sampled and are in the pool. A sample writes
  // whatever the field says, so anything laid over the field there (an edited chunk's
  // bricks) has to go back on top: src/far/edits.ts listens.
  onSlabBuilt: ((level: number, axis: number, plane: number) => void) | null = null;

  private readonly device: GPUDevice;
  private readonly world: WorldProgram;
  private slabsPerFrame: number;
  private builtThisFrame = false;
  private scale: number;
  private readonly slabWords: number; // words per ring slot in the slab buffer
  private readonly planeBricks: number; // B^2
  private readonly paramsBuffer: GPUBuffer;
  private readonly colorBuffer: GPUBuffer;
  private readonly indirectionBuffer: GPUBuffer;
  private readonly brickBuffer: GPUBuffer;
  private readonly buildParamsBuffer: GPUBuffer;
  private readonly brushRecordsBuffer: GPUBuffer;
  private readonly brushOpsBuffer: GPUBuffer;
  private readonly brushCellsBuffer: GPUBuffer;
  private readonly slabBuffer: GPUBuffer;
  private readonly coverageBuffer: GPUBuffer;
  private readonly reduceBuffer: GPUBuffer;
  private readonly reduceRead: GPUBuffer;
  private readonly reduceRequests = new Uint32Array(REDUCE_MAX * REDUCE_WORDS);
  private readonly reduceBricks = new Int32Array(REDUCE_PER_FRAME * 4);
  private readonly reduceSlots = new Uint32Array(REDUCE_PER_FRAME);
  private readonly reduceCells = new Int32Array(REDUCE_PER_FRAME);
  private reduceInFlight = 0; // requests whose report is being read
  private reduceMapping = false;
  private readonly layout: GPUBindGroupLayout;
  private readonly beamLayout: GPUBindGroupLayout;
  private readonly buildLayout: GPUBindGroupLayout;
  private readonly blitLayout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly params = new ArrayBuffer(PARAMS_BYTES);
  private readonly paramsF32 = new Float32Array(this.params);
  private readonly paramsI32 = new Int32Array(this.params);
  private readonly paramsU32 = new Uint32Array(this.params);
  private readonly buildParams = new ArrayBuffer(BUILD_PARAMS_BYTES);
  private readonly buildI32 = new Int32Array(this.buildParams);
  private readonly buildU32 = new Uint32Array(this.buildParams);
  private readonly ring: RingSlot[] = [];
  private readonly zeros: Uint32Array;
  private readonly slotScratch = new Uint32Array(1);
  private readonly offsets = [0]; // scratch for the build pass's dynamic offset
  private readonly copies = new Int32Array(RING); // report copies to encode after the pass
  private readonly fresh = new Int32Array(CLEARS * 3); // slabs to blank this frame
  private readonly zeroedLevels = new Int32Array(MAX_LEVELS);
  private readonly freshSlab: Slab = { level: 0, axis: 0, plane: 0, u0: 0, v0: 0 };
  // The reduce dispatch reads only the range fields of the params, but writeBuildParams
  // wants a slab; this one is never read by the shader.
  private readonly coarseSlab: Slab = { level: 0, axis: 2, plane: 0, u0: 0, v0: 0 };
  private readonly copySlots = new Int32Array(RING);
  private readonly entry = new Uint32Array(1);
  private pipeline: GPUComputePipeline | null = null;
  private buildPipeline: GPUComputePipeline | null = null;
  private clearPipeline: GPUComputePipeline | null = null;
  private reducePipeline: GPUComputePipeline | null = null;
  private blitPipeline: GPURenderPipeline | null = null;
  // The marked-ray and marked-point probes (`mark` in the panel, src/debug/mark.ts).
  // Built on the first mark rather than at startup: a session that never marks anything
  // pays nothing, and a mark is a click, not a frame.
  private marchModule: GPUShaderModule | null = null;
  private buildModule: GPUShaderModule | null = null;
  private probes: Promise<void> | null = null;
  private probeLayout: GPUBindGroupLayout | null = null;
  private probeMarch: GPUComputePipeline | null = null;
  private probeWorldPipeline: GPUComputePipeline | null = null;
  private probeBuffer: GPUBuffer | null = null;
  private probeGroup: GPUBindGroup | null = null;
  private worldProbeBuffer: GPUBuffer | null = null;
  private worldProbeGroup: GPUBindGroup | null = null;
  private buildBindGroup: GPUBindGroup | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private beamBindGroup: GPUBindGroup | null = null;
  private beamPipeline: GPUComputePipeline | null = null;
  private beamTarget: GPUTexture | null = null;
  private beamWidth = 0;
  private beamHeight = 0;
  private blitBindGroup: GPUBindGroup | null = null;
  private target: GPUTexture | null = null;
  private depth: GPUTexture | null = null;
  private width = 0; // the march target, frame size times the scale
  private height = 0;
  private frameWidth = 0;
  private frameHeight = 0;
  private uploadBytes = 0;

  constructor(device: GPUDevice, world: WorldProgram, options: FarFieldOptions = {}) {
    this.horizon = fogHorizonVoxels(world.sky);
    this.device = device;
    this.world = world;
    this.slabsPerFrame = options.slabsPerFrame ?? DEFAULT_SLABS_PER_FRAME;
    this.scale = options.scale ?? DEFAULT_FAR_SCALE;
    this.map = new Clipmap(options.clipmap ?? DEFAULT_CLIPMAP_OPTIONS);
    const size = this.map.options.size;
    this.planeBricks = size * size;
    this.slabWords = 1 + 2 * this.planeBricks;
    this.zeros = new Uint32Array(this.map.cells);
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.paramsBuffer = device.createBuffer({
      label: "far params",
      size: PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Far-field colors, not the near field's display colors: one table, owned by the
    // block registry, read by the march and by the brick builder. A uniform, so the
    // build shader stays inside the default maxStorageBuffersPerShaderStage of 8.
    this.colorBuffer = device.createBuffer({
      label: "far block colors",
      size: COLOR_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const colors = new Float32Array(BLOCK_TABLE_FLOATS);
    farColorTable(colors, 0, options.textures ?? null);
    device.queue.writeBuffer(this.colorBuffer, 0, colors);
    this.indirectionBuffer = device.createBuffer({
      label: "far indirection",
      size: this.map.cells * this.map.levelCapacity * 4,
      usage: storage,
    });
    this.brickBuffer = device.createBuffer({
      label: "far bricks",
      size: this.map.pool.capacity * BRICK_WORDS * 4,
      usage: storage,
    });
    this.buildParamsBuffer = device.createBuffer({
      label: "far build params",
      size: (RING + CLEARS + 1) * BUILD_PARAMS_STRIDE, // the last slot is the reduce's
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Field brushes near the camera (src/brush/grid.ts), so a placed brush is in the
    // far field's terrain too. Allocated even when nothing places brushes: the build
    // reads a cell per brick whatever the case.
    this.brushRecordsBuffer = device.createBuffer({
      label: "far brush records",
      size: MAX_GRID_RECORDS * INSTANCE_WORDS * 4,
      usage: storage,
    });
    this.brushOpsBuffer = device.createBuffer({ label: "far brush ops", size: MAX_GRID_OP_WORDS * 4, usage: storage });
    this.brushCellsBuffer = device.createBuffer({ label: "far brush cells", size: GRID_CELLS * 16, usage: storage });
    this.slabBuffer = device.createBuffer({
      label: "far slab",
      size: RING * this.slabWords * 4,
      usage: storage,
    });
    this.coverageBuffer = device.createBuffer({ label: "far coverage", size: COVERAGE_WORDS * 4, usage: storage });
    this.reduceBuffer = device.createBuffer({
      label: "far reduce",
      size: (REDUCE_MAX * REDUCE_WORDS + REDUCE_MAX) * 4,
      usage: storage,
    });
    this.reduceRead = device.createBuffer({
      label: "far reduce read",
      size: REDUCE_PER_FRAME * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    for (let i = 0; i < RING; i++) {
      this.ring.push({
        read: device.createBuffer({
          label: `far slab read ${i}`,
          size: this.planeBricks * 4,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        slots: new Uint32Array(this.planeBricks),
        upload: new Uint32Array(1 + this.planeBricks),
        slab: { level: 0, axis: 0, plane: 0, u0: 0, v0: 0 },
        state: SLOT_FREE,
        taken: 0,
      });
    }
    const compute = GPUShaderStage.COMPUTE;
    this.layout = device.createBindGroupLayout({
      label: "far",
      entries: [
        { binding: 0, visibility: compute, buffer: { type: "uniform" } },
        { binding: 1, visibility: compute, buffer: { type: "uniform" } },
        { binding: 2, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: compute, texture: { sampleType: "depth" } },
        { binding: 6, visibility: compute, storageTexture: { access: "write-only", format: "rgba16float" } },
        { binding: 8, visibility: compute, texture: { sampleType: "unfilterable-float" } },
      ],
    });
    // The beam writes the tile texture the march reads, so it needs its own group.
    this.beamLayout = device.createBindGroupLayout({
      label: "far beam",
      entries: [
        { binding: 0, visibility: compute, buffer: { type: "uniform" } },
        { binding: 2, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 7, visibility: compute, storageTexture: { access: "write-only", format: "r32float" } },
      ],
    });
    this.buildLayout = device.createBindGroupLayout({
      label: "far build",
      entries: [
        { binding: 0, visibility: compute, buffer: { type: "uniform", hasDynamicOffset: true } },
        { binding: 1, visibility: compute, buffer: { type: "uniform" } },
        { binding: 2, visibility: compute, buffer: { type: "storage" } },
        { binding: 3, visibility: compute, buffer: { type: "storage" } },
        { binding: 4, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 7, visibility: compute, buffer: { type: "storage" } },
        { binding: 8, visibility: compute, buffer: { type: "storage" } },
      ],
    });
    this.buildBindGroup = device.createBindGroup({
      label: "far build",
      layout: this.buildLayout,
      entries: [
        { binding: 0, resource: { buffer: this.buildParamsBuffer, size: BUILD_PARAMS_BYTES } },
        { binding: 1, resource: { buffer: this.colorBuffer } },
        { binding: 2, resource: { buffer: this.indirectionBuffer } },
        { binding: 3, resource: { buffer: this.brickBuffer } },
        { binding: 4, resource: { buffer: this.brushRecordsBuffer } },
        { binding: 5, resource: { buffer: this.brushOpsBuffer } },
        { binding: 6, resource: { buffer: this.brushCellsBuffer } },
        { binding: 7, resource: { buffer: this.slabBuffer } },
        { binding: 8, resource: { buffer: this.reduceBuffer } },
      ],
    });
    this.blitLayout = device.createBindGroupLayout({
      label: "far blit",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.sampler = device.createSampler({ label: "far blit", magFilter: "linear", minFilter: "linear" });
  }

  async init(format: GPUTextureFormat, depthFormat: GPUTextureFormat, report: Report): Promise<boolean> {
    const device = this.device;
    const [march, blit, build] = await Promise.all([
      compileShader(device, "far", [
        { name: "sky.wgsl (generated)", code: skyConstantsWgsl(this.world.sky) },
        { name: "sky-color.wgsl", code: skyColorWgsl },
        { name: "shading.wgsl", code: shadingWgsl },
        { name: "far/far.wgsl", code: farWgsl },
      ], report),
      compileShader(device, "far blit", [{ name: "far/far-blit.wgsl", code: blitWgsl }], report),
      compileShader(device, "far build", [
        ...worldSources(this.world),
        { name: "brush/brush.wgsl", code: brushWgsl },
        { name: "far/far-build.wgsl", code: buildWgsl },
      ], report),
    ]);
    if (!march || !blit || !build) return false;
    // Kept for the probes, which are compiled when someone asks to mark rather than
    // here: they inline the march and the world program a second time, and on the forest
    // that is 16 seconds of pipeline compilation nobody who never marks should wait for.
    this.marchModule = march;
    this.buildModule = build;
    const buildLayout = device.createPipelineLayout({ label: "far build", bindGroupLayouts: [this.buildLayout] });
    try {
      const [sample, clear, reduce, pipeline, beam] = await Promise.all([
        device.createComputePipelineAsync({
          label: "far build",
          layout: buildLayout,
          compute: { module: build, entryPoint: "build_slab" },
        }),
        device.createComputePipelineAsync({
          label: "far clear",
          layout: buildLayout,
          compute: { module: build, entryPoint: "clear_slab" },
        }),
        device.createComputePipelineAsync({
          label: "far reduce",
          layout: buildLayout,
          compute: { module: build, entryPoint: "reduce_bricks" },
        }),
        device.createComputePipelineAsync({
          label: "far march",
          layout: device.createPipelineLayout({ label: "far", bindGroupLayouts: [this.layout] }),
          compute: { module: march, entryPoint: "march_far" },
        }),
        device.createComputePipelineAsync({
          label: "far beam",
          layout: device.createPipelineLayout({ label: "far beam", bindGroupLayouts: [this.beamLayout] }),
          compute: { module: march, entryPoint: "beam_far" },
        }),
      ]);
      this.buildPipeline = sample;
      this.clearPipeline = clear;
      this.reducePipeline = reduce;
      this.pipeline = pipeline;
      this.beamPipeline = beam;
    } catch (err) {
      report(`far pipeline: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.blitPipeline = await createRenderPipeline(device, {
      label: "far blit",
      layout: device.createPipelineLayout({ label: "far blit", bindGroupLayouts: [this.blitLayout] }),
      vertex: { module: blit, entryPoint: "vs" },
      fragment: { module: blit, entryPoint: "fs", targets: [{ format }] },
      // Behind the near field, like the sky: only where the near pass left depth 0.
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: "greater-equal" },
    }, report);
    return this.blitPipeline !== null;
  }

  get ready(): boolean {
    return this.pipeline !== null && this.blitPipeline !== null && this.target !== null;
  }

  // True when the last encode() dispatched any brick building; see encodeBuilds().
  get builtLastFrame(): boolean {
    return this.builtThisFrame;
  }

  // Reach and build budget, both moved by the adaptive controller (src/far/adapt.ts).
  // Dropping a level frees its bricks and shortens the view; adding one rebuilds it,
  // which is a burst of slabs the budget below spreads over the next few seconds.
  get levels(): number {
    return this.map.levels;
  }

  set levels(n: number) {
    this.map.setLevels(n);
  }

  get slabs(): number {
    return this.slabsPerFrame;
  }

  set slabs(n: number) {
    this.slabsPerFrame = Math.max(1, n | 0);
  }

  // The three buffers a shadow ray needs (src/far/shadow.wgsl): this frame's march
  // parameters, the clipmap's indirection and the brick pool. The near field binds them
  // to its draw pipeline, which is the only consumer outside this class.
  shadowResources(): readonly GPUBuffer[] {
    return [this.paramsBuffer, this.indirectionBuffer, this.brickBuffer];
  }

  // Resolution the march runs at, as a fraction of the frame. Changing it rebuilds the
  // target on the next frame.
  get resolutionScale(): number {
    return this.scale;
  }

  set resolutionScale(scale: number) {
    const next = Math.max(0.1, Math.min(1, scale));
    if (next === this.scale) return;
    this.scale = next;
    this.frameWidth = 0; // force resize() to rebuild
  }

  resize(frameWidth: number, frameHeight: number, depth: GPUTexture): void {
    if (this.target && this.frameWidth === frameWidth && this.frameHeight === frameHeight && this.depth === depth) {
      return;
    }
    this.target?.destroy();
    this.depth = depth;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    const width = Math.max(1, Math.round(frameWidth * this.scale));
    const height = Math.max(1, Math.round(frameHeight * this.scale));
    this.width = width;
    this.height = height;
    this.target = this.device.createTexture({
      label: "far color",
      size: [width, height],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.beamWidth = Math.max(1, Math.ceil(width / BEAM_TILE));
    this.beamHeight = Math.max(1, Math.ceil(height / BEAM_TILE));
    this.beamTarget?.destroy();
    this.beamTarget = this.device.createTexture({
      label: "far beam",
      size: [this.beamWidth, this.beamHeight],
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const beamView = this.beamTarget.createView();
    this.beamBindGroup = this.device.createBindGroup({
      label: "far beam",
      layout: this.beamLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 2, resource: { buffer: this.indirectionBuffer } },
        { binding: 7, resource: beamView },
      ],
    });
    const view = this.target.createView();
    this.bindGroup = this.device.createBindGroup({
      label: "far",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.colorBuffer } },
        { binding: 2, resource: { buffer: this.indirectionBuffer } },
        { binding: 3, resource: { buffer: this.brickBuffer } },
        { binding: 4, resource: { buffer: this.coverageBuffer } },
        { binding: 5, resource: depth.createView({ aspect: "depth-only" }) },
        { binding: 6, resource: view },
        { binding: 8, resource: beamView },
      ],
    });
    this.blitBindGroup = this.device.createBindGroup({
      label: "far blit",
      layout: this.blitLayout,
      entries: [{ binding: 0, resource: view }, { binding: 1, resource: this.sampler }],
    });
  }

  // --- Probes (the `mark` switch, src/debug/mark.ts) -------------------------------
  //
  // Both run outside the frame: a mark is a click, so a submit of their own and a map
  // that is awaited are fine here, and neither touches anything the frame loop holds.

  // Compiles the probe pipelines, once, and hands back the same promise after that.
  // `mark` in the panel calls this when it is switched on, so the wait lands there
  // rather than on the click or on every startup.
  warmProbes(): Promise<void> {
    if (this.marchModule === null || this.buildModule === null) return Promise.resolve();
    this.probes ??= this.buildProbes(this.marchModule, this.buildModule);
    return this.probes;
  }

  // Neither probe pipeline is small to compile: each inlines something the frame already
  // has (the march, the world program) a second time.
  private async buildProbes(march: GPUShaderModule, build: GPUShaderModule): Promise<void> {
    const device = this.device;
    this.probeLayout = device.createBindGroupLayout({
      label: "far probe",
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }],
    });
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.probeBuffer = device.createBuffer({ label: "far probe", size: PROBE_WORDS * 4, usage });
    this.worldProbeBuffer = device.createBuffer({ label: "world probe", size: WORLD_PROBE_WORDS * 4, usage });
    this.probeGroup = device.createBindGroup({
      label: "far probe",
      layout: this.probeLayout,
      entries: [{ binding: 0, resource: { buffer: this.probeBuffer } }],
    });
    this.worldProbeGroup = device.createBindGroup({
      label: "world probe",
      layout: this.probeLayout,
      entries: [{ binding: 0, resource: { buffer: this.worldProbeBuffer } }],
    });
    const [probeMarch, probeWorld] = await Promise.all([
      device.createComputePipelineAsync({
        label: "far probe",
        layout: device.createPipelineLayout({
          label: "far probe",
          bindGroupLayouts: [this.layout, this.probeLayout],
        }),
        compute: { module: march, entryPoint: "probe_far" },
      }),
      device.createComputePipelineAsync({
        label: "world probe",
        layout: device.createPipelineLayout({
          label: "world probe",
          bindGroupLayouts: [this.buildLayout, this.probeLayout],
        }),
        compute: { module: build, entryPoint: "probe_world" },
      }),
    ]);
    this.probeMarch = probeMarch;
    this.probeWorldPipeline = probeWorld;
  }

  // The staging buffer is made and thrown away per probe on purpose: a map that never
  // resolves (a lost device, a tab that went away) then costs one buffer instead of
  // leaving the next mark with nothing to read into.
  private async runProbe(
    pipeline: GPUComputePipeline,
    group0: GPUBindGroup,
    group1: GPUBindGroup,
    storage: GPUBuffer,
    input: Uint32Array,
    words: number,
    offset0 = -1,
  ): Promise<Uint32Array> {
    const device = this.device;
    const readBuffer = device.createBuffer({
      label: "probe read",
      size: words * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    device.pushErrorScope("validation");
    try {
      device.queue.writeBuffer(storage, 0, input);
      const encoder = device.createCommandEncoder({ label: "probe" });
      const pass = encoder.beginComputePass({ label: "probe" });
      pass.setPipeline(pipeline);
      if (offset0 >= 0) pass.setBindGroup(0, group0, [offset0]);
      else pass.setBindGroup(0, group0);
      pass.setBindGroup(1, group1);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(storage, 0, readBuffer, 0, words * 4);
      device.queue.submit([encoder.finish()]);
      await readBuffer.mapAsync(GPUMapMode.READ);
      const out = new Uint32Array(readBuffer.getMappedRange().slice(0));
      readBuffer.unmap();
      return out;
    } finally {
      readBuffer.destroy();
      // Popped in the same call that pushed it, whatever happened in between: an
      // unpopped scope outlives the probe and swallows the next pass's errors.
      void device.popErrorScope().then((err) => {
        if (err !== null) console.error(`probe: ${err.message}`);
      }).catch(() => {});
    }
  }

  // Marches one ray from zero, through the clipmap the frame is using, and reports what
  // it met. `ndc` is the clicked point in normalised device coordinates.
  async probeRay(ndcX: number, ndcY: number): Promise<Uint32Array | null> {
    await this.warmProbes();
    if (this.probeMarch === null || this.bindGroup === null) return null;
    const input = new Uint32Array(PROBE_WORDS);
    new Float32Array(input.buffer)[0] = ndcX;
    new Float32Array(input.buffer)[1] = ndcY;
    return await this.runProbe(
      this.probeMarch!,
      this.bindGroup,
      this.probeGroup!,
      this.probeBuffer!,
      input,
      PROBE_WORDS,
    );
  }

  // Asks the world program itself along a line of voxels, at two footprints: `fine` is
  // what the voxelizer would see and `coarse` what the brick builder saw.
  async probeWorld(
    origin: readonly [number, number, number],
    step: readonly [number, number, number],
    count: number,
    fine: number,
    coarse: number,
  ): Promise<Uint32Array | null> {
    await this.warmProbes();
    if (this.probeWorldPipeline === null || this.buildBindGroup === null) return null;
    const input = new Uint32Array(WORLD_PROBE_WORDS);
    const asI32 = new Int32Array(input.buffer);
    const asF32 = new Float32Array(input.buffer);
    asI32[0] = origin[0];
    asI32[1] = origin[1];
    asI32[2] = origin[2];
    asI32[3] = step[0];
    asI32[4] = step[1];
    asI32[5] = step[2];
    input[6] = Math.max(0, Math.min(WORLD_PROBE_SAMPLES, count));
    asF32[7] = fine;
    asF32[8] = coarse;
    // The build group carries a dynamic offset; any slot will do, the probe reads only
    // the world seed out of it.
    return await this.runProbe(
      this.probeWorldPipeline!,
      this.buildBindGroup,
      this.worldProbeGroup!,
      this.worldProbeBuffer!,
      input,
      WORLD_PROBE_WORDS,
      0,
    );
  }

  // Moves the clipmap to follow the camera and queues the slabs that scrolled in.
  // Cheap: the work is one origin per level plus whatever crossed a brick boundary.
  update(x: number, y: number, z: number): void {
    this.map.update(x, y, z);
    this.coverage.center(x >> 5, y >> 5, z >> 5);
    this.stats.queued = this.map.queued;
  }

  // Queues every level again, as after a teleport: the far field reads as empty until
  // the slabs land, rather than showing terrain from where the camera was.
  rebuild(): void {
    for (let level = 0; level < this.map.levels; level++) this.map.rebuildLevel(level);
    this.stats.queued = this.map.queued;
  }

  // Reads finished slab reports and samples the next slabs. Encoded before the march,
  // so what lands this frame is marched this frame.
  encodeBuilds(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void {
    this.uploadBytes = 0;
    this.collectReduce();
    if (this.coverage.dirty) {
      const lo = this.coverage.dirtyLo, n = this.coverage.dirtyHi - lo;
      this.device.queue.writeBuffer(this.coverageBuffer, lo * 4, this.coverage.words, lo, n);
      this.uploadBytes += n * 4;
      this.coverage.clearDirty();
    }
    this.collect();
    if (this.buildPipeline === null || this.clearPipeline === null) return;
    let pass: GPUComputePassEncoder | null = null;
    let copies = 0;
    // A level that jumped a whole window (a teleport, or the first frame) keeps its old
    // entries until the slabs land, which would be the old place drawn around the new
    // one. Blank the slice instead.
    const zeroed = this.map.takeZeroed(this.zeroedLevels);
    for (let i = 0; i < zeroed; i++) {
      this.device.queue.writeBuffer(this.indirectionBuffer, this.zeroedLevels[i] * this.map.cells * 4, this.zeros);
      this.uploadBytes += this.zeros.byteLength;
    }
    // Blank what just scrolled in, before anything else: those cells hold bricks from
    // a window away until their slab is sampled, and the march would draw them.
    const fresh = this.map.takeFresh(this.fresh, CLEARS);
    for (let i = 0; i < fresh; i++) {
      this.freshSlab.level = this.fresh[i * 3];
      this.freshSlab.axis = this.fresh[i * 3 + 1];
      this.freshSlab.plane = this.fresh[i * 3 + 2];
      this.writeBuildParams(this.freshSlab, RING + i, 0);
      if (pass === null) pass = encoder.beginComputePass({ label: "far build", timestampWrites });
      pass.setBindGroup(0, this.buildBindGroup!, this.dynamicOffset(RING + i));
      pass.setPipeline(this.clearPipeline);
      pass.dispatchWorkgroups(Math.ceil(this.planeBricks / 64));
    }
    for (let i = 0; i < this.slabsPerFrame; i++) {
      const slot = this.freeSlot();
      // Taken straight into the ring slot's own slab, never copied field by field: the
      // slab is what the report is applied with frames later, and a field left behind by
      // a copy is a report applied against the wrong origin. That is exactly what
      // happened when `u0`/`v0` were added (gotchas.md "A slab that comes back after the
      // window moved").
      if (slot === null || !this.map.take(slot.slab)) break;
      const n = this.map.pool.take(slot.slots, 0, this.planeBricks);
      slot.taken = n;
      slot.state = SLOT_ENCODED;
      // [0] resets the slot cursor the build increments; the rest is the free list it
      // hands out.
      slot.upload[0] = 0;
      slot.upload.set(slot.slots.subarray(0, n), 1);
      const ring = this.ring.indexOf(slot);
      const base = ring * this.slabWords * 4;
      this.device.queue.writeBuffer(this.slabBuffer, base, slot.upload, 0, 1 + n);
      this.uploadBytes += (1 + n) * 4;
      this.writeBuildParams(slot.slab, ring, n);
      if (pass === null) pass = encoder.beginComputePass({ label: "far build", timestampWrites });
      // The clear runs first so a slab that is dispatched but not yet reported reads
      // as empty rather than as whatever the cells held before.
      pass.setBindGroup(0, this.buildBindGroup!, this.dynamicOffset(ring));
      pass.setPipeline(this.clearPipeline);
      pass.dispatchWorkgroups(Math.ceil(this.planeBricks / 64));
      pass.setPipeline(this.buildPipeline);
      pass.dispatchWorkgroups(this.map.options.size, this.map.options.size);
      this.copies[copies++] = base;
      this.copySlots[copies - 1] = ring;
    }
    pass?.end();
    // Its own pass: it reads bricks a slab build in the same pass could be writing.
    const reduced = this.encodeReduce(encoder);
    if (reduced > 0) {
      encoder.copyBufferToBuffer(
        this.reduceBuffer,
        REDUCE_MAX * REDUCE_WORDS * 4,
        this.reduceRead,
        0,
        reduced * 4,
      );
      this.reduceInFlight = reduced;
    }
    // Copies go after the pass: an encoder is locked while one is open.
    for (let i = 0; i < copies; i++) {
      encoder.copyBufferToBuffer(
        this.slabBuffer,
        this.copies[i] + (1 + this.planeBricks) * 4,
        this.ring[this.copySlots[i]].read,
        0,
        this.planeBricks * 4,
      );
    }
    this.stats.queued = this.map.queued;
    this.stats.inFlight = this.inFlight();
    this.stats.uploadBytes = this.uploadBytes;
    this.stats.coarseQueued = this.map.coarseQueued;
    // Whether this frame encoded a build at all. The GPU timer only samples a pass on
    // the frames it runs, so a clipmap that has caught up leaves the build's ring
    // holding whatever it last cost, forever; the adaptive controller needs to know how
    // often it actually runs to turn that into a cost per frame (src/far/adapt.ts).
    this.builtThisFrame = pass !== null;
  }

  // Rebuilds the coarse bricks over anything that changed, from the level under them:
  // an edit reaches levels 1 and 2 through the chunk reduction, and everything above
  // through this (plan-far-field phase 5). One dispatch, one level, lowest first, so a
  // level is rebuilt before the one above reads it.
  private encodeReduce(encoder: GPUCommandEncoder): number {
    if (this.reducePipeline === null || this.reduceInFlight > 0) return 0;
    const n = this.map.takeCoarse(this.reduceBricks, REDUCE_PER_FRAME);
    if (n === 0) return 0;
    const map = this.map;
    for (let i = 0; i < n; i++) {
      const level = this.reduceBricks[i * 4];
      const bx = this.reduceBricks[i * 4 + 1], by = this.reduceBricks[i * 4 + 2], bz = this.reduceBricks[i * 4 + 3];
      const cell = map.cellOf(level, bx, by, bz);
      let slot = entrySlot(map.entries[cell]);
      if (slot < 0) {
        // No brick of its own yet (empty, or solid throughout): offer a free one, and
        // take it back when the report says it went unused.
        slot = map.pool.take(this.slotScratch, 0, 1) === 1 ? this.slotScratch[0] : -1;
      }
      this.reduceCells[i] = cell;
      this.reduceSlots[i] = slot < 0 ? REDUCE_NONE : slot;
      const at = i * REDUCE_WORDS;
      this.reduceRequests[at] = level;
      this.reduceRequests[at + 1] = bx;
      this.reduceRequests[at + 2] = by;
      this.reduceRequests[at + 3] = bz;
      this.reduceRequests[at + 4] = this.reduceSlots[i];
      map.pending[cell] = 1;
    }
    this.device.queue.writeBuffer(this.reduceBuffer, 0, this.reduceRequests, 0, n * REDUCE_WORDS);
    this.uploadBytes += n * REDUCE_WORDS * 4;
    // The reduce shares the build's params slot for its dynamic offset; a slot past the
    // ring keeps it out of the slab builds' way.
    const ring = RING + CLEARS;
    this.buildU32[16] = 0;
    this.buildU32[17] = n;
    this.writeBuildParams(this.coarseSlab, ring, 0);
    const p = encoder.beginComputePass({ label: "far reduce" });
    p.setBindGroup(0, this.buildBindGroup!, this.dynamicOffset(ring));
    p.setPipeline(this.reducePipeline);
    p.dispatchWorkgroups(n);
    p.end();
    return n;
  }

  // Applies a finished coarse rebuild: the entries the GPU wrote, and the slots it did
  // not need.
  private collectReduce(): void {
    if (this.reduceInFlight === 0 || this.reduceMapping) return;
    this.reduceMapping = true;
    const n = this.reduceInFlight;
    this.reduceRead.mapAsync(GPUMapMode.READ, 0, n * 4).then(() => {
      const entries = new Uint32Array(this.reduceRead.getMappedRange(0, n * 4));
      for (let i = 0; i < n; i++) {
        const cell = this.reduceCells[i];
        const entry = entries[i];
        this.map.entries[cell] = entry;
        this.map.pending[cell] = 0;
        const offered = this.reduceSlots[i];
        if (offered !== REDUCE_NONE && entrySlot(entry) !== offered) this.map.pool.give(offered);
      }
      this.reduceRead.unmap();
      this.reduceMapping = false;
      this.reduceInFlight = 0;
      this.stats.coarse += n;
      this.stats.bricks = this.map.pool.used;
    }).catch(() => {
      this.reduceMapping = false;
      this.reduceInFlight = 0;
    });
  }

  // Marches into the target. `invViewProj` and the camera come from the frame.
  encode(
    encoder: GPUCommandEncoder,
    invViewProj: ArrayLike<number>,
    eye: ArrayLike<number>,
    cameraChunk: ArrayLike<number>,
    timestampWrites?: GPUComputePassTimestampWrites,
    beamWrites?: GPUComputePassTimestampWrites,
  ): void {
    if (!this.ready) return;
    for (let i = 0; i < 16; i++) this.paramsF32[i] = invViewProj[i];
    for (let i = 0; i < 3; i++) this.paramsF32[16 + i] = eye[i];
    // The fog horizon, where the march stops: past it the fog has the pixel to within
    // FOG_RESIDUAL. Infinity for a world with no fog, which f32 carries as is.
    this.paramsF32[19] = this.horizon;
    const size = this.map.options.size;
    this.paramsU32[20] = size;
    this.paramsU32[21] = size * 3; // brick steps per level
    this.paramsU32[22] = 32; // cell steps inside one brick
    this.paramsU32[23] = this.debug;
    this.paramsU32[24] = this.map.levels;
    this.paramsU32[25] = this.beam ? 1 : 0;
    this.paramsU32[26] = this.axes ? 1 : 0;
    for (let i = 0; i < 3; i++) {
      this.paramsI32[28 + i] = cameraChunk[i];
      this.paramsI32[32 + i] = this.coverage.origin[i];
    }
    for (let level = 0; level < this.map.levels; level++) {
      const at = LEVELS_AT + level * (LEVEL_BYTES / 4);
      const brickVoxels = this.map.brickVoxels(level);
      for (let a = 0; a < 3; a++) {
        // Integer offset from render space to this level's grid, so no absolute f32
        // world position is ever formed (CLAUDE.md "Invariants").
        this.paramsI32[at + a] = cameraChunk[a] * CHUNK_SIZE - this.map.origins[level * 3 + a] * brickVoxels;
        this.paramsI32[at + 4 + a] = this.map.origins[level * 3 + a] & (size - 1);
      }
      this.paramsI32[at + 3] = level * this.map.cells;
      this.paramsF32[at + 8] = this.map.cellVoxels(level);
      this.paramsF32[at + 9] = size * 8;
    }
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
    if (this.beam && this.beamPipeline !== null) {
      // One coarse ray per tile first: it walks bricks only, and tells the march where
      // it can start. Its own pass, since the march samples what it writes.
      const beamPass = encoder.beginComputePass({ label: "far beam", timestampWrites: beamWrites });
      beamPass.setPipeline(this.beamPipeline);
      beamPass.setBindGroup(0, this.beamBindGroup!);
      beamPass.dispatchWorkgroups(Math.ceil(this.beamWidth / 8), Math.ceil(this.beamHeight / 8));
      beamPass.end();
    }
    const pass = encoder.beginComputePass({ label: "far march", timestampWrites });
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.bindGroup!);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    pass.end();
  }

  // Uploads the brush grid the sampled bricks include, when it changed.
  updateBrushes(cx: number, cy: number, cz: number): void {
    const grid = this.brushes;
    if (grid === null || !grid.update(cx, cy, cz)) return;
    const q = this.device.queue;
    q.writeBuffer(this.brushCellsBuffer, 0, grid.cells);
    if (grid.recordCount > 0) {
      q.writeBuffer(this.brushRecordsBuffer, 0, grid.records, 0, grid.recordCount * INSTANCE_WORDS);
    }
    if (grid.opWords > 0) q.writeBuffer(this.brushOpsBuffer, 0, grid.ops, 0, grid.opWords);
  }

  // k of each level, for consumers that reason in cell sizes (src/far/edits.ts).
  get levelKs(): Int32Array {
    const out = new Int32Array(this.map.levels);
    for (let i = 0; i < out.length; i++) out[i] = this.map.levelK(i);
    return out;
  }

  get firstLevel(): number {
    return this.map.options.firstLevel;
  }

  // Writes one brick reduced from chunk data (src/far/edits.ts) over whatever the
  // field sampled there. `words` holds BRICK_WORDS at `at`, or the brick is empty.
  // Returns true when the write has to be tried again: the cell is being sampled
  // right now, and the sample would land on top of it.
  patchBrick(level: number, bx: number, by: number, bz: number, words: Uint32Array | null, at: number): boolean {
    if (!this.map.inLevel(level, bx, by, bz)) return false; // outside the window: nothing to do
    const cell = this.map.cellOf(level, bx, by, bz);
    if (this.map.pending[cell] === 1) return true;
    let slot = entrySlot(this.map.entries[cell]);
    if (words === null) {
      if (slot >= 0) this.map.pool.give(slot);
      this.map.entries[cell] = 0;
      this.entry[0] = 0;
    } else {
      if (slot < 0) {
        const taken = this.map.pool.take(this.slotScratch, 0, 1);
        if (taken === 0) {
          this.map.dropped++;
          return false; // the pool is full; retrying would not help
        }
        slot = this.slotScratch[0];
      }
      this.map.entries[cell] = slot + 1;
      this.entry[0] = slot + 1;
      this.device.queue.writeBuffer(this.brickBuffer, slot * BRICK_WORDS * 4, words, at, BRICK_WORDS);
      this.uploadBytes += BRICK_WORDS * 4;
    }
    this.device.queue.writeBuffer(this.indirectionBuffer, cell * 4, this.entry);
    this.uploadBytes += 4;
    this.stats.patched++;
    this.stats.bricks = this.map.pool.used;
    // Everything above this brick is built from it, so it has to follow.
    this.map.queueCoarse(level, bx, by, bz);
    return false;
  }

  // Draws the marched color where the near field left the depth cleared.
  blit(pass: GPURenderPassEncoder): void {
    if (!this.ready) return;
    pass.setPipeline(this.blitPipeline!);
    pass.setBindGroup(0, this.blitBindGroup!);
    pass.draw(3);
  }

  // Reads the clipmap back for `?farCheck`. Awaited outside the frame path only.
  async readBack(): Promise<{ indirection: Uint32Array; bricks: Uint32Array }> {
    const device = this.device;
    const indirectionBytes = this.map.cells * this.map.levelCapacity * 4;
    const brickBytes = this.map.pool.capacity * BRICK_WORDS * 4;
    const read = device.createBuffer({
      label: "far readback",
      size: indirectionBytes + brickBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder({ label: "far readback" });
    encoder.copyBufferToBuffer(this.indirectionBuffer, 0, read, 0, indirectionBytes);
    encoder.copyBufferToBuffer(this.brickBuffer, 0, read, indirectionBytes, brickBytes);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const all = new Uint32Array(read.getMappedRange()).slice();
    read.unmap();
    read.destroy();
    return { indirection: all.subarray(0, indirectionBytes / 4), bricks: all.subarray(indirectionBytes / 4) };
  }

  destroy(): void {
    this.target?.destroy();
    this.beamTarget?.destroy();
  }

  // The copy of the report is encoded into this frame's encoder; the map that reads
  // it happens on a later frame (collect), never in the frame that encodes the copy
  // (gotchas.md "Mapping a readback buffer in the frame that encodes the copy").
  private dynamicOffset(ring: number): number[] {
    this.offsets[0] = ring * BUILD_PARAMS_STRIDE;
    return this.offsets;
  }

  private writeBuildParams(slab: Slab, ring: number, slots: number): void {
    const map = this.map;
    for (let a = 0; a < 3; a++) this.buildI32[a] = map.origins[slab.level * 3 + a];
    this.buildI32[3] = slab.level;
    this.buildI32[4] = slab.axis;
    this.buildI32[5] = slab.plane;
    this.buildI32[6] = ring;
    this.buildI32[7] = slots;
    this.buildU32[8] = map.options.size;
    this.buildU32[9] = map.cellVoxels(slab.level);
    this.buildU32[10] = map.brickVoxels(slab.level);
    this.buildU32[11] = this.world.seed >>> 0;
    const brushes = this.brushes;
    for (let a = 0; a < 3; a++) this.buildI32[12 + a] = brushes === null ? 1 << 20 : brushes.origin[a];
    this.device.queue.writeBuffer(this.buildParamsBuffer, ring * BUILD_PARAMS_STRIDE, this.buildParams);
    this.uploadBytes += BUILD_PARAMS_BYTES;
  }

  private freeSlot(): RingSlot | null {
    for (const slot of this.ring) if (slot.state === SLOT_FREE) return slot;
    return null;
  }

  private inFlight(): number {
    let n = 0;
    for (const slot of this.ring) if (slot.state !== SLOT_FREE) n++;
    return n;
  }

  // Maps the reports whose copy was submitted, and applies the ones that arrived.
  // Never awaited in the frame path (CLAUDE.md "Invariants").
  private collect(): void {
    for (const slot of this.ring) {
      if (slot.state !== SLOT_ENCODED) continue;
      slot.state = SLOT_MAPPING;
      slot.read.mapAsync(GPUMapMode.READ).then(() => {
        const entries = new Uint32Array(slot.read.getMappedRange());
        let dropped = 0;
        for (let i = 0; i < entries.length; i++) {
          if (entries[i] === DROPPED) {
            entries[i] = 0;
            dropped++;
          }
        }
        const used = this.map.applyReport(slot.slab, entries, dropped);
        slot.read.unmap();
        this.map.pool.giveRange(slot.slots, used, slot.taken);
        slot.state = SLOT_FREE;
        this.stats.slabs++;
        this.stats.dropped = this.map.dropped;
        this.stats.bricks = this.map.pool.used;
        this.stats.poolBytes = this.map.pool.used * BRICK_WORDS * 4;
        this.onSlabBuilt?.(slot.slab.level, slot.slab.axis, slot.slab.plane);
      }).catch(() => {
        slot.state = SLOT_FREE;
      });
    }
  }
}
