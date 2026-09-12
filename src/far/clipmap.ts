// Far-field clipmap (plan-far-field phase 3). L camera-centred levels, level k with
// 2^k-voxel cells, each a B^3 grid of bricks addressed toroidally (`brick mod B`), so
// moving the camera rewrites only the slab of bricks that scrolls in.
//
// This is the CPU half: where each level sits, which slabs are waiting to be built,
// which grid cells hold which pool slot (the shadow of the indirection buffer), and
// which are being built right now. The GPU half samples a slab from the world SDF and
// reports back what it found (src/far/far-build.wgsl, src/far/far-field.ts).
//
// Why a shadow: the GPU decides which bricks are occupied, so only it knows which
// pool slot each grid cell holds. The CPU needs that to free slots when bricks scroll
// out and to patch bricks from edited chunks, so each build reports its slab's
// indirection entries back and the shadow follows, a few frames behind.
//
// Staleness. A slab's cells are zeroed the moment it is queued, so the ring that
// scrolls in reads as empty (a hole the near field or the next level covers) rather
// than as terrain from B bricks away. Nothing is ever marched against a brick that
// belongs somewhere else.

import { BrickPool } from "./pool.ts";
import { entrySlot } from "./reduce.ts";

export const MAX_LEVELS = 8;

// The two grid axes a slab of the given axis spans, in in-slab index order.
const OTHER: readonly (readonly [number, number])[] = [[1, 2], [0, 2], [0, 1]];

export interface ClipmapOptions {
  size: number; // B: bricks per side of every level, a power of two
  levels: number; // L
  firstLevel: number; // k of the finest level
  bricks: number; // pool capacity in slots
}

// Eight levels from k = 1: 2-voxel cells at the near/far boundary, out to 32,768
// voxels, which is the far-field view distance in CLAUDE.md's targets. Measured against
// five levels at one camera (1920x1080, horizon view): the march goes from 0.79 ms to
// 1.44, the pool from 37,537 bricks to 39,564, and the reach from 4,096 voxels to
// 32,768. The coarse levels are nearly free because a brick that is solid throughout
// costs no pool slot, and underground almost every one of them is.
//
// `?farFirst=2` shifts the stack a level coarser, which buys reach for about the same
// GPU time but makes the cells at the near/far boundary 4 voxels, which reads as blocky
// next to the raster pass.
export const DEFAULT_CLIPMAP_OPTIONS: ClipmapOptions = {
  size: 32,
  levels: 8,
  firstLevel: 1,
  bricks: 49152, // 27 MiB; terrain uses 39,564 of them and the forest 12,741, and drops are counted
};

export interface Slab {
  level: number; // index into the levels, not k
  axis: number;
  plane: number; // brick coordinate along `axis`
}

export class Clipmap {
  readonly options: ClipmapOptions;
  readonly pool: BrickPool;
  readonly cells: number; // grid cells per level
  // Brick coordinate of each level's min corner, 3 per level.
  readonly origins: Int32Array;
  // Indirection as the GPU last reported it: 0 empty, else slot + 1.
  readonly entries: Uint32Array;
  // 1 while a build covering the cell is in flight.
  readonly pending: Uint8Array;
  dropped = 0; // bricks the pool had no slot for
  built = 0; // slabs reported
  // Queued slabs, oldest first.
  private readonly queue: Int32Array;
  private queueCount = 0;
  private readonly mask: number;
  private centred = false;
  // Scratch, so update() and slabCell() allocate nothing per frame (CLAUDE.md
  // "Invariants").
  // Slabs queued since the last frame looked, 3 entries each: their cells hold bricks
  // from a window away until they are sampled, and the GPU has to be told to forget
  // them now rather than when the build gets its turn.
  private readonly fresh: number[] = [];
  // Coarse bricks to rebuild from the level under them, 4 entries each (level, xyz).
  // An edit reaches levels 1 and 2 through the chunk reduction; above that a brick
  // spans more than a chunk, so it is rebuilt from its children instead.
  private readonly coarse: number[] = [];
  // Levels rebuilt whole since the last frame looked: their whole slice has to be
  // blanked on the GPU, or a teleport shows the old place until the slabs land.
  private readonly zeroed: number[] = [];
  // Slabs being built, 3 entries each. Small (the ring bounds it), and testing
  // against it beats scanning a slab's B^2 pending flags for every queued candidate.
  private readonly flight: number[] = [];
  private readonly target = new Int32Array(3);
  private readonly from = new Int32Array(3);
  private readonly brick = new Int32Array(3);

  constructor(options: ClipmapOptions = DEFAULT_CLIPMAP_OPTIONS) {
    const { size, levels } = options;
    if ((size & (size - 1)) !== 0) throw new Error(`clipmap size ${size} is not a power of two`);
    if (levels < 1 || levels > MAX_LEVELS) throw new Error(`clipmap levels ${levels} out of range`);
    this.options = options;
    this.mask = size - 1;
    this.cells = size ** 3;
    this.pool = new BrickPool(options.bricks);
    this.origins = new Int32Array(levels * 3);
    this.entries = new Uint32Array(levels * this.cells);
    this.pending = new Uint8Array(levels * this.cells);
    // A full rebuild of every level is L * B slabs; leave room for scrolling on top.
    this.queue = new Int32Array(levels * size * 3 * 4);
  }

  get levels(): number {
    return this.options.levels;
  }

  get queued(): number {
    return this.queueCount;
  }

  // k of a level: cells are 2^k voxels.
  levelK(level: number): number {
    return this.options.firstLevel + level;
  }

  cellVoxels(level: number): number {
    return 1 << this.levelK(level);
  }

  brickVoxels(level: number): number {
    return 8 << this.levelK(level);
  }

  extentVoxels(level: number): number {
    return this.options.size * this.brickVoxels(level);
  }

  // Grid cell of a brick coordinate, toroidally. Every brick maps to one cell; only
  // the one inside the level's window is the cell's current occupant.
  cellOf(level: number, bx: number, by: number, bz: number): number {
    const size = this.options.size;
    const x = bx & this.mask, y = by & this.mask, z = bz & this.mask;
    return level * this.cells + x + y * size + z * size * size;
  }

  // True while the brick is inside the level's window.
  inLevel(level: number, bx: number, by: number, bz: number): boolean {
    const o = level * 3;
    const size = this.options.size;
    return bx >= this.origins[o] && bx < this.origins[o] + size &&
      by >= this.origins[o + 1] && by < this.origins[o + 1] + size &&
      bz >= this.origins[o + 2] && bz < this.origins[o + 2] + size;
  }

  // Moves the levels to follow the camera, queueing the slabs that scrolled in. The
  // first call, and any jump of a whole window, rebuilds the level instead.
  update(x: number, y: number, z: number): void {
    const size = this.options.size;
    const half = size >> 1;
    const target = this.target, from = this.from;
    for (let level = 0; level < this.levels; level++) {
      const b = this.brickVoxels(level);
      const o = level * 3;
      let jumped = !this.centred;
      for (let a = 0; a < 3; a++) {
        target[a] = Math.floor((a === 0 ? x : a === 1 ? y : z) / b) - half;
        if (Math.abs(target[a] - this.origins[o + a]) >= size) jumped = true;
      }
      if (jumped) {
        for (let a = 0; a < 3; a++) this.origins[o + a] = target[a];
        this.rebuildLevel(level);
        continue;
      }
      for (let a = 0; a < 3; a++) from[a] = this.origins[o + a];
      for (let a = 0; a < 3; a++) this.origins[o + a] = target[a];
      for (let a = 0; a < 3; a++) {
        const d = target[a] - from[a];
        if (d === 0) continue;
        // What scrolled in: the far side when moving forward, the near side back.
        const lo = d > 0 ? from[a] + size : target[a];
        const hi = d > 0 ? target[a] + size : from[a];
        for (let p = lo; p < hi; p++) this.enqueue(level, a, p);
      }
    }
    this.centred = true;
  }

  // Queues every slab of a level and drops what it held. Used on a teleport and on
  // the first frame; the level reads as empty until the slabs land.
  rebuildLevel(level: number): void {
    if (!this.zeroed.includes(level)) this.zeroed.push(level);
    const size = this.options.size;
    const base = level * this.cells;
    for (let i = 0; i < this.cells; i++) {
      const slot = entrySlot(this.entries[base + i]);
      // A cell whose build is still in flight is freed when its report lands.
      if (slot >= 0 && this.pending[base + i] === 0) this.pool.give(slot);
      this.entries[base + i] = 0;
    }
    this.dropQueued(level);
    const o = level * 3;
    for (let p = 0; p < size; p++) this.enqueue(level, 2, this.origins[o + 2] + p, false);
  }

  private dropQueued(level: number): void {
    let out = 0;
    for (let i = 0; i < this.queueCount; i++) {
      if (this.queue[i * 3] === level) continue;
      this.queue[out * 3] = this.queue[i * 3];
      this.queue[out * 3 + 1] = this.queue[i * 3 + 1];
      this.queue[out * 3 + 2] = this.queue[i * 3 + 2];
      out++;
    }
    this.queueCount = out;
  }

  // Queues the bricks above `brick` at `level`, one per coarser level, so a change
  // there reaches the whole stack. Cheap and idempotent: the queue is deduplicated and
  // a brick that is already waiting is not queued twice.
  queueCoarse(level: number, bx: number, by: number, bz: number): void {
    let x = bx, y = by, z = bz;
    for (let l = level + 1; l < this.levels; l++) {
      x = x >> 1;
      y = y >> 1;
      z = z >> 1;
      if (!this.inLevel(l, x, y, z)) break; // outside the window: nothing to rebuild
      let found = false;
      for (let i = 0; i < this.coarse.length; i += 4) {
        if (this.coarse[i] === l && this.coarse[i + 1] === x && this.coarse[i + 2] === y && this.coarse[i + 3] === z) {
          found = true;
          break;
        }
      }
      if (!found) this.coarse.push(l, x, y, z);
    }
  }

  get coarseQueued(): number {
    return this.coarse.length / 4;
  }

  // Coarse rebuilds, lowest level first so a level is rebuilt before the one above it
  // reads it. Returns how many were written into `out` (4 entries each).
  takeCoarse(out: Int32Array, max: number): number {
    if (this.coarse.length === 0) return 0;
    let level = Infinity;
    for (let i = 0; i < this.coarse.length; i += 4) level = Math.min(level, this.coarse[i]);
    let n = 0;
    let at = 0;
    while (at < this.coarse.length && n < max) {
      if (this.coarse[at] !== level) {
        at += 4;
        continue;
      }
      for (let k = 0; k < 4; k++) out[n * 4 + k] = this.coarse[at + k];
      n++;
      const last = this.coarse.length - 4;
      for (let k = 0; k < 4; k++) this.coarse[at + k] = this.coarse[last + k];
      this.coarse.length = last;
    }
    return n;
  }

  // Levels rebuilt whole since the last call.
  takeZeroed(out: Int32Array): number {
    const n = Math.min(out.length, this.zeroed.length);
    for (let i = 0; i < n; i++) out[i] = this.zeroed[i];
    this.zeroed.splice(0, n);
    return n;
  }

  // Slabs queued since the last call, into `out` as (level, axis, plane) triples.
  takeFresh(out: Int32Array, max: number): number {
    const n = Math.min(max, this.fresh.length / 3);
    for (let i = 0; i < n * 3; i++) out[i] = this.fresh[i];
    this.fresh.splice(0, n * 3);
    return n;
  }

  // `stale` marks a slab whose cells still hold a brick from a window away, so the
  // caller clears them on the GPU. A level that was rebuilt whole has had its whole
  // slice zeroed already and passes false.
  private enqueue(level: number, axis: number, plane: number, stale = true): void {
    for (let i = 0; i < this.queueCount; i++) {
      if (this.queue[i * 3] === level && this.queue[i * 3 + 1] === axis && this.queue[i * 3 + 2] === plane) return;
    }
    if (this.queueCount * 3 >= this.queue.length) {
      // Never silently lose a slab: rebuild the level instead of queueing past the end.
      this.rebuildLevel(level);
      return;
    }
    const at = this.queueCount++ * 3;
    this.queue[at] = level;
    this.queue[at + 1] = axis;
    this.queue[at + 2] = plane;
    if (stale) this.fresh.push(level, axis, plane);
  }

  // Takes the oldest slab no build is already covering, into `out`. Its cells are
  // marked in flight, their slots go back to the pool, and the shadow is zeroed:
  // the caller zeroes the same entries on the GPU before building them.
  take(out: Slab): boolean {
    for (let i = 0; i < this.queueCount; i++) {
      const level = this.queue[i * 3], axis = this.queue[i * 3 + 1], plane = this.queue[i * 3 + 2];
      if (!this.planeInLevel(level, axis, plane)) {
        this.removeQueued(i);
        i--;
        continue; // scrolled out of the window before it was built
      }
      if (this.slabPending(level, axis, plane)) continue;
      this.removeQueued(i);
      out.level = level;
      out.axis = axis;
      out.plane = plane;
      this.flight.push(level, axis, plane);
      const size = this.options.size;
      for (let v = 0; v < size; v++) {
        for (let u = 0; u < size; u++) {
          const cell = this.slabCell(level, axis, plane, u, v);
          const slot = entrySlot(this.entries[cell]);
          if (slot >= 0) this.pool.give(slot);
          this.entries[cell] = 0;
          this.pending[cell] = 1;
        }
      }
      return true;
    }
    return false;
  }

  // Grid cell of one brick of a slab, by its in-slab coordinates.
  slabCell(level: number, axis: number, plane: number, u: number, v: number): number {
    const au = OTHER[axis][0], av = OTHER[axis][1];
    const o = level * 3;
    const b = this.brick;
    b[axis] = plane;
    b[au] = this.origins[o + au] + u;
    b[av] = this.origins[o + av] + v;
    return this.cellOf(level, b[0], b[1], b[2]);
  }

  private planeInLevel(level: number, axis: number, plane: number): boolean {
    const o = this.origins[level * 3 + axis];
    return plane >= o && plane < o + this.options.size;
  }

  // Two slabs of one level overlap unless they are parallel planes: a slab of another
  // axis always crosses this one, and the window holds one plane per coordinate, so
  // toroidal aliasing cannot make two in-window planes share cells.
  private slabPending(level: number, axis: number, plane: number): boolean {
    for (let i = 0; i < this.flight.length; i += 3) {
      if (this.flight[i] !== level) continue;
      if (this.flight[i + 1] !== axis || this.flight[i + 2] === plane) return true;
    }
    return false;
  }

  private removeQueued(i: number): void {
    const last = --this.queueCount;
    for (let k = 0; k < 3; k++) this.queue[i * 3 + k] = this.queue[last * 3 + k];
    // Order is not preserved, which only changes which slab is built first.
  }

  // A finished build: `entries` is the slab's indirection as the GPU wrote it, in
  // in-slab order. Returns how many bricks were occupied, which is how many of the
  // slot list the build used; the caller returns the rest to the pool.
  applyReport(slab: Slab, entries: Uint32Array, dropped: number): number {
    for (let i = 0; i < this.flight.length; i += 3) {
      if (this.flight[i] === slab.level && this.flight[i + 1] === slab.axis && this.flight[i + 2] === slab.plane) {
        const last = this.flight.length - 3;
        for (let k = 0; k < 3; k++) this.flight[i + k] = this.flight[last + k];
        this.flight.length = last;
        break;
      }
    }
    const size = this.options.size;
    let used = 0;
    for (let v = 0; v < size; v++) {
      for (let u = 0; u < size; u++) {
        const cell = this.slabCell(slab.level, slab.axis, slab.plane, u, v);
        const entry = entries[u + v * size];
        // The shadow mirrors the GPU even when the slab has scrolled since: the queue
        // holds a rebuild for those cells, and it is what frees these slots.
        this.entries[cell] = entry;
        this.pending[cell] = 0;
        // Only a brick in the pool spent a slot; a solid-throughout one is the entry.
        if (entrySlot(entry) >= 0) used++;
      }
    }
    this.dropped += dropped;
    this.built++;
    return used;
  }

  // Slot holding a brick, or -1 when it is empty, solid throughout, or outside the
  // level.
  slotOf(level: number, bx: number, by: number, bz: number): number {
    if (!this.inLevel(level, bx, by, bz)) return -1;
    const cell = this.cellOf(level, bx, by, bz);
    if (this.pending[cell] === 1) return -1;
    return entrySlot(this.entries[cell]);
  }
}
