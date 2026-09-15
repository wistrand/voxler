// A TS port of the DDA in far.wgsl, checked against an exact reference on random
// bricks (plan-far-field "Testing methodology"). The port and the shader have to be
// changed together; the point of the test is that the traversal visits every cell a
// ray crosses and in order, which is what a heatmap cannot show and a screenshot
// hides behind plausible-looking geometry.
//
// Three things are traversed: the clipmap levels, the bricks of a level, and the cells
// of a brick. The level walk and the toroidal addressing came with phase 3.

import { random01 } from "../util/random.ts";
import { BRICK_AXES_WORD, BRICK_CELLS, BRICK_OCCUPANCY_WORDS, BRICK_WORDS, cellIndex } from "./bricks.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const MAX_BRICK_STEPS = 256;
const MAX_CELL_STEPS = 32;

interface World {
  size: number; // bricks per side
  indirection: Uint32Array;
  bricks: Uint32Array;
  // Toroidal addressing: the window's brick b sits at (b + wrap) mod size, so
  // scrolling rewrites one slab instead of moving every brick.
  wrap?: number[];
  base?: number; // first entry of this level's slice of the indirection buffer
}

// The port of one level. Coordinates are that level's cell units and the window spans
// [0, size * 8) per axis. `t0` is where the ray entered this level, in cell units;
// the return says where it left, so the next level can pick up there.
interface LevelResult {
  hit: number[] | null;
  exit: number;
}

function marchLevel(w: World, p0: number[], dir: number[], t0: number): LevelResult {
  const d = dir;
  const extent = w.size * BRICK_CELLS;
  const entryPoint = [0, 1, 2].map((i) => p0[i] + d[i] * (t0 + 1e-4));
  if (entryPoint.some((v, i) => v < 0 || v >= extent || Number.isNaN(entryPoint[i]))) {
    return { hit: null, exit: t0 };
  }
  const inv = d.map((v) => 1 / (Math.abs(v) < 1e-8 ? 1e-8 : v));
  const step = d.map((v) => Math.sign(v) || 1);
  const brick = entryPoint.map((v) => Math.floor(v / BRICK_CELLS));
  const t = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    t[i] = ((brick[i] + Math.max(step[i], 0)) * BRICK_CELLS - p0[i]) * inv[i];
  }
  const dt = inv.map((v) => Math.abs(v) * BRICK_CELLS);
  let enter = t0;
  for (let s = 0; s < MAX_BRICK_STEPS; s++) {
    const entry = brickEntry(w, brick);
    if (entry !== 0) {
      const exit = Math.min(t[0], t[1], t[2]);
      if (brickCanHit(w, entry - 1, brick, p0, d, enter, exit)) {
        const hit = marchBrick(w, entry - 1, brick, p0, d, inv, enter);
        if (hit) return { hit, exit: enter };
      } else {
        skipped++;
      }
    }
    const axis = t[0] <= t[1] && t[0] <= t[2] ? 0 : t[1] <= t[2] ? 1 : 2;
    enter = t[axis];
    t[axis] += dt[axis];
    brick[axis] += step[axis];
    if (brick.some((v) => v < 0 || v >= w.size)) return { hit: null, exit: enter };
  }
  return { hit: null, exit: enter };
}

// The whole march: each level in turn, picking up where the last one left off. Levels
// are camera-centred and each is twice the one before, so the ray starts inside the
// finest and every exit lands inside the next.
interface LevelSetup {
  world: World;
  origin: number[]; // ray origin in this level's cell units
  cellVoxels: number;
}

function marchLevels(levels: LevelSetup[], dir: number[]): { hit: number[] | null; level: number } {
  const len = Math.hypot(...dir);
  const d = dir.map((v) => v / len);
  let t = 0; // voxels, the unit the levels share
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    const res = marchLevel(l.world, l.origin, d, t / l.cellVoxels);
    if (res.hit) return { hit: res.hit, level: i };
    t = Math.max(t, res.exit * l.cellVoxels);
  }
  return { hit: null, level: -1 };
}

// One level, the shape the phase 1 tests use.
function march(w: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number[] | null {
  const len = Math.hypot(dx, dy, dz);
  return marchLevel(w, [ox, oy, oz], [dx / len, dy / len, dz / len], 0).hit;
}

// Bricks whose cell walk the axes word let the port skip, for the test that counts them.
let skipped = 0;

// The port of `brick_can_hit` in far.wgsl: the run of rows the segment covers on each
// axis, against the rows the brick's axes word says hold anything.
function brickCanHit(w: World, brick: number, base: number[], p0: number[], d: number[], t0: number, t1: number): boolean {
  const axes = w.bricks[brick * BRICK_WORDS + BRICK_AXES_WORD];
  for (let i = 0; i < 3; i++) {
    const a = p0[i] + d[i] * (t0 + 1e-4) - base[i] * BRICK_CELLS;
    const b = p0[i] + d[i] * (t1 + 1e-4) - base[i] * BRICK_CELLS;
    const lo = Math.max(0, Math.min(BRICK_CELLS - 1, Math.floor(Math.min(a, b))));
    const hi = Math.max(0, Math.min(BRICK_CELLS - 1, Math.floor(Math.max(a, b))));
    const run = ((1 << (hi - lo + 1)) - 1) << lo;
    const rows = (axes >>> (8 * i)) & 0xff;
    if ((run & rows) === 0) return false;
  }
  return true;
}

function marchBrick(
  w: World,
  brick: number,
  base: number[],
  p0: number[],
  d: number[],
  inv: number[],
  t0: number,
): number[] | null {
  const step = d.map((v) => Math.sign(v) || 1);
  const cell = [0, 0, 0];
  // Step a hair past the entry so the cell is the one the ray is actually in; a
  // clamp here instead would invent a cell on a ray that only grazes the brick.
  for (let i = 0; i < 3; i++) {
    cell[i] = Math.floor(p0[i] + d[i] * (t0 + 1e-4)) - base[i] * BRICK_CELLS;
    if (cell[i] < 0 || cell[i] >= BRICK_CELLS) return null;
  }
  const t = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    t[i] = (base[i] * BRICK_CELLS + cell[i] + Math.max(step[i], 0) - p0[i]) * inv[i];
  }
  const dt = inv.map(Math.abs);
  for (let s = 0; s < MAX_CELL_STEPS; s++) {
    if (cellSolid(w, brick, cell)) return [base[0] * BRICK_CELLS + cell[0], base[1] * BRICK_CELLS + cell[1], base[2] * BRICK_CELLS + cell[2]];
    const axis = t[0] <= t[1] && t[0] <= t[2] ? 0 : t[1] <= t[2] ? 1 : 2;
    t[axis] += dt[axis];
    cell[axis] += step[axis];
    if (cell[axis] < 0 || cell[axis] >= BRICK_CELLS) return null;
  }
  return null;
}

function brickEntry(w: World, c: number[]): number {
  if (c.some((v) => v < 0 || v >= w.size)) return 0;
  const wrap = w.wrap ?? [0, 0, 0];
  const m = w.size - 1;
  const g = [0, 1, 2].map((i) => (c[i] + wrap[i]) & m);
  return w.indirection[(w.base ?? 0) + g[0] + g[1] * w.size + g[2] * w.size * w.size];
}

function cellSolid(w: World, brick: number, cell: number[]): boolean {
  const i = cellIndex(cell[0], cell[1], cell[2]);
  return (w.bricks[brick * BRICK_WORDS + (i >>> 5)] & (1 << (i & 31))) !== 0;
}

// The reference: a plain single-level DDA over cells, with no brick level at all.
// Exact, and independent of the thing under test, which is the brick skipping.
//
// Sampling the ray at a fixed step was the first attempt and it was wrong: a ray can
// clip the corner of a cell over an interval far shorter than any step, and the
// sampler walks past it. It reported the march hitting cells that were not on the
// ray, when the march was right.
function reference(w: World, o: number[], d: number[], maxSteps: number): number[] | null {
  const len = Math.hypot(...d);
  const n = d.map((v) => v / len);
  const inv = n.map((v) => 1 / (Math.abs(v) < 1e-8 ? 1e-8 : v));
  const step = n.map((v) => Math.sign(v) || 1);
  const cell = o.map(Math.floor);
  const t = [0, 1, 2].map((i) => (cell[i] + Math.max(step[i], 0) - o[i]) * inv[i]);
  const dt = inv.map(Math.abs);
  for (let s = 0; s < maxSteps; s++) {
    const brick = cell.map((v) => Math.floor(v / BRICK_CELLS));
    const entry = brickEntry(w, brick);
    if (entry !== 0) {
      const local = [0, 1, 2].map((i) => cell[i] - brick[i] * BRICK_CELLS);
      if (cellSolid(w, entry - 1, local)) return cell.slice();
    }
    const axis = t[0] <= t[1] && t[0] <= t[2] ? 0 : t[1] <= t[2] ? 1 : 2;
    t[axis] += dt[axis];
    cell[axis] += step[axis];
    if (cell[axis] < -1 || cell[axis] > w.size * BRICK_CELLS) return null;
  }
  return null;
}

// A world of random bricks: some empty, some sparse, some dense.
function world(seed: number, size: number): World {
  const indirection = new Uint32Array(size ** 3);
  const bricks = new Uint32Array(size ** 3 * BRICK_WORDS);
  let count = 0;
  for (let i = 0; i < indirection.length; i++) {
    const r = random01(seed, i);
    if (r < 0.55) continue; // empty
    const density = r < 0.85 ? 0.04 : 0.4;
    const at = count * BRICK_WORDS;
    let any = false;
    for (let c = 0; c < BRICK_CELLS ** 3; c++) {
      if (random01(seed * 31 + i, c) >= density) continue;
      any = true;
      bricks[at + (c >>> 5)] |= 1 << (c & 31);
      bricks[at + BRICK_OCCUPANCY_WORDS + (c >>> 2)] |= 3 << ((c & 3) * 8);
      bricks[at + BRICK_AXES_WORD] |= (1 << (c & 7)) | (1 << (8 + ((c >>> 3) & 7))) | (1 << (16 + (c >>> 6)));
    }
    if (!any) continue;
    indirection[i] = count + 1;
    count++;
  }
  return { size, indirection, bricks };
}

Deno.test("the two-level DDA finds the same first cell as a finely sampled ray", () => {
  for (let seed = 1; seed <= 5; seed++) {
    const w = world(seed, 6);
    const extent = w.size * BRICK_CELLS;
    let hits = 0, misses = 0;
    for (let i = 0; i < 600; i++) {
      const r = (j: number) => random01(seed * 7919 + i, j);
      const o = [r(0) * extent, r(1) * extent, r(2) * extent];
      const d = [r(3) * 2 - 1, r(4) * 2 - 1, r(5) * 2 - 1];
      if (Math.hypot(...d) < 1e-3) continue;
      // Skip rays starting inside a solid cell: both agree there trivially.
      const start = o.map(Math.floor);
      const sb = start.map((v) => Math.floor(v / BRICK_CELLS));
      const se = brickEntry(w, sb);
      if (se !== 0 && cellSolid(w, se - 1, [0, 1, 2].map((k) => start[k] - sb[k] * BRICK_CELLS))) continue;
      const want = reference(w, o, d, extent * 4);
      const got = march(w, o[0], o[1], o[2], d[0], d[1], d[2]);
      if (want === null) {
        assert(got === null, `seed ${seed} ray ${i}: the march hit ${got} where the reference found nothing`);
        misses++;
        continue;
      }
      assert(got !== null, `seed ${seed} ray ${i}: the march missed ${want}`);
      assert(got!.join() === want.join(), `seed ${seed} ray ${i}: march ${got}, reference ${want}`);
      hits++;
    }
    assert(hits > 100 && misses > 5, `seed ${seed}: ${hits} hits and ${misses} misses is not a useful spread`);
  }
});

Deno.test("the axes word skips cell walks and never changes the first hit", () => {
  // The comparison against the finely sampled reference above already runs with the
  // skip in the port; this pins down that the skip actually fired, and that a world of
  // half-empty bricks marches to the same cells with it and without it.
  skipped = 0;
  const seeds = [1, 2, 3];
  let checked = 0;
  for (const seed of seeds) {
    const w = world(seed, 6);
    const extent = w.size * BRICK_CELLS;
    // The same world with every axes word saying "everything": the skip never fires.
    const full: World = { ...w, bricks: w.bricks.slice() };
    for (let b = 0; b * BRICK_WORDS < full.bricks.length; b++) full.bricks[b * BRICK_WORDS + BRICK_AXES_WORD] = 0xFFFFFF;
    for (let i = 0; i < 300; i++) {
      const o = [0, 1, 2].map((k) => random01(seed * 7 + i, k) * extent);
      const d = [0, 1, 2].map((k) => random01(seed * 11 + i, k + 3) * 2 - 1);
      if (Math.hypot(...d) < 1e-3) continue;
      const a = march(w, o[0], o[1], o[2], d[0], d[1], d[2]);
      const b = march(full, o[0], o[1], o[2], d[0], d[1], d[2]);
      assert(JSON.stringify(a) === JSON.stringify(b), `ray ${i} of seed ${seed}: with the skip ${a}, without ${b}`);
      checked++;
    }
  }
  assert(checked > 500, `only ${checked} rays compared`);
  assert(skipped > 0, "the axes word never skipped a brick; the test is not testing anything");
});

Deno.test("an empty brick costs one step whatever its size", () => {
  // The point of the outer level: a ray across empty space steps per brick, not per
  // cell. Counting brick steps over a world with one solid brick at the far end.
  const size = 6;
  const indirection = new Uint32Array(size ** 3);
  const bricks = new Uint32Array(BRICK_WORDS);
  for (let c = 0; c < BRICK_CELLS ** 3; c++) bricks[c >>> 5] |= 1 << (c & 31);
  bricks[BRICK_AXES_WORD] = 0xFFFFFF;
  indirection[5 + 0 * size + 0 * size * size] = 1; // brick (5, 0, 0), fully solid
  const w: World = { size, indirection, bricks };
  const hit = march(w, 0.5, 4.5, 4.5, 1, 0, 0);
  assert(hit !== null, "the ray should reach the solid brick");
  assert(hit![0] === 5 * BRICK_CELLS, `hit at cell x ${hit![0]}, expected ${5 * BRICK_CELLS}`);
});

Deno.test("toroidal addressing changes where a brick is stored, not what the ray hits", () => {
  // The same world read through every wrap: scrolling moves a brick's grid cell, and
  // the march has to undo that exactly, or terrain appears a window away from itself.
  const w = world(3, 4);
  const extent = w.size * BRICK_CELLS;
  for (let wrap = 0; wrap < w.size; wrap++) {
    const shifted: World = {
      size: w.size,
      bricks: w.bricks,
      indirection: new Uint32Array(w.indirection.length),
      wrap: [wrap, wrap * 3, wrap * 5],
    };
    const m = w.size - 1;
    for (let z = 0; z < w.size; z++) {
      for (let y = 0; y < w.size; y++) {
        for (let x = 0; x < w.size; x++) {
          const from = x + y * w.size + z * w.size * w.size;
          const to = ((x + shifted.wrap![0]) & m) + (((y + shifted.wrap![1]) & m) + ((z + shifted.wrap![2]) & m) * w.size) * w.size;
          shifted.indirection[to] = w.indirection[from];
        }
      }
    }
    for (let i = 0; i < 200; i++) {
      const r = (j: number) => random01(97 + wrap, i * 8 + j);
      const o = [r(0) * extent, r(1) * extent, r(2) * extent];
      const d = [r(3) * 2 - 1, r(4) * 2 - 1, r(5) * 2 - 1];
      if (Math.hypot(...d) < 1e-3) continue;
      const plain = march(w, o[0], o[1], o[2], d[0], d[1], d[2]);
      const rolled = march(shifted, o[0], o[1], o[2], d[0], d[1], d[2]);
      assert(
        (plain === null) === (rolled === null) && (plain === null || plain.join() === rolled!.join()),
        `wrap ${wrap} ray ${i}: ${plain} against ${rolled}`,
      );
    }
  }
});

Deno.test("a ray that leaves a level carries on in the next, from where it left", () => {
  // Two levels: the fine one holds nothing, the coarse one a solid brick past the fine
  // window. A ray has to leave level 0 and find the level 1 brick, and it must not
  // re-march the inner region, which is what carrying `t` across levels is for.
  const size = 4;
  const fine: World = { size, indirection: new Uint32Array(size ** 3), bricks: new Uint32Array(BRICK_WORDS) };
  const coarse: World = { size, indirection: new Uint32Array(size ** 3), bricks: new Uint32Array(BRICK_WORDS * 2) };
  const solid = new Uint32Array(BRICK_WORDS);
  for (let c = 0; c < BRICK_CELLS ** 3; c++) solid[c >>> 5] |= 1 << (c & 31);
  solid[BRICK_AXES_WORD] = 0xFFFFFF; // every writer sets the axes word; a hand-built brick must too
  // The ray runs along +x from the middle of both windows, which is level 1 brick
  // (2, 2, 2). That brick is solid too: the ray is past it by the time it steps up,
  // and hitting it would mean the coarse level re-marched what the fine one covered.
  coarse.bricks.set(solid, 0);
  coarse.bricks.set(solid, BRICK_WORDS);
  coarse.indirection[3 + 2 * size + 2 * size * size] = 1;
  coarse.indirection[2 + 2 * size + 2 * size * size] = 2;
  const cell = BRICK_CELLS;
  // The camera sits at the middle of both windows. Level 1 cells are twice as big, so
  // the same world point is at half the cell coordinate.
  const mid = [size * cell / 2, size * cell / 2, size * cell / 2];
  const levels: LevelSetup[] = [
    { world: fine, origin: mid, cellVoxels: 1 },
    { world: coarse, origin: [mid[0] / 2 + size * cell / 4, mid[1] / 2 + size * cell / 4, mid[2] / 2 + size * cell / 4], cellVoxels: 2 },
  ];
  const res = marchLevels(levels, [1, 0, 0]);
  assert(res.hit !== null, "the ray should reach the coarse brick");
  assert(res.level === 1, `hit reported at level ${res.level}`);
  // Brick (3, 1, 1) at level 1 starts at cell x 24, and the ray runs along x.
  assert(res.hit![0] === 3 * BRICK_CELLS, `hit at level 1 cell x ${res.hit![0]}, expected ${3 * BRICK_CELLS}`);
  // With nothing in the coarse level either, the ray leaves both windows.
  coarse.indirection.fill(0);
  assert(marchLevels(levels, [1, 0, 0]).hit === null, "an empty clipmap has nothing to hit");
});
