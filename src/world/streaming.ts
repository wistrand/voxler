// Chunk streaming (plan-sdf-generation phase 3, first part of plan-voxel-data
// phase 4): keeps chunks near the camera resident in the ChunkStore.
//
// Each frame, update():
// - requests missing chunks nearest-first by walking offsets presorted by distance,
//   but only keeps the voxel source's queue about two batches deep, so a moving
//   camera never waits behind a backlog of stale far requests;
// - evicts chunks outside radius + hysteresis with a bounded sweep;
// - counts holes: chunks within the inner radius that should be resident but
//   aren't (the "streaming keeps up" metric);
// - submits regeneration requests (plan-world-modelling phase 2): chunks whose
//   generated content changed, asked for again through the same voxel source. A
//   chunk being regenerated stays resident with its old data until the new payload
//   arrives, so nothing disappears meanwhile, and repeat requests coalesce.
// Results arrive through onVoxelResult (air and uniform go straight to the store;
// dense go to the compressor) and onCompressed. Results for chunks that fell out
// of range meanwhile are dropped. Work per frame is bounded by the scan and sweep
// budgets, not by the resident count.

import { ChunkTable } from "./chunk-table.ts";
import { CHUNK_VOLUME } from "./coords.ts";
import { chunkInRange, chunkKey, keyX, keyY, keyZ } from "./keys.ts";
import type { ChunkStore } from "./store.ts";

// Chunk results from the voxelizer, reduced to what streaming needs.
export interface VoxelSource {
  // `priority` jumps the streaming backlog; regeneration sets it.
  queueChunk(cx: number, cy: number, cz: number, priority?: boolean): void;
  readonly queuedCount: number;
  recycle(ids: Uint16Array): void;
}

// Compresses dense ids off the main thread, running the voxel stage first when the
// chunk has ops; answers with streamer.onCompressed(). `ids` is null for a chunk the
// voxelizer found uniform, and `uniformId` is then the id to materialize.
export interface Compressor {
  compress(key: number, ids: Uint16Array | null, uniformId: number, ops: ArrayBuffer | null): void;
}

// The voxel stage: ordered voxel writes replayed onto a freshly generated chunk
// (src/brush/voxel-ops.ts). Null when nothing edits the world.
export interface VoxelStage {
  // Packed ops for a chunk, or null when it has none. Transferred to the worker.
  opsFor(key: number): ArrayBuffer | null;
  // Whether a chunk has ops at all, asked before a uniform result is stored as it is.
  has(key: number): boolean;
}

// Told when streaming stores or evicts a chunk (the mesh scheduler).
export interface StoreListener {
  // `urgent` marks a chunk that replaced one already on screen (a regeneration),
  // which is worth meshing a frame sooner than the queue would.
  stored(key: number, urgent: boolean): void;
  evicted(key: number): void;
}

export interface StreamOptions {
  radius: number; // horizontal, chunks (circle)
  height: number; // vertical, chunks each way from the camera chunk
  hysteresis: number; // extra chunks kept before eviction
  innerRadius: number; // holes are counted inside this (horizontal), and |dy| <= 1
  queueTarget: number; // keep the voxel source's queue at most this deep
  scanPerFrame: number; // offsets examined per frame at most
  sweepPerFrame: number; // resident chunks checked for eviction per frame
  regenPerFrame: number; // regeneration requests submitted per frame at most
}

export const DEFAULT_STREAM_OPTIONS: StreamOptions = {
  radius: 16,
  height: 6,
  hysteresis: 2,
  innerRadius: 4,
  queueTarget: 128, // 8 batches: enough for the voxelizer to refill slots between frames
  scanPerFrame: 4096,
  sweepPerFrame: 1024,
  regenPerFrame: 8,
};

// Chunk kinds as delivered by the voxel source (same values as CHUNK_AIR,
// CHUNK_UNIFORM, CHUNK_DENSE in src/sdf/voxelizer.ts).
export const KIND_AIR = 0;
export const KIND_UNIFORM = 1;
export const KIND_DENSE = 2;

const REQUESTED = 1; // queued in or voxelizing on the source
const COMPRESSING = 2; // dense ids at the compressor

// Regeneration state per chunk.
const REGEN_QUEUED = 1; // in regenKeys, waiting to be submitted
const REGEN_WAITING = 2; // a result is in flight; queue it again once that settles

// Entries scanned when picking the nearest chunk to regenerate. Bounds the work per
// submission; the cursor rotates, so nothing starves.
const REGEN_SCAN = 512;

export interface StreamStats {
  resident: number;
  requested: number; // in flight at the source
  compressing: number;
  holes: number;
  loaded: number; // chunks stored, total
  evicted: number;
  dropped: number; // results discarded as out of range
  storeFull: number; // stores that failed for lack of slots or arena
  regenQueued: number; // entries in the regeneration queue, stale ones included
  regenerated: number; // regeneration requests submitted, total
  regenReplaced: number; // results that replaced a resident chunk, total
  regenDiffer: number; // replacements whose voxels changed (checkRegen only)
}

// Offsets (dx, dy, dz) within the load range, sorted nearest first.
export function streamOffsets(radius: number, height: number): Int32Array {
  const list: [number, number, number, number][] = [];
  for (let dy = -height; dy <= height; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > radius * radius) continue;
        list.push([dx, dy, dz, dx * dx + dy * dy + dz * dz]);
      }
    }
  }
  list.sort((a, b) => a[3] - b[3]);
  const out = new Int32Array(list.length * 3);
  list.forEach(([dx, dy, dz], i) => out.set([dx, dy, dz], i * 3));
  return out;
}

export class ChunkStreamer {
  readonly stats: StreamStats = {
    resident: 0,
    requested: 0,
    compressing: 0,
    holes: 0,
    loaded: 0,
    evicted: 0,
    dropped: 0,
    storeFull: 0,
    regenQueued: 0,
    regenerated: 0,
    regenReplaced: 0,
    regenDiffer: 0,
  };
  // Compares a regenerated chunk against the one it replaces and counts the
  // differences (`?regenCheck`). Debug only: it copies 32768 ids per replacement.
  checkRegen = false;
  listener: StoreListener | null = null;
  voxelStage: VoxelStage | null = null;
  private readonly store: ChunkStore;
  private readonly options: StreamOptions;
  private readonly offsets: Int32Array;
  private readonly innerCount: number; // leading offsets inside the hole radius
  private readonly pending: ChunkTable; // key -> REQUESTED | COMPRESSING
  private readonly residentIndex: ChunkTable; // key -> index into residentKeys
  private readonly residentKeys: Float64Array;
  private source: VoxelSource | null = null;
  private compressor: Compressor | null = null;
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private started = false;
  private cursor = 0;
  private sweep = 0;
  private readonly regenIndex: ChunkTable; // key -> REGEN_QUEUED | REGEN_WAITING
  private regenKeys = new Float64Array(1024);
  private regenCount = 0;
  private regenCursor = 0;
  private regenScratch: Uint16Array | null = null;

  constructor(store: ChunkStore, options: StreamOptions = DEFAULT_STREAM_OPTIONS) {
    this.store = store;
    this.options = options;
    this.offsets = streamOffsets(options.radius, options.height);
    let inner = 0;
    const r2 = options.innerRadius * options.innerRadius;
    for (let i = 0; i < this.offsets.length; i += 3) {
      const dx = this.offsets[i], dy = this.offsets[i + 1], dz = this.offsets[i + 2];
      if (dx * dx + dz * dz <= r2 && Math.abs(dy) <= 1) inner++;
    }
    this.innerCount = inner; // interleaved with other offsets; countHoles() scans for them
    const keep = ChunkStreamer.keepCapacity(options);
    this.pending = new ChunkTable(keep);
    this.regenIndex = new ChunkTable(1024);
    this.residentIndex = new ChunkTable(keep);
    // Sized to the store: eviction lags camera movement, so resident chunks can
    // briefly exceed the keep range, but never the store's slot count.
    this.residentKeys = new Float64Array(store.capacity);
  }

  // Chunks that can be resident at once: the load range plus hysteresis.
  static keepCapacity(o: StreamOptions): number {
    const r = o.radius + o.hysteresis;
    return (2 * r + 1) * (2 * r + 1) * (2 * (o.height + o.hysteresis) + 1);
  }

  // Connects a (new) voxel source, e.g. after device loss rebuilt the voxelizer.
  // Requests in flight at the old source are forgotten and asked for again.
  attach(source: VoxelSource, compressor: Compressor): void {
    this.source = source;
    this.compressor = compressor;
    const stale: number[] = [];
    this.pending.forEach((key, state) => {
      if (state === REQUESTED) stale.push(key);
    });
    for (const key of stale) this.pending.delete(key);
    this.stats.requested = 0;
    this.cursor = 0;
    // A regeneration in flight at the old source is lost, and request() will not ask
    // again because the chunk is still resident. Queue those, and any chunk waiting
    // on a result that will never arrive, so no edit is silently dropped.
    for (const key of stale) {
      if (this.store.hasKey(key)) this.regenerate(key);
    }
    const waiting: number[] = [];
    this.regenIndex.forEach((key, state) => {
      if (state === REGEN_WAITING) waiting.push(key);
    });
    for (const key of waiting) {
      this.regenIndex.set(key, REGEN_QUEUED);
      this.pushRegen(key);
    }
  }

  update(cx: number, cy: number, cz: number): void {
    if (!this.started || cx !== this.cx || cy !== this.cy || cz !== this.cz) {
      this.cx = cx;
      this.cy = cy;
      this.cz = cz;
      this.started = true;
      this.cursor = 0; // rescan from the nearest offset
    }
    this.request();
    this.regenerateSome();
    this.evictSome();
    this.countHoles();
  }

  // Resident chunk count and the key at an index, for callers that want to pick
  // chunks to regenerate (the `?regen` soak switch).
  get residentCount(): number {
    return this.stats.resident;
  }

  residentKeyAt(i: number): number {
    return this.residentKeys[i];
  }

  // Asks for a chunk to be voxelized again, because what generates it changed. The
  // chunk keeps its current data until the new payload arrives. Repeat calls for one
  // chunk coalesce, and a call for a chunk that is neither resident nor in flight is
  // ignored: it will be generated from the current state when it streams in.
  regenerate(key: number): void {
    if (this.regenIndex.get(key) !== -1) return;
    if (!this.store.hasKey(key) && this.pending.get(key) === -1) return;
    this.regenIndex.set(key, REGEN_QUEUED);
    this.pushRegen(key);
  }

  // Asks for a run of keys, e.g. the chunks a brush edit dirtied.
  regenerateKeys(keys: ArrayLike<number>, count: number): void {
    for (let i = 0; i < count; i++) this.regenerate(keys[i]);
  }

  onVoxelResult(cx: number, cy: number, cz: number, kind: number, blockId: number, ids: Uint16Array | null): void {
    const key = chunkKey(cx, cy, cz);
    if (this.pending.get(key) !== REQUESTED) {
      if (ids) this.source?.recycle(ids);
      return;
    }
    this.pending.delete(key);
    this.stats.requested--;
    if (!this.inKeepRange(cx, cy, cz)) {
      this.stats.dropped++;
      if (ids) this.source?.recycle(ids);
      this.settled(key);
      return;
    }
    // A uniform or air chunk still goes through the compressor when edits touch it:
    // the voxel stage needs dense ids, and only the worker may build them.
    const dense = ids !== null && kind === KIND_DENSE;
    if (dense || (this.voxelStage !== null && this.voxelStage.has(key))) {
      this.pending.set(key, COMPRESSING);
      this.stats.compressing++;
      this.compressor!.compress(
        key,
        dense ? ids : null,
        kind === KIND_AIR ? 0 : blockId,
        this.voxelStage?.opsFor(key) ?? null,
      );
      if (!dense && ids) this.source?.recycle(ids);
      return;
    }
    const replacing = this.store.hasKey(key);
    const compare = replacing && this.checkRegen && this.snapshot(key);
    const handle = this.store.putUniform(key, kind === KIND_AIR ? 0 : blockId);
    this.finishPut(key, handle, replacing, compare);
  }

  // `block` holds the chunk in arena block layout (bytes long), or null with
  // `uniform` set when compression found a single id.
  onCompressed(key: number, uniform: number, block: ArrayBuffer | null, bytes: number): void {
    if (this.pending.get(key) !== COMPRESSING) return;
    this.pending.delete(key);
    this.stats.compressing--;
    if (!this.inKeepRange(keyX(key), keyY(key), keyZ(key))) {
      this.stats.dropped++;
      this.settled(key);
      return;
    }
    const replacing = this.store.hasKey(key);
    const compare = replacing && this.checkRegen && this.snapshot(key);
    const handle = block ? this.store.putBlock(key, block, bytes) : this.store.putUniform(key, uniform);
    this.finishPut(key, handle, replacing, compare);
  }

  private pushRegen(key: number): void {
    if (this.regenCount === this.regenKeys.length) {
      const grown = new Float64Array(this.regenKeys.length * 2);
      grown.set(this.regenKeys);
      this.regenKeys = grown;
    }
    this.regenKeys[this.regenCount++] = key;
    this.stats.regenQueued = this.regenCount;
  }

  // Submits regeneration requests, nearest first among the entries scanned. These go
  // to the source's priority lane and are not held back by the streaming queue
  // target: a regenerated chunk is already on screen with the wrong content, and
  // `regenPerFrame` is what bounds the work.
  private regenerateSome(): void {
    const source = this.source;
    if (!source) return;
    let submitted = 0;
    while (submitted < this.options.regenPerFrame && this.regenCount > 0) {
      const i = this.nearestRegen();
      const key = this.regenKeys[i];
      this.regenKeys[i] = this.regenKeys[--this.regenCount];
      if (this.regenIndex.get(key) !== REGEN_QUEUED) continue; // evicted, or a stale entry
      if (this.pending.get(key) !== -1) {
        this.regenIndex.set(key, REGEN_WAITING); // queued again when the result settles
        continue;
      }
      if (!this.store.hasKey(key)) {
        this.regenIndex.delete(key);
        continue;
      }
      this.regenIndex.delete(key);
      this.pending.set(key, REQUESTED);
      this.stats.requested++;
      this.stats.regenerated++;
      source.queueChunk(keyX(key), keyY(key), keyZ(key), true);
      submitted++;
    }
    this.stats.regenQueued = this.regenCount;
  }

  // Index of the nearest chunk among up to REGEN_SCAN entries from a rotating start.
  private nearestRegen(): number {
    const n = Math.min(REGEN_SCAN, this.regenCount);
    if (this.regenCursor >= this.regenCount) this.regenCursor = 0;
    let best = this.regenCursor;
    let bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const i = (this.regenCursor + k) % this.regenCount;
      const key = this.regenKeys[i];
      const dx = keyX(key) - this.cx, dy = keyY(key) - this.cy, dz = keyZ(key) - this.cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.regenCursor = best + 1;
    return best;
  }

  // A result for `key` reached its end, whatever happened to it: queue another
  // regeneration when one was asked for while this one was in flight.
  private settled(key: number): void {
    if (this.regenIndex.get(key) !== REGEN_WAITING) return;
    if (!this.store.hasKey(key)) {
      this.regenIndex.delete(key);
      return;
    }
    this.regenIndex.set(key, REGEN_QUEUED);
    this.pushRegen(key);
  }

  // Copies a resident chunk's voxels aside so the replacement can be compared.
  private snapshot(key: number): boolean {
    const chunk = this.store.read(this.store.handle(keyX(key), keyY(key), keyZ(key)));
    if (chunk === null) return false;
    if (this.regenScratch === null) this.regenScratch = new Uint16Array(CHUNK_VOLUME);
    const scratch = this.regenScratch;
    for (let i = 0; i < CHUNK_VOLUME; i++) scratch[i] = chunk.get(i);
    return true;
  }

  private compareSnapshot(key: number): void {
    const chunk = this.store.read(this.store.handle(keyX(key), keyY(key), keyZ(key)));
    const scratch = this.regenScratch;
    if (chunk === null || scratch === null) return;
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      if (chunk.get(i) !== scratch[i]) {
        this.stats.regenDiffer++;
        return;
      }
    }
  }

  // A payload has landed, whether it is a first load or a regeneration replacing an
  // existing chunk. The caller takes `replacing` and `compare` before it stores, and
  // never through a closure: this runs in the frame path (CLAUDE.md "Invariants").
  private finishPut(key: number, handle: number, replacing: boolean, compare: boolean): void {
    if (replacing && handle !== -1) {
      this.stats.regenReplaced++;
      if (compare) this.compareSnapshot(key);
    }
    this.stored(key, handle, replacing);
    this.settled(key);
  }

  private stored(key: number, handle: number, urgent = false): void {
    if (handle === -1) {
      this.stats.storeFull++;
      return;
    }
    if (this.residentIndex.get(key) === -1) {
      const i = this.stats.resident++;
      this.residentKeys[i] = key;
      this.residentIndex.set(key, i);
    }
    this.stats.loaded++;
    this.listener?.stored(key, urgent);
  }

  private request(): void {
    const source = this.source;
    if (!source) return;
    const o = this.offsets;
    let scanned = 0;
    while (
      this.cursor < o.length && scanned < this.options.scanPerFrame && source.queuedCount < this.options.queueTarget
    ) {
      const x = this.cx + o[this.cursor], y = this.cy + o[this.cursor + 1], z = this.cz + o[this.cursor + 2];
      this.cursor += 3;
      scanned++;
      if (!chunkInRange(x, y, z)) continue;
      const key = chunkKey(x, y, z);
      if (this.store.hasKey(key) || this.pending.get(key) !== -1) continue;
      this.pending.set(key, REQUESTED);
      this.stats.requested++;
      source.queueChunk(x, y, z);
    }
  }

  private evictSome(): void {
    for (let n = 0; n < this.options.sweepPerFrame && this.stats.resident > 0; n++) {
      if (this.sweep >= this.stats.resident) this.sweep = 0;
      const key = this.residentKeys[this.sweep];
      if (this.inKeepRange(keyX(key), keyY(key), keyZ(key))) {
        this.sweep++;
        continue;
      }
      this.store.removeKey(key);
      this.removeResident(key);
      // Its queue entry, if any, is dropped when popped: the state says it is gone.
      if (this.regenIndex.get(key) !== -1) this.regenIndex.delete(key);
      this.stats.evicted++;
      this.listener?.evicted(key);
      // The swapped-in key now sits at this.sweep; check it next.
    }
  }

  private removeResident(key: number): void {
    const i = this.residentIndex.get(key);
    if (i === -1) return;
    const last = --this.stats.resident;
    const moved = this.residentKeys[last];
    this.residentKeys[i] = moved;
    if (moved !== key) this.residentIndex.set(moved, i);
    this.residentIndex.delete(key);
  }

  private countHoles(): void {
    const o = this.offsets;
    const r2 = this.options.innerRadius * this.options.innerRadius;
    let holes = 0;
    let seen = 0;
    for (let i = 0; i < o.length && seen < this.innerCount; i += 3) {
      const dx = o[i], dy = o[i + 1], dz = o[i + 2];
      if (dx * dx + dz * dz > r2 || Math.abs(dy) > 1) continue;
      seen++;
      const x = this.cx + dx, y = this.cy + dy, z = this.cz + dz;
      if (chunkInRange(x, y, z) && !this.store.hasKey(chunkKey(x, y, z))) holes++;
    }
    this.stats.holes = holes;
  }

  private inKeepRange(x: number, y: number, z: number): boolean {
    const r = this.options.radius + this.options.hysteresis;
    const dx = x - this.cx, dz = z - this.cz;
    return dx * dx + dz * dz <= r * r && Math.abs(y - this.cy) <= this.options.height + this.options.hysteresis;
  }
}

