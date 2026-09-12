// Mesh scheduling (plan-meshing phase 6; plan-voxel-data phase 4 "neighbor
// readiness"): decides which stored chunks get meshed, builds "chunk.mesh" job
// inputs (src/mesh/job.ts), and applies results in version order. Main thread.
//
// Per chunk record: a data version (bumped by stored() and markDirty()), the version
// of the accepted mesh, and at most one outstanding job. Rules:
// - A chunk is meshed only when it and its neighbors are stored (or the neighbor is
//   outside the world): the six face neighbors, or all 26 when AO is baked, since
//   the AO shell reads the edge and corner ones too. Chunks on the edge of the load
//   range stay unmeshed; a neighbor arriving re-queues them.
// - One job per chunk at a time. A change while a job runs waits for it to settle,
//   then the chunk is submitted again at the new version. So rapid edits coalesce,
//   and a result older than the chunk's version is dropped (stale), never shown.
// - Chunks that can't have faces (uniform air; uniform opaque or translucent
//   surrounded by what hides it) get an empty mesh without a job.
// - Shared arena: workers read blocks in place, so the store defers frees
//   (store.ts) and this class hands out job stamps and reclaims retired blocks once
//   every job that might read them has settled. Copy path: the blocks are copied
//   into a pooled buffer per job; nothing to defer.
// Per-frame work is bounded by scanPerFrame and submitPerFrame, and the pool never
// holds more than maxOutstanding mesh jobs.

import { CLUSTER_QUADS, ORDER_EMISSION } from "../mesh/cluster.ts";
import { type MeshJobInput, type MeshJobOutput, REF_ALL, REF_BLOCK, REF_FACES, REF_MISSING } from "../mesh/job.ts";
import { ALL_NEIGHBORS, FACE_NEIGHBORS, NEIGHBOR_OFFSETS } from "../mesh/neighbors.ts";
import { FACE_COUNT } from "../mesh/quad.ts";
import { SETTLED_FAILED } from "../workers/pool.ts";
import { BLOCK_OPAQUE, BLOCK_TRANSLUCENT } from "./blocks.ts";
import { ChunkTable } from "./chunk-table.ts";
import { chunkInRange, chunkKey, keyX, keyY, keyZ } from "./keys.ts";
import type { ChunkStore } from "./store.ts";

export const MESH_JOB = "chunk.mesh";
// Id under which the shared arena is handed to the workers (WorkerPool.share()).
export const ARENA_SHARE_ID = 1;

// What the scheduler needs from WorkerPool.
export interface MeshJobPool {
  submit(
    kind: string,
    key: number,
    version: number,
    priority: number,
    input: unknown,
    transfer?: Transferable[] | null,
  ): void;
  cancel(kind: string, key: number): boolean;
  recycle(buffer: ArrayBuffer): void;
  share(id: number, buffer: SharedArrayBuffer): void;
}

export interface MeshSchedulerOptions {
  scanPerFrame: number; // dirty entries examined per frame at most
  submitPerFrame: number; // jobs submitted per frame at most
  maxOutstanding: number; // mesh jobs queued or running in the pool at most
  clusterQuads: number; // cluster size for every job (plan-rendering phase 1 sweep)
  clusterOrder: number; // quad order within a cluster (plan-rendering phase 4)
  ao: boolean; // bake AO into the meshes (?ao); costs the 20 extra neighbors
}

export const DEFAULT_MESH_OPTIONS: MeshSchedulerOptions = {
  scanPerFrame: 4096,
  submitPerFrame: 64,
  maxOutstanding: 48,
  clusterQuads: CLUSTER_QUADS,
  clusterOrder: ORDER_EMISSION,
  ao: true,
};

export interface MeshStats {
  meshes: number; // chunks with a non-empty accepted mesh
  empty: number; // accepted empty meshes, total (with or without a job)
  submitted: number; // jobs, total
  accepted: number; // results applied, total
  stale: number; // results dropped for an older version
  failed: number;
  dirty: number; // entries in the dirty queue
  outstanding: number; // jobs in the pool
  quads: number; // opaque quads in accepted meshes
  translucentQuads: number;
  clusters: number;
  bytes: number; // mesh output bytes held for accepted meshes
  latencyMs: number; // submit to result, moving average
}

// Record flags.
const QUEUED = 1; // in the dirty queue
const EVICTED = 2; // chunk gone; the record waits for its job to settle

// Key of neighbor i (neighbors.ts order; i < FACE_NEIGHBORS is face i).
function neighborKey(key: number, i: number): number {
  const o = i * 3;
  return chunkKey(
    keyX(key) + NEIGHBOR_OFFSETS[o],
    keyY(key) + NEIGHBOR_OFFSETS[o + 1],
    keyZ(key) + NEIGHBOR_OFFSETS[o + 2],
  );
}

function neighborInWorld(key: number, i: number): boolean {
  const o = i * 3;
  return chunkInRange(
    keyX(key) + NEIGHBOR_OFFSETS[o],
    keyY(key) + NEIGHBOR_OFFSETS[o + 1],
    keyZ(key) + NEIGHBOR_OFFSETS[o + 2],
  );
}

export class MeshScheduler {
  readonly stats: MeshStats = {
    meshes: 0,
    empty: 0,
    submitted: 0,
    accepted: 0,
    stale: 0,
    failed: 0,
    dirty: 0,
    outstanding: 0,
    quads: 0,
    translucentQuads: 0,
    clusters: 0,
    bytes: 0,
    latencyMs: 0,
  };
  // Takes an accepted non-empty mesh; return true to keep output.mesh (and recycle
  // it through the pool later), false to let the scheduler recycle it now. The
  // renderer sets this (plan-rendering phase 2).
  onMesh: ((key: number, output: MeshJobOutput) => boolean) | null = null;
  // Told when a chunk starts or stops being one the near field draws: a mesh was
  // accepted, the chunk turned out to have no faces, or it was evicted. The far field
  // uses it to stay out of the near field's way (src/far/coverage.ts).
  onCoverage: ((key: number, covered: boolean) => void) | null = null;
  // A chunk's accepted mesh is gone (evicted, or replaced by an empty one).
  onUnmesh: ((key: number) => void) | null = null;

  private readonly store: ChunkStore;
  private readonly pool: MeshJobPool;
  private readonly options: MeshSchedulerOptions;
  private readonly shared: boolean;
  private readonly neighborCount: number; // 6, or 26 when AO is baked
  private readonly refEntries: number;
  private readonly index: ChunkTable; // key -> record
  private readonly recKey: Float64Array;
  private readonly version: Float64Array;
  private readonly meshed: Float64Array; // accepted version, -1 none
  private readonly jobVersion: Float64Array; // outstanding job's version, -1 none
  private readonly jobStamp: Float64Array;
  private readonly jobStart: Float64Array; // performance.now() at submit
  private readonly quads: Int32Array; // accepted mesh counts, to keep totals
  private readonly translucentQuads: Int32Array;
  private readonly clusters: Int32Array;
  private readonly bytes: Int32Array;
  private readonly flags: Uint8Array;
  private readonly freeRecs: Int32Array;
  private freeCount: number;
  private dirty: Float64Array; // FIFO ring of keys
  private dirtyHead = 0;
  private dirtyCount = 0;
  private readonly outstanding: Int32Array; // record indices with a job
  private readonly outPos: Int32Array; // record -> position in outstanding
  private outCount = 0;
  private nextStamp = 1;
  private readonly inputBuffers: ArrayBuffer[] = []; // copy path, returned by jobs
  private cx = 0;
  private cy = 0;
  private cz = 0;

  constructor(store: ChunkStore, pool: MeshJobPool, options: MeshSchedulerOptions = DEFAULT_MESH_OPTIONS) {
    this.store = store;
    this.pool = pool;
    this.options = options;
    this.shared = store.arena.shared;
    this.neighborCount = options.ao ? ALL_NEIGHBORS : FACE_NEIGHBORS;
    this.refEntries = options.ao ? REF_ALL : REF_FACES;
    store.deferFrees = this.shared;
    store.freeStamp = this.nextStamp;
    if (this.shared) pool.share(ARENA_SHARE_ID, store.arena.buffer as SharedArrayBuffer);
    // Evicted records can outlive their store slot until their job settles.
    const n = store.capacity + options.maxOutstanding;
    this.index = new ChunkTable(n);
    this.recKey = new Float64Array(n);
    this.version = new Float64Array(n);
    this.meshed = new Float64Array(n);
    this.jobVersion = new Float64Array(n);
    this.jobStamp = new Float64Array(n);
    this.jobStart = new Float64Array(n);
    this.quads = new Int32Array(n);
    this.translucentQuads = new Int32Array(n);
    this.clusters = new Int32Array(n);
    this.bytes = new Int32Array(n);
    this.flags = new Uint8Array(n);
    this.freeRecs = new Int32Array(n);
    for (let i = 0; i < n; i++) this.freeRecs[i] = n - 1 - i;
    this.freeCount = n;
    this.dirty = new Float64Array(2 * n);
    this.outstanding = new Int32Array(options.maxOutstanding);
    this.outPos = new Int32Array(n);
  }

  // A chunk's data was stored (new, reloaded, or replaced). Called by streaming.
  // `urgent` submits the job now instead of at the next update(), which is a frame
  // sooner: a regenerated chunk is already on screen with the wrong content, so the
  // frame matters. The per-frame budget still bounds it, because the caller that
  // asks for regeneration is itself budgeted.
  stored(key: number, urgent = false): void {
    let r = this.index.get(key);
    if (r === -1) r = this.allocRecord(key);
    else this.flags[r] &= ~EVICTED;
    this.version[r]++;
    this.enqueue(r);
    // Neighbors waiting on this chunk may be ready now.
    for (let f = 0; f < this.neighborCount; f++) {
      const nr = this.index.get(neighborKey(key, f));
      if (nr !== -1 && (this.flags[nr] & EVICTED) === 0 && this.meshed[nr] !== this.version[nr]) this.enqueue(nr);
    }
    if (urgent) this.submitNow(r, key);
  }

  // Submits a chunk's job immediately when nothing stands in the way. Anything that
  // does (a full pool, a missing neighbor, a job already running) leaves it queued,
  // so this is a shortcut, never a second scheduling path.
  private submitNow(r: number, key: number): void {
    if (this.outCount >= this.options.maxOutstanding) return;
    if (this.jobVersion[r] >= 0 || this.meshed[r] === this.version[r]) return;
    if (!this.ready(key) || this.cannotHaveFaces(key)) return;
    this.flags[r] &= ~QUEUED; // its queue entry is skipped when popped
    this.submit(r, key);
  }

  // A chunk left the store. Called by streaming.
  evicted(key: number): void {
    const r = this.index.get(key);
    if (r === -1) return;
    this.onCoverage?.(key, false);
    this.unmesh(r);
    if (this.jobVersion[r] >= 0) {
      if (!this.pool.cancel(MESH_JOB, key)) {
        this.flags[r] |= EVICTED; // running: keep the record until it settles
        return;
      }
      this.endJob(r); // was still queued: it never read anything
    }
    this.freeRecord(r);
  }

  // A stored chunk changed (an edit). Edits on a border also mark the neighbor.
  markDirty(key: number): void {
    const r = this.index.get(key);
    if (r === -1 || (this.flags[r] & EVICTED) !== 0) return;
    this.version[r]++;
    this.enqueue(r);
  }

  // Meshes every stored chunk again, e.g. after the renderer (and its copy of the
  // meshes) was rebuilt. Bumps versions, so results in flight are dropped.
  remeshAll(): void {
    this.index.forEach((_key, r) => {
      if ((this.flags[r] & EVICTED) !== 0) return;
      this.dropTotals(r);
      this.version[r]++;
      this.enqueue(r);
    });
  }

  // Current data version of a chunk, -1 when unknown.
  versionOf(key: number): number {
    const r = this.index.get(key);
    return r === -1 ? -1 : this.version[r];
  }

  // Version of a chunk's accepted mesh, -1 when none.
  meshedVersionOf(key: number): number {
    const r = this.index.get(key);
    return r === -1 ? -1 : this.meshed[r];
  }

  update(cx: number, cy: number, cz: number): void {
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
    const o = this.options;
    let scanned = 0;
    let submitted = 0;
    while (
      this.dirtyCount > 0 && scanned < o.scanPerFrame && submitted < o.submitPerFrame &&
      this.outCount < o.maxOutstanding
    ) {
      scanned++;
      const key = this.popDirty();
      const r = this.index.get(key);
      if (r === -1 || (this.flags[r] & QUEUED) === 0) continue; // a leftover duplicate
      this.flags[r] &= ~QUEUED;
      if ((this.flags[r] & EVICTED) !== 0 || this.meshed[r] === this.version[r]) continue;
      if (this.jobVersion[r] >= 0) continue; // re-queued when it settles
      if (!this.ready(key)) continue; // re-queued when a neighbor arrives
      if (this.cannotHaveFaces(key)) {
        this.meshed[r] = this.version[r];
        this.unmesh(r);
        this.onCoverage?.(key, true); // nothing to draw is still the near field's answer
        this.stats.empty++;
        continue;
      }
      this.submit(r, key);
      submitted++;
    }
    this.stats.dirty = this.dirtyCount;
    if (this.shared) this.store.reclaim(this.safeStamp());
  }

  onResult(key: number, version: number, output: MeshJobOutput): void {
    if (output.input !== null && output.input.byteLength > 0) this.inputBuffers.push(output.input);
    const r = this.index.get(key);
    if (r === -1 || (this.flags[r] & EVICTED) !== 0 || version !== this.version[r] || version <= this.meshed[r]) {
      this.stats.stale++;
      if (output.mesh !== null) this.pool.recycle(output.mesh);
      return;
    }
    const s = this.stats;
    s.accepted++;
    s.latencyMs += (performance.now() - this.jobStart[r] - s.latencyMs) * 0.05;
    this.meshed[r] = version;
    this.onCoverage?.(key, true);
    if (output.mesh === null) {
      this.unmesh(r);
      s.empty++;
      return;
    }
    // A replacement: onMesh swaps it in, so no onUnmesh for the old one.
    this.dropTotals(r);
    this.quads[r] = output.quads;
    this.translucentQuads[r] = output.translucentQuads;
    this.clusters[r] = output.clusters;
    this.bytes[r] = output.bytes;
    s.meshes++;
    s.quads += output.quads;
    s.translucentQuads += output.translucentQuads;
    s.clusters += output.clusters;
    s.bytes += output.bytes;
    if (!(this.onMesh?.(key, output) ?? false)) this.pool.recycle(output.mesh);
  }

  onSettled(key: number, version: number, outcome: number): void {
    const r = this.index.get(key);
    if (r === -1 || this.jobVersion[r] !== version) return;
    this.endJob(r);
    if (outcome === SETTLED_FAILED) {
      // Don't retry a version that failed; the next change will.
      this.stats.failed++;
      if (this.meshed[r] < version) this.meshed[r] = version;
    }
    if ((this.flags[r] & EVICTED) !== 0) {
      this.freeRecord(r);
      return;
    }
    if (this.meshed[r] !== this.version[r]) this.enqueue(r);
  }

  private ready(key: number): boolean {
    if (!this.store.hasKey(key)) return false;
    for (let f = 0; f < this.neighborCount; f++) {
      if (neighborInWorld(key, f) && !this.store.hasKey(neighborKey(key, f))) return false;
    }
    return true;
  }

  // True for uniform chunks whose every face is hidden (or that have none).
  private cannotHaveFaces(key: number): boolean {
    const store = this.store;
    const id = store.slotUniformId(store.slotOf(key));
    if (id < 0) return false;
    const opaque = BLOCK_OPAQUE[id] === 1;
    if (!opaque && BLOCK_TRANSLUCENT[id] === 0) return true; // air
    for (let f = 0; f < FACE_COUNT; f++) {
      const slot = store.slotOf(neighborKey(key, f));
      if (slot === -1) return false; // outside the world reads as air
      const n = store.slotUniformId(slot);
      if (n < 0) return false;
      if (BLOCK_OPAQUE[n] || (!opaque && n === id)) continue;
      return false;
    }
    return true;
  }

  private submit(r: number, key: number): void {
    const store = this.store;
    const refs = new Int32Array(this.refEntries * 2);
    let blockBytes = 0;
    for (let i = 0; i < this.refEntries; i++) {
      const k = i === 0 ? key : neighborKey(key, i - 1);
      const slot = store.slotOf(k);
      if (slot === -1) {
        refs[i * 2] = REF_MISSING;
        continue;
      }
      const id = store.slotUniformId(slot);
      if (id >= 0) {
        refs[i * 2] = id;
        continue;
      }
      refs[i * 2] = REF_BLOCK;
      refs[i * 2 + 1] = store.slotBlockOffset(slot);
      blockBytes += store.slotBlockBytes(slot);
    }
    let input: MeshJobInput;
    let transfer: Transferable[] | null = null;
    if (this.shared || blockBytes === 0) {
      input = {
        sharedId: blockBytes === 0 ? -1 : ARENA_SHARE_ID,
        buffer: null,
        returnBuffer: false,
        refs,
        clusterQuads: this.options.clusterQuads,
        clusterOrder: this.options.clusterOrder,
        ao: this.options.ao,
      };
    } else {
      // Copy path: this job's blocks into one pooled buffer, transferred.
      const buffer = this.takeInputBuffer(blockBytes);
      const src = new Uint8Array(store.arena.buffer);
      let at = 0;
      for (let i = 0; i < this.refEntries; i++) {
        if (refs[i * 2] !== REF_BLOCK) continue;
        const slot = store.slotOf(i === 0 ? key : neighborKey(key, i - 1));
        const offset = refs[i * 2 + 1];
        const bytes = store.slotBlockBytes(slot);
        new Uint8Array(buffer, at, bytes).set(src.subarray(offset, offset + bytes));
        refs[i * 2 + 1] = at;
        at += bytes; // block sizes are multiples of 4
      }
      input = {
        sharedId: -1,
        buffer,
        returnBuffer: true,
        refs,
        clusterQuads: this.options.clusterQuads,
        clusterOrder: this.options.clusterOrder,
        ao: this.options.ao,
      };
      transfer = [buffer];
    }
    const stamp = this.nextStamp++;
    store.freeStamp = this.nextStamp;
    this.jobVersion[r] = this.version[r];
    this.jobStamp[r] = stamp;
    this.jobStart[r] = performance.now();
    this.outPos[r] = this.outCount;
    this.outstanding[this.outCount++] = r;
    this.stats.outstanding = this.outCount;
    this.stats.submitted++;
    const dx = keyX(key) - this.cx, dy = keyY(key) - this.cy, dz = keyZ(key) - this.cz;
    this.pool.submit(MESH_JOB, key, this.version[r], dx * dx + dy * dy + dz * dz, input, transfer);
  }

  private takeInputBuffer(bytes: number): ArrayBuffer {
    const pool = this.inputBuffers;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].byteLength >= bytes) {
        const b = pool[i];
        pool[i] = pool[pool.length - 1];
        pool.pop();
        return b;
      }
    }
    let size = 4096;
    while (size < bytes) size *= 2;
    return new ArrayBuffer(size);
  }

  // Oldest stamp any outstanding job holds, or the next stamp when none: blocks
  // retired at or before it are safe to reuse.
  private safeStamp(): number {
    let min = this.nextStamp;
    for (let i = 0; i < this.outCount; i++) {
      const s = this.jobStamp[this.outstanding[i]];
      if (s < min) min = s;
    }
    return min;
  }

  private endJob(r: number): void {
    this.jobVersion[r] = -1;
    const i = this.outPos[r];
    const last = this.outstanding[--this.outCount];
    this.outstanding[i] = last;
    this.outPos[last] = i;
    this.stats.outstanding = this.outCount;
  }

  // Drops a record's accepted mesh and tells onUnmesh.
  private unmesh(r: number): void {
    if (this.dropTotals(r)) this.onUnmesh?.(this.recKey[r]);
  }

  // Removes a record's accepted mesh from the totals; false when it had none.
  private dropTotals(r: number): boolean {
    if (this.bytes[r] === 0) return false;
    const s = this.stats;
    s.meshes--;
    s.quads -= this.quads[r];
    s.translucentQuads -= this.translucentQuads[r];
    s.clusters -= this.clusters[r];
    s.bytes -= this.bytes[r];
    this.quads[r] = this.translucentQuads[r] = this.clusters[r] = this.bytes[r] = 0;
    return true;
  }

  private enqueue(r: number): void {
    if ((this.flags[r] & QUEUED) !== 0) return;
    this.flags[r] |= QUEUED;
    if (this.dirtyCount === this.dirty.length) {
      // Duplicates left by freed records can fill the ring; grow (rare).
      const grown = new Float64Array(this.dirty.length * 2);
      for (let i = 0; i < this.dirtyCount; i++) grown[i] = this.dirty[(this.dirtyHead + i) % this.dirty.length];
      this.dirty = grown;
      this.dirtyHead = 0;
    }
    this.dirty[(this.dirtyHead + this.dirtyCount) % this.dirty.length] = this.recKey[r];
    this.dirtyCount++;
  }

  private popDirty(): number {
    const key = this.dirty[this.dirtyHead];
    this.dirtyHead = (this.dirtyHead + 1) % this.dirty.length;
    this.dirtyCount--;
    return key;
  }

  private allocRecord(key: number): number {
    if (this.freeCount === 0) throw new Error("mesh scheduler records exhausted");
    const r = this.freeRecs[--this.freeCount];
    this.recKey[r] = key;
    this.version[r] = 0;
    this.meshed[r] = -1;
    this.jobVersion[r] = -1;
    this.flags[r] = 0;
    this.quads[r] = this.translucentQuads[r] = this.clusters[r] = this.bytes[r] = 0;
    this.index.set(key, r);
    return r;
  }

  private freeRecord(r: number): void {
    this.index.delete(this.recKey[r]);
    this.flags[r] = 0; // a queued duplicate of this key is skipped when popped
    this.freeRecs[this.freeCount++] = r;
  }
}
