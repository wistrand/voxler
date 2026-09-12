import { stepSpeed, wheelDolly } from "./controls.ts";

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
