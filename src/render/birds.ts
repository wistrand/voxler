// The flock's shape and the one thing about it that is worked out on the CPU: which bird
// a ray hits. Pure, so it runs in `deno test` without a GPU.
//
// The numbers here are also written in `birds-common.wgsl`, which the step and the draw
// both read, and nothing in the type system connects the two; `birds_test.ts` checks them
// against each other.

// Small white birds in flocks, and the hunters that work them. One buffer holds both:
// `[0, WHITE)` are the flocking birds, laid out flock by flock, and the rest are hunters.
export const BIRD_PER_FLOCK = 24;
export const BIRD_FLOCKS = 6;
export const BIRD_HUNTERS = 4;
export const BIRD_WHITE = BIRD_PER_FLOCK * BIRD_FLOCKS;
export const BIRDS = BIRD_WHITE + BIRD_HUNTERS;

// Two vec4f a bird: position with a placed flag in w, then velocity with the wing phase.
export const BIRD_STATE_FLOATS = 8;
export const BIRD_STATE_BYTES = BIRDS * BIRD_STATE_FLOATS * 4;

// How far a bird reaches from its own centre, in voxels: the wing, which is the widest
// part of it, times the hunter's scale.
const WING_SPAN = 5.2;
const HUNTER_SCALE = 1.8;
// Clicking is aimed by hand at a thing a few pixels across, so the sphere the ray is
// tested against is a little wider than the bird. Generous enough to hit and tight enough
// that two birds in a flock are still two things.
const PICK_SLACK = 1.35;

export const NO_BIRD = -1;

export function isHunter(index: number): boolean {
  return index >= BIRD_WHITE;
}

export function birdReach(index: number): number {
  return WING_SPAN * (isHunter(index) ? HUNTER_SCALE : 1);
}

// The nearest bird the ray hits, or `NO_BIRD`. `state` is the flock buffer read back from
// the GPU, `origin` the camera in world voxels and `dir` a unit direction.
//
// A sphere a bird, rather than the three boxes it is actually drawn as: the boxes are
// built in the vertex stage from a heading and a wing phase, and rebuilding them here to
// click on would be a second copy of the bird's shape that could drift from the first.
// What is lost is the air between a wing and a body, which nobody is aiming at.
export function pickBird(
  state: Float32Array,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): number {
  let best = NO_BIRD;
  let nearest = maxDistance;
  const count = Math.min(BIRDS, Math.floor(state.length / BIRD_STATE_FLOATS));
  for (let i = 0; i < count; i++) {
    const at = i * BIRD_STATE_FLOATS;
    if (state[at + 3] === 0) continue; // not placed yet: the step has not run
    const vx = state[at] - ox;
    const vy = state[at + 1] - oy;
    const vz = state[at + 2] - oz;
    // How far along the ray the bird's centre projects. Behind the eye, or further than
    // something already hit, and there is nothing to test.
    const t = vx * dx + vy * dy + vz * dz;
    if (t <= 0 || t >= nearest) continue;
    const r = birdReach(i) * PICK_SLACK;
    const miss = vx * vx + vy * vy + vz * vz - t * t;
    if (miss > r * r) continue;
    nearest = t;
    best = i;
  }
  return best;
}

// One line about a bird, for the on-screen panel.
export function describeBird(state: Float32Array, index: number): string {
  if (index < 0 || index >= BIRDS) return "";
  const at = index * BIRD_STATE_FLOATS;
  const vx = state[at + 4], vy = state[at + 5], vz = state[at + 6];
  const speed = Math.hypot(vx, vy, vz);
  // The same climb angle the wing beat is keyed to (birds-common.wgsl `bird_effort`), so
  // what the panel says and what the wings are doing are the same number.
  const climb = speed > 0 ? Math.round(Math.asin(Math.max(-1, Math.min(1, vy / speed))) * (180 / Math.PI)) : 0;
  const kind = isHunter(index) ? "hunter" : `flock ${Math.floor(index / BIRD_PER_FLOCK) + 1}`;
  const going = climb > 3 ? `climbing ${climb}°` : climb < -3 ? `gliding ${-climb}°` : "level";
  return `bird ${index} (${kind})  y ${Math.round(state[at + 1])}  ${speed.toFixed(0)} v/s  ${going}`;
}
