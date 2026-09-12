// Coverage maps: which unit faces a mesh covers, and with which block id. Two
// meshes are equivalent when their maps are identical, however they merged faces.
// This is how greedy output is checked against the reference mesher. Pure; test
// and debug use only.
//
// Map layout: FACE_COUNT x 32768 u16, entry [face * 32768 + voxelIndex] = block id
// of the quad covering that voxel's face, 0 when uncovered.

import { CHUNK_VOLUME, voxelIndex } from "../world/coords.ts";
import { decodeQuad, FACE_COUNT, FACE_U, FACE_V, type Mesh, newQuad } from "./quad.ts";

export interface Coverage {
  map: Uint16Array;
  overlaps: number; // unit faces covered by more than one quad
  outOfBounds: number; // quads extending past the chunk
  faceMismatches: number; // quads stored in the wrong face group
}

export function coverage(mesh: Mesh): Coverage {
  const map = new Uint16Array(FACE_COUNT * CHUNK_VOLUME);
  const q = newQuad();
  const p = [0, 0, 0];
  let overlaps = 0;
  let outOfBounds = 0;
  let faceMismatches = 0;
  for (let face = 0; face < FACE_COUNT; face++) {
    for (let i = mesh.groupStart[face]; i < mesh.groupStart[face + 1]; i++) {
      decodeQuad(mesh.quads[i * 2], mesh.quads[i * 2 + 1], q);
      if (q.face !== face) faceMismatches++;
      const u = FACE_U[q.face];
      const v = FACE_V[q.face];
      for (let dv = 0; dv < q.h; dv++) {
        for (let du = 0; du < q.w; du++) {
          p[0] = q.x;
          p[1] = q.y;
          p[2] = q.z;
          p[u] += du;
          p[v] += dv;
          if (p[u] > 31 || p[v] > 31) {
            outOfBounds++;
            continue;
          }
          const k = q.face * CHUNK_VOLUME + voxelIndex(p[0], p[1], p[2]);
          if (map[k] !== 0) overlaps++;
          map[k] = q.id;
        }
      }
    }
  }
  return { map, overlaps, outOfBounds, faceMismatches };
}

// null when the maps match; otherwise a description of the first difference.
export function diffCoverage(expected: Uint16Array, actual: Uint16Array): string | null {
  for (let k = 0; k < expected.length; k++) {
    if (expected[k] !== actual[k]) {
      const face = Math.floor(k / CHUNK_VOLUME);
      const i = k % CHUNK_VOLUME;
      const x = i & 31, z = (i >>> 5) & 31, y = i >>> 10;
      return `face ${face} at voxel (${x}, ${y}, ${z}): expected id ${expected[k]}, got ${actual[k]}`;
    }
  }
  return null;
}
