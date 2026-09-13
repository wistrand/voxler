import { hash32, random01 } from "../util/random.ts";
import { p50Spread, type RunSummary, spreadOk } from "./runner.ts";
import { type Pose, SCENES } from "./scenes.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function pose(): Pose {
  return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
}

Deno.test("random01 is deterministic, in range, and seed-dependent", () => {
  for (let i = 0; i < 1000; i++) {
    const v = random01(7, i);
    assert(v >= 0 && v < 1, `range at ${i}: ${v}`);
    assert(v === random01(7, i), `repeatable at ${i}`);
  }
  assert(random01(7, 0) !== random01(8, 0), "seed changes the value");
  assert(hash32(0) !== hash32(1), "hash distinguishes inputs");
});

Deno.test("every scene pose is a pure function of t", () => {
  for (const scene of Object.values(SCENES)) {
    for (const t of [0, 0.25, 0.5, 0.999, 1]) {
      const a = pose();
      const b = pose();
      scene.pose(t, a);
      scene.pose(t, b);
      assert(JSON.stringify(a) === JSON.stringify(b), `${scene.name} at ${t}`);
      for (const v of Object.values(a)) assert(Number.isFinite(v), `${scene.name} finite at ${t}`);
    }
  }
});

Deno.test("flyover covers sprint speed times duration", () => {
  const a = pose();
  const b = pose();
  SCENES.flyover.pose(0, a);
  SCENES.flyover.pose(1, b);
  assert(Math.abs((a.z - b.z) - 200 * 10) < 1e-9, `distance ${a.z - b.z}`);
});

Deno.test("teleport visits distinct places", () => {
  const seen = new Set<string>();
  for (let jump = 0; jump < 8; jump++) {
    const p = pose();
    SCENES.teleport.pose((jump + 0.5) / 8, p);
    seen.add(`${Math.round(p.x)},${Math.round(p.z)}`);
  }
  assert(seen.size === 8, `distinct places ${seen.size}`);
});

Deno.test("p50 spread compares runs per metric", () => {
  const run = (p50: number): RunSummary => ({
    frames: 1,
    missedFrames: 0,
    metrics: { "cpu.frame": { count: 1, mean: p50, p50, p95: p50, p99: p50, max: p50 } },
  });
  const wide = p50Spread([run(1.0), run(1.1)])["cpu.frame"];
  assert(Math.abs(wide.relative - 0.095) < 0.001, `relative ${wide.relative}`);
  assert(Math.abs(wide.absolute - 0.1) < 1e-9, `absolute ${wide.absolute}`);
  assert(!spreadOk(wide), "10% and 0.1 ms is not ok");
  // Tiny values: 20% apart but only 0.025 ms, within timer noise.
  const tiny = p50Spread([run(0.115), run(0.14)])["cpu.frame"];
  assert(tiny.relative > 0.05 && spreadOk(tiny), `tiny ${JSON.stringify(tiny)}`);
});
