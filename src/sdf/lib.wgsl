// SDF library for world programs. Concatenated ahead of the world file in every
// shader that evaluates a world (the preview; later the voxelizer and brick
// sampler). Distances are in voxels. Contract: agent_docs/design-formats.md
// "World program".
//
// Primitive and smooth-min formulas follow Inigo Quilez's articles
// (iquilezles.org), as ported earlier in ../astrocatch (MIT, same author). The
// hash is pcg3d (Jarzynski and Olano, "Hash Functions for GPU Rendering", 2020);
// the noise gradients are Ken Perlin's improved-noise edge set.

// ---------------------------------------------------------------------------
// World points

// A world position as an integer voxel coordinate plus a fraction in [0, 1).
// Exact at any distance from the origin, unlike a plain vec3f.
struct WorldPoint {
  cell: vec3i,
  frac: vec3f,
}

// Seed of the world being evaluated. Every entry point sets it from its own
// uniform before calling world_sdf or world_material.
var<private> world_seed: u32;

// Size in voxels of the region one sample stands for: 1 when voxelizing, a pixel's
// footprint in the preview, a cell size for far-field bricks. Noise skips octaves
// whose wavelength is below it (fading the last one in), so coarse samples don't
// pay for detail they can't show. A skipped octave contributes 0, the noise mean:
// world code whose features depend on zero crossings (caves, ridges carved at 0)
// must check sample_footprint itself. Entry points set it; worlds only read it.
var<private> sample_footprint: f32;

// Normalizes cell + offset so the fraction is in [0, 1).
fn wp_make(cell: vec3i, offset: vec3f) -> WorldPoint {
  let f = floor(offset);
  return WorldPoint(cell + vec3i(f), offset - f);
}

fn wp_offset(p: WorldPoint, d: vec3f) -> WorldPoint {
  return wp_make(p.cell, p.frac + d);
}

// Position relative to an integer anchor; exact while the result is small.
// Use this to place objects anywhere in the world.
fn wp_local(p: WorldPoint, anchor: vec3i) -> vec3f {
  return vec3f(p.cell - anchor) + p.frac;
}

// Plain vec3f position: exact near the origin, about 0.06 voxels coarse at 1e6.
fn wp_f32(p: WorldPoint) -> vec3f {
  return vec3f(p.cell) + p.frac;
}

// Floor division for a positive divisor (WGSL i32 division truncates toward 0).
fn floor_div(a: vec3i, b: vec3i) -> vec3i {
  return (a - select(vec3i(0), b - 1, a < vec3i(0))) / b;
}

// Domain repetition with an integer period, exact at any distance: the position
// inside the repeated cell, centered on the cell.
fn wp_repeat(p: WorldPoint, period: vec3i) -> vec3f {
  let m = p.cell - floor_div(p.cell, period) * period;
  return vec3f(m) + p.frac - vec3f(period) * 0.5;
}

// Which repeated cell p is in, for varying repeated content.
fn wp_repeat_id(p: WorldPoint, period: vec3i) -> vec3i {
  return floor_div(p.cell, period);
}

// Position relative to the object in a *neighbouring* repeated cell, for the usual
// 3x3 loop: `q` is the sample point already offset by `-shift`, and `shift` is that
// offset, a whole number of periods.
//
// This exists because the obvious way to write it is silently wrong, and it is wrong in
// exactly the way that makes a scatter look like a grid. `wp_repeat` is periodic, so
// offsetting the point by a whole period before calling it hands back the *same* number:
// the neighbour's object comes out placed around the sample's own cell instead of around
// its own. Nine objects crowd onto every cell centre, each one visible only while the
// sample point is inside that cell, so every object that reaches past a cell boundary is
// cut off at it (gotchas.md "Domain repetition loses the neighbour offset").
fn wp_repeat_near(q: WorldPoint, period: vec3i, shift: vec3i) -> vec3f {
  return wp_repeat(q, period) + vec3f(shift);
}

// Lattice coordinates at a wavelength of 2^k voxels: exact integer lattice cell
// plus a fraction in [0, 1). k must be at most 30.
struct Lattice {
  cell: vec3i,
  frac: vec3f,
}

fn wp_lattice(p: WorldPoint, k: u32) -> Lattice {
  let c = p.cell >> vec3u(k); // arithmetic shift: floor division by 2^k
  let rem = p.cell - (c << vec3u(k));
  return Lattice(c, (vec3f(rem) + p.frac) / f32(1u << k));
}

// ---------------------------------------------------------------------------
// Hashing and noise (all seeded, all integer-lattice based)

fn pcg3d(v0: vec3u) -> vec3u {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

fn hash3(c: vec3i, seed: u32) -> vec3u {
  return pcg3d(bitcast<vec3u>(c) + vec3u(seed, seed * 0x9E3779B9u, seed * 0x85EBCA6Bu));
}

fn fade3(t: vec3f) -> vec3f {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// Perlin's improved-noise gradient: one of 12 edge directions dotted with f.
fn grad_dot3(h: u32, f: vec3f) -> f32 {
  let k = h & 15u;
  let u = select(f.y, f.x, k < 8u);
  let v = select(select(f.z, f.x, k == 12u || k == 14u), f.y, k < 4u);
  return select(u, -u, (k & 1u) != 0u) + select(v, -v, (k & 2u) != 0u);
}

// 3D gradient noise, roughly in [-1, 1].
fn gnoise3(l: Lattice, seed: u32) -> f32 {
  let c = l.cell;
  let f = l.frac;
  let u = fade3(f);
  let n000 = grad_dot3(hash3(c, seed).x, f);
  let n100 = grad_dot3(hash3(c + vec3i(1, 0, 0), seed).x, f - vec3f(1.0, 0.0, 0.0));
  let n010 = grad_dot3(hash3(c + vec3i(0, 1, 0), seed).x, f - vec3f(0.0, 1.0, 0.0));
  let n110 = grad_dot3(hash3(c + vec3i(1, 1, 0), seed).x, f - vec3f(1.0, 1.0, 0.0));
  let n001 = grad_dot3(hash3(c + vec3i(0, 0, 1), seed).x, f - vec3f(0.0, 0.0, 1.0));
  let n101 = grad_dot3(hash3(c + vec3i(1, 0, 1), seed).x, f - vec3f(1.0, 0.0, 1.0));
  let n011 = grad_dot3(hash3(c + vec3i(0, 1, 1), seed).x, f - vec3f(0.0, 1.0, 1.0));
  let n111 = grad_dot3(hash3(c + vec3i(1, 1, 1), seed).x, f - vec3f(1.0, 1.0, 1.0));
  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

// 2D gradient noise over a lattice's xz, roughly in [-1, 1]. Half the cost of
// gnoise3; use it for heightfields.
fn gnoise2(cell: vec2i, f: vec2f, seed: u32) -> f32 {
  var dirs = array<vec2f, 8>(
    vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0),
    vec2f(0.7071, 0.7071), vec2f(-0.7071, 0.7071), vec2f(0.7071, -0.7071), vec2f(-0.7071, -0.7071),
  );
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let n00 = dot(dirs[hash3(vec3i(cell, 0), seed).x & 7u], f);
  let n10 = dot(dirs[hash3(vec3i(cell + vec2i(1, 0), 0), seed).x & 7u], f - vec2f(1.0, 0.0));
  let n01 = dot(dirs[hash3(vec3i(cell + vec2i(0, 1), 0), seed).x & 7u], f - vec2f(0.0, 1.0));
  let n11 = dot(dirs[hash3(vec3i(cell + vec2i(1, 1), 0), seed).x & 7u], f - vec2f(1.0, 1.0));
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y) * 1.4142;
}

// Integer shift per octave, so octave lattices don't line up at the origin. Cheap
// affine function of the octave and seed; it only has to break alignment.
fn octave_shift(octave: u32) -> vec3i {
  let o = i32(octave);
  return vec3i(o * 7919 + i32(world_seed & 0xFFFFu), o * 6271 - 1301, o * 5381 + 977);
}

// Weight of an octave with wavelength 2^k at the current sample_footprint: 1 for
// wavelengths of at least twice the footprint, 0 below the footprint, smooth
// between (so detail fades in instead of popping as the footprint changes).
fn octave_weight(k: u32) -> f32 {
  let f = max(sample_footprint, 1e-3);
  return smoothstep(f, 2.0 * f, f32(1u << k));
}

// Fractal sum of 2D noise over x and z. Wavelengths start at 2^k0 voxels and halve
// per octave (never below 1 voxel); amplitudes scale by `gain`. Roughly [-1, 1].
// Octaves finer than sample_footprint are skipped (see its comment).
fn fbm2(p: WorldPoint, k0: u32, octaves: u32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  for (var i = 0u; i < octaves; i++) {
    let k = select(k0 - i, 0u, i > k0);
    let w = octave_weight(k);
    if (w > 0.0) {
      let l = wp_lattice(WorldPoint(p.cell + octave_shift(i), p.frac), k);
      sum += amp * w * gnoise2(l.cell.xz, l.frac.xz, world_seed + i * 0x632BE5ABu);
    }
    norm += amp;
    amp *= gain;
  }
  return sum / norm;
}

// Fractal sum of 3D noise, as fbm2. Roughly [-1, 1].
fn fbm3(p: WorldPoint, k0: u32, octaves: u32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  for (var i = 0u; i < octaves; i++) {
    let k = select(k0 - i, 0u, i > k0);
    let w = octave_weight(k);
    if (w > 0.0) {
      let l = wp_lattice(WorldPoint(p.cell + octave_shift(i), p.frac), k);
      sum += amp * w * gnoise3(l, world_seed + i * 0x632BE5ABu);
    }
    norm += amp;
    amp *= gain;
  }
  return sum / norm;
}

// Ridged 2D fractal: sharp crests where the noise crosses zero. In [0, 1]. Unlike
// fbm, a ridged octave has a positive mean, so skipped octaves are left out of the
// normalization too: the level stays put and only detail fades with footprint.
fn ridged2(p: WorldPoint, k0: u32, octaves: u32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  for (var i = 0u; i < octaves; i++) {
    let k = select(k0 - i, 0u, i > k0);
    let w = octave_weight(k);
    if (w > 0.0) {
      let l = wp_lattice(WorldPoint(p.cell + octave_shift(i + 64u), p.frac), k);
      let n = 1.0 - abs(gnoise2(l.cell.xz, l.frac.xz, world_seed + (i + 64u) * 0x632BE5ABu));
      sum += amp * w * n * n;
      norm += amp * w;
    }
    amp *= gain;
  }
  return select(0.5, sum / norm, norm > 0.0);
}

// ---------------------------------------------------------------------------
// Primitives (local vec3f positions; center at the origin unless noted)

fn sd_sphere(p: vec3f, r: f32) -> f32 {
  return length(p) - r;
}

fn sd_box(p: vec3f, half: vec3f) -> f32 {
  let q = abs(p) - half;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn sd_round_box(p: vec3f, half: vec3f, r: f32) -> f32 {
  return sd_box(p, half - vec3f(r)) - r;
}

// Torus in the xz plane: major radius t.x, tube radius t.y.
fn sd_torus(p: vec3f, t: vec2f) -> f32 {
  let q = vec2f(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

fn sd_capsule(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Vertical capped cylinder: half height h, radius r.
fn sd_cylinder(p: vec3f, h: f32, r: f32) -> f32 {
  let d = abs(vec2f(length(p.xz), p.y)) - vec2f(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
}

// Ellipsoid with radii r. Not an exact distance (a bound near the surface):
// fine for voxel signs; sphere tracing may need a Lipschitz margin.
fn sd_ellipsoid(p: vec3f, r: vec3f) -> f32 {
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / k1;
}

// Tube along a quadratic Bezier a -> b -> c, radius r0 at a to r1 at c. Nearest
// point by coarse sampling plus two Newton steps: approximate distance.
fn sd_bezier_tube(p: vec3f, a: vec3f, b: vec3f, c: vec3f, r0: f32, r1: f32) -> f32 {
  let d1 = 2.0 * (b - a);
  let d2 = 2.0 * (a - 2.0 * b + c);
  var best_t = 0.0;
  var best_d = 1e30;
  for (var i = 0u; i <= 6u; i++) {
    let t = f32(i) / 6.0;
    let q = a + t * (d1 + 0.5 * t * d2) - p;
    let d = dot(q, q);
    if (d < best_d) {
      best_d = d;
      best_t = t;
    }
  }
  var t = best_t;
  for (var i = 0u; i < 2u; i++) {
    let q = a + t * (d1 + 0.5 * t * d2) - p; // B(t) - p
    let dq = d1 + t * d2; // B'(t)
    let f = dot(q, dq);
    let df = dot(dq, dq) + dot(q, d2);
    t = clamp(t - f / max(df, 1e-6), 0.0, 1.0);
  }
  let q = a + t * (d1 + 0.5 * t * d2) - p;
  return length(q) - mix(r0, r1, t);
}

// ---------------------------------------------------------------------------
// Operators

fn op_union(a: f32, b: f32) -> f32 {
  return min(a, b);
}

fn op_subtract(a: f32, b: f32) -> f32 {
  return max(a, -b);
}

fn op_intersect(a: f32, b: f32) -> f32 {
  return max(a, b);
}

// Polynomial smooth minimum with blend radius k.
fn op_smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn op_smax(a: f32, b: f32, k: f32) -> f32 {
  return -op_smin(-a, -b, k);
}

// Hollow shell of thickness t around the surface of d.
fn op_onion(d: f32, t: f32) -> f32 {
  return abs(d) - t;
}

// Scene helper: (distance, material) pairs; the nearer one wins.
fn pick(a: vec2f, b: vec2f) -> vec2f {
  return select(b, a, a.x < b.x);
}
