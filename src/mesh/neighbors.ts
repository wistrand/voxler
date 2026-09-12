// The 26 neighbor chunks of a chunk, in one fixed order: the six faces first (in
// FACE order, so the first six entries are the ones plain meshing needs), then the
// twelve edges and eight corners that baked AO reads (ao.ts "shell"). Pure.

import { FACE_AXIS, FACE_COUNT, FACE_SIGN } from "./quad.ts";

export const FACE_NEIGHBORS = FACE_COUNT;
export const ALL_NEIGHBORS = 26;

function buildOffsets(): Int8Array {
  const out = new Int8Array(ALL_NEIGHBORS * 3);
  for (let f = 0; f < FACE_COUNT; f++) out[f * 3 + FACE_AXIS[f]] = FACE_SIGN[f];
  let n = FACE_COUNT;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const axes = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (axes < 2) continue; // the centre and the six faces are already in
        out[n * 3] = dx;
        out[n * 3 + 1] = dy;
        out[n * 3 + 2] = dz;
        n++;
      }
    }
  }
  return out;
}

// [i * 3 + axis], each -1, 0 or 1.
export const NEIGHBOR_OFFSETS: Int8Array = buildOffsets();
