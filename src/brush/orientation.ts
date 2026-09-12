// The 24 rotations of the cube (plan-world-modelling phase 1). Pure.
//
// A rotation is a signed permutation: out[r] = sign(r) * v[source(r)], with
// determinant +1 (no mirrors). Packed into 9 bits so a shader can unpack it without
// a runtime-indexed table: for each output axis r, bits 3r..3r+1 hold the source
// axis and bit 3r+2 holds the sign (1 means negative).
//
// Orientation 0 is the identity. The inverse of a signed permutation is its
// transpose, so it is another of the 24 and needs no matrix work.

export const ORIENTATION_COUNT = 24;

// Axis permutations, and the parity of each (+1 even, -1 odd).
const PERMS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
const PARITY: readonly number[] = [1, -1, -1, 1, 1, -1];

export function packCode(source: readonly number[], sign: readonly number[]): number {
  let code = 0;
  for (let r = 0; r < 3; r++) code |= (source[r] | (sign[r] < 0 ? 4 : 0)) << (r * 3);
  return code;
}

// Source axis (0..2) feeding output axis r.
export function codeSource(code: number, r: number): number {
  return (code >>> (r * 3)) & 3;
}

// Sign (+1 or -1) applied to output axis r.
export function codeSign(code: number, r: number): number {
  return (code >>> (r * 3 + 2)) & 1 ? -1 : 1;
}

function build(): { codes: Int32Array; inverse: Uint8Array; inverseCodes: Int32Array } {
  const codes = new Int32Array(ORIENTATION_COUNT);
  let n = 0;
  for (let p = 0; p < PERMS.length; p++) {
    for (let s = 0; s < 8; s++) {
      const sign = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1];
      if (PARITY[p] * sign[0] * sign[1] * sign[2] !== 1) continue; // a mirror
      codes[n++] = packCode(PERMS[p], sign);
    }
  }
  if (n !== ORIENTATION_COUNT) throw new Error(`built ${n} orientations`);
  // Transpose: out[r] = sign[r] * v[source[r]] means v[source[r]] = sign[r] * out[r].
  const byCode = new Map<number, number>();
  for (let o = 0; o < n; o++) byCode.set(codes[o], o);
  const inverse = new Uint8Array(ORIENTATION_COUNT);
  const inverseCodes = new Int32Array(ORIENTATION_COUNT);
  const source = [0, 0, 0];
  const sign = [0, 0, 0];
  for (let o = 0; o < n; o++) {
    for (let r = 0; r < 3; r++) {
      const a = codeSource(codes[o], r);
      source[a] = r;
      sign[a] = codeSign(codes[o], r);
    }
    const code = packCode(source, sign);
    const index = byCode.get(code);
    if (index === undefined) throw new Error(`inverse of orientation ${o} is not in the set`);
    inverse[o] = index;
    inverseCodes[o] = code;
  }
  return { codes, inverse, inverseCodes };
}

const TABLE = build();

// Packed code of each orientation, and of its inverse; `INVERSE[o]` is the index of
// that inverse. Instance records carry both codes so the shader unpacks bits only.
export const ORIENTATION_CODES: Int32Array = TABLE.codes;
export const INVERSE_CODES: Int32Array = TABLE.inverseCodes;
export const INVERSE: Uint8Array = TABLE.inverse;

// The code of the inverse rotation, from a code alone: a signed permutation's
// inverse is its transpose, so source and sign swap places.
export function invertCode(code: number): number {
  let out = 0;
  for (let r = 0; r < 3; r++) {
    const a = (code >>> (r * 3)) & 3;
    out |= (r | (code & (1 << (r * 3 + 2)) ? 4 : 0)) << (a * 3);
  }
  return out;
}

export type NumArray = number[] | Int32Array | Float32Array | Float64Array;

// Rotates (x, y, z) by `code` into out[at..at+2].
export function rotate(code: number, x: number, y: number, z: number, out: NumArray, at = 0): void {
  const v = [x, y, z];
  for (let r = 0; r < 3; r++) out[at + r] = codeSign(code, r) * v[codeSource(code, r)];
}

// Rotates the axis-aligned box [min, max] by `code`. A signed permutation maps a box
// to a box: axis r takes source axis a's interval, flipped when the sign is negative.
export function rotateBounds(
  code: number,
  min: NumArray,
  max: NumArray,
  outMin: NumArray,
  outMax: NumArray,
  atIn = 0,
  atOut = 0,
): void {
  for (let r = 0; r < 3; r++) {
    const a = codeSource(code, r);
    const lo = min[atIn + a];
    const hi = max[atIn + a];
    if (codeSign(code, r) > 0) {
      outMin[atOut + r] = lo;
      outMax[atOut + r] = hi;
    } else {
      outMin[atOut + r] = -hi;
      outMax[atOut + r] = -lo;
    }
  }
}
