// Packed quad format, TS side. Layout owned by agent_docs/design-formats.md "Packed
// quad"; the vertex shader decode (plan-rendering) must mirror decodeQuad() and
// quadCorners() exactly. Pure.
//
// word0: x 0-4, y 5-9, z 10-14, (w-1) 15-19, (h-1) 20-24, face 25-27, light base 28-31
// word1: block id 0-15, AO 16-23, light offsets 24-31
//
// Light is split across the two words because it needs twelve bits and neither word has
// twelve spare: the quad's lowest corner level (0-15) in word0, and each corner's step
// above it (0-3) in word1. `light` here is the packed pair faceLight() produces, base in
// bits 0-3 and corner k's offset at bits 4 + 2k.

export const FACE_POS_X = 0;
export const FACE_NEG_X = 1;
export const FACE_POS_Y = 2;
export const FACE_NEG_Y = 3;
export const FACE_POS_Z = 4;
export const FACE_NEG_Z = 5;
export const FACE_COUNT = 6;

// Per face: the axis it faces along (0 x, 1 y, 2 z), its sign, and its two tangent
// axes. w extends along U, h along V. X faces use (z, y), Y faces (x, z), Z faces
// (x, y).
export const FACE_AXIS: readonly number[] = [0, 0, 1, 1, 2, 2];
export const FACE_SIGN: readonly number[] = [1, -1, 1, -1, 1, -1];
export const FACE_U: readonly number[] = [2, 2, 0, 0, 0, 0];
export const FACE_V: readonly number[] = [1, 1, 2, 2, 1, 1];

export interface Quad {
  x: number; // min-corner voxel, local 0..31
  y: number;
  z: number;
  w: number; // 1..32 along FACE_U
  h: number; // 1..32 along FACE_V
  face: number;
  id: number; // block id
  ao: number; // 8 bits, 2 per corner
  light: number; // 12 bits: base 0-3, corner offsets 4-11 (src/mesh/light.ts)
}

export function newQuad(): Quad {
  return { x: 0, y: 0, z: 0, w: 1, h: 1, face: 0, id: 0, ao: 0, light: 0 };
}

export function encodeWord0(
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  face: number,
  light = 0,
): number {
  return (x | (y << 5) | (z << 10) | ((w - 1) << 15) | ((h - 1) << 20) | (face << 25) | ((light & 15) << 28)) >>> 0;
}

export function encodeWord1(id: number, ao: number, light = 0): number {
  return (id | (ao << 16) | ((light >>> 4) << 24)) >>> 0;
}

export function decodeQuad(word0: number, word1: number, out: Quad): Quad {
  out.x = word0 & 31;
  out.y = (word0 >>> 5) & 31;
  out.z = (word0 >>> 10) & 31;
  out.w = ((word0 >>> 15) & 31) + 1;
  out.h = ((word0 >>> 20) & 31) + 1;
  out.face = (word0 >>> 25) & 7;
  out.id = word1 & 0xffff;
  out.ao = (word1 >>> 16) & 0xff;
  out.light = ((word0 >>> 28) & 15) | (((word1 >>> 24) & 0xff) << 4);
  return out;
}

// The quad's four corners in chunk-local voxel units, as the vertex shader will
// compute them: the min corner, moved one voxel along the normal for positive
// faces, then + w*U, + w*U + h*V, + h*V. Writes 12 numbers (4 x xyz) into `out`.
export function quadCorners(q: Quad, out: Float64Array): Float64Array {
  const base = [q.x, q.y, q.z];
  if (FACE_SIGN[q.face] > 0) base[FACE_AXIS[q.face]] += 1;
  const u = FACE_U[q.face];
  const v = FACE_V[q.face];
  for (let c = 0; c < 4; c++) {
    const p = [base[0], base[1], base[2]];
    if (c === 1 || c === 2) p[u] += q.w;
    if (c === 2 || c === 3) p[v] += q.h;
    out[c * 3] = p[0];
    out[c * 3 + 1] = p[1];
    out[c * 3 + 2] = p[2];
  }
  return out;
}

// A quad's two triangles as 6 corner indices (quadCorners() order), counter-clockwise
// seen from outside the face (from where its normal points). U x V points against
// the normal on faces 0 (+X), 2 (+Y) and 5 (-Z), so those use the flipped order.
// The vertex shader (src/render/near.wgsl) mirrors these tables.
export const QUAD_TRIANGLES: readonly number[] = [0, 1, 2, 0, 2, 3];
export const QUAD_TRIANGLES_FLIPPED: readonly number[] = [0, 2, 1, 0, 3, 2];
export const FACE_FLIP_MASK = 0b100101;

// A mesh as meshers produce it: packed quads grouped by face (all of face 0, then
// face 1, ...). groupStart[f] is the first quad of face f; groupStart[6] = count.
export interface Mesh {
  quads: Uint32Array; // 2 words per quad; may be longer than 2 * count
  count: number;
  groupStart: Int32Array; // FACE_COUNT + 1 entries
}
