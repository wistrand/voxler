// Drawing the flock. Requires camera.wgsl, the generated sky constants, sky-color.wgsl,
// shading.wgsl and birds-common.wgsl. The state it draws is stepped in birds-step.wgsl.
//
// Three boxes to a bird, built in the vertex stage from the bird's own frame: a body
// along the way it is going, and two wings hinged on it. Rotating the wings here rather
// than animating a stored shape is the whole reason a bird is drawn and not voxelized.

@group(1) @binding(0) var<storage, read> boids: array<Boid>;

// A white bird is a gull: small, long-winged, pale. A hunter is bigger, darker and
// broader in the wing, which at a few pixels is all the two need to differ by.
const BODY_LEN: f32 = 4.0;
const BODY_HALF: f32 = 0.65;
const WING_CHORD: f32 = 1.2;
const WING_THICK: f32 = 0.32;
// WING_SPAN and HUNTER_SCALE are in birds-common.wgsl: the CPU needs them to know how big
// a bird is when a click asks which one it hit.

// The bird a click picked, or a number no bird has. Not in the state buffer, because the
// step owns that and this is the other way round: the CPU chooses and the draw reads.
@group(1) @binding(1) var<uniform> picked: vec4u;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) normal: vec3f,
  @location(1) @interpolate(flat) tint: vec3f,
  @location(2) view: vec3f, // eye to fragment in render space, for fog
}

// One of a cube's 36 corners as a unit box from -1 to 1, and its face normal.
fn cube_corner(v: u32) -> vec3f {
  let face = v / 6u;
  var q = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
  let c = q[v % 6u];
  let a = f32(c & 1u) * 2.0 - 1.0;
  let b = f32((c >> 1u) & 1u) * 2.0 - 1.0;
  let axis = face / 2u;
  let side = select(-1.0, 1.0, (face & 1u) == 1u);
  if (axis == 0u) { return vec3f(side, a * side, b); }
  if (axis == 1u) { return vec3f(a * side, side, b); }
  return vec3f(a * side, b, side);
}

fn cube_normal(v: u32) -> vec3f {
  let face = v / 6u;
  let axis = face / 2u;
  let side = select(-1.0, 1.0, (face & 1u) == 1u);
  return vec3f(f32(axis == 0u), f32(axis == 1u), f32(axis == 2u)) * side;
}

fn degenerate() -> VsOut {
  var out: VsOut;
  out.position = vec4f(0.0, 0.0, 0.0, 1.0);
  out.normal = vec3f(0.0, 1.0, 0.0);
  out.tint = vec3f(0.0);
  out.view = vec3f(0.0, 0.0, 1.0);
  return out;
}

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VsOut {
  let index = instance / 3u; // three boxes to a bird
  let part = instance % 3u;
  if (index >= BIRDS) {
    return degenerate();
  }
  let bird = boids[index];
  if (bird.pos.w == 0.0) {
    return degenerate(); // not placed yet: the step has not run
  }
  let hunter = is_hunter(index);

  // Render space, which is where everything else in the frame already is.
  let local = bird.pos.xyz - vec3f(camera.chunk.xyz * 32);
  // Shrunk to nothing at the edge of the box the step keeps them in, so the carry that
  // happens out there is a carry of something nobody can see.
  let far = max(abs(local.x - camera.offset.x), abs(local.z - camera.offset.z));
  let fade = 1.0 - smoothstep(FADE_IN, FADE_OUT, far);
  if (fade <= 0.0) {
    return degenerate();
  }
  let scale = fade * select(1.0, HUNTER_SCALE, hunter);

  // The bird's own frame: forward along its flight, up as near world up as it can be.
  let moving = length(bird.vel.xyz) > 1e-4;
  let fwd = normalize(select(vec3f(0.0, 0.0, 1.0), bird.vel.xyz, moving));
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, fwd);

  let corner = cube_corner(vertex);
  var n = cube_normal(vertex);
  var p: vec3f;
  if (part == 0u) {
    // The body, tapered at the tail by pulling the back face in, which is the difference
    // between a bird and a brick.
    let taper = select(1.0, 0.45, corner.x < 0.0);
    p = vec3f(corner.x * BODY_LEN * 0.5, corner.y * BODY_HALF * taper, corner.z * BODY_HALF * taper);
  } else {
    // A wing: a slab out to one side, hinged at the body and beating about the flight
    // axis. A hunter's is broader in the chord and beats through a shallower arc, which
    // with the slower phase reads as a bird that soars rather than one that flits.
    let dir = select(-1.0, 1.0, part == 1u);
    let chord = WING_CHORD * select(1.0, 1.5, hunter);
    // How far the wing beats, and where it sits when it is not beating. Both follow the
    // work the bird is doing: climbing it beats through the whole arc, gliding it holds
    // the wings out in a shallow V and rides, and the beat rate the step integrates has
    // already dropped to nothing by then (birds-common.wgsl `bird_effort`).
    let effort = bird_effort(bird.vel.xyz);
    let amp = select(0.85, 0.45, hunter) * (0.12 + 0.88 * effort);
    let dihedral = (1.0 - effort) * select(0.22, 0.32, hunter);
    // Positive is up. The rotation below takes a wing *down* for a positive angle, so the
    // sign is turned once here rather than being carried through the numbers above.
    let bend = dihedral + sin(bird.vel.w) * amp;
    let root = vec3f(corner.x * chord * 0.5, corner.y * WING_THICK, (corner.z * 0.5 + 0.5) * WING_SPAN * dir);
    let a = -bend * dir;
    let c = cos(a);
    let s = sin(a);
    p = vec3f(root.x, root.y * c - root.z * s, root.y * s + root.z * c);
    n = vec3f(n.x, n.y * c - n.z * s, n.y * s + n.z * c);
  }
  let offset = right * p.z + up * p.y + fwd * p.x;
  let world_n = normalize(right * n.z + up * n.y + fwd * n.x);
  let at = local + offset * scale;

  var out: VsOut;
  out.position = camera.view_proj * vec4f(at, 1.0);
  out.normal = world_n;
  out.view = at - camera.offset.xyz;
  // Countershaded, which is what a real bird is and what makes this one legible from
  // either side: dark on the back, where it is seen against the wood, and pale
  // underneath, where it is seen against the sky. The forest's own sky is night, and a
  // bird dark on every face is invisible in it. A hunter is dark on both, which is the
  // difference the eye picks up first.
  let under = world_n.y < -0.3;
  let pale = vec3f(0.92, 0.93, 0.96);
  let back = vec3f(0.80, 0.82, 0.86);
  let dark = vec3f(0.17, 0.15, 0.14);
  var tint = select(select(back, pale, under), select(dark, dark * 2.2, under), hunter);
  // The one a click picked out. Amber, which nothing else in this world is, and bright
  // enough to find again at night: a bird is a few pixels and a subtler mark would be a
  // mark nobody could see.
  if (index == picked.x) {
    tint = mix(tint, vec3f(1.0, 0.62, 0.12), 0.85) + vec3f(0.25, 0.13, 0.0);
  }
  out.tint = tint;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let lit = in.tint * surface_light(in.normal);
  let dist = length(in.view);
  return vec4f(apply_fog(lit, in.view / max(dist, 1e-5), dist), 1.0);
}
