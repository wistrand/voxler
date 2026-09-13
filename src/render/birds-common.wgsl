// Shared by the boid step (birds-step.wgsl) and the draw (birds.wgsl): the state layout,
// the flock's shape, and the helpers both need. No bindings, so each of the two can
// declare the buffer with the access it is allowed (a vertex stage may only read a
// storage buffer, and the step has to write one).
//
// Birds are the one thing in this engine that is not in the world SDF, and they cannot
// be: a chunk is voxelized once and a brick is sampled once, so anything whose position
// depends on time would have to put every chunk it crosses back through the voxelizer
// every frame. The two kinds of motion a world block has (`sway` in the vertex stage,
// `flow` in the texture) both animate a thing that stays where it is, which is what a
// leaf and a waterfall do and not what a bird does.
//
// So a bird is drawn instead of stored: no chunk, no brick, no block id, no shadow, and
// no place in the far field. It is also the one thing here that carries state between
// frames, because a boid is defined by what its neighbours are doing and no function of
// position and time can answer that.

// Small white birds in flocks, and the hunters that work them. One buffer holds both:
// `[0, WHITE)` are the flocking birds, laid out flock by flock, and the rest are hunters.
// The draw's own numbers live here too, because the CPU needs them to work out which
// bird a click hit (`src/render/birds.ts`, checked against this file by birds_test.ts).
const WING_SPAN: f32 = 5.2;
const HUNTER_SCALE: f32 = 1.8;

const PER_FLOCK: u32 = 24u;
const FLOCKS: u32 = 6u;
const WHITE: u32 = PER_FLOCK * FLOCKS;
const HUNTERS: u32 = 4u;
const BIRDS: u32 = WHITE + HUNTERS;

// How far from the camera the flock is kept, in voxels. It has to stay inside the near
// field's meshed radius (`?streamRadius`, 16 chunks = 512 voxels): birds test and write
// the near field's depth and draw before the far field marches, so one further out than
// the depth buffer holds terrain would be drawn in front of a hill it is behind.
const HOME: f32 = 300.0;
// Where the birds are shrunk to nothing rather than popped out of existence, and where
// they are gone. A flock is carried across the world when it leaves the box, and the wrap
// has to happen somewhere nobody is looking.
const FADE_IN: f32 = 215.0;
const FADE_OUT: f32 = 285.0;

// The band they fly in. Above the canopy (the forest's trees top out near 180) and under
// the snow line, so it is sky over the wood and rock over the mountains, where the near
// field's depth hides them.
const BAND_LOW: f32 = 194.0;
const BAND_HIGH: f32 = 258.0;

struct Boid {
  // xyz world position; w is 0 until the bird has been placed, which is how the step
  // knows a zeroed buffer from a live one without a flag from the CPU.
  pos: vec4f,
  // xyz voxels a second; w is the wing phase in radians, integrated rather than taken
  // from the clock so the beat does not depend on a wrap.
  vel: vec4f,
}

fn bird_hash(i: u32, salt: u32) -> f32 {
  var h = (i * 73856093u) ^ (salt * 19349663u);
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return f32(h & 0xffffffu) / f32(0x1000000u);
}

// How hard a bird is working, 0 gliding to 1 climbing, from the climb angle and nothing
// else. Lift costs energy and a descent gives it back, so a bird going up beats its wings
// deeper and faster and one coming down holds them out and rides. Both the step and the
// draw read this: the step turns it into the beat rate, which is state it has to
// integrate, and the draw turns it into the amplitude and the dihedral, which are not.
// One function so the two halves of the same wing cannot disagree.
//
// `vel` is renormalised to a fixed speed every step, so `vel.y / |vel|` is the sine of
// the climb angle. The gain is what spreads a climb angle a bird actually reaches over
// the whole range.
fn bird_effort(vel: vec3f) -> f32 {
  return clamp(0.5 + (vel.y / max(length(vel), 1e-4)) * 2.2, 0.0, 1.0);
}

fn is_hunter(i: u32) -> bool {
  return i >= WHITE;
}

// The camera in world voxels, from the two halves the uniform carries it in.
fn camera_world() -> vec3f {
  return vec3f(camera.chunk.xyz * 32) + camera.offset.xyz;
}
