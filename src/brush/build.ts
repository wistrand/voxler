// Op-list builders (plan-world-modelling phase 1). Pure. These write the packed
// words format.ts reads; they exist so callers, tools, and tests never hand-pack
// words. Not a frame path: they allocate.

import {
  BLEND_UNION,
  CSG_HEADER_WORDS,
  csgOpWords,
  packCsgHeader,
  packVoxelHeader,
  PRIM_PARAMS,
  SHAPE_PARAMS,
  VOXEL_HEADER_WORDS,
  voxelOpWords,
} from "./format.ts";

export interface CsgOpSpec {
  prim: number;
  params: readonly number[]; // PRIM_PARAMS[prim] entries
  blend?: number; // how it folds onto the ops before it; the first op's is ignored
  material?: number; // block id where this op is the nearest surface
  k?: number; // blend radius for smin and smax
  center?: readonly [number, number, number];
}

export function packCsg(ops: readonly CsgOpSpec[]): Uint32Array {
  let words = 0;
  for (const op of ops) words += csgOpWords(op.prim);
  const buffer = new ArrayBuffer(words * 4);
  const u32 = new Uint32Array(buffer);
  const f32 = new Float32Array(buffer);
  let at = 0;
  for (const op of ops) {
    if (op.params.length !== PRIM_PARAMS[op.prim]) {
      throw new Error(`primitive ${op.prim} takes ${PRIM_PARAMS[op.prim]} parameters, got ${op.params.length}`);
    }
    u32[at] = packCsgHeader(op.blend ?? BLEND_UNION, op.prim, op.material ?? 0);
    f32[at + 1] = op.k ?? 0;
    const c = op.center ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) f32[at + 2 + i] = c[i];
    for (let i = 0; i < op.params.length; i++) f32[at + CSG_HEADER_WORDS + i] = op.params[i];
    at += csgOpWords(op.prim);
  }
  return u32;
}

export interface VoxelOpSpec {
  mode: number;
  shape: number;
  id?: number; // block id to write
  match?: number; // block id to match, for VOXEL_REPLACE
  params: readonly number[]; // SHAPE_PARAMS[shape] integer entries
}

export function packVoxel(ops: readonly VoxelOpSpec[]): Uint32Array {
  let words = 0;
  for (const op of ops) words += voxelOpWords(op.shape);
  const buffer = new ArrayBuffer(words * 4);
  const u32 = new Uint32Array(buffer);
  const i32 = new Int32Array(buffer);
  let at = 0;
  for (const op of ops) {
    if (op.params.length !== SHAPE_PARAMS[op.shape]) {
      throw new Error(`shape ${op.shape} takes ${SHAPE_PARAMS[op.shape]} parameters, got ${op.params.length}`);
    }
    u32[at] = packVoxelHeader(op.mode, op.shape, op.id ?? 0);
    u32[at + 1] = (op.match ?? 0) & 0xffff;
    for (let i = 0; i < op.params.length; i++) i32[at + VOXEL_HEADER_WORDS + i] = op.params[i];
    at += voxelOpWords(op.shape);
  }
  return u32;
}

// A CSG brush of one primitive, the shape a hand-placed field brush usually takes.
// `blend` is how it folds into the world (union, subtract or smooth union).
export function csgOne(
  prim: number,
  params: readonly number[],
  material = 0,
  k = 0,
): Uint32Array {
  return packCsg([{ prim, params, material, k }]);
}
