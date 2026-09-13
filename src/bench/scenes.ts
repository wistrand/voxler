// Benchmark scenes: a seed and a scripted camera path. The pose is a pure function
// of normalized time, so every run renders the same path regardless of frame rate.
// Positions are offsets from the world's spawn point (BenchRun adds it), so a path
// flies over each world's surface instead of through it. Pure: no DOM or GPU access.

import { random01 } from "../util/random.ts";

export interface Pose {
  x: number; // offset from the world spawn point, float64
  y: number;
  z: number;
  yaw: number; // radians, FlyCamera convention (0 looks along -Z)
  pitch: number;
}

export interface Scene {
  readonly name: string;
  readonly description: string;
  readonly seed: number;
  readonly warmupMs: number; // rendered but not measured; camera holds the t = 0 pose
  readonly durationMs: number; // measured
  // Writes the pose at normalized time t in [0, 1] into `out`. Allocation-free.
  pose(t: number, out: Pose): void;
}

// Sprint speed of FlyControls (base 20 x sprint 10): the streaming target in
// CLAUDE.md "Performance targets" is "no visible holes at sprint flight speed".
const SPRINT_SPEED = 200; // voxels per second
const WARMUP_MS = 1500;
const TELEPORT_JUMPS = 8;
const TELEPORT_RANGE = 50_000; // voxels each way from the origin

const flyover: Scene = {
  name: "flyover",
  description: "straight line along -Z at sprint speed from the spawn point, looking ahead and down",
  seed: 1,
  warmupMs: WARMUP_MS,
  durationMs: 10_000,
  pose(t, out) {
    out.x = 0;
    out.y = 0;
    out.z = -t * SPRINT_SPEED * (this.durationMs / 1000);
    out.yaw = 0;
    out.pitch = -0.2;
  },
};

const spin: Scene = {
  name: "spin",
  description: "one full turn in place at the spawn point over 6 s",
  seed: 1,
  warmupMs: WARMUP_MS,
  durationMs: 6_000,
  pose(t, out) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.yaw = t * 2 * Math.PI;
    out.pitch = -0.25;
  },
};

const teleport: Scene = {
  name: "teleport",
  description: `${TELEPORT_JUMPS} jumps to seeded random places within ${TELEPORT_RANGE} voxels of the spawn, 1 s each`,
  seed: 1,
  warmupMs: WARMUP_MS,
  durationMs: TELEPORT_JUMPS * 1000,
  pose(t, out) {
    const jump = Math.min(TELEPORT_JUMPS - 1, Math.floor(t * TELEPORT_JUMPS));
    const base = jump * 4;
    out.x = (random01(this.seed, base) * 2 - 1) * TELEPORT_RANGE;
    out.y = random01(this.seed, base + 1) * 50; // above the spawn height
    out.z = (random01(this.seed, base + 2) * 2 - 1) * TELEPORT_RANGE;
    out.yaw = random01(this.seed, base + 3) * 2 * Math.PI;
    out.pitch = -0.3;
  },
};

// The occlusion-heavy case: a ground-level walk that hugs the terrain, so hills
// hide most of what is loaded, the opposite of the other scenes' view from above
// (plan-rendering phase 4). The waypoints were sampled from the terrain world at
// seed 1, three voxels above its surface along the route with the most relief
// near the spawn; they hid 52% of the clusters that survive frustum and face
// culling, against 21% for the flyover. They are offsets from the spawn, so
// another world or seed gets the same path over different ground.
const CAVE_PATH = [
  -90, -67, 90,
  -56, -76, 56,
  -24, -76, 24,
  10, -82, -10,
  44, -76, -44,
  76, -69, -76,
];
const CAVE_LEGS = CAVE_PATH.length / 3 - 1;
const CAVE_HEADING = -Math.PI / 4; // the route runs toward +x and -z

const cave: Scene = {
  name: "cave",
  description: "a ground-level walk along the terrain below the spawn, hills hiding most of the view",
  seed: 1,
  warmupMs: WARMUP_MS,
  durationMs: 8_000,
  pose(t, out) {
    const u = Math.min(0.999999, Math.max(0, t)) * CAVE_LEGS;
    const leg = Math.floor(u);
    const f = u - leg;
    const a = leg * 3;
    out.x = CAVE_PATH[a] + (CAVE_PATH[a + 3] - CAVE_PATH[a]) * f;
    out.y = CAVE_PATH[a + 1] + (CAVE_PATH[a + 4] - CAVE_PATH[a + 1]) * f;
    out.z = CAVE_PATH[a + 2] + (CAVE_PATH[a + 5] - CAVE_PATH[a + 2]) * f;
    out.yaw = CAVE_HEADING + 0.6 * Math.sin(t * 4 * Math.PI); // sweeping around the route
    out.pitch = 0.05 * Math.sin(t * 6 * Math.PI);
  },
};

// A walk through the trees rather than over them: the forest's cost is undergrowth and
// canopy close up, which a flyover at 200 voxels a second never sees
// (plan-living-world.md phase 3). Run it with `?world=forest`.
const WALK_SPEED = 8; // voxels a second, a stroll; the walk stays in one stretch of wood
const grove: Scene = {
  name: "grove",
  description: "a slow walk under the canopy from the spawn, turning to look around",
  seed: 1,
  warmupMs: WARMUP_MS,
  durationMs: 12_000,
  pose(t, out) {
    const d = t * WALK_SPEED * (this.durationMs / 1000);
    out.x = Math.sin(t * 2.2) * 26;
    // The spawn stands above the canopy, so the walk drops under it. The ground along
    // this path runs from 95 down to 71 voxels, so a fixed height cannot hug it: -20
    // clears the highest of it and still has canopy overhead for most of the walk.
    out.y = -20 + Math.sin(t * 3.1) * 3;
    out.z = -d;
    out.yaw = Math.sin(t * 1.7) * 0.9;
    out.pitch = -0.08 + Math.sin(t * 2.6) * 0.12;
  },
};

// A descent onto the planet, from four thousand voxels out down to forty over the ground,
// looking straight down the whole way. Run it with `?world=planet`.
//
// It is here because the planet is the worst case this engine has: a shell rather than a
// heightfield, so the far field cannot skip the inside or the outside of it, and an SDF
// whose every sample is a stack of 3D noise. Descending crosses every clipmap level in one
// run, which is what makes it the scene for level transitions rather than for steady state.
//
// The path is radial, along the spawn's own direction from the planet's centre, because
// "up" here is not +Y. That direction is the spawn's, normalised, and it is written out
// rather than computed so the scene stays a pure function of t.
const PLANET_UP = [0.8079, 0.0, -0.5893] as const;
const PLANET_HIGH = 4000; // where the descent starts, in voxels above the spawn
const PLANET_LOW = 40;

const descent: Scene = {
  name: "descent",
  description: "a fall from orbit onto the planet, looking down, crossing every clipmap level",
  seed: 1,
  warmupMs: WARMUP_MS,
  durationMs: 14_000,
  pose(t, out) {
    // Quadratic in t, so the slow part is near the ground where the near field is doing
    // the work and the fast part is out where a frame is one long march.
    const d = PLANET_HIGH + (PLANET_LOW - PLANET_HIGH) * (t * t);
    out.x = PLANET_UP[0] * d;
    out.y = PLANET_UP[1] * d;
    out.z = PLANET_UP[2] * d;
    // Looking straight down the radius at the ground below.
    out.yaw = Math.atan2(PLANET_UP[0], -PLANET_UP[2]);
    out.pitch = -Math.PI / 2 + 0.22;
  },
};

export const SCENES: Readonly<Record<string, Scene>> = { flyover, spin, teleport, cave, grove, descent };
