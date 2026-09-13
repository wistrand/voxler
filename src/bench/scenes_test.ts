// The descent scene is the planet's, and it carries the planet's own radial direction as
// three literals. It has to: a scene pose is a pure function of t with no access to the
// world it runs in. That makes it a copy of something that lives somewhere else, and a
// spawn moved by a voxel would leave the scene falling at a slight angle into a hillside
// while still reporting numbers, which is the failure this file exists to stop.

import { SCENES } from "./scenes.ts";
import { WORLDS } from "../worlds/index.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

Deno.test("the descent falls along the planet's own radius", () => {
  const spawn = WORLDS.planet.spawn;
  const len = Math.hypot(spawn[0], spawn[1], spawn[2]);
  const up = spawn.map((c) => c / len);

  const out = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  SCENES.descent.pose(0, out);
  const d = Math.hypot(out.x, out.y, out.z);
  assert(d > 0, "the descent starts at the spawn, so it measures nothing");
  const dir = [out.x / d, out.y / d, out.z / d];

  // Within a thousandth: the literals are the spawn direction rounded to four places.
  for (let i = 0; i < 3; i++) {
    const off = Math.abs(dir[i] - up[i]);
    assert(off < 1e-3, `axis ${i} is off by ${off.toFixed(4)}: the scene no longer falls straight down`);
  }
});

Deno.test("the descent ends above the ground and starts above the sky", () => {
  const out = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  SCENES.descent.pose(0, out);
  const high = Math.hypot(out.x, out.y, out.z);
  SCENES.descent.pose(1, out);
  const low = Math.hypot(out.x, out.y, out.z);
  assert(high > low, "the descent has to descend");
  assert(low > 0, "it must not end inside the spawn");
  // Every level of a seven-level clipmap is crossed on the way down, which is the point of
  // the scene; the outermost is thousands of voxels out.
  assert(high > 2000, `starts only ${high.toFixed(0)} voxels up, which crosses too few levels`);
});

Deno.test("every scene's pose is a pure function of t", () => {
  const a = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  const b = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  for (const [name, scene] of Object.entries(SCENES)) {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      scene.pose(t, a);
      scene.pose(t, b);
      assert(
        a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw && a.pitch === b.pitch,
        `${name} gives a different pose for the same t, so two runs are not the same path`,
      );
    }
  }
});
