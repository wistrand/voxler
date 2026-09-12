import { stepSpeed, wheelDolly } from "./controls.ts";
import { FlyCamera } from "./camera.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

Deno.test("a wheel notch flies a slice of a second, forward when pushed up", () => {
  const speed = 20;
  const forward = wheelDolly(speed, -100);
  const back = wheelDolly(speed, 100);
  assert(forward > 0, `a notch up gave ${forward}, expected forward`);
  assert(Math.abs(forward + back) < 1e-9, "up and down are not mirror images");
  assert(Math.abs(forward - 7) < 1e-6, `a notch moved ${forward} voxels at speed 20`);
  // Line and page deltas are the same gesture in other units.
  assert(Math.abs(wheelDolly(speed, -100 / 16, 1) - forward) < 1e-6, "deltaMode 1 (lines) differs");
  assert(Math.abs(wheelDolly(speed, -100 / 800, 2) - forward) < 1e-6, "deltaMode 2 (pages) differs");
});

Deno.test("the step scales with the speed, so the gesture works at any scale", () => {
  const slow = wheelDolly(2, -100);
  const fast = wheelDolly(2000, -100);
  assert(Math.abs(fast / slow - 1000) < 1e-6, `${slow} and ${fast} are not in proportion`);
});

Deno.test("a touchpad's stream of small deltas adds up to one notch", () => {
  let moved = 0;
  for (let i = 0; i < 25; i++) moved += wheelDolly(20, -4); // 100 px, 4 at a time
  assert(Math.abs(moved - wheelDolly(20, -100)) < 1e-6, `25 four-pixel events moved ${moved}`);
});

Deno.test("a horizontal scroll or a broken delta moves nothing", () => {
  assert(wheelDolly(20, 0) === 0, "deltaY 0 moved the camera");
  assert(wheelDolly(20, NaN) === 0, "a NaN delta moved the camera");
});

Deno.test("one event cannot fling the camera across the world", () => {
  const huge = wheelDolly(20, -100000);
  assert(huge <= 4 * 20 * 0.35 + 1e-6, `one event moved ${huge} voxels`);
});

Deno.test("+ and - step the speed and keep it in range", () => {
  assert(Math.abs(stepSpeed(20, 1.25) - 25) < 1e-6, "a press of + did not step up");
  assert(Math.abs(stepSpeed(20, 1 / 1.25) - 16) < 1e-6, "a press of - did not step down");
  assert(stepSpeed(0.5, 1 / 1.25) === 0.5, "the speed went below the floor");
  assert(stepSpeed(20000, 1.25) === 20000, "the speed went above the ceiling");
  assert(stepSpeed(20, NaN) === 20, "a broken factor changed the speed");
});

Deno.test("the wheel step is a distance, and aiming it does not change how far it goes", () => {
  // FlyControls needs a canvas, so this covers the two halves it composes: wheelDolly
  // gives the distance and FlyCamera.rayThrough gives the direction. The class
  // multiplies them, so a step away from the centre has to be the same length as one
  // through it, or the wheel would fly further towards a corner than straight ahead.
  const cam = new FlyCamera();
  cam.setOrientation(0.8, -0.3);
  const step = wheelDolly(20, -100);
  const dir = new Float64Array(3);
  for (const [x, y] of [[0, 0], [-1, 1], [1, -1], [0.4, 0.9]]) {
    cam.rayThrough(x, y, 16 / 9, dir);
    const len = Math.hypot(dir[0] * step, dir[1] * step, dir[2] * step);
    assert(Math.abs(len - step) < 1e-9, `aiming at (${x}, ${y}) moved ${len}, not ${step}`);
  }
  // The centre of the viewport is the view, so aiming there is the old behaviour.
  cam.rayThrough(0, 0, 16 / 9, dir);
  for (let a = 0; a < 3; a++) {
    assert(Math.abs(dir[a] - cam.basis[6 + a]) < 1e-12, `the centre ray is not the view, axis ${a}`);
  }
});
