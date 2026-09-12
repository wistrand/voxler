// Cluster culling, CPU side (plan-rendering phase 3): frustum planes for the cull
// uniform, and a TS mirror of the cull shader's tests (cull.wgsl) for unit tests.
// Pure.
//
// Planes come from view_proj (render space -> clip) by the Gribb-Hartmann method,
// for WebGPU clip space with reversed-Z and an infinite far plane: left, right,
// bottom, top, near. There is no far plane. Each plane (a, b, c, d) keeps points
// with a*x + b*y + c*z + d >= 0; planes are not normalized (only signs matter).
//
// Face test: a cluster's quads all face one direction and lie on planes inside its
// box. Quads of a positive face (+X...) lie on planes [lo + 1, hi] along the axis
// and are seen only from eye > plane; negative faces lie on [lo, hi - 1] and are
// seen only from eye < plane. The cluster is culled when the eye is behind every
// one of them.

export const PLANE_COUNT = 5;
export const CULL_FRUSTUM = 1;
export const CULL_FACE = 2;
export const CULL_OCCLUSION = 4; // Hi-Z test, phase B only
export const CULL_WRITE_SEEN = 8; // phase B records next frame's visible set
export const CULL_ALL_CLUSTERS = 16; // phase A tests every cluster (the cull check)

export const CULL_VISIBLE = 0;
export const CULLED_FACE = 1;
export const CULLED_FRUSTUM = 2;

// Writes 5 planes (4 floats each) from a column-major view_proj into `out`.
export function frustumPlanes(m: ArrayLike<number>, out: Float32Array | Float64Array, offset = 0): void {
  // Row i of the matrix is (m[i], m[4 + i], m[8 + i], m[12 + i]).
  const rows = [0, 1];
  let k = offset;
  for (const r of rows) {
    for (const sign of [1, -1]) {
      for (let c = 0; c < 4; c++) out[k + c] = m[3 + 4 * c] + sign * m[r + 4 * c];
      k += 4;
    }
  }
  for (let c = 0; c < 4; c++) out[k + c] = m[3 + 4 * c] - m[2 + 4 * c]; // near: z <= w
}

// The cull shader's decision for one cluster box [lo, hi] (render space) holding
// quads of `face`. Mirrors cull_cluster() in cull.wgsl.
export function cullBox(
  planes: ArrayLike<number>,
  eye: ArrayLike<number>,
  lo: ArrayLike<number>,
  hi: ArrayLike<number>,
  face: number,
  flags: number,
): number {
  if (flags & CULL_FACE) {
    const axis = face >> 1;
    const behind = (face & 1) === 0 ? eye[axis] <= lo[axis] + 1 : eye[axis] >= hi[axis] - 1;
    if (behind) return CULLED_FACE;
  }
  if (flags & CULL_FRUSTUM) {
    for (let p = 0; p < PLANE_COUNT; p++) {
      const a = planes[p * 4], b = planes[p * 4 + 1], c = planes[p * 4 + 2], d = planes[p * 4 + 3];
      const x = a > 0 ? hi[0] : lo[0], y = b > 0 ? hi[1] : lo[1], z = c > 0 ? hi[2] : lo[2];
      if (a * x + b * y + c * z + d < 0) return CULLED_FRUSTUM;
    }
  }
  return CULL_VISIBLE;
}
