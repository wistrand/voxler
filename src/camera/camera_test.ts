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
