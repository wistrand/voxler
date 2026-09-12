// Stateless seeded randomness: the value depends only on (seed, index), so any
// sample can be computed in any order without shared state. Not cryptographic.

// 32-bit integer hash (lowbias32 by Chris Wellons).
export function hash32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

// Uniform in [0, 1) for a (seed, index) pair.
export function random01(seed: number, index: number): number {
  return hash32(hash32(seed >>> 0) ^ (index >>> 0)) / 4294967296;
}
