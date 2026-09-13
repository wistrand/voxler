import {
  type BlockAt,
  DEFAULT_FOLLOW,
  Follow,
  type FollowState,
  MAX_HEIGHT,
  MIN_HEIGHT,
  raiseHeight,
} from "./follow.ts";

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

Deno.test("it clears a cliff instead of flying into it", () => {
  // Flat at 100 until z = -300, then a wall to 220: taller than the flight's line, so
  // the only way through is over.
  const at = (x: number, y: number, z: number): number => {
    const ground = z < -300 ? 220 : 100;
    return y <= ground ? 1 : 0;
  };
  const f = new Follow(at);
  const s = pose(0, 0, 0);
  f.start(s);
  let worst = Infinity;
  for (let i = 0; i < 60 * 60; i++) {
    f.step(s, 1 / 60);
    const ground = s.z < -300 ? 220 : 100;
    worst = Math.min(worst, s.y - ground);
    assert(s.y > ground, `flew into the cliff at z ${Math.round(s.z)}, y ${s.y} against ${ground}`);
  }
  assert(s.z < -300, `should have crossed the cliff, got z ${Math.round(s.z)}`);
  assert(worst >= MIN_HEIGHT - 1, `came within ${worst.toFixed(1)} of the rock`);
});

Deno.test("it clears a tree it would otherwise fly through", () => {
  // A single trunk in the way, forty voxels over the canopy line the flight holds.
  const at = (x: number, y: number, z: number): number => {
    if (y <= 100) return 1;
    return Math.abs(x) < 4 && z > -420 && z < -400 && y <= 160 ? 2 : 0;
  };
  const f = new Follow(at);
  const s = pose(0, 0, 0);
  f.start(s);
  for (let i = 0; i < 60 * 40; i++) {
    f.step(s, 1 / 60);
    assert(at(s.x, s.y, s.z) === 0, `inside a block at ${Math.round(s.x)}, ${Math.round(s.y)}, ${Math.round(s.z)}`);
  }
  assert(s.z < -420, `should have passed the tree, got z ${Math.round(s.z)}`);
});

Deno.test("it moves at the same speed whether it climbs or not", () => {
  // A long ramp: the flight has to lift the whole way, and lifting must come out of the
  // same budget as going forward rather than adding to it.
  const ramp = (x: number, y: number, z: number): number => (y <= 100 - z / 4 ? 1 : 0);
  const travel = (at: BlockAt) => {
    const f = new Follow(at);
    const s = pose(0, 0, 0);
    f.start(s);
    let moved = 0;
    for (let i = 0; i < 60 * 20; i++) {
      const x = s.x, y = s.y, z = s.z;
      f.step(s, 1 / 60);
      moved += Math.hypot(s.x - x, s.y - y, s.z - z);
    }
    return moved / 20; // voxels a second through the air
  };
  const flat = travel(world(() => false));
  const climbing = travel(ramp);
  assert(Math.abs(flat - DEFAULT_FOLLOW.speed) < 0.5, `flat flight moved at ${flat.toFixed(1)}`);
  assert(
    Math.abs(climbing - flat) < 1.0,
    `climbing moved at ${climbing.toFixed(1)} against ${flat.toFixed(1)} on the flat`,
  );
});

Deno.test("the lift over an obstacle arrives as a ramp, not a step", () => {
  // The corridor probe is a handful of points, so an obstacle crosses one probe at a
  // time. Asking each probe for clearance on a glide slope is what keeps that from
  // reading as a jolt: what must stay bounded is the change in vertical speed and in
  // pitch from one frame to the next, not their size.
  const at = (_x: number, y: number, z: number): number => (y <= (z < -400 ? 200 : 100) ? 1 : 0);
  const f = new Follow(at);
  const s = pose(0, 0, 0);
  f.start(s);
  const dt = 1 / 60;
  let lastRate = 0;
  let lastPitch = s.pitch;
  let worstRate = 0;
  let worstPitch = 0;
  for (let i = 0; i < 60 * 40; i++) {
    const y = s.y;
    f.step(s, dt);
    const rate = (s.y - y) / dt;
    if (i > 0) {
      worstRate = Math.max(worstRate, Math.abs(rate - lastRate));
      worstPitch = Math.max(worstPitch, Math.abs(s.pitch - lastPitch));
    }
    lastRate = rate;
    lastPitch = s.pitch;
  }
  assert(s.z < -400, `should have crossed the step, got z ${Math.round(s.z)}`);
  // The vertical rate is eased like the turn rate, so what is bounded is its change: at
  // most its whole range in one of its own time constants.
  const bound = 2 * DEFAULT_FOLLOW.speed * (dt / DEFAULT_FOLLOW.liftSmoothing);
  assert(worstRate <= bound, `vertical speed jumped by ${worstRate.toFixed(1)} in one frame, over ${bound.toFixed(1)}`);
  assert(worstPitch <= 0.01, `pitch jumped by ${worstPitch.toFixed(4)} rad in one frame`);
});

Deno.test("a flight raised to the top of its range still sees the ground", () => {
  // The probe depth has to cover MAX_HEIGHT. Under it, a raised flight finds nothing
  // below: it keeps neither the height it was started at (the probe returns NaN, so
  // `start` falls back to the default and the camera drops hundreds of voxels) nor the
  // material it was following.
  const f = new Follow(world((x) => Math.abs(x) < 15));
  const s = pose(0, 0, 0);
  s.y = 100 + MAX_HEIGHT - 20;
  assert(f.start(s) === WATER, "should still pick up the water far below it");
  assert(Math.abs(f.height - (MAX_HEIGHT - 20)) < 1, `should have kept its height, got ${f.height}`);
  for (let i = 0; i < 600; i++) f.step(s, 1 / 60);
  assert(Math.abs(s.y - (100 + MAX_HEIGHT - 20)) < 2, `should have held its altitude, got ${s.y}`);
  assert(f.matched > 0, "should still have the river in front of it");
});

Deno.test("switching the flight off and on does not carry the old rates over", () => {
  // Everything the flight does is a low pass, and a low pass that is not reset starts
  // the next flight mid-turn and mid-climb.
  const shape = (x: number, z: number) => z < -40 && x < -40;
  const f = new Follow(world(shape));
  const s = pose(0, 0, 0);
  f.start(s);
  f.height = 160; // a flight that is climbing hard when it is switched off
  for (let i = 0; i < 200; i++) f.step(s, 1 / 60);
  // A restarted flight has to take the same first steps as one that never ran, which is
  // a stronger check than "it does not move": the first step may well turn and climb,
  // it just must not carry the last flight's rates into doing so.
  const restarted = pose(0, 0, 0);
  f.start(restarted);
  const clean = new Follow(world(shape));
  const virgin = pose(0, 0, 0);
  clean.start(virgin);
  let worstY = 0;
  for (let i = 0; i < 120; i++) {
    f.step(restarted, 1 / 60);
    clean.step(virgin, 1 / 60);
    worstY = Math.max(worstY, Math.abs(restarted.y - virgin.y));
  }
  assert(worstY < 1e-9, `y drifted ${worstY} from a fresh flight during the first seconds`);
  assert(Math.abs(restarted.yaw - virgin.yaw) < 1e-9, `yaw drifted ${restarted.yaw - virgin.yaw} from a fresh flight`);
  assert(Math.abs(restarted.y - virgin.y) < 1e-9, `y drifted ${restarted.y - virgin.y} from a fresh flight`);
  assert(Math.abs(restarted.pitch - virgin.pitch) < 1e-9, `pitch drifted from a fresh flight`);
});
