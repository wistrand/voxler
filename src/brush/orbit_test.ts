// Orbiting brushes (src/app/orbit.ts): they go round, a brush moves only when its cell
// changes, and the store sees exactly those moves as dirty chunks.

import { BrushStore } from "./store.ts";
import { BLEND_SUBTRACT } from "./format.ts";
import { Orbits } from "./orbit.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const SPECS = [
  { material: 1, radius: 4, orbit: 40, height: 4, period: 10 },
  { material: 7, radius: 6, orbit: 52, height: 2, period: -16, phase: Math.PI, blend: BLEND_SUBTRACT },
];

Deno.test("orbiters stand on their circles and move only when their cell changes", () => {
  const store = new BrushStore();
  const orbits = new Orbits(store, [8, 0, 8], SPECS);
  assert(orbits.count === 2, "two orbiters");
  const box = new Float64Array(6);
  const scratch = new Int32Array(3);
  const on = (i: number, seconds: number): boolean => {
    const s = SPECS[i];
    const a = (s.phase ?? 0) + (Math.PI * 2 * seconds) / s.period;
    const want = [Math.round(8 + Math.cos(a) * s.orbit), Math.round(0 + s.height), Math.round(8 + Math.sin(a) * s.orbit)];
    // The store's own record of where the instance is.
    let id = -1;
    let n = 0;
    for (let k = 0; k < 64 && n <= i; k++) if (store.has(k)) { if (n === i) id = k; n++; }
    store.cellOf(id, scratch);
    return scratch[0] === want[0] && scratch[1] === want[1] && scratch[2] === want[2];
  };
  assert(on(0, 0) && on(1, 0), "placed at t = 0");
  store.takeDirty(box);
  // A tiny step moves nothing: both are still in the same voxel.
  orbits.update(0.0001);
  assert(orbits.takeMoves() === 0, "a step within a voxel is not a move");
  assert(store.dirty === 0, "and dirties nothing");
  // A quarter turn moves both, and the store has chunks to regenerate for it.
  orbits.update(2.5);
  assert(orbits.takeMoves() === 2, "a quarter turn moves both");
  assert(on(0, 2.5) && on(1, 2.5), "and lands them where the circle says");
  assert(store.dirty > 0, "the store has dirty chunks");
  orbits.dispose();
  let left = 0;
  for (let k = 0; k < 64; k++) if (store.has(k)) left++;
  assert(left === 0, "dispose takes the brushes out");
});
