// One step of the flock. Requires camera.wgsl and birds-common.wgsl.
//
// Three rules and two more, which is as much boid as this needs: separation, alignment
// and cohesion inside a flock; a band to stay in; and a hunter to get away from. The
// hunters have their own two: pick the nearest flock and lean on it, and keep off each
// other.
//
// One workgroup to a flock, so the flock's own centroid and mean heading are a workgroup
// reduction and the neighbour loop reads workgroup memory rather than the buffer. The
// last workgroup takes the hunters. At twenty-four birds a flock that is 576 pair tests
// per flock per frame, which is nothing, and it is why the neighbourhood is the whole
// flock rather than a radius: a radius needs a grid to be cheap, and a grid is more
// machinery than four dozen birds are worth.

@group(1) @binding(0) var<storage, read_write> boids: array<Boid>;

const SEPARATION: f32 = 9.0; // voxels; under this two birds push apart
const NEIGHBOUR: f32 = 60.0; // and over this they ignore each other, so a flock can split
const FLEE: f32 = 70.0; // how far a white bird sees a hunter
const WHITE_SPEED: f32 = 21.0;
const HUNTER_SPEED: f32 = 27.0;
const TURN: f32 = 3.4; // voxels a second a second: how hard any of them may steer

// Air a bird wants under it, in voxels, and how many places it looks for it. The probes
// are spread over that reach, so the clipmap's cell size sets how sharp the answer is
// (two voxels at the finest level, wider further out) and this sets how early it comes.
const GROUND_CLEAR: f32 = 26.0;
const GROUND_PROBES: u32 = 5u;
// How far ahead it looks for the ground, in seconds of its own flight.
const GROUND_LOOK: f32 = 1.0;
// The climb out of rock a bird is already in, per step, and how many steps it may take.
const GROUND_ESCAPE: f32 = 5.0;
const GROUND_ESCAPE_STEPS: u32 = 10u;
// How hard it climbs with no air left at all. Far over anything else here: everything
// else in the flock is a preference, and this is not.
const GROUND_LIFT: f32 = 260.0;

var<workgroup> wg_pos: array<vec3f, PER_FLOCK>;
var<workgroup> wg_vel: array<vec3f, PER_FLOCK>;

// Where a bird starts, the first time the buffer is seen. Spread around the camera, in
// the band, with the flock together and pointed one way: a flock that starts scattered
// takes half a minute to pull itself in, and the first half minute is the one somebody is
// watching.
fn place(i: u32, home: vec3f) -> Boid {
  let flock = i / PER_FLOCK;
  let seed = select(flock, i, is_hunter(i));
  let a = bird_hash(seed, 1u) * 6.2831853;
  let r = (0.35 + bird_hash(seed, 2u) * 0.5) * HOME;
  let centre = home + vec3f(cos(a) * r, 0.0, sin(a) * r);
  let jitter = vec3f(bird_hash(i, 3u) - 0.5, bird_hash(i, 4u) - 0.5, bird_hash(i, 5u) - 0.5) * 26.0;
  let heading = bird_hash(seed, 6u) * 6.2831853;
  let speed = select(WHITE_SPEED, HUNTER_SPEED, is_hunter(i));
  var out: Boid;
  out.pos = vec4f(
    centre.x + jitter.x,
    BAND_LOW + bird_hash(i, 7u) * (BAND_HIGH - BAND_LOW),
    centre.z + jitter.z,
    1.0,
  );
  out.vel = vec4f(cos(heading) * speed, 0.0, sin(heading) * speed, bird_hash(i, 8u) * 6.2831853);
  return out;
}

// Clamp a steering force, so nothing in the flock can turn faster than a bird turns.
fn limit(v: vec3f, most: f32) -> vec3f {
  let n = length(v);
  return select(v, v * (most / n), n > most);
}

@compute @workgroup_size(PER_FLOCK)
fn step(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let dt = camera.time.y;
  let home = camera_world();
  let hunters = group.x == FLOCKS;
  let i = select(group.x * PER_FLOCK + lane, WHITE + lane, hunters);
  let live = select(true, lane < HUNTERS, hunters);

  var me: Boid;
  if (live) {
    me = boids[i];
    if (me.pos.w == 0.0) {
      me = place(i, home);
    }
  }

  // The flock's own birds into workgroup memory once, so the neighbour loop below is not
  // twenty-four reads of the buffer per bird.
  wg_pos[lane] = me.pos.xyz;
  wg_vel[lane] = me.vel.xyz;
  workgroupBarrier();

  if (!live) {
    return;
  }

  var accel = vec3f(0.0);
  if (!hunters) {
    var centre = vec3f(0.0);
    var heading = vec3f(0.0);
    var push = vec3f(0.0);
    var seen = 0.0;
    for (var k = 0u; k < PER_FLOCK; k++) {
      if (k == lane) {
        continue;
      }
      let d = wg_pos[k] - me.pos.xyz;
      let dist = length(d);
      if (dist >= NEIGHBOUR) {
        continue;
      }
      seen += 1.0;
      centre += wg_pos[k];
      heading += wg_vel[k];
      if (dist < SEPARATION && dist > 1e-4) {
        // Falls off with distance, so the push is a nudge at the edge of the radius and
        // a shove when they are about to touch.
        push -= d / (dist * dist) * SEPARATION;
      }
    }
    if (seen > 0.0) {
      accel += (centre / seen - me.pos.xyz) * 0.55; // cohesion
      accel += (heading / seen - me.vel.xyz) * 1.20; // alignment
      accel += push * 9.0; // separation
    }
    // The hunters, which they can all see further than they see each other.
    for (var h = 0u; h < HUNTERS; h++) {
      let d = me.pos.xyz - boids[WHITE + h].pos.xyz;
      let dist = length(d);
      if (dist < FLEE && dist > 1e-4) {
        accel += d / dist * (1.0 - dist / FLEE) * 95.0;
      }
    }
  } else {
    // A hunter leans on the nearest flock and keeps off the other hunters. It never
    // catches anything: what reads from the ground is a dark bird working a white flock
    // and the flock bending away from it, and a catch would need the flock to be able to
    // lose one.
    var best = 1e9;
    var quarry = me.pos.xyz + me.vel.xyz;
    for (var f = 0u; f < FLOCKS; f++) {
      // The flock's first bird stands for the flock: a centroid over every member would
      // be another hundred reads for a number that moves with the flock anyway.
      let at = boids[f * PER_FLOCK].pos.xyz;
      let dist = distance(at, me.pos.xyz);
      if (dist < best) {
        best = dist;
        quarry = at;
      }
    }
    accel += normalize(quarry - me.pos.xyz) * 16.0;
    for (var h = 0u; h < HUNTERS; h++) {
      if (h == lane) {
        continue;
      }
      let d = me.pos.xyz - boids[WHITE + h].pos.xyz;
      let dist = length(d);
      if (dist < 90.0 && dist > 1e-4) {
        accel += d / dist * 30.0;
      }
    }
  }

  // The band, as a height it is heading for rather than a wall it bounces off, and that
  // height rises and falls: a bird that holds one altitude never climbs and never glides,
  // and climbing and gliding is what the wing beat is keyed to. The cycle is a whole
  // number of turns of the wind clock, so it comes back to itself at the wrap; the white
  // birds take four seconds over it and the hunters eight, which on its own reads as one
  // working and the other riding.
  let low = BAND_LOW + select(0.0, 14.0, hunters);
  let high = BAND_HIGH + select(0.0, 20.0, hunters);
  let turns = select(2.0, 1.0, hunters);
  let swing = sin(camera.time.x * (6.2831853 / 8.0) * turns + bird_hash(i, 11u) * 6.2831853);
  // Each bird around its own height in the band, so the flock is spread through it, and
  // the swing is small: a bird undulates by a few voxels, and a target that moved faster
  // than the bird flies would have it climbing at sixty degrees to keep up.
  let base_y = mix(low, high, 0.15 + 0.7 * bird_hash(i, 12u));
  accel.y += (base_y + swing * select(8.0, 11.0, hunters) - me.pos.y) * 1.1;
  // And a wall after all, for a bird the flock has shoved out of the band entirely.
  accel.y += max(0.0, low - me.pos.y) * 1.6 - max(0.0, me.pos.y - high) * 1.6;

  // The ground, which the band on its own knows nothing about: it is a pair of absolute
  // heights, and the forest's mountains stand well through it. Asked of the far field's
  // clipmap, which already holds the world around the camera as occupancy and is already
  // bound for the shadow rays, so this costs a handful of cell reads and no new data
  // (far/shadow.wgsl `sh_solid_at`). A bird outside the clipmap's window, or in a world
  // with `?far=0`, keeps the absolute band and nothing else.
  //
  // Under the bird and under where it will be in a second, because a slope rising into a
  // bird flying level has nothing under the bird until it is far too late. The nearest
  // probe that finds rock is what sets the lift; nothing inside `GROUND_CLEAR` leaves it
  // at zero.
  var lift = 0.0;
  if (sh_ground_reaches()) {
    let render = me.pos.xyz - vec3f(camera.chunk.xyz * 32);
    let ahead = render + me.vel.xyz * GROUND_LOOK;
    var clear = GROUND_CLEAR;
    for (var k = 0u; k < GROUND_PROBES; k++) {
      let down = GROUND_CLEAR * (1.0 - f32(k) / f32(GROUND_PROBES));
      let drop = vec3f(0.0, down, 0.0);
      if (sh_solid_at(render - drop) || sh_solid_at(ahead - drop)) {
        clear = down;
        break;
      }
    }
    lift = (1.0 - clear / GROUND_CLEAR) * GROUND_LIFT;
  }
  // A little wander, keyed to the bird, or a settled flock flies in a dead straight line.
  let wobble = camera.time.x * 3.0 + bird_hash(i, 9u) * 6.2831853;
  accel += vec3f(sin(wobble), sin(wobble * 0.7) * 0.35, cos(wobble * 1.3)) * 6.0;

  var vel = me.vel.xyz + limit(accel, TURN * 12.0) * dt;
  // Outside the steering clamp, because everything else in the flock is a preference and
  // this is not: a bird may be pulled off its heading by its neighbours and it may not be
  // pulled into a hill. The renormalisation below turns it back into a heading, so what a
  // large lift buys is a steeper climb and never a faster bird.
  vel.y += lift * dt;
  // Birds fly at a bird's speed: the rules set the heading and this sets the pace.
  let want = select(WHITE_SPEED, HUNTER_SPEED, hunters);
  let speed = max(length(vel), 1e-4);
  vel *= want / speed;
  var pos = me.pos.xyz + vel * dt;

  // Carried back when it has gone too far, as a whole flock and in one axis at a time, so
  // the shape of the flock survives the trip. It happens where `FADE_OUT` has already
  // taken the birds to nothing, so what pops is nothing.
  let span = 2.0 * HOME;
  let off = pos - home;
  if (abs(off.x) > HOME) {
    pos.x -= sign(off.x) * span;
  }
  if (abs(off.z) > HOME) {
    pos.z -= sign(off.z) * span;
  }

  // The last resort, for ground that arrived faster than a bird can climb: a chunk that
  // has just streamed in under it, or a cliff met square on. It only ever moves up, and
  // only out of rock it is already inside, so on the frames that matter it does nothing.
  // Bounded, because an unbounded loop in a shader can reset the GPU
  // (gotchas.md "A loop the GPU cannot leave").
  if (sh_ground_reaches()) {
    let render = pos - vec3f(camera.chunk.xyz * 32);
    var up = 0.0;
    for (var k = 0u; k < GROUND_ESCAPE_STEPS; k++) {
      if (!sh_solid_at(render + vec3f(0.0, up, 0.0))) {
        break;
      }
      up += GROUND_ESCAPE;
    }
    pos.y += up;
  }

  // The wing beat, integrated: faster for the small birds, slower for the hunters, which
  // is most of what tells the two apart at a distance, and faster again for whichever of
  // them is climbing. A bird on the way down barely moves its wings at all, which is the
  // other half of what `bird_effort` is for; the amplitude is the draw's half.
  let effort = bird_effort(vel);
  let beat = select(15.0, 6.5, hunters) * (0.85 + bird_hash(i, 10u) * 0.3) * (0.18 + 1.5 * effort);
  let phase = fract((me.vel.w + beat * dt) / 6.2831853) * 6.2831853;

  boids[i].pos = vec4f(pos, 1.0);
  boids[i].vel = vec4f(vel, phase);
}
