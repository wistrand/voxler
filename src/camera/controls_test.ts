import { pinchDolly, stepScale, stepSpeed, stickAxis, wheelDolly } from "./controls.ts";
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

Deno.test("spreading two fingers flies towards what is between them, closing them backs off", () => {
  const speed = 20;
  const towards = pinchDolly(speed, 100, 190);
  const away = pinchDolly(speed, 190, 100);
  assert(towards > 0, `spreading flew ${towards}`);
  assert(away === -towards, `closing flew ${away} against ${-towards}`);
  // The same gesture at twice the speed goes twice as far, like a wheel notch.
  assert(pinchDolly(2 * speed, 100, 190) === 2 * towards, "the pinch does not scale with the speed");
  assert(pinchDolly(speed, 100, 100) === 0, "fingers that did not move flew somewhere");
  assert(pinchDolly(speed, 0, 100) === 0, "a pinch from nowhere flew somewhere");
});

Deno.test("one fling of a pinch cannot cross the world", () => {
  const speed = 20;
  const huge = pinchDolly(speed, 10, 100000);
  const four = pinchDolly(speed, 100, 100 + 4 * 90);
  assert(huge === four, `a fling flew ${huge} against the cap of ${four}`);
});

Deno.test("the two-finger stick has a dead zone and reaches full speed, both ways", () => {
  assert(stickAxis(0) === 0, "a stick at rest moves");
  assert(stickAxis(10) === 0, "a stick inside the dead zone moves");
  assert(stickAxis(-10) === 0, "a stick inside the dead zone moves backwards");
  const small = stickAxis(50);
  assert(small > 0 && small < 1, `a small push gave ${small}`);
  assert(stickAxis(-50) === -small, "the stick is not symmetric");
  assert(stickAxis(1000) === 1, "a full push is not full speed");
  assert(stickAxis(NaN) === 0, "a broken offset moved the camera");
});

Deno.test("the stick is analog, and the keys still normalise", () => {
  const speed = 20;
  // `stepScale` is the scale the move vector is multiplied by, so what is travelled in a
  // second is the vector's length times it.
  const travelled = (f: number, r: number, u: number, sprinting = false) =>
    Math.sqrt(f * f + r * r + u * u) * stepScale(speed, sprinting, 1, f, r, u);
  // A key is a direction: one key and two together both travel the base speed.
  assert(Math.abs(travelled(1, 0, 0) - speed) < 1e-9, `one key flew ${travelled(1, 0, 0)}`);
  assert(Math.abs(travelled(1, 1, 0) - speed) < 1e-9, `two keys flew ${travelled(1, 1, 0)}`);
  // A stick is a deflection: half of one is half the speed, not all of it.
  assert(Math.abs(travelled(0.5, 0, 0) - speed / 2) < 1e-9, `half a deflection flew ${travelled(0.5, 0, 0)}`);
  assert(Math.abs(travelled(0.25, 0, 0) - speed / 4) < 1e-9, "a quarter deflection is not a quarter");
  // A stick pushed to the corner is still one speed, like two keys.
  assert(Math.abs(travelled(1, 1, 0) - speed) < 1e-9, "a corner deflection outruns the speed");
  assert(stepScale(speed, false, 1, 0, 0, 0) === 0, "a stick at rest flew somewhere");
  assert(stepScale(speed, false, 0, 1, 0, 0) === 0, "a frame of no time flew somewhere");
  assert(Math.abs(travelled(1, 0, 0, true) - 10 * speed) < 1e-9, "sprint is not ten times");
});
