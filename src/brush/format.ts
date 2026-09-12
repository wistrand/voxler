// Brush binary formats (plan-world-modelling phase 1). Pure: no DOM, no GPU.
// Layouts owned by agent_docs/design-formats.md "Brush instance" and "Brush ops";
// change an encoder and its decoder (here, the CPU field fold, and the WGSL fold)
// in the same change.
//
// Three brush kinds. SDF is a WGSL function per type with parameters in the op
// pool; CSG is an interpreted list of primitive and blend ops and is still a field;
// voxel is an ordered list of voxel writes and exists only after voxelization.

import { codeSign, codeSource, INVERSE_CODES, ORIENTATION_CODES } from "./orientation.ts";

export const BRUSH_SDF = 0;
export const BRUSH_CSG = 1;
export const BRUSH_VOXEL = 2;

export const BLEND_UNION = 0;
export const BLEND_SUBTRACT = 1;
export const BLEND_INTERSECT = 2;
export const BLEND_SMIN = 3;
export const BLEND_SMAX = 4;

// CSG primitives, mirroring src/sdf/lib.wgsl. Every op carries a blend radius and a
// local center, then these parameters. `bezier tube` is not here yet: its CPU mirror is long and no
// brush needs it (plan-world-modelling "Open questions").
export const PRIM_SPHERE = 0;
export const PRIM_BOX = 1;
export const PRIM_ROUND_BOX = 2;
export const PRIM_TORUS = 3;
export const PRIM_CAPSULE = 4;
export const PRIM_CYLINDER = 5;
export const PRIM_ELLIPSOID = 6;
export const PRIM_COUNT = 7;

// Parameter words after the center, per primitive.
export const PRIM_PARAMS: readonly number[] = [1, 3, 4, 2, 7, 2, 3];

// Bound on |gradient| per primitive. The exact ones are 1; the ellipsoid's formula
// is a bound near the surface, not a distance, and its gradient grows with the
// radius ratio, so the store raises this per instance from the actual radii.
// Estimates, not proofs: the conservative-classification test is what catches a
// wrong one (CLAUDE.md "Invariants").
export const PRIM_LIPSCHITZ: readonly number[] = [1, 1, 1, 1, 1, 1, 1];

// header, blend radius k, then the local center.
export const CSG_HEADER_WORDS = 5;

export function csgOpWords(prim: number): number {
  return CSG_HEADER_WORDS + PRIM_PARAMS[prim];
}

export function packCsgHeader(blend: number, prim: number, material: number): number {
  return (blend & 0xff) | ((prim & 0xff) << 8) | ((material & 0xffff) << 16);
}

export function csgBlend(header: number): number {
  return header & 0xff;
}

export function csgPrim(header: number): number {
  return (header >>> 8) & 0xff;
}

export function csgMaterial(header: number): number {
  return (header >>> 16) & 0xffff;
}

// Voxel op modes and shapes. Two header words, then integer local coordinates.
export const VOXEL_SET = 0; // write `id`
export const VOXEL_CARVE = 1; // write air
export const VOXEL_REPLACE = 2; // write `id` only where the voxel is `match`
export const VOXEL_PAINT = 3; // write `id` only where the voxel is not air

export const SHAPE_VOXEL = 0;
export const SHAPE_BOX = 1;
export const SHAPE_SPHERE = 2;
export const SHAPE_ELLIPSOID = 3;
export const SHAPE_COUNT = 4;

// Integer words after the two header words, per shape.
export const SHAPE_PARAMS: readonly number[] = [3, 6, 4, 6];

export const VOXEL_HEADER_WORDS = 2;

export function voxelOpWords(shape: number): number {
  return VOXEL_HEADER_WORDS + SHAPE_PARAMS[shape];
}

export function packVoxelHeader(mode: number, shape: number, id: number): number {
  return (mode & 0xff) | ((shape & 0xff) << 8) | ((id & 0xffff) << 16);
}

export function voxelMode(header: number): number {
  return header & 0xff;
}

export function voxelShape(header: number): number {
  return (header >>> 8) & 0xff;
}

export function voxelId(header: number): number {
  return (header >>> 16) & 0xffff;
}

// One brush instance, 16 u32 (64 bytes, four vec4 loads):
//
//   0   cell.x                                        i32
//   1   cell.y                                        i32
//   2   cell.z                                        i32
//   3   inverse rotation 0-8, rotation 9-17, kind 18-19, blend 20-22
//   4   SDF type 0-15, material 16-31
//   5   ops offset, words into the pool                u32
//   6   ops count 0-15, Lipschitz bound 16-31 (8.8 fixed)
//   7   uniform scale                                  f32
//   8-10  local box min                                f32
//   11-13 local box max                                f32
//   14  blend radius k (smin, smax)                    f32
//   15  sequence number                                 u32
export const INSTANCE_WORDS = 16;
export const LIPSCHITZ_SCALE = 256; // 8.8 fixed point
export const LIPSCHITZ_MAX = 0xffff / LIPSCHITZ_SCALE;
export const MAX_OPS_WORDS = 0xffff;

// A growable word buffer with the three views a record needs. The views are
// replaced on growth, so never hold one across an `ensure`.
export class WordBuffer {
  u32: Uint32Array;
  i32: Int32Array;
  f32: Float32Array;
  private buffer: ArrayBuffer;

  constructor(words = 1024) {
    this.buffer = new ArrayBuffer(words * 4);
    this.u32 = new Uint32Array(this.buffer);
    this.i32 = new Int32Array(this.buffer);
    this.f32 = new Float32Array(this.buffer);
  }

  get words(): number {
    return this.u32.length;
  }

  // Grows to hold at least `words`, keeping the contents.
  ensure(words: number): void {
    if (words <= this.u32.length) return;
    let size = this.u32.length;
    while (size < words) size *= 2;
    const grown = new ArrayBuffer(size * 4);
    new Uint32Array(grown).set(this.u32);
    this.buffer = grown;
    this.u32 = new Uint32Array(grown);
    this.i32 = new Int32Array(grown);
    this.f32 = new Float32Array(grown);
  }
}

export interface InstanceFields {
  kind: number;
  blend: number;
  orientation: number; // 0..23
  type: number; // SDF brush type; 0 otherwise
  material: number;
  cellX: number;
  cellY: number;
  cellZ: number;
  scale: number;
  blendK: number;
  lipschitz: number;
  opsOffset: number;
  opsCount: number;
  // Order among instances: strictly increasing with creation, never reused, so the
  // field fold and the voxel journal replay in one definite order whatever the
  // instance ids are (they come from a free list).
  seq: number;
  localMin: ArrayLike<number>; // 3 entries
  localMax: ArrayLike<number>;
}

export function writeInstance(words: WordBuffer, at: number, f: InstanceFields): void {
  const { u32, i32, f32 } = words;
  i32[at] = f.cellX;
  i32[at + 1] = f.cellY;
  i32[at + 2] = f.cellZ;
  u32[at + 3] = (INVERSE_CODES[f.orientation] & 0x1ff) | ((ORIENTATION_CODES[f.orientation] & 0x1ff) << 9) |
    ((f.kind & 3) << 18) | ((f.blend & 7) << 20);
  u32[at + 4] = (f.type & 0xffff) | ((f.material & 0xffff) << 16);
  u32[at + 5] = f.opsOffset;
  const q = Math.min(0xffff, Math.round(f.lipschitz * LIPSCHITZ_SCALE));
  u32[at + 6] = (f.opsCount & 0xffff) | (q << 16);
  f32[at + 7] = f.scale;
  for (let i = 0; i < 3; i++) {
    f32[at + 8 + i] = f.localMin[i];
    f32[at + 11 + i] = f.localMax[i];
  }
  f32[at + 14] = f.blendK;
  u32[at + 15] = f.seq;
}

export function readInstance(words: WordBuffer, at: number, out: InstanceFields): InstanceFields {
  const { u32, i32, f32 } = words;
  out.cellX = i32[at];
  out.cellY = i32[at + 1];
  out.cellZ = i32[at + 2];
  const flags = u32[at + 3];
  out.kind = (flags >>> 18) & 3;
  out.blend = (flags >>> 20) & 7;
  out.orientation = orientationOfCode((flags >>> 9) & 0x1ff);
  out.type = u32[at + 4] & 0xffff;
  out.material = (u32[at + 4] >>> 16) & 0xffff;
  out.opsOffset = u32[at + 5];
  out.opsCount = u32[at + 6] & 0xffff;
  out.lipschitz = (u32[at + 6] >>> 16) / LIPSCHITZ_SCALE;
  out.scale = f32[at + 7];
  const min = out.localMin as number[];
  const max = out.localMax as number[];
  for (let i = 0; i < 3; i++) {
    min[i] = f32[at + 8 + i];
    max[i] = f32[at + 11 + i];
  }
  out.blendK = f32[at + 14];
  out.seq = u32[at + 15];
  return out;
}

const CODE_TO_ORIENTATION = (() => {
  const map = new Map<number, number>();
  for (let o = 0; o < ORIENTATION_CODES.length; o++) map.set(ORIENTATION_CODES[o], o);
  return map;
})();

export function orientationOfCode(code: number): number {
  const o = CODE_TO_ORIENTATION.get(code);
  if (o === undefined) throw new Error(`orientation code ${code} is not one of the 24`);
  return o;
}

export function newInstanceFields(): InstanceFields {
  return {
    kind: BRUSH_CSG,
    blend: BLEND_UNION,
    orientation: 0,
    type: 0,
    material: 0,
    cellX: 0,
    cellY: 0,
    cellZ: 0,
    scale: 1,
    blendK: 0,
    lipschitz: 1,
    opsOffset: 0,
    opsCount: 0,
    seq: 0,
    localMin: [0, 0, 0],
    localMax: [0, 0, 0],
  };
}

// The local box a CSG op list covers, and its Lipschitz bound. Every op contributes
// its own bounds whatever its blend mode: a subtract op only removes inside its
// shape, and a smooth blend reaches `k` beyond it, which the instance's blendK
// covers. Writes min into out[0..2] and max into out[3..5]; returns the bound.
export function csgBounds(pool: WordBuffer, offset: number, count: number, out: Float64Array): number {
  const f32 = pool.f32;
  const u32 = pool.u32;
  for (let i = 0; i < 3; i++) {
    out[i] = Infinity;
    out[3 + i] = -Infinity;
  }
  let lipschitz = 1;
  let at = offset;
  const end = offset + count;
  const half = [0, 0, 0];
  while (at < end) {
    const prim = csgPrim(u32[at]);
    if (prim >= PRIM_COUNT) throw new Error(`csg op at ${at} has primitive ${prim}`);
    const k = f32[at + 1];
    const c = at + 2;
    const p = at + CSG_HEADER_WORDS;
    let lip = PRIM_LIPSCHITZ[prim];
    switch (prim) {
      case PRIM_SPHERE:
        half[0] = half[1] = half[2] = f32[p];
        break;
      case PRIM_BOX:
        half[0] = f32[p];
        half[1] = f32[p + 1];
        half[2] = f32[p + 2];
        break;
      case PRIM_ROUND_BOX:
        for (let i = 0; i < 3; i++) half[i] = Math.max(f32[p + i], f32[p + 3]);
        break;
      case PRIM_TORUS:
        half[0] = half[2] = f32[p] + f32[p + 1];
        half[1] = f32[p + 1];
        break;
      case PRIM_CAPSULE: {
        const r = f32[p + 6];
        for (let i = 0; i < 3; i++) half[i] = Math.max(Math.abs(f32[p + i]), Math.abs(f32[p + 3 + i])) + r;
        break;
      }
      case PRIM_CYLINDER:
        half[0] = half[2] = f32[p + 1];
        half[1] = f32[p];
        break;
      default: { // PRIM_ELLIPSOID
        let lo = Infinity;
        let hi = 0;
        for (let i = 0; i < 3; i++) {
          half[i] = f32[p + i];
          lo = Math.min(lo, f32[p + i]);
          hi = Math.max(hi, f32[p + i]);
        }
        // The bound formula's gradient grows with the radius ratio (lib.wgsl
        // "Not an exact distance"). Estimated, not proved.
        lip = lo > 0 ? hi / lo : LIPSCHITZ_MAX;
        break;
      }
    }
    // A smooth blend reaches k beyond the primitive's own surface.
    const reach = csgBlend(u32[at]) === BLEND_SMIN || csgBlend(u32[at]) === BLEND_SMAX ? k : 0;
    for (let i = 0; i < 3; i++) {
      out[i] = Math.min(out[i], f32[c + i] - half[i] - reach);
      out[3 + i] = Math.max(out[3 + i], f32[c + i] + half[i] + reach);
    }
    lipschitz = Math.max(lipschitz, lip);
    at += csgOpWords(prim);
  }
  if (at !== end) throw new Error(`csg op list at ${offset} ends at ${at}, expected ${end}`);
  if (count === 0) for (let i = 0; i < 6; i++) out[i] = 0;
  return Math.min(lipschitz, LIPSCHITZ_MAX);
}

// The inclusive voxel range one op writes, into out[0..2] and out[3..5]. `words` is
// any view holding the op at `at`.
export function voxelOpRange(i32: Int32Array, u32: Uint32Array, at: number, out: Int32Array): void {
  const shape = voxelShape(u32[at]);
  if (shape >= SHAPE_COUNT) throw new Error(`voxel op at ${at} has shape ${shape}`);
  const p = at + VOXEL_HEADER_WORDS;
  for (let i = 0; i < 3; i++) {
    switch (shape) {
      case SHAPE_VOXEL:
        out[i] = out[3 + i] = i32[p + i];
        break;
      case SHAPE_BOX:
        out[i] = Math.min(i32[p + i], i32[p + 3 + i]);
        out[3 + i] = Math.max(i32[p + i], i32[p + 3 + i]);
        break;
      case SHAPE_SPHERE:
        out[i] = i32[p + i] - i32[p + 3];
        out[3 + i] = i32[p + i] + i32[p + 3];
        break;
      default: // SHAPE_ELLIPSOID
        out[i] = i32[p + i] - i32[p + 3 + i];
        out[3 + i] = i32[p + i] + i32[p + 3 + i];
        break;
    }
  }
}

// The local box a voxel op list covers, in voxels. Inclusive voxel ranges become a
// half-open box, so the field-stage box rules apply unchanged. Writes min into
// out[0..2] and max into out[3..5].
export function voxelBounds(pool: WordBuffer, offset: number, count: number, out: Float64Array): void {
  for (let i = 0; i < 3; i++) {
    out[i] = Infinity;
    out[3 + i] = -Infinity;
  }
  let at = offset;
  const end = offset + count;
  while (at < end) {
    voxelOpRange(pool.i32, pool.u32, at, RANGE);
    for (let i = 0; i < 3; i++) {
      out[i] = Math.min(out[i], RANGE[i]);
      out[3 + i] = Math.max(out[3 + i], RANGE[3 + i] + 1); // voxel (lo..hi) spans [lo, hi + 1)
    }
    at += voxelOpWords(voxelShape(pool.u32[at]));
  }
  if (at !== end) throw new Error(`voxel op list at ${offset} ends at ${at}, expected ${end}`);
  if (count === 0) for (let i = 0; i < 6; i++) out[i] = 0;
}

const RANGE = new Int32Array(6);

// Unpacks a record's rotation codes; `codeSource`/`codeSign` read them.
export function instanceRotation(words: WordBuffer, at: number): number {
  return (words.u32[at + 3] >>> 9) & 0x1ff;
}

export function instanceInverseRotation(words: WordBuffer, at: number): number {
  return words.u32[at + 3] & 0x1ff;
}

export { codeSign, codeSource };
