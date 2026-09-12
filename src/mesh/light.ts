// Block light, flood filled and baked per quad corner beside AO (plan-living-world
// phase 4). Pure.
//
// A block with `light` in the registry seeds its own level; the level falls by one per
// voxel step through anything the light can pass (air and translucent blocks), and stops
// at opaque ones. What a face sees is the light in the air cell in front of it, which is
// the same rule baked AO uses, so the two read the same neighbourhood and a corner is
// lit by what is actually beside it.
//
// The grid is the chunk plus LIGHT_REACH voxels of padding on every side, so a light
// LIGHT_REACH voxels outside the chunk still reaches into it. LIGHT_MAX is 15 and a
// level is one voxel, so LIGHT_REACH is 15 and the padded side is 62. The padding comes
// from the 26 neighbour chunks, which reach 32 voxels: enough.
//
// Cost is the reason this is not simply always on. Filling the grid means reading 62^3
// voxels through the palette, which is far past a mesh job's budget, so the caller only
// runs it when one of the 27 chunks actually holds a light (`hasLight`), and the fill
// itself touches only cells a light reaches.

import { BLOCK_LIGHT, BLOCK_OPAQUE, LIGHT_MAX } from "../world/blocks.ts";
import type { ChunkData } from "../world/chunk.ts";
import { voxelIndex } from "../world/coords.ts";
import { FACE_AXIS, FACE_SIGN, FACE_U, FACE_V } from "./quad.ts";

export const LIGHT_REACH = LIGHT_MAX;
export const LIGHT_PAD = 32 + 2 * LIGHT_REACH;
export const LIGHT_VOLUME = LIGHT_PAD * LIGHT_PAD * LIGHT_PAD;

// Index into the padded grid; coordinates -LIGHT_REACH..31 + LIGHT_REACH. Same axis
// order as voxelIndex and padIndex.
export function lightIndex(x: number, y: number, z: number): number {
  return x + LIGHT_REACH + (z + LIGHT_REACH) * LIGHT_PAD + (y + LIGHT_REACH) * LIGHT_PAD * LIGHT_PAD;
}

// log2 of a palette width, for unpacking a chunk's index words without the palette
// indirection. Mirrors ChunkData's own packing (src/world/chunk.ts).
const LOG2: readonly number[] = (() => {
  const t = new Array(33).fill(0);
  for (let b = 1; b <= 32; b <<= 1) t[b] = Math.log2(b);
  return t;
})();

const LIGHT_STRIDE: readonly number[] = [1, LIGHT_PAD * LIGHT_PAD, LIGHT_PAD];
// The six steps of the fill, in the same order as the face table's axes.
const STEPS: readonly number[] = [
  LIGHT_STRIDE[0],
  -LIGHT_STRIDE[0],
  LIGHT_STRIDE[1],
  -LIGHT_STRIDE[1],
  LIGHT_STRIDE[2],
  -LIGHT_STRIDE[2],
];

// True when any voxel of the chunk could be a light. Reads the palette, not the voxels:
// a chunk that never saw a glowing block answers in a handful of comparisons, which is
// what keeps the light pass off the bill for most of a world.
export function hasLight(chunk: ChunkData | null): boolean {
  if (chunk === null) return false;
  for (let i = 0; i < chunk.paletteLength; i++) {
    if (BLOCK_LIGHT[chunk.paletteAt(i)] !== 0) return true;
  }
  return false;
}

// A chunk holding at least one light, at a chunk offset from the meshed chunk.
export interface LightSource {
  dx: number;
  dy: number;
  dz: number;
  chunk: ChunkData;
}

// Scratch for one fill, one set per worker. Cells are bucketed by level so the fill is
// a plain sweep from the brightest level down: every cell is reached at its final level
// first, so no cell is ever queued twice.
export class LightFill {
  readonly levels = new Uint8Array(LIGHT_VOLUME);
  // Cells written since the last reset, so clearing costs what the light covered
  // rather than the whole grid.
  private readonly touched = new Int32Array(LIGHT_VOLUME >> 3);
  private touchedCount = 0;
  private readonly buckets: Int32Array[] = [];
  private readonly bucketCount = new Int32Array(LIGHT_MAX + 1);
  // Light level of each palette index of the source chunk being scanned.
  private readonly byIndex = new Uint8Array(65536);

  constructor() {
    for (let i = 0; i <= LIGHT_MAX; i++) this.buckets.push(new Int32Array(1024));
  }

  // Clears what the last fill wrote. Cheap when the light covered little; a fill that
  // overflowed the touched list falls back to clearing the grid.
  reset(): void {
    if (this.touchedCount > this.touched.length) {
      this.levels.fill(0);
    } else {
      for (let i = 0; i < this.touchedCount; i++) this.levels[this.touched[i]] = 0;
    }
    this.touchedCount = 0;
    this.bucketCount.fill(0);
  }

  private push(level: number, cell: number): void {
    const n = this.bucketCount[level];
    let bucket = this.buckets[level];
    if (n === bucket.length) {
      const grown = new Int32Array(n * 2);
      grown.set(bucket);
      this.buckets[level] = grown;
      bucket = grown;
    }
    bucket[n] = cell;
    this.bucketCount[level] = n + 1;
  }

  private mark(cell: number, level: number): void {
    this.levels[cell] = level;
    if (this.touchedCount < this.touched.length) this.touched[this.touchedCount] = cell;
    this.touchedCount++;
  }

  // Seeds the lights in `sources` and spreads them. Each source is a chunk that
  // `hasLight()` said holds one, at a chunk offset of -1, 0 or 1 from the meshed chunk;
  // only its voxels inside the padded region are scanned. `voxelAt` reads a block id at
  // a padded coordinate and is called only where light actually goes.
  fill(
    sources: readonly LightSource[],
    count: number,
    voxelAt: (x: number, y: number, z: number) => number,
  ): void {
    this.reset();
    const lo = -LIGHT_REACH, hi = 31 + LIGHT_REACH;
    for (let i = 0; i < count; i++) {
      const src = sources[i];
      const bx = src.dx * 32, by = src.dy * 32, bz = src.dz * 32;
      const x0 = Math.max(lo, bx), x1 = Math.min(hi, bx + 31);
      const y0 = Math.max(lo, by), y1 = Math.min(hi, by + 31);
      const z0 = Math.max(lo, bz), z1 = Math.min(hi, bz + 31);
      // Light level by palette index, so the scan below compares packed indices and
      // never goes through the palette: this loop reads every voxel of the chunk and is
      // the whole cost of seeding.
      const chunk = src.chunk;
      const words = chunk.indexWords();
      const bits = chunk.bitsPerVoxel;
      const byIndex = this.byIndex;
      let any = 0;
      for (let k = 0; k < chunk.paletteLength; k++) {
        byIndex[k] = BLOCK_LIGHT[chunk.paletteAt(k)];
        any |= byIndex[k];
      }
      if (any === 0) continue;
      const perWordLog = words === null ? 0 : 5 - LOG2[bits];
      const perWordMask = (1 << perWordLog) - 1;
      const indexMask = (1 << bits) - 1;
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            const i = voxelIndex(x - bx, y - by, z - bz);
            const level = words === null
              ? byIndex[0]
              : byIndex[(words[i >>> perWordLog] >>> ((i & perWordMask) * bits)) & indexMask];
            if (level === 0) continue;
            const cell = lightIndex(x, y, z);
            if (this.levels[cell] >= level) continue;
            this.mark(cell, level);
            this.push(level, cell);
          }
        }
      }
    }
    this.spread(voxelAt);
  }

  // Sweeps the buckets from the brightest level down. A cell reached at level L is
  // reached from every brighter level first, so its final value is the first one
  // written and nothing is revisited.
  private spread(voxelAt: (x: number, y: number, z: number) => number): void {
    const levels = this.levels;
    const pad = LIGHT_PAD;
    const plane = pad * pad;
    for (let level = LIGHT_MAX; level > 1; level--) {
      const bucket = this.buckets[level];
      const n = this.bucketCount[level];
      const next = level - 1;
      for (let i = 0; i < n; i++) {
        const cell = bucket[i];
        // Padded coordinates back out of the index, to keep the fill inside the grid.
        const y = ((cell / plane) | 0) - LIGHT_REACH;
        const rest = cell - (y + LIGHT_REACH) * plane;
        const z = ((rest / pad) | 0) - LIGHT_REACH;
        const x = rest - (z + LIGHT_REACH) * pad - LIGHT_REACH;
        for (let s = 0; s < 6; s++) {
          const axis = FACE_AXIS[s], sign = FACE_SIGN[s];
          const at = axis === 0 ? x : axis === 1 ? y : z;
          if (at + sign < -LIGHT_REACH || at + sign > 31 + LIGHT_REACH) continue;
          const to = cell + STEPS[s];
          if (levels[to] >= next) continue;
          const nx = axis === 0 ? x + sign : x;
          const ny = axis === 1 ? y + sign : y;
          const nz = axis === 2 ? z + sign : z;
          // Light stops at opaque blocks. It still lights their faces: what a face
          // reads is the cell in front of it, which is the one the fill was in.
          if (BLOCK_OPAQUE[voxelAt(nx, ny, nz)] !== 0) continue;
          this.mark(to, next);
          this.push(next, to);
        }
      }
    }
  }
}

// Light of the `face` face of voxel (x, y, z), packed as the quad carries it: the four
// corners' levels as a base (the smallest) and three-step offsets above it. Corners are
// in quadCorners() order, the same as the AO byte's.
//
// Returns (base) | (offsets << 4): base in bits 0-3, corner k's offset at bits 4 + 2k.
// A corner more than three levels above the base is clamped to the base plus three,
// which is a one-level error at the foot of a light and invisible against the ramp.
export function faceLight(levels: Uint8Array, x: number, y: number, z: number, face: number): number {
  const su = LIGHT_STRIDE[FACE_U[face]];
  const sv = LIGHT_STRIDE[FACE_V[face]];
  // The cell in front of the face, as faceAo() reads it.
  const n = lightIndex(x, y, z) + FACE_SIGN[face] * LIGHT_STRIDE[FACE_AXIS[face]];
  const c = levels[n];
  const u0 = levels[n - su], u1 = levels[n + su];
  const v0 = levels[n - sv], v1 = levels[n + sv];
  const a0 = cornerLight(c, u0, v0, levels[n - su - sv]);
  const a1 = cornerLight(c, u1, v0, levels[n + su - sv]);
  const a2 = cornerLight(c, u1, v1, levels[n + su + sv]);
  const a3 = cornerLight(c, u0, v1, levels[n - su + sv]);
  const base = Math.min(a0, a1, a2, a3);
  return base |
    (Math.min(3, a0 - base) << 4) |
    (Math.min(3, a1 - base) << 6) |
    (Math.min(3, a2 - base) << 8) |
    (Math.min(3, a3 - base) << 10);
}

// A corner's level: the mean of the four cells that meet at it, rounded down. Averaging
// is what turns a staircase of levels into a ramp once the vertex stage interpolates it.
function cornerLight(centre: number, side1: number, side2: number, corner: number): number {
  return (centre + side1 + side2 + corner) >> 2;
}

// Packed light of a quad with no lights near it.
export const LIGHT_NONE = 0;
