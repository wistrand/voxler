// Reference mesher: one 1x1 quad per visible face. Deliberately simple and slow; it
// is the correctness oracle for the greedy mesher and is never deleted (CLAUDE.md
// "Invariants"). Pure.
//
// Opaque faces (meshReference): the voxel is opaque and the voxel across the face is
// not (inside the chunk, or in the neighbor plane on the border).
// Translucent faces (meshReferenceTranslucent, plan-meshing phase 6): the voxel is
// translucent and the voxel across the face is neither opaque nor the same id. On
// the border, opacity comes from the planes and the id from the border ids (null:
// never the same id).

import { BLOCK_OPAQUE, BLOCK_TRANSLUCENT } from "../world/blocks.ts";
import { CHUNK_VOLUME, voxelIndex } from "../world/coords.ts";
import { BORDER_IDS, planeBit } from "./planes.ts";
import { encodeWord0, encodeWord1, FACE_AXIS, FACE_COUNT, FACE_SIGN, FACE_U, FACE_V, type Mesh } from "./quad.ts";

export function meshReference(ids: Uint16Array, planes: Uint32Array): Mesh {
  return referenceMesh(ids, planes, null, false);
}

export function meshReferenceTranslucent(ids: Uint16Array, planes: Uint32Array, borders: Uint16Array | null): Mesh {
  return referenceMesh(ids, planes, borders, true);
}

function referenceMesh(ids: Uint16Array, planes: Uint32Array, borders: Uint16Array | null, translucent: boolean): Mesh {
  let quads = new Uint32Array(8192);
  let count = 0;
  const groupStart = new Int32Array(FACE_COUNT + 1);
  const p = [0, 0, 0];
  const kind = translucent ? BLOCK_TRANSLUCENT : BLOCK_OPAQUE;
  for (let face = 0; face < FACE_COUNT; face++) {
    groupStart[face] = count;
    const axis = FACE_AXIS[face];
    const sign = FACE_SIGN[face];
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      const id = ids[i];
      if (!kind[id]) continue;
      p[0] = i & 31;
      p[2] = (i >>> 5) & 31;
      p[1] = i >>> 10;
      const n = p[axis] + sign;
      let covered: boolean;
      if (n >= 0 && n < 32) {
        const saved = p[axis];
        p[axis] = n;
        const across = ids[voxelIndex(p[0], p[1], p[2])];
        p[axis] = saved;
        covered = BLOCK_OPAQUE[across] === 1 || (translucent && across === id);
      } else {
        const u = p[FACE_U[face]], v = p[FACE_V[face]];
        covered = planeBit(planes, face, u, v) ||
          (translucent && borders !== null && borders[face * BORDER_IDS + v * 32 + u] === id);
      }
      if (covered) continue;
      if (count * 2 + 2 > quads.length) {
        const grown = new Uint32Array(quads.length * 2);
        grown.set(quads);
        quads = grown;
      }
      quads[count * 2] = encodeWord0(p[0], p[1], p[2], 1, 1, face);
      quads[count * 2 + 1] = encodeWord1(id, 0);
      count++;
    }
  }
  groupStart[FACE_COUNT] = count;
  return { quads, count, groupStart };
}
