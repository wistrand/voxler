import { type AdaptOptions, DEFAULT_ADAPT_OPTIONS, FarAdapt, farBudgetMs, refreshFromIntervals } from "./adapt.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function assertEquals(got: number | string, want: number | string, what = ""): void {
  if (got !== want) throw new Error(`${what ? what + ": " : ""}got ${got}, want ${want}`);
}

const OPTIONS: AdaptOptions = {
  budgetMs: 3,
  framesPerWindow: 4,
  minLevels: 3,
  maxLevels: 8,
  minSlabs: 1,
  maxSlabs: 4,
  scales: [0.5, 0.75, 1.0],
  reserveMs: 1.5,
  minBudgetMs: 0.8,
  maxBudgetShare: 0.5,
};

// The tests below drive the controller on its fallback budget, which is OPTIONS.budgetMs;
// NaN is what a frame that has not been measured hands it.
const UNMEASURED = NaN;

// Runs `windows` decision windows at one steady cost, and reports what settled.
function run(a: FarAdapt, windows: number, march: number, build: number, buildMax: number, queued = 0): void {
  for (let w = 0; w < windows; w++) {
    for (let f = 0; f < OPTIONS.framesPerWindow; f++) a.frame(UNMEASURED, march, build, buildMax, queued, true);
  }
}

Deno.test("a window has to close before anything moves", () => {
  const a = new FarAdapt(8, 2, 1, OPTIONS);
  for (let f = 0; f < OPTIONS.framesPerWindow - 1; f++) {
    assertEquals(a.frame(UNMEASURED, 9, 9, 9, 0, true) ? 1 : 0, 0, "changed mid-window");
  }
  assert(a.frame(UNMEASURED, 9, 9, 9, 0, true), "the window closing should decide");
});

Deno.test("over budget gives up the build budget before the reach", () => {
  const a = new FarAdapt(8, 4, 1, OPTIONS);
  run(a, 1, 2.0, 2.0, 2.0);
  assertEquals(a.settings.slabsPerFrame, 3, "slabs first");
  assertEquals(a.settings.levels, 8, "reach is not what moves first");
  run(a, 2, 2.0, 2.0, 2.0);
  assertEquals(a.settings.slabsPerFrame, 1, "slabs down to the floor");
  assertEquals(a.settings.levels, 8, "still no level given up");
  run(a, 1, 2.0, 2.0, 2.0);
  assertEquals(a.settings.levels, 7, "with slabs at the floor the reach goes");
});

Deno.test("it stops at the floor instead of marching to zero levels", () => {
  const a = new FarAdapt(8, 1, 1, OPTIONS);
  run(a, 60, 20, 20, 20);
  assertEquals(a.settings.levels, OPTIONS.minLevels, "floored");
  assertEquals(a.settings.slabsPerFrame, OPTIONS.minSlabs, "floored");
  assert(a.report.action.includes("floor"), `expected a floor report, got "${a.report.action}"`);
});

Deno.test("a single spiking frame costs slabs even when the mean fits", () => {
  const a = new FarAdapt(8, 4, 1, OPTIONS);
  run(a, 1, 0.2, 0.3, 9.0);
  assertEquals(a.settings.slabsPerFrame, 3, "the spike is what drops a vsync");
  assertEquals(a.settings.levels, 8, "a spike is not a reason to shorten the view");
});

Deno.test("headroom restores the build budget before it reaches further", () => {
  const a = new FarAdapt(4, 1, 1, OPTIONS);
  run(a, 1, 0.2, 0.2, 0.3, 40);
  assertEquals(a.settings.slabsPerFrame, 2, "a backed-up queue wants slabs");
  assertEquals(a.settings.levels, 4, "reach waits");
  // Slabs keep coming back even with nothing queued: they cost nothing until the camera
  // moves, and having them ready is what catches the clipmap up after the next jump.
  run(a, 2, 0.2, 0.2, 0.3, 0);
  assertEquals(a.settings.slabsPerFrame, OPTIONS.maxSlabs, "budget back to full");
  assertEquals(a.settings.levels, 4, "reach still waits for the budget to be full");
  run(a, 1, 0.2, 0.2, 0.3, 0);
  assertEquals(a.settings.levels, 5, "only then does the reach grow");
});

Deno.test("a level change is followed by windows of settling", () => {
  const a = new FarAdapt(4, OPTIONS.maxSlabs, 1, OPTIONS);
  run(a, 1, 0.2, 0.2, 0.3, 0);
  assertEquals(a.settings.levels, 5, "grew");
  // The new level rebuilds itself, so the next windows are expensive. They must not be
  // read as "too expensive, drop it again".
  run(a, 3, 2.0, 2.0, 2.0, 0);
  assertEquals(a.settings.levels, 5, "held while settling");
  run(a, 1, 2.0, 2.0, 2.0, 0);
  assert(a.settings.levels === 5 && a.settings.slabsPerFrame === 3, "after settling, slabs go first");
});

Deno.test("it holds when there are no timings to adapt to", () => {
  const a = new FarAdapt(8, 2, 1, OPTIONS);
  run(a, 4, NaN, NaN, NaN, 0);
  assertEquals(a.settings.levels, 8, "no measurement, no change");
  assertEquals(a.settings.slabsPerFrame, 2, "no measurement, no change");
  assertEquals(a.report.action, "no timings");
});

Deno.test("the starting settings are clamped into range", () => {
  const low = new FarAdapt(0, 0, 1, OPTIONS);
  assertEquals(low.settings.levels, OPTIONS.minLevels);
  assertEquals(low.settings.slabsPerFrame, OPTIONS.minSlabs);
  const high = new FarAdapt(99, 99, 1, OPTIONS);
  assertEquals(high.settings.levels, OPTIONS.maxLevels);
  assertEquals(high.settings.slabsPerFrame, OPTIONS.maxSlabs);
});

Deno.test("the shipped budget leaves room in a 120 Hz frame", () => {
  assert(
    DEFAULT_ADAPT_OPTIONS.budgetMs < 8.33 / 2,
    `budget ${DEFAULT_ADAPT_OPTIONS.budgetMs} ms leaves the rest of the frame nothing`,
  );
  assert(DEFAULT_ADAPT_OPTIONS.minLevels >= 1, "the finest level carries the shadow rays");
});

Deno.test("a build that has stopped running costs nothing, whatever its ring still says", () => {
  const a = new FarAdapt(8, 1, 1, OPTIONS);
  // The clipmap has caught up: the build pass is not encoded, so the GPU timer keeps
  // sampling nothing and its ring holds the last expensive frame forever. Reading that
  // as a per-frame cost would give up the whole reach to pay for work that stopped.
  for (let w = 0; w < 12; w++) {
    for (let f = 0; f < OPTIONS.framesPerWindow; f++) a.frame(UNMEASURED, 0.2, 9.0, 9.0, 0, false);
  }
  assertEquals(a.settings.levels, OPTIONS.maxLevels, "reach should have grown, not collapsed");
  assertEquals(a.report.buildMs, 0, "no build frames, no build cost");
  assertEquals(a.report.buildDuty, 0);
});

Deno.test("a build that runs half the frames costs half of what it costs when it runs", () => {
  const a = new FarAdapt(8, 1, 1, OPTIONS);
  for (let f = 0; f < OPTIONS.framesPerWindow; f++) a.frame(UNMEASURED, 0.5, 4.0, 4.0, 0, f % 2 === 0);
  assertEquals(a.report.buildDuty, 0.5);
  assertEquals(a.report.buildMs, 2.0, "4 ms on half the frames is 2 ms a frame");
});

Deno.test("the display's period comes from the short end of the intervals, not the middle", () => {
  // A run that holds 120 Hz and one that misses every other vsync see the same display.
  assertEquals(refreshFromIntervals(8.33), 8.33);
  assertEquals(refreshFromIntervals(16.67), 16.67, "60 Hz reads as 60 Hz");
  // Out of range is a measurement to distrust: clamp rather than believe it.
  assertEquals(refreshFromIntervals(0.5), 4, "faster than any display");
  assertEquals(refreshFromIntervals(400), 34, "a stalled frame is not a 2.5 Hz display");
  assert(Number.isNaN(refreshFromIntervals(NaN)), "no samples, no period");
});

Deno.test("the budget is what the frame has left once the other passes are paid", () => {
  // 120 Hz with 3 ms of near field and culling: 8.33 - 3 - 1.5 reserve.
  const at120 = farBudgetMs(8.33, 3, OPTIONS);
  assertEquals(Math.round(at120 * 100) / 100, 3.83);
  // The same GPU on a 60 Hz display has a longer frame and so more to spend, capped at
  // half of it rather than the whole thing.
  assertEquals(farBudgetMs(16.67, 3, OPTIONS), 16.67 * OPTIONS.maxBudgetShare);
  // A near field that has eaten the frame squeezes the far field to the floor rather
  // than to nothing.
  assertEquals(farBudgetMs(16.67, 20, OPTIONS), OPTIONS.minBudgetMs);
  assert(Number.isNaN(farBudgetMs(NaN, 3, OPTIONS)), "no period, no budget");
  assert(Number.isNaN(farBudgetMs(8.33, NaN, OPTIONS)), "no pass times, no budget");
});

Deno.test("a measured budget overrides the fallback, and NaN falls back", () => {
  const a = new FarAdapt(8, 1, 1, OPTIONS);
  // 2 ms of far field fits the fallback budget of 3, so nothing is given up.
  for (let f = 0; f < OPTIONS.framesPerWindow; f++) a.frame(UNMEASURED, 2.0, 0, 0, 0, false);
  assertEquals(a.settings.levels, 8, "fits the fallback");
  assertEquals(a.report.budgetMs, OPTIONS.budgetMs, "reported the fallback");
  // The same cost against a measured 1 ms frame does not fit.
  for (let f = 0; f < OPTIONS.framesPerWindow; f++) a.frame(1.0, 2.0, 0, 0, 0, false);
  assertEquals(a.settings.levels, 7, "a tighter measured budget gives up reach");
  assertEquals(a.report.budgetMs, 1.0, "reported what it worked to");
});

Deno.test("sharpness is the last thing given up and the first taken back", () => {
  const a = new FarAdapt(OPTIONS.minLevels, OPTIONS.minSlabs, 1.0, OPTIONS);
  assertEquals(a.settings.scale, 1.0, "starts sharp");
  // Slabs and levels are already at the floor, so resolution is what is left to give.
  run(a, 1, 9, 0, 0);
  assertEquals(a.settings.scale, 0.75, "one step down");
  run(a, 1, 9, 0, 0);
  assertEquals(a.settings.scale, 0.5, "two steps down");
  run(a, 1, 9, 0, 0);
  assertEquals(a.settings.scale, 0.5, "floored, not below the lowest step");
  assert(a.report.action.includes("floor"), `expected a floor report, got "${a.report.action}"`);
  // Coming back: the free knob first (slabs cost nothing at rest), then sharpness, and
  // reach last, because the levels it would grow are the ones fog has already taken.
  const slabSteps = OPTIONS.maxSlabs - OPTIONS.minSlabs;
  run(a, slabSteps, 0.1, 0, 0);
  assertEquals(a.settings.slabsPerFrame, OPTIONS.maxSlabs, "the free knob comes back first");
  assertEquals(a.settings.scale, 0.5, "sharpness has not moved yet");
  run(a, 1, 0.1, 0, 0);
  assertEquals(a.settings.scale, 0.75, "then sharpness");
  assertEquals(a.settings.levels, OPTIONS.minLevels, "reach waits");
  run(a, 1, 0.1, 0, 0);
  assertEquals(a.settings.scale, 1.0, "back to sharp");
  run(a, 1, 0.1, 0, 0);
  assertEquals(a.settings.levels, OPTIONS.minLevels + 1, "only then does the reach grow");
});

Deno.test("a starting scale off the ladder snaps to the nearest step", () => {
  assertEquals(new FarAdapt(8, 1, 0.9, OPTIONS).settings.scale, 1.0);
  assertEquals(new FarAdapt(8, 1, 0.6, OPTIONS).settings.scale, 0.5);
  assertEquals(new FarAdapt(8, 1, 0.1, OPTIONS).settings.scale, 0.5, "clamped to the lowest step");
});
