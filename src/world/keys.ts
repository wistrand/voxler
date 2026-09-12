// Chunk keys: (cx, cy, cz) packed into one JS number (53 bits), so chunk lookups
// index typed-array tables instead of string or object keys. Layout owned by
// agent_docs/design-formats.md "Coordinate spaces": cx and cz 21 bits each, cy 11
// bits, each offset to unsigned; x in the high bits, y in the low bits.

import { hash32 } from "../util/random.ts";

const XZ_RANGE = 2 ** 21;
const Y_RANGE = 2 ** 11;
const XZ_OFFSET = XZ_RANGE / 2;
const Y_OFFSET = Y_RANGE / 2;

export const CHUNK_XZ_MIN = -XZ_OFFSET;
export const CHUNK_XZ_MAX = XZ_OFFSET - 1;
export const CHUNK_Y_MIN = -Y_OFFSET;
export const CHUNK_Y_MAX = Y_OFFSET - 1;

export function chunkInRange(cx: number, cy: number, cz: number): boolean {
  return cx >= CHUNK_XZ_MIN && cx <= CHUNK_XZ_MAX && cz >= CHUNK_XZ_MIN && cz <= CHUNK_XZ_MAX &&
    cy >= CHUNK_Y_MIN && cy <= CHUNK_Y_MAX;
}

// Non-negative integer below 2^53. Coordinates must be in range (chunkInRange).
export function chunkKey(cx: number, cy: number, cz: number): number {
  return ((cx + XZ_OFFSET) * XZ_RANGE + (cz + XZ_OFFSET)) * Y_RANGE + (cy + Y_OFFSET);
}

export function keyX(key: number): number {
  return Math.floor(key / (XZ_RANGE * Y_RANGE)) - XZ_OFFSET;
}

export function keyY(key: number): number {
  return (key % Y_RANGE) - Y_OFFSET;
}

export function keyZ(key: number): number {
  return (Math.floor(key / Y_RANGE) % XZ_RANGE) - XZ_OFFSET;
}

// 32-bit hash of a key for table indexing. `>>> 0` takes the value mod 2^32, which
// is exact for integers below 2^53.
export function hashKey(key: number): number {
  const lo = key >>> 0;
  const hi = (key / 4294967296) >>> 0;
  return hash32(lo ^ Math.imul(hi, 0x9e3779b1));
}
