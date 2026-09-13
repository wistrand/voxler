// The flock's shape is written twice: as constants in `birds-common.wgsl`, which the step
// and the draw both read, and as constants in `renderer.ts`, which sizes the state buffer
// and picks the workgroup and instance counts from them. Nothing in the type system
// connects the two, and getting them out of step is quiet: too small a buffer is an
// out-of-bounds write, too few workgroups is a flock that never moves, too few instances
// is a flock with birds missing. Same hazard as a stride copied into a shader
// (`src/far/brick-layout_test.ts`), so the same kind of test.

import { BIRD_STATE_FLOATS, birdReach, BIRDS, isHunter, NO_BIRD, pickBird } from "./birds.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function wgslConst(src: string, name: string): number | null {
  const m = src.match(new RegExp(`const\\s+${name}\\s*:\\s*(?:u32|f32)\\s*=\\s*([0-9.]+)u?\\s*;`));
  return m === null ? null : Number(m[1]);
}

function tsConst(src: string, name: string): number | null {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9.]+)\\s*;`));
  return m === null ? null : Number(m[1]);
}

Deno.test("the TypeScript side and the bird shaders agree on the flock", () => {
  const wgsl = Deno.readTextFileSync("src/render/birds-common.wgsl");
  const ts = Deno.readTextFileSync("src/render/birds.ts");
  const pairs: [string, string][] = [
    ["PER_FLOCK", "BIRD_PER_FLOCK"],
    ["FLOCKS", "BIRD_FLOCKS"],
    ["HUNTERS", "BIRD_HUNTERS"],
    // The picker tests a sphere the size of a bird, so it needs the draw's own numbers.
    ["WING_SPAN", "WING_SPAN"],
    ["HUNTER_SCALE", "HUNTER_SCALE"],
  ];
  for (const [inWgsl, inTs] of pairs) {
    const a = wgslConst(wgsl, inWgsl);
    const b = tsConst(ts, inTs);
    assert(a !== null, `birds-common.wgsl no longer declares ${inWgsl}; this test is stale`);
    assert(b !== null, `renderer.ts no longer declares ${inTs}; this test is stale`);
    assert(a === b, `${inWgsl} is ${a} in WGSL and ${b} in the renderer`);
  }
  // The step dispatches one workgroup a flock plus one for the hunters, and its workgroup
  // is PER_FLOCK wide, so the hunters have to fit in one flock's worth of lanes.
  const perFlock = wgslConst(wgsl, "PER_FLOCK")!;
  const hunters = wgslConst(wgsl, "HUNTERS")!;
  assert(hunters <= perFlock, `${hunters} hunters do not fit in a workgroup of ${perFlock}`);
  const renderer = Deno.readTextFileSync("src/render/renderer.ts");
  assert(renderer.includes("BIRD_FLOCKS + 1"), "the step should dispatch one workgroup a flock plus the hunters'");
});

Deno.test("the flock stays inside the meshed radius, where there is depth to hide it", () => {
  // Birds test and write the near field's depth and draw before the far field marches, so
  // one further out than the near field reaches would be drawn in front of a hill it is
  // behind. The default stream radius is 16 chunks.
  const wgsl = Deno.readTextFileSync("src/render/birds-common.wgsl");
  const home = wgslConst(wgsl, "HOME");
  const fadeOut = wgslConst(wgsl, "FADE_OUT");
  assert(home !== null && fadeOut !== null, "birds-common.wgsl no longer declares HOME and FADE_OUT");
  assert(home! <= 16 * 32, `the flock is kept ${home} voxels out, past the meshed radius of 512`);
  // Nothing may still be visible where the step carries a flock across the world, or the
  // carry is a pop.
  assert(fadeOut! <= home!, `birds fade out at ${fadeOut} but are carried at ${home}`);
});

Deno.test("the band the birds fly in clears the canopy", () => {
  // The forest's trees top out near 180 and its spawn stands at 188. A band under that is
  // birds in the trees.
  const wgsl = Deno.readTextFileSync("src/render/birds-common.wgsl");
  const low = wgslConst(wgsl, "BAND_LOW")!;
  const high = wgslConst(wgsl, "BAND_HIGH")!;
  assert(low > 185, `the band starts at ${low}, inside the canopy`);
  assert(high > low, "the band has to have room in it");
});

Deno.test("both halves of the wing beat are keyed to the same effort", () => {
  // The rate is state the step integrates and the amplitude is not, so they live in
  // different shaders and could easily drift apart: a bird whose wings beat fast through
  // a tiny arc, or slowly through a whole one, is a bird that reads as broken without
  // anything in the code looking wrong. One function, read by both, is what stops that.
  const common = Deno.readTextFileSync("src/render/birds-common.wgsl");
  const step = Deno.readTextFileSync("src/render/birds-step.wgsl");
  const draw = Deno.readTextFileSync("src/render/birds.wgsl");
  assert(common.includes("fn bird_effort("), "birds-common.wgsl no longer defines bird_effort");
  assert(step.includes("bird_effort("), "the step no longer keys the beat rate to effort");
  assert(draw.includes("bird_effort("), "the draw no longer keys the amplitude to effort");

  // Both are `floor + gain * effort`, and both have to rise with it: a bird climbing
  // works harder than one gliding down, which is the whole point of the term.
  const term = (src: string, what: string) => {
    const m = src.match(/\(\s*([0-9.]+)\s*\+\s*([0-9.]+)\s*\*\s*effort\s*\)/);
    assert(m !== null, `${what} is no longer a floor plus a gain times effort`);
    return { floor: Number(m![1]), gain: Number(m![2]) };
  };
  const rate = term(step, "the beat rate");
  const amp = term(draw, "the beat amplitude");
  for (const [name, t] of [["rate", rate], ["amplitude", amp]] as const) {
    assert(t.gain > 0, `the beat ${name} does not rise with effort`);
    assert(t.floor < t.gain, `the beat ${name} barely varies: ${t.floor} to ${t.floor + t.gain}`);
  }
});

Deno.test("a click picks the nearest bird along the ray, and nothing when it misses", () => {
  // A flock laid out by hand: three birds straight down the -Z axis at 50, 100 and 150
  // voxels, one off to the side, and the rest unplaced.
  const state = new Float32Array(BIRDS * BIRD_STATE_FLOATS);
  const place = (i: number, x: number, y: number, z: number) => {
    state[i * BIRD_STATE_FLOATS] = x;
    state[i * BIRD_STATE_FLOATS + 1] = y;
    state[i * BIRD_STATE_FLOATS + 2] = z;
    state[i * BIRD_STATE_FLOATS + 3] = 1; // placed
  };
  place(0, 0, 0, -50);
  place(1, 0, 0, -100);
  place(2, 0, 0, -150);
  place(3, 60, 0, -100);
  const down = (ox: number, oy: number, oz: number) => pickBird(state, ox, oy, oz, 0, 0, -1, 400);

  assert(down(0, 0, 0) === 0, "should take the nearest of three on the ray");
  assert(down(0, 0, -70) === 1, "should skip the one behind the eye");
  assert(down(0, 0, -160) === NO_BIRD, "nothing ahead is nothing to pick");
  assert(pickBird(state, 0, 0, 0, 0, 0, -1, 60) === 0, "within reach");
  assert(pickBird(state, 0, 0, 0, 0, 1, 0, 400) === NO_BIRD, "a ray into the sky hits none of them");
  // Just off the side of the first bird, inside and then outside the sphere it is tested
  // against: a click a whole bird's width away is a miss, or two birds in a flock would
  // be one target.
  assert(pickBird(state, birdReach(0) * 0.5, 0, 0, 0, 0, -1, 400) === 0, "a near miss still hits");
  assert(pickBird(state, birdReach(0) * 3, 0, 0, 0, 0, -1, 400) === NO_BIRD, "a wide miss does not");
  // An unplaced bird is not there to be clicked, whatever is in its slot.
  state[4 * BIRD_STATE_FLOATS + 2] = -10;
  assert(down(0, 0, 0) === 0, "an unplaced bird at zero is not the nearest thing");
});

Deno.test("a hunter is a bigger target than a small bird", () => {
  assert(birdReach(BIRDS - 1) > birdReach(0), "a hunter is the bigger bird");
  assert(isHunter(BIRDS - 1) && !isHunter(0), "the hunters are the tail of the buffer");
});
