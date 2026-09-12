import { FlyCamera } from "./camera.ts";

function assertClose(actual: number, expected: number, eps: number, what: string): void {
  if (Math.abs(actual - expected) > eps) throw new Error(`${what}: ${actual} != ${expected}`);
}

Deno.test("setPosition splits negative and positive coordinates into chunk and offset", () => {
  const c = new FlyCamera();
  c.setPosition(-1, 0, 33.5);
  if (c.chunk[0] !== -1 || c.chunk[1] !== 0 || c.chunk[2] !== 1) throw new Error(`chunk ${c.chunk}`);
  assertClose(c.offset[0], 31, 0, "x offset");
  assertClose(c.offset[1], 0, 0, "y offset");
  assertClose(c.offset[2], 1.5, 0, "z offset");
});

Deno.test("translate carries across chunk boundaries in both directions", () => {
  const c = new FlyCamera();
  c.setPosition(31.5, 0.25, 0);
  c.translate(1, -0.5, -64.25);
  assertClose(c.worldPosition(0), 32.5, 1e-12, "x");
  assertClose(c.worldPosition(1), -0.25, 1e-12, "y");
  assertClose(c.worldPosition(2), -64.25, 1e-12, "z");
  for (let axis = 0; axis < 3; axis++) {
    if (!(c.offset[axis] >= 0 && c.offset[axis] < 32)) throw new Error(`offset ${axis} ${c.offset[axis]}`);
  }
});

Deno.test("far from the origin the offset keeps sub-voxel precision", () => {
  const c = new FlyCamera();
  c.setPosition(1_000_000.125, 10, -1_000_000.875);
  assertClose(c.offset[0], 0.125, 1e-9, "x offset");
  assertClose(c.offset[2], 31.125, 1e-9, "z offset"); // -1000000.875 = -31251 * 32 + 31.125
  c.translate(0.001, 0, 0);
  assertClose(c.worldPosition(0), 1_000_000.126, 1e-6, "x after small move");
});

Deno.test("basis stays orthonormal and pitch is clamped", () => {
  const c = new FlyCamera();
  c.setOrientation(1.1, 3);
  if (c.pitch >= Math.PI / 2) throw new Error(`pitch not clamped: ${c.pitch}`);
  const b = c.basis;
  const dot = (i: number, j: number) => b[i] * b[j] + b[i + 1] * b[j + 1] + b[i + 2] * b[j + 2];
  assertClose(dot(0, 0), 1, 1e-12, "|right|");
  assertClose(dot(3, 3), 1, 1e-12, "|up|");
  assertClose(dot(6, 6), 1, 1e-12, "|forward|");
  assertClose(dot(0, 3), 0, 1e-12, "right.up");
  assertClose(dot(0, 6), 0, 1e-12, "right.forward");
  assertClose(dot(3, 6), 0, 1e-12, "up.forward");
});

Deno.test("yaw 0 looks along -Z", () => {
  const c = new FlyCamera();
  c.setOrientation(0, 0);
  assertClose(c.basis[6], 0, 1e-12, "forward x");
  assertClose(c.basis[8], -1, 1e-12, "forward z");
  assertClose(c.basis[0], 1, 1e-12, "right x");
});

Deno.test("the ray through the middle of the viewport is the way the camera looks", () => {
  const c = new FlyCamera();
  const out = new Float64Array(3);
  for (const [yaw, pitch] of [[0, 0], [0.9, -0.4], [-2.2, 0.7]]) {
    c.setOrientation(yaw, pitch);
    c.rayThrough(0, 0, 16 / 9, out);
    for (let a = 0; a < 3; a++) {
      assertClose(out[a], c.basis[6 + a], 1e-12, `centre ray axis ${a} at yaw ${yaw}`);
    }
  }
});

Deno.test("a ray through the top edge is half the vertical field of view off the view", () => {
  const c = new FlyCamera();
  c.setOrientation(0, 0);
  const out = new Float64Array(3);
  c.rayThrough(0, 1, 1, out);
  const b = c.basis;
  const along = out[0] * b[6] + out[1] * b[7] + out[2] * b[8];
  assertClose(Math.acos(along), c.fovY / 2, 1e-12, "angle off the view at the top edge");
  // And it leans along the camera's up, not its right.
  assertClose(out[0] * b[0] + out[1] * b[1] + out[2] * b[2], 0, 1e-12, "no sideways lean");
});

Deno.test("the aspect widens the ray sideways, and every ray is a unit vector", () => {
  const c = new FlyCamera();
  c.setOrientation(0.3, -0.2);
  const out = new Float64Array(3);
  const b = c.basis;
  const sideways = (aspect: number) => {
    c.rayThrough(1, 0, aspect, out);
    return out[0] * b[0] + out[1] * b[1] + out[2] * b[2];
  };
  const narrow = sideways(1), wide = sideways(2);
  if (!(wide > narrow)) throw new Error(`aspect 2 leans ${wide}, aspect 1 leans ${narrow}`);
  for (const [x, y, a] of [[0, 0, 1], [-1, 1, 16 / 9], [1, -1, 0.5], [0.3, 0.8, 2]]) {
    c.rayThrough(x, y, a, out);
    assertClose(Math.hypot(out[0], out[1], out[2]), 1, 1e-12, `ray (${x}, ${y}) is normalized`);
  }
});

Deno.test("rays through opposite corners mirror each other", () => {
  const c = new FlyCamera();
  c.setOrientation(1.1, 0.25);
  const a = new Float64Array(3), b = new Float64Array(3);
  c.rayThrough(-1, -1, 16 / 9, a);
  c.rayThrough(1, 1, 16 / 9, b);
  const f = c.basis;
  // Both the same angle off the view, and their sum lies along it.
  const dotA = a[0] * f[6] + a[1] * f[7] + a[2] * f[8];
  const dotB = b[0] * f[6] + b[1] * f[7] + b[2] * f[8];
  assertClose(dotA, dotB, 1e-12, "opposite corners are equally far off the view");
  for (let i = 0; i < 3; i++) {
    assertClose(a[i] + b[i], 2 * dotA * f[6 + i], 1e-12, `corner rays sum along the view, axis ${i}`);
  }
});
