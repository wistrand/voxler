// Column-major 4x4 matrices in Float64Array, matching WGSL mat4x4f element order.
// Math runs in float64 and is copied to float32 only when written to a GPU buffer.
// Every function writes into `out` and allocates nothing.

export type Mat4 = Float64Array;

export function create(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// out = a * b. `out` may alias `a` or `b`.
export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
  const a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7];
  const a8 = a[8], a9 = a[9], a10 = a[10], a11 = a[11];
  const a12 = a[12], a13 = a[13], a14 = a[14], a15 = a[15];
  for (let c = 0; c < 16; c += 4) {
    const b0 = b[c], b1 = b[c + 1], b2 = b[c + 2], b3 = b[c + 3];
    out[c] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
    out[c + 1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
    out[c + 2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
    out[c + 3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;
  }
  return out;
}

// out = inverse(a). Returns false and leaves `out` unchanged if `a` is singular.
export function invert(out: Mat4, a: Mat4): boolean {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0) return false;
  const d = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return true;
}

// Reversed-Z perspective with an infinite far plane, for WebGPU's [0, 1] depth.
// View space is right-handed looking down -Z. Depth is 1 at the near plane and
// approaches 0 at infinity: clear depth to 0 and test with "greater".
export function perspectiveReversedZ(out: Mat4, fovY: number, aspect: number, near: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  out[14] = near;
  return out;
}

// View matrix from an eye position and an orthonormal basis stored as
// [right xyz, up xyz, forward xyz]. The camera looks along `forward`.
export function view(out: Mat4, eye: ArrayLike<number>, basis: ArrayLike<number>): Mat4 {
  const rx = basis[0], ry = basis[1], rz = basis[2];
  const ux = basis[3], uy = basis[4], uz = basis[5];
  const bx = -basis[6], by = -basis[7], bz = -basis[8]; // camera +Z points backward
  const ex = eye[0], ey = eye[1], ez = eye[2];
  out[0] = rx;
  out[1] = ux;
  out[2] = bx;
  out[3] = 0;
  out[4] = ry;
  out[5] = uy;
  out[6] = by;
  out[7] = 0;
  out[8] = rz;
  out[9] = uz;
  out[10] = bz;
  out[11] = 0;
  out[12] = -(rx * ex + ry * ey + rz * ez);
  out[13] = -(ux * ex + uy * ey + uz * ez);
  out[14] = -(bx * ex + by * ey + bz * ez);
  out[15] = 1;
  return out;
}

// out = m * (x, y, z, w), written as [x, y, z, w].
export function transform(out: Float64Array, m: Mat4, x: number, y: number, z: number, w: number): Float64Array {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return out;
}
