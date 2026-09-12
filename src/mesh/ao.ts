// Baked per-vertex ambient occlusion (plan-meshing phase 5 spike, Lysenko's
// "Ambient occlusion for Minecraft-like worlds"). Pure.
//
// AO reads opacity from a padded 34^3 byte grid: the chunk at 0..31 plus a one-voxel
// shell (-1 and 32) taken from all 26 neighbors. Faces on the chunk border need the
// shell's edges and corners, not just the six face planes.
//
// Per face, the four corners in quadCorners() order (0 min, 1 +U, 2 +U+V, 3 +V),
// 2 bits each, corner k at bits 2k of the AO byte (word1 bits 16-23). Each value is
// the occlusion level: 0 unoccluded, 3 fully occluded (the inverse of Lysenko's
// light level), so a mesh built without AO reads as unoccluded. The vertex shader
// flips the triangulation by these values (gotchas.md "AO anisotropy").

import { BLOCK_OPAQUE } from "../world/blocks.ts";
import type { ChunkData } from "../world/chunk.ts";
import { voxelIndex } from "../world/coords.ts";
import { ALL_NEIGHBORS, NEIGHBOR_OFFSETS } from "./neighbors.ts";
import { FACE_AXIS, FACE_SIGN, FACE_U, FACE_V } from "./quad.ts";

export const PAD = 34;
export const PAD_VOLUME = PAD * PAD * PAD;
export const AO_UNOCCLUDED = 0;

// Index into the padded grid; coordinates -1..32. Same axis order as voxelIndex.
export function padIndex(x: number, y: number, z: number): number {
  return x + 1 + (z + 1) * PAD + (y + 1) * PAD * PAD;
}

// Padded-grid index step for each axis.
const PAD_STRIDE: readonly number[] = [1, PAD * PAD, PAD];

// Occlusion of one corner from its two side neighbors and the diagonal between them
// (each 0 or 1). Two sides occlude fully whatever the diagonal is.
export function vertexAo(side1: number, side2: number, corner: number): number {
  return side1 !== 0 && side2 !== 0 ? 3 : side1 + side2 + corner;
}

// AO byte of the `face` face of voxel (x, y, z), reading `padded` (0 air, 1 opaque).
export function faceAo(padded: Uint8Array, x: number, y: number, z: number, face: number): number {
  const su = PAD_STRIDE[FACE_U[face]];
  const sv = PAD_STRIDE[FACE_V[face]];
  // The air cell in front of the face; its U/V neighbors decide the corners.
  const n = padIndex(x, y, z) + FACE_SIGN[face] * PAD_STRIDE[FACE_AXIS[face]];
  const u0 = padded[n - su], u1 = padded[n + su];
  const v0 = padded[n - sv], v1 = padded[n + sv];
  const a0 = vertexAo(u0, v0, padded[n - su - sv]);
  const a1 = vertexAo(u1, v0, padded[n + su - sv]);
  const a2 = vertexAo(u1, v1, padded[n + su + sv]);
  const a3 = vertexAo(u0, v1, padded[n - su + sv]);
  return a0 | (a1 << 2) | (a2 << 4) | (a3 << 6);
}

// Writes the whole shell from the 26 neighbor chunks (neighbors.ts order): each
// neighbor covers the face, edge, or corner region of the shell that touches it.
// A missing neighbor reads as air. The interior is left alone; the mesher fills it.
export function fillShell(padded: Uint8Array, neighborAt: (i: number) => ChunkData | null): void {
  for (let i = 0; i < ALL_NEIGHBORS; i++) {
    const dx = NEIGHBOR_OFFSETS[i * 3], dy = NEIGHBOR_OFFSETS[i * 3 + 1], dz = NEIGHBOR_OFFSETS[i * 3 + 2];
    const chunk = neighborAt(i);
    // The shell cells this neighbor owns: pinned to -1 or 32 on its axes, the
    // chunk's own range on the others. Its source voxel is 32 back along each.
    const x0 = dx === 0 ? 0 : dx > 0 ? 32 : -1, x1 = dx === 0 ? 31 : x0;
    const y0 = dy === 0 ? 0 : dy > 0 ? 32 : -1, y1 = dy === 0 ? 31 : y0;
    const z0 = dz === 0 ? 0 : dz > 0 ? 32 : -1, z1 = dz === 0 ? 31 : z0;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          let opaque = 0;
          if (chunk !== null) {
            opaque = BLOCK_OPAQUE[chunk.get(voxelIndex(x - dx * 32, y - dy * 32, z - dz * 32))];
          }
          padded[padIndex(x, y, z)] = opaque;
        }
      }
    }
  }
}

// Writes the shell's six face regions from neighbor planes (planes.ts layout), so
// the shell and the planes can't disagree. Edges and corners are left as they are.
export function shellFromPlanes(padded: Uint8Array, planes: Uint32Array): void {
  const p = [0, 0, 0];
  for (let face = 0; face < 6; face++) {
    const axis = FACE_AXIS[face];
    for (let v = 0; v < 32; v++) {
      const word = planes[face * 32 + v];
      for (let u = 0; u < 32; u++) {
        p[axis] = FACE_SIGN[face] > 0 ? 32 : -1;
        p[FACE_U[face]] = u;
        p[FACE_V[face]] = v;
        padded[padIndex(p[0], p[1], p[2])] = (word >>> u) & 1;
      }
    }
  }
}
