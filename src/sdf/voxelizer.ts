// GPU chunk voxelizer (plan-sdf-generation phase 2). Chunk coordinates are queued on
// the CPU; pump() dispatches batches while readback slots are free. Each batch
// voxelizes up to BATCH_SIZE chunks (voxelize.wgsl), compacts the dense ones, and
// copies headers and payloads to the slot's readback buffers. Results arrive frames
// later through two async maps: headers first (kinds), then only the dense payload
// prefix. Nothing in the frame path awaits a map.
//
// Output layout: agent_docs/design-formats.md "Voxelizer output".

import "../gpu/globals.ts";
import { type FieldBrushes, MAX_BRUSHES_PER_CHUNK, MAX_OP_WORDS_PER_CHUNK } from "../brush/batch.ts";
import { INSTANCE_WORDS } from "../brush/format.ts";
import { compileShader, type Report } from "../gpu/shader.ts";
import type { WorldProgram } from "../worlds/index.ts";
import { worldSources } from "./sources.ts";
import brushWgsl from "../brush/brush.wgsl" with { type: "text" };
import voxelizeWgsl from "./voxelize.wgsl" with { type: "text" };

export const BATCH_SIZE = 16; // chunks per dispatch
export const VOXELS_PER_CHUNK = 32768;
const CHUNK_BYTES = VOXELS_PER_CHUNK * 2; // u16 ids
const HEADER_BYTES = 16; // struct ChunkHeader
const DEFAULT_SLOTS = 8;
const MAX_CPU_POOL = 64; // pooled id arrays kept for reuse

export const CHUNK_AIR = 0;
export const CHUNK_UNIFORM = 1; // one block id fills the chunk
export const CHUNK_DENSE = 2;
export type ChunkKind = typeof CHUNK_AIR | typeof CHUNK_UNIFORM | typeof CHUNK_DENSE;

// Mirrors is_dense() in voxelize.wgsl.
export function chunkKind(solid: number, minId: number, maxId: number): ChunkKind {
  if (solid === 0) return CHUNK_AIR;
  return solid === VOXELS_PER_CHUNK && minId === maxId ? CHUNK_UNIFORM : CHUNK_DENSE;
}

export interface VoxelResult {
  cx: number;
  cy: number;
  cz: number;
  kind: ChunkKind;
  blockId: number; // CHUNK_UNIFORM: the id; otherwise 0
  ids: Uint16Array | null; // CHUNK_DENSE: 32768 ids in voxel order, pooled (recycle it)
}

export interface VoxelizerStats {
  queued: number;
  inFlight: number;
  batches: number;
  chunks: number;
  air: number;
  uniform: number;
  dense: number;
  mappedBytes: number;
  brushes: number; // field brush instances in the last batch
  brushesDropped: number; // instances left out for lack of room, total
  latencyMs: number; // last batch, dispatch to delivery
}

const SLOT_FREE = 0;
const SLOT_HEADERS = 1; // submitted, header map pending
const SLOT_PAYLOAD = 2; // payload map pending

interface Slot {
  readonly headerRead: GPUBuffer;
  readonly payloadRead: GPUBuffer;
  readonly coords: Int32Array; // BATCH_SIZE * 3
  state: number;
  count: number;
  submittedAt: number;
  readonly kinds: Uint8Array;
  readonly uniformIds: Uint32Array;
  denseCount: number;
  readonly onHeaders: () => void;
  readonly onPayload: () => void;
  readonly onFailed: () => void;
}

export class Voxelizer {
  onResult: (result: VoxelResult) => void = () => {};
  readonly stats: VoxelizerStats = {
    queued: 0,
    inFlight: 0,
    batches: 0,
    chunks: 0,
    air: 0,
    uniform: 0,
    dense: 0,
    mappedBytes: 0,
    brushes: 0,
    brushesDropped: 0,
    latencyMs: 0,
  };

  private readonly device: GPUDevice;
  private readonly world: WorldProgram;
  private readonly report: Report;
  private readonly skip: boolean;
  private voxelizePipeline: GPUComputePipeline | null = null;
  private compactPipeline: GPUComputePipeline | null = null;
  private readonly layout: GPUBindGroupLayout;
  private readonly bindGroup: GPUBindGroup;
  private readonly paramsBuffer: GPUBuffer;
  private readonly chunksBuffer: GPUBuffer;
  private readonly headersBuffer: GPUBuffer;
  private readonly idsBuffer: GPUBuffer;
  private readonly compactBuffer: GPUBuffer;
  private readonly slots: Slot[] = [];
  // CPU queue of chunk coordinates, FIFO, grown as needed.
  private queue = new Int32Array(3 * 1024);
  private queueHead = 0;
  private queueTail = 0;
  // Chunks asked for again because what generates them changed. Drained before the
  // streaming queue: a regeneration is something already on screen being wrong, and
  // waiting behind a streaming backlog shows up directly as edit latency.
  private priority = new Int32Array(3 * 64);
  private priorityHead = 0;
  private priorityTail = 0;
  private readonly params = new Uint32Array(4);
  private readonly chunkUpload = new Int32Array(BATCH_SIZE * 4);
  private readonly headerInit = new Uint32Array(BATCH_SIZE * 4);
  private readonly pool: Uint16Array[] = [];
  // Field brushes for the batch being dispatched (plan-world-modelling phase 5).
  // Null means no brush store is attached and every range is empty.
  fieldBrushes: FieldBrushes | null = null;
  private readonly brushRecordsBuffer: GPUBuffer;
  private readonly brushOpsBuffer: GPUBuffer;
  private readonly brushRangesBuffer: GPUBuffer;
  private readonly brushRecords = new Uint32Array(BATCH_SIZE * MAX_BRUSHES_PER_CHUNK * INSTANCE_WORDS);
  private readonly brushOps = new Uint32Array(BATCH_SIZE * MAX_OP_WORDS_PER_CHUNK);
  private readonly brushRanges = new Uint32Array(BATCH_SIZE * 4);

  // `skip: false` evaluates every voxel (tests compare it with the skipping path).
  constructor(device: GPUDevice, world: WorldProgram, report: Report, options: { slots?: number; skip?: boolean } = {}) {
    this.device = device;
    this.world = world;
    this.report = report;
    this.skip = options.skip ?? true;
    const storage = GPUBufferUsage.STORAGE;
    this.paramsBuffer = device.createBuffer({
      label: "voxelize params",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.chunksBuffer = device.createBuffer({
      label: "voxelize chunks",
      size: BATCH_SIZE * 16,
      usage: storage | GPUBufferUsage.COPY_DST,
    });
    this.headersBuffer = device.createBuffer({
      label: "voxelize headers",
      size: BATCH_SIZE * HEADER_BYTES,
      usage: storage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.idsBuffer = device.createBuffer({ label: "voxelize ids", size: BATCH_SIZE * CHUNK_BYTES, usage: storage });
    this.compactBuffer = device.createBuffer({
      label: "voxelize compact",
      size: BATCH_SIZE * CHUNK_BYTES,
      usage: storage | GPUBufferUsage.COPY_SRC,
    });
    this.brushRecordsBuffer = device.createBuffer({
      label: "voxelize brush records",
      size: this.brushRecords.byteLength,
      usage: storage | GPUBufferUsage.COPY_DST,
    });
    this.brushOpsBuffer = device.createBuffer({
      label: "voxelize brush ops",
      size: this.brushOps.byteLength,
      usage: storage | GPUBufferUsage.COPY_DST,
    });
    this.brushRangesBuffer = device.createBuffer({
      label: "voxelize brush ranges",
      size: this.brushRanges.byteLength,
      usage: storage | GPUBufferUsage.COPY_DST,
    });
    const compute = GPUShaderStage.COMPUTE;
    this.layout = device.createBindGroupLayout({
      label: "voxelize",
      entries: [
        { binding: 0, visibility: compute, buffer: { type: "uniform" } },
        { binding: 1, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: compute, buffer: { type: "storage" } },
        { binding: 3, visibility: compute, buffer: { type: "storage" } },
        { binding: 4, visibility: compute, buffer: { type: "storage" } },
        { binding: 5, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 7, visibility: compute, buffer: { type: "read-only-storage" } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      label: "voxelize",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.chunksBuffer } },
        { binding: 2, resource: { buffer: this.headersBuffer } },
        { binding: 3, resource: { buffer: this.idsBuffer } },
        { binding: 4, resource: { buffer: this.compactBuffer } },
        { binding: 5, resource: { buffer: this.brushRecordsBuffer } },
        { binding: 6, resource: { buffer: this.brushOpsBuffer } },
        { binding: 7, resource: { buffer: this.brushRangesBuffer } },
      ],
    });
    for (let i = 0; i < BATCH_SIZE; i++) this.headerInit[i * 4 + 1] = 0xFFFFFFFF;

    const slotCount = options.slots ?? DEFAULT_SLOTS;
    for (let i = 0; i < slotCount; i++) {
      const slot: Slot = {
        headerRead: device.createBuffer({
          label: `voxelize headers read ${i}`,
          size: BATCH_SIZE * HEADER_BYTES,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        payloadRead: device.createBuffer({
          label: `voxelize payload read ${i}`,
          size: BATCH_SIZE * CHUNK_BYTES,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        coords: new Int32Array(BATCH_SIZE * 3),
        state: SLOT_FREE,
        count: 0,
        submittedAt: 0,
        kinds: new Uint8Array(BATCH_SIZE),
        uniformIds: new Uint32Array(BATCH_SIZE),
        denseCount: 0,
        onHeaders: () => this.readHeaders(slot),
        onPayload: () => this.readPayload(slot),
        onFailed: () => this.failSlot(slot),
      };
      this.slots.push(slot);
    }
  }

  async init(): Promise<boolean> {
    const module = await compileShader(this.device, `voxelize (${this.world.name})`, [
      ...worldSources(this.world),
      { name: "brush/brush.wgsl", code: brushWgsl },
      { name: "sdf/voxelize.wgsl", code: voxelizeWgsl },
    ], this.report);
    if (!module) return false;
    const layout = this.device.createPipelineLayout({ label: "voxelize", bindGroupLayouts: [this.layout] });
    try {
      [this.voxelizePipeline, this.compactPipeline] = await Promise.all([
        this.device.createComputePipelineAsync({
          label: "voxelize",
          layout,
          compute: { module, entryPoint: "voxelize" },
        }),
        this.device.createComputePipelineAsync({
          label: "voxelize compact",
          layout,
          compute: { module, entryPoint: "compact_dense" },
        }),
      ]);
    } catch (err) {
      this.report(`voxelize pipeline: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    return true;
  }

  queueChunk(cx: number, cy: number, cz: number, priority = false): void {
    if (priority) {
      if (this.priorityTail + 3 > this.priority.length) this.priority = this.growRing(this.priority, true);
      this.priority[this.priorityTail++] = cx;
      this.priority[this.priorityTail++] = cy;
      this.priority[this.priorityTail++] = cz;
      this.stats.queued = this.queuedChunks;
      return;
    }
    if (this.queueTail + 3 > this.queue.length) this.queue = this.growRing(this.queue, false);
    this.queue[this.queueTail++] = cx;
    this.queue[this.queueTail++] = cy;
    this.queue[this.queueTail++] = cz;
    this.stats.queued = this.queuedChunks;
  }

  // Dispatches up to `maxBatches` batches into free slots. Returns batches dispatched.
  pump(maxBatches: number): number {
    if (!this.voxelizePipeline || !this.compactPipeline) return 0;
    let dispatched = 0;
    for (const slot of this.slots) {
      if (dispatched >= maxBatches || this.queuedChunks === 0) break;
      if (slot.state !== SLOT_FREE) continue;
      this.dispatch(slot);
      dispatched++;
    }
    this.stats.queued = this.queuedChunks;
    return dispatched;
  }

  // Chunks waiting in either queue.
  private get queuedChunks(): number {
    return (this.priorityTail - this.priorityHead + this.queueTail - this.queueHead) / 3;
  }

  // Returns a dense result's ids array for reuse.
  recycle(ids: Uint16Array): void {
    if (this.pool.length < MAX_CPU_POOL) this.pool.push(ids);
  }

  get idle(): boolean {
    return this.queuedChunks === 0 && this.stats.inFlight === 0;
  }

  private growRing(ring: Int32Array, priority: boolean): Int32Array<ArrayBuffer> {
    const head = priority ? this.priorityHead : this.queueHead;
    const tail = priority ? this.priorityTail : this.queueTail;
    const live = ring.subarray(head, tail);
    const next = new Int32Array(Math.max(ring.length * 2, live.length + 3)) as Int32Array<ArrayBuffer>;
    next.set(live);
    if (priority) {
      this.priorityTail = tail - head;
      this.priorityHead = 0;
    } else {
      this.queueTail = tail - head;
      this.queueHead = 0;
    }
    return next;
  }

  // Pops the next queued chunk into out[at..at+2], priority queue first.
  private popQueued(out: Int32Array, at: number): void {
    if (this.priorityHead !== this.priorityTail) {
      for (let i = 0; i < 3; i++) out[at + i] = this.priority[this.priorityHead++];
      if (this.priorityHead === this.priorityTail) this.priorityHead = this.priorityTail = 0;
      return;
    }
    for (let i = 0; i < 3; i++) out[at + i] = this.queue[this.queueHead++];
    if (this.queueHead === this.queueTail) this.queueHead = this.queueTail = 0;
  }

  private dispatch(slot: Slot): void {
    const device = this.device;
    const n = Math.min(BATCH_SIZE, this.queuedChunks);
    for (let i = 0; i < n; i++) {
      this.popQueued(slot.coords, i * 3);
      this.chunkUpload[i * 4] = slot.coords[i * 3];
      this.chunkUpload[i * 4 + 1] = slot.coords[i * 3 + 1];
      this.chunkUpload[i * 4 + 2] = slot.coords[i * 3 + 2];
    }
    slot.count = n;

    // Field brushes for these chunks, and their per-chunk runs. Uploaded even when
    // empty: the shader reads a range per chunk whatever the world holds.
    const records = this.fieldBrushes === null
      ? (this.brushRanges.fill(0), 0)
      : this.fieldBrushes.pack(slot.coords, n, this.brushRecords, this.brushOps, this.brushRanges);
    device.queue.writeBuffer(this.brushRangesBuffer, 0, this.brushRanges, 0, n * 4);
    if (records > 0) {
      device.queue.writeBuffer(this.brushRecordsBuffer, 0, this.brushRecords, 0, records * INSTANCE_WORDS);
      const words = this.fieldBrushes!.opWords;
      if (words > 0) device.queue.writeBuffer(this.brushOpsBuffer, 0, this.brushOps, 0, words);
    }
    this.stats.brushes = records;
    this.stats.brushesDropped = this.fieldBrushes?.dropped ?? 0;

    this.params[0] = this.world.seed >>> 0;
    this.params[1] = n;
    this.params[2] = this.skip ? 1 : 0;
    device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
    device.queue.writeBuffer(this.chunksBuffer, 0, this.chunkUpload, 0, n * 4);
    device.queue.writeBuffer(this.headersBuffer, 0, this.headerInit, 0, n * 4);

    const encoder = device.createCommandEncoder({ label: "voxelize" });
    const pass = encoder.beginComputePass({ label: "voxelize" });
    pass.setBindGroup(0, this.bindGroup);
    pass.setPipeline(this.voxelizePipeline!);
    pass.dispatchWorkgroups(64, n);
    pass.setPipeline(this.compactPipeline!);
    pass.dispatchWorkgroups(n);
    pass.end();
    encoder.copyBufferToBuffer(this.headersBuffer, 0, slot.headerRead, 0, n * HEADER_BYTES);
    encoder.copyBufferToBuffer(this.compactBuffer, 0, slot.payloadRead, 0, n * CHUNK_BYTES);
    device.queue.submit([encoder.finish()]);

    slot.state = SLOT_HEADERS;
    slot.submittedAt = performance.now();
    this.stats.inFlight++;
    this.stats.batches++;
    slot.headerRead.mapAsync(GPUMapMode.READ, 0, n * HEADER_BYTES).then(slot.onHeaders, slot.onFailed);
  }

  private readHeaders(slot: Slot): void {
    const h = new Uint32Array(slot.headerRead.getMappedRange(0, slot.count * HEADER_BYTES));
    let dense = 0;
    for (let i = 0; i < slot.count; i++) {
      const kind = chunkKind(h[i * 4], h[i * 4 + 1], h[i * 4 + 2]);
      slot.kinds[i] = kind;
      slot.uniformIds[i] = kind === CHUNK_UNIFORM ? h[i * 4 + 1] : 0;
      if (kind === CHUNK_DENSE) dense++;
    }
    slot.headerRead.unmap();
    this.stats.mappedBytes += slot.count * HEADER_BYTES;
    slot.denseCount = dense;
    if (dense === 0) {
      this.deliver(slot, null);
      this.release(slot);
      return;
    }
    slot.state = SLOT_PAYLOAD;
    slot.payloadRead.mapAsync(GPUMapMode.READ, 0, dense * CHUNK_BYTES).then(slot.onPayload, slot.onFailed);
  }

  private readPayload(slot: Slot): void {
    const bytes = slot.denseCount * CHUNK_BYTES;
    const payload = new Uint16Array(slot.payloadRead.getMappedRange(0, bytes));
    this.deliver(slot, payload);
    slot.payloadRead.unmap();
    this.stats.mappedBytes += bytes;
    this.release(slot);
  }

  // Emits one result per chunk in batch order; dense payloads are copied out of the
  // mapped range (which detaches on unmap) into pooled arrays.
  private deliver(slot: Slot, payload: Uint16Array | null): void {
    const stats = this.stats;
    let rank = 0;
    for (let i = 0; i < slot.count; i++) {
      const kind = slot.kinds[i] as ChunkKind;
      let ids: Uint16Array | null = null;
      if (kind === CHUNK_DENSE && payload) {
        ids = this.pool.pop() ?? new Uint16Array(VOXELS_PER_CHUNK);
        ids.set(payload.subarray(rank * VOXELS_PER_CHUNK, (rank + 1) * VOXELS_PER_CHUNK));
        rank++;
        stats.dense++;
      } else if (kind === CHUNK_UNIFORM) {
        stats.uniform++;
      } else {
        stats.air++;
      }
      stats.chunks++;
      this.onResult({
        cx: slot.coords[i * 3],
        cy: slot.coords[i * 3 + 1],
        cz: slot.coords[i * 3 + 2],
        kind,
        blockId: slot.uniformIds[i],
        ids,
      });
    }
    stats.latencyMs = performance.now() - slot.submittedAt;
  }

  // Frees a slot and refills it right away instead of waiting for the next frame's
  // pump(): with a busy GPU a batch takes several frames, and throughput is slots
  // per latency. Call only after both of the slot's readback buffers are unmapped:
  // the refill submits copies into them, and submitting a mapped buffer is a
  // validation error that leaves stale data to be read back as the next result.
  private release(slot: Slot): void {
    this.stats.inFlight--;
    slot.state = SLOT_FREE;
    this.pump(1);
  }

  private failSlot(slot: Slot): void {
    // Device lost or destroyed: the batch is gone. The owner rebuilds everything.
    if (slot.state !== SLOT_FREE) this.stats.inFlight--;
    slot.state = SLOT_FREE;
  }
}
