// Far-field bricks for edited chunks (plan-far-field phases 2-3). An edit leaves a
// chunk whose voxels no longer follow the world SDF, so its bricks cannot be sampled
// from the field (far-build.wgsl) and are reduced from the chunk data in a worker
// (src/far/brick-job.ts) instead. One job per chunk, budgeted per frame.
//
// Only the levels whose bricks fit inside a chunk are patched (k = 1 and 2 at a
// 32-voxel chunk). A coarser brick spans several chunks, and the ones around an edit
// are on the GPU only, so rebuilding it needs the reduction to run over brick data
// rather than voxels: that is phase 5's "edit events rebuild affected bricks at every
// level". Until then an edit shows in the far field out to the second level's window
// and is part of the sampled field beyond it only if it was a field brush.
//
// The job always takes a copy of the chunk's arena block rather than reading the
// shared arena in place: a job kind that reads the arena has to join the free-stamp
// protocol (CLAUDE.md "Invariants"), and a chunk block is a few tens of kilobytes
// that only a rebuilt chunk pays for.
//
// Versions work like the mesh scheduler's: every mark bumps the chunk's version, the
// pool coalesces by key, and a result older than the current version is dropped.

import { BRICK_WORDS, bricksPerChunkSide, tilesChunk } from "./reduce.ts";
import type { BrickJobInput, BrickJobOutput } from "./brick-job.ts";
import { REF_BLOCK, REF_MISSING } from "../mesh/job.ts";
import type { ChunkStore } from "../world/store.ts";
import { keyX, keyY, keyZ } from "../world/keys.ts";

export const BRICK_JOB = "far.bricks";

export interface BrickPool {
  submit(
    kind: string,
    key: number,
    version: number,
    priority: number,
    input: unknown,
    transfer: Transferable[] | null,
  ): void;
  recycle(buffer: ArrayBuffer): void;
}

// What the far field has to offer for a patch to land. Returns true when the brick
// could not be written yet because its cell is being built, in which case the chunk is
// queued again.
export interface BrickTarget {
  readonly levelKs: Int32Array; // k of each clipmap level, ascending
  firstLevel: number; // k of level index 0
  patchBrick(level: number, bx: number, by: number, bz: number, words: Uint32Array | null, at: number): boolean;
}

export interface FarEditStats {
  queued: number;
  missing: number; // results for chunks that were not resident
  submitted: number;
  applied: number; // bricks written
  stale: number; // results dropped for an older version
  retried: number; // bricks whose cell was still being built
}

export class FarEdits {
  readonly stats: FarEditStats = { queued: 0, missing: 0, submitted: 0, applied: 0, stale: 0, retried: 0 };
  // k of the levels a chunk reduction can reach: those whose bricks fit in a chunk.
  readonly levels: Int32Array;

  private readonly store: ChunkStore;
  private readonly pool: BrickPool;
  private readonly target: BrickTarget;
  private readonly queue: number[] = [];
  private readonly queued = new Set<number>();
  private readonly versions = new Map<number, number>();
  private readonly buffers: ArrayBuffer[] = [];
  // Chunks whose bricks are the reduction's, not the field's. Small: it holds the
  // chunks an edit has touched, not every chunk.
  private readonly edited = new Set<number>();

  constructor(store: ChunkStore, pool: BrickPool, target: BrickTarget) {
    this.store = store;
    this.pool = pool;
    this.target = target;
    const levels: number[] = [];
    for (const k of target.levelKs) if (tilesChunk(k)) levels.push(k);
    this.levels = new Int32Array(levels);
  }

  // A chunk's voxels changed. Cheap to call for a chunk outside the clipmap: the
  // result is dropped when it comes back.
  markDirty(key: number): void {
    this.edited.add(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push(key);
    this.stats.queued = this.queue.length;
  }

  // A slab was sampled from the field, so any edited chunk it covers lost its bricks
  // and has to be reduced again. Cheaper than it looks: the loop is over chunks an
  // edit has touched, not over the slab.
  slabBuilt(level: number, axis: number, plane: number): void {
    if (this.edited.size === 0) return;
    const k = this.target.firstLevel + level;
    if (!tilesChunk(k)) return;
    const per = bricksPerChunkSide(k);
    for (const key of this.edited) {
      const chunk = axis === 0 ? keyX(key) : axis === 1 ? keyY(key) : keyZ(key);
      const c = chunk * per;
      if (plane >= c && plane < c + per) this.markDirty(key);
    }
  }

  // Submits up to `budget` jobs.
  pump(budget: number): void {
    if (this.levels.length === 0) return;
    for (let i = 0; i < budget && this.queue.length > 0; i++) {
      const key = this.queue.shift()!;
      this.queued.delete(key);
      this.submit(key);
    }
    this.stats.queued = this.queue.length;
  }

  private submit(key: number): void {
    const store = this.store;
    const slot = store.slotOf(key);
    const uniform = slot === -1 ? -1 : store.slotUniformId(slot);
    const state = slot === -1 ? REF_MISSING : uniform >= 0 ? uniform : REF_BLOCK;
    let buffer: ArrayBuffer | null = null;
    let transfer: Transferable[] | null = null;
    if (state === REF_BLOCK) {
      const bytes = store.slotBlockBytes(slot);
      buffer = this.takeBuffer(bytes);
      const src = new Uint8Array(store.arena.buffer, store.slotBlockOffset(slot), bytes);
      new Uint8Array(buffer, 0, bytes).set(src);
      transfer = [buffer];
    }
    const input: BrickJobInput = {
      sharedId: -1,
      buffer,
      returnBuffer: buffer !== null,
      levels: this.levels,
      state,
      offset: 0, // the copy puts the block at the front of its own buffer
      cx: keyX(key),
      cy: keyY(key),
      cz: keyZ(key),
      version: this.versions.get(key) ?? 0,
    };
    this.stats.submitted++;
    this.pool.submit(BRICK_JOB, key, input.version, 0, input, transfer);
  }

  // Applies a finished reduction: each brick over whatever the field sampled there.
  onResult(key: number, version: number, output: BrickJobOutput): void {
    if (output.input !== null) this.buffers.push(output.input);
    if (version !== (this.versions.get(key) ?? 0)) {
      this.stats.stale++;
      if (output.bricks !== null) this.pool.recycle(output.bricks);
      return;
    }
    if (output.missing) {
      // Not resident: there is nothing to reduce, and blanking the bricks would punch
      // a hole where the sampled field had terrain. Leave them; storing the chunk
      // marks it dirty again.
      this.stats.missing++;
      return;
    }
    const words = output.bricks === null ? null : new Uint32Array(output.bricks);
    const cx = keyX(key), cy = keyY(key), cz = keyZ(key);
    let retry = false;
    let at = 0;
    for (let l = 0; l < this.levels.length; l++) {
      const k = this.levels[l];
      const level = k - this.target.firstLevel;
      const per = bricksPerChunkSide(k);
      for (let i = 0; i < per ** 3; i++) {
        const bx = i % per, by = Math.floor(i / per) % per, bz = Math.floor(i / (per * per));
        const isSolid = (output.solid & (1 << at)) !== 0;
        const again = this.target.patchBrick(
          level,
          cx * per + bx,
          cy * per + by,
          cz * per + bz,
          isSolid && words !== null ? words : null,
          at * BRICK_WORDS,
        );
        if (again) retry = true;
        else this.stats.applied++;
        at++;
      }
    }
    if (retry) {
      this.stats.retried++;
      this.markDirty(key); // its cell was being built; reduce it again once that lands
    }
    if (output.bricks !== null) this.pool.recycle(output.bricks);
  }

  private takeBuffer(bytes: number): ArrayBuffer {
    const pool = this.buffers;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].byteLength >= bytes) {
        const buffer = pool[i];
        pool[i] = pool[pool.length - 1];
        pool.pop();
        return buffer;
      }
    }
    return new ArrayBuffer(Math.max(bytes, 1 << 16));
  }
}
