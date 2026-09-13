import { DEFAULT_FOLLOW, Follow, type FollowState, MAX_HEIGHT, MIN_HEIGHT, raiseHeight } from "./follow.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const WATER = 10;
const GRASS = 3;

// A world whose surface is at y = 100 everywhere, with a river of `WATER` along a path
// the test picks. Everything below the surface is solid so the height probe terminates.
function world(inRiver: (x: number, z: number) => boolean) {
  return (x: number, y: number, z: number): number => {
    if (y > 100) return 0;
    if (y < 100) return 1;
    return inRiver(x, z) ? WATER : GRASS;
  };
}

function pose(x: number, z: number, yaw: number): FollowState {
  return { x, y: 114, z, yaw, pitch: 0 };
}

Deno.test("it follows the material it started over", () => {
  // A river 30 voxels wide running along -Z, which is where yaw 0 points.
  const f = new Follow(world((x) => Math.abs(x) < 15));
  const s = pose(0, 0, 0);
  assert(f.start(s) === WATER, "should pick up the water under it");
  for (let i = 0; i < 400; i++) f.step(s, 1 / 60);
  assert(s.z < -100, `should have flown down the river, got z ${s.z}`);
  assert(Math.abs(s.x) < 15, `should still be over the river, got x ${s.x}`);
});

Deno.test("it turns to stay over a river that bends", () => {
  // Straight along -Z to z = -150, then away at 45 degrees toward +X.
  const river = (x: number, z: number) => (z > -150 ? Math.abs(x) < 15 : Math.abs(x + (z + 150)) < 15);
  const f = new Follow(world(river));
  const s = pose(0, 0, 0);
  f.start(s);
  for (let i = 0; i < 1800; i++) f.step(s, 1 / 60);
  assert(s.z < -150, `should have reached the bend, got z ${s.z}`);
  assert(s.x > 60, `should have followed the bend, got x ${s.x}`);
  assert(river(s.x, s.z), `should have ended over the river, got ${s.x}, ${s.z}`);
  assert(f.matched > 0, "should still have the river in front of it");
});

Deno.test("it holds its line when there is nothing to follow", () => {
  // No water anywhere: every arm scores the same and straight ahead breaks the tie.
  const f = new Follow(world(() => false));
  const s = pose(0, 0, 0);
  assert(f.start(s) === GRASS, "picks up whatever is under it");
  const before = s.yaw;
  for (let i = 0; i < 600; i++) f.step(s, 1 / 60);
  assert(Math.abs(s.yaw - before) < 1e-6, `should not have wandered, yaw moved to ${s.yaw}`);
});

Deno.test("it keeps the height it was started at", () => {
  // Turning it on should not yank the view somewhere else first, so the held height is
  // whatever the camera was already flying at.
  const f = new Follow(world(() => true));
  const s = pose(0, 0, 0);
  s.y = 170; // 70 over the surface
  f.start(s);
  for (let i = 0; i < 900; i++) f.step(s, 1 / 60);
  assert(Math.abs(s.y - 170) < 1.0, `should have held 70 over the surface, got ${s.y}`);
});

Deno.test("it settles back to the height it is given", () => {
  const f = new Follow(world(() => true));
  const s = pose(0, 0, 0); // 14 over the surface
  f.start(s);
  f.height = 40; // raised while it runs
  for (let i = 0; i < 900; i++) f.step(s, 1 / 60);
  assert(Math.abs(s.y - 140) < 1.0, `should have climbed to the new height, got ${s.y}`);
  f.height = 8; // and lowered again
  for (let i = 0; i < 900; i++) f.step(s, 1 / 60);
  assert(Math.abs(s.y - 108) < 1.0, `should have come back down, got ${s.y}`);
});

Deno.test("raising and lowering stays in range", () => {
  assert(raiseHeight(10, -1000) === MIN_HEIGHT, "cannot be lowered into the ground");
  assert(raiseHeight(10, 1e6) === MAX_HEIGHT, "cannot be raised out of the world");
  assert(raiseHeight(10, 5) === 15, "moves by what it is given");
});

Deno.test("a faster flight looks further ahead and turns wider", () => {
  // The same bend at four times the speed: if the lookahead did not scale with it the
  // flight would meet the bend with a quarter of the warning and overshoot the water.
  const river = (x: number, z: number) => (z > -200 ? Math.abs(x) < 15 : Math.abs(x + (z + 200)) < 15);
  const fly = (speed: number) => {
    const f = new Follow(world(river));
    const s = pose(0, 0, 0);
    f.start(s);
    f.speed = speed;
    // Same distance covered either way, so the two end in the same place if it works.
    for (let i = 0; i < Math.round(60 * 4000 / speed); i++) f.step(s, 1 / 60);
    return s;
  };
  for (const speed of [DEFAULT_FOLLOW.speed, DEFAULT_FOLLOW.speed * 4]) {
    const s = fly(speed);
    assert(river(s.x, s.z), `at ${speed} voxels a second it left the river at ${Math.round(s.x)}, ${Math.round(s.z)}`);
  }
});

Deno.test("it turns no faster than the rate limit", () => {
  const f = new Follow(world((x, z) => z < -20 && x < -20));
  const s = pose(0, 0, 0);
  f.start(s);
  const dt = 1 / 60;
  for (let i = 0; i < 200; i++) {
    const before = s.yaw;
    f.step(s, dt);
    let turn = s.yaw - before;
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;
    assert(
      Math.abs(turn) <= DEFAULT_FOLLOW.turnRate * dt + 1e-9,
      `turned ${turn} in one step, over the ${DEFAULT_FOLLOW.turnRate * dt} limit`,
    );
  }
});

Deno.test("the turn eases rather than hinges", () => {
  // A river that bends sharply is the worst case: the fan gains on one side all at once.
  // What must stay bounded is not the turn but the *change* in it, or the camera snaps.
  const f = new Follow(world((x, z) => (z > -120 ? Math.abs(x) < 15 : Math.abs(x + (z + 120)) < 15)));
  const s = pose(0, 0, 0);
  f.start(s);
  const dt = 1 / 60;
  let last = 0;
  let worst = 0;
  for (let i = 0; i < 1500; i++) {
    const before = s.yaw;
    f.step(s, dt);
    const rate = (s.yaw - before) / dt;
    if (i > 0) worst = Math.max(worst, Math.abs(rate - last));
    last = rate;
  }
  // One frame of the rate's own time constant, and the rate can move at most the whole
  // range in that: anything past a few times that would be a hinge.
  const bound = 2 * DEFAULT_FOLLOW.turnRate * (dt / DEFAULT_FOLLOW.smoothing);
  assert(worst <= bound, `turn rate jumped by ${worst} rad/s in one frame, over ${bound}`);
});

Deno.test("the same second of flight lands in the same place at any frame rate", () => {
  // The easing is exponential in dt, not a fixed fraction per frame, so a slow machine
  // does not fly a different path from a fast one.
  const river = (x: number, z: number) => (z > -100 ? Math.abs(x) < 15 : Math.abs(x + (z + 100)) < 15);
  const fly = (dt: number, steps: number) => {
    const f = new Follow(world(river));
    const s = pose(0, 0, 0);
    f.start(s);
    for (let i = 0; i < steps; i++) f.step(s, dt);
    return s;
  };
  const fast = fly(1 / 240, 240 * 12);
  const slow = fly(1 / 30, 30 * 12);
  assert(Math.abs(fast.x - slow.x) < 12, `x drifted ${Math.abs(fast.x - slow.x)} between frame rates`);
  assert(Math.abs(fast.z - slow.z) < 12, `z drifted ${Math.abs(fast.z - slow.z)} between frame rates`);
});

Deno.test("a column that is not resident does not steer the flight", () => {
  // -1 everywhere is what the store returns outside the loaded range.
  const f = new Follow(() => -1);
  const s = pose(0, 0, 0);
  assert(f.start(s) === 0, "nothing under the camera");
  const before = s.yaw;
  for (let i = 0; i < 300; i++) f.step(s, 1 / 60);
  assert(Math.abs(s.yaw - before) < 1e-6, "should hold its heading rather than hunt");
});
