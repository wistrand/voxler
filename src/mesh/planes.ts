// Neighbor boundary planes: for each face of a chunk, which voxels of the adjacent
// chunk's touching layer are opaque. They let a mesher cull faces on chunk borders
// without the neighbors' full data (the 64-bit binary mesher pads chunks instead;
// JS has no fast u64, see agent_docs/research-voxel-rendering.md). Pure.
//
// Layout: 6 planes x 32 u32 in one Uint32Array. In plane f, bit u of word v is the
// neighbor voxel at tangent coordinates (u, v) = (coordinate along FACE_U[f],
// coordinate along FACE_V[f]).

import { BLOCK_OPAQUE } from "../world/blocks.ts";
import type { ChunkData } from "../world/chunk.ts";
import { voxelIndex } from "../world/coords.ts";
import { FACE_AXIS, FACE_COUNT, FACE_SIGN, FACE_U, FACE_V } from "./quad.ts";
import { RowReader } from "./rows.ts";

export const PLANE_WORDS = 32;

export function newPlanes(): Uint32Array {
  return new Uint32Array(FACE_COUNT * PLANE_WORDS);
}

// Fills plane `face` from the neighbor across that face. null (not loaded) reads
// as all empty, so border faces are emitted; meshing waits for neighbors anyway
// (plan-voxel-data "Neighbor readiness").
export function setPlane(planes: Uint32Array, face: number, neighbor: ChunkData | null): void {
  const base = face * PLANE_WORDS;
  if (neighbor === null) {
    planes.fill(0, base, base + PLANE_WORDS);
    return;
  }
  if (neighbor.isUniform) {
    planes.fill(BLOCK_OPAQUE[neighbor.uniformId] ? 0xffffffff : 0, base, base + PLANE_WORDS);
    return;
  }
  // The neighbor's layer touching us: x = 0 of the +X neighbor, x = 31 of the -X one.
  // Read from the packed indices (rows.ts): a Y or Z layer is 32 whole rows; an X
  // layer is one voxel per row.
  const layer = FACE_SIGN[face] > 0 ? 0 : 31;
  reader.beginOpaque(neighbor);
  switch (FACE_AXIS[face]) {
    case 0: // (u, v) = (z, y): voxel (layer, y, z)
      for (let y = 0; y < 32; y++) {
        let word = 0;
        for (let z = 0; z < 32; z++) word |= reader.voxel(layer + 32 * z + 1024 * y) << z;
        planes[base + y] = word;
      }
      break;
    case 1: // (u, v) = (x, z): row (z, layer)
      for (let z = 0; z < 32; z++) planes[base + z] = reader.row(z + 32 * layer);
      break;
    default: // (u, v) = (x, y): row (layer, y)
      for (let y = 0; y < 32; y++) planes[base + y] = reader.row(layer + 32 * y);
  }
}

const reader = new RowReader();

// Border ids: the neighbors' touching layers as block ids, for translucent culling
// (a translucent face is hidden by the same id across the border). 6 x 1024 u16;
// entry [face * 1024 + v * 32 + u], same (u, v) as the planes.
export const BORDER_IDS = 1024;

export function newBorders(): Uint16Array {
  return new Uint16Array(FACE_COUNT * BORDER_IDS);
}

// Fills border `face` from the neighbor across it; null (not loaded) reads as air.
export function setBorder(borders: Uint16Array, face: number, neighbor: ChunkData | null): void {
  const base = face * BORDER_IDS;
  if (neighbor === null || neighbor.isUniform) {
    borders.fill(neighbor === null ? 0 : neighbor.uniformId, base, base + BORDER_IDS);
    return;
  }
  const p = [0, 0, 0];
  p[FACE_AXIS[face]] = FACE_SIGN[face] > 0 ? 0 : 31;
  const u = FACE_U[face];
  const v = FACE_V[face];
  for (let pv = 0; pv < 32; pv++) {
    p[v] = pv;
    for (let pu = 0; pu < 32; pu++) {
      p[u] = pu;
      borders[base + pv * 32 + pu] = neighbor.get(voxelIndex(p[0], p[1], p[2]));
    }
  }
}

// All six planes set to one state: every neighbor empty (false) or opaque (true).
export function uniformPlanes(opaque: boolean): Uint32Array {
  return newPlanes().fill(opaque ? 0xffffffff : 0);
}

export function planeBit(planes: Uint32Array, face: number, u: number, v: number): boolean {
  return ((planes[face * PLANE_WORDS + v] >>> u) & 1) === 1;
}
