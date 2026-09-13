// World: a small planet. A ball of rock with oceans, continents, mountain ranges, ice at
// the poles, and conifer forest with glowing caps under it.
// Contract: agent_docs/design-formats.md "World program".
//
// Every other world here is a heightfield in y: the ground is `y - height(x, z)` and up is
// the same direction everywhere. This one is a shell. The ground is
// `length(p) - (RADIUS + height(direction))`, up is `normalize(p)`, and "north" is a
// latitude read off that direction rather than a coordinate. Almost nothing from the
// forest's placement survives that change, which is why this is a world of its own rather
// than a switch inside it: its lattices are 2D (`vec3i(40, 1 << 20, 40)`, a period so tall
// in y that it never repeats), and a 2D lattice wrapped onto a sphere is a lattice with a
// seam and two singularities. The palette, the plants and the sky are the forest's; the
// arithmetic underneath is not.
//
// The planet sits at the origin and is about five thousand voxels across, so every
// position in it is small and f32 is exact throughout. That is the one simplification a
// bounded world buys: `wp_f32` is safe here in a way it is not in a world that goes on.

// A sphere on its own is 1-Lipschitz. Everything added to it is the height field, and
// getting this number wrong is not a quality setting: the engine skips a region whenever
// the distance says nothing can be in it, so a field that moves faster than the bound
// claims has its terrain silently deleted.
//
// It was 6 once and the field reached 54, which is what the holes in the ocean were. Then
// it was 9, and two of the five terms had still not been counted. The arithmetic, per
// voxel, with each term's amplitude over its wavelength:
//
//   the sphere                                              1.0
//   the rolling field, 42 voxels at a 256 wavelength        2.2
//   the ridges, 78 at 512, doubled by the square that
//     sharpens their crests                                 4.1
//   the `range` smoothstep, which multiplies those ridges    1.0
//   the `coast` smoothstep, which multiplies all the relief  4.2
//                                                          ----
//                                                          12.5
//
// The two easy ones to miss are the smoothsteps, because they look like shaping and behave
// like slopes (gotchas.md "A Lipschitz bound is a promise about the steepest thing in the
// world, including the ramps"). 13 covers the sum. The preview (P) is where an overestimate
// shows as holes, and it is the check to run after touching any amplitude, wavelength or
// ramp width here.
const WORLD_LIPSCHITZ: f32 = 13.0;

// Sea level, in voxels from the centre. Big enough that the ground under your feet reads
// as ground rather than as the inside of a bowl, small enough to fly around in a minute:
// standing 30 voxels up, the horizon is sqrt(2 * RADIUS * 30), a little under 400 voxels,
// which is inside the meshed radius. So the curve is drawn in blocks, not in fog.
const RADIUS = 2600.0;

// Relief, as a fraction of the radius. The first pass had 350 voxels of it on a 2600
// radius, an eighth of the planet, and from orbit that is a potato rather than a world.
// Earth's whole range is a seventh of one percent. This is about two percent: still far
// more dramatic than the real thing, and it has to be, because the horizon here is four
// hundred voxels away and a mountain has to read at that distance.
const SEA_FLOOR = -60.0; // deepest the ocean basins reach below sea level
const LAND_AMP = 42.0; // rolling ground on the continents
const MOUNTAIN_AMP = 78.0; // the ranges on top of that
const SHORE = 3.0; // sand this far above the water line
const SNOW_ALT = 116.0; // snow above this, before latitude is taken into account
const SOIL = 5.0; // dirt over stone
// The highest the ground can reach, used as a bound and not as a shape: nothing below may
// exceed it. 6 of base, the rolling field at its largest and the ridges at theirs.
const MAX_RELIEF = 170.0;

// Where the ice caps start, as |latitude| with 1 at a pole. Snow reaches lower as you go
// north or south, so the caps meet the mountain snow rather than starting at a line.
const POLE_ICE = 0.80;
const POLE_FADE = 0.14;

// Trees stop this far up. A tree line on a planet is a pair of limits, height and
// latitude, and the second is what puts bare rock around the caps.
const TREE_ALT = 92.0;
const TREE_LAT = 0.80;

// A sample stands for this many voxels or fewer before the plants are worth placing. The
// voxelizer passes 1 and the far field passes its cell size, so this is what keeps the far
// field from paying for a forest it draws as a green smear anyway
// (gotchas.md "A footprint gate deletes a feature from the far field"). The trees are
// broad enough to survive being drawn coarsely, so their gate is the looser one.
// Both are under the finest clipmap cell (2 voxels at `firstLevel: 1`), so the plants are
// in the meshes and in no brick. The far field was building a forest into every brick of
// the shell, which is most of what `far.build` was spending its time on; what it costs to
// leave them out is that the wood stops at the meshed radius
// (gotchas.md "A footprint gate deletes a feature from the far field").
const PLANT_FOOTPRINT = 1.5;
const TREE_FOOTPRINT = 1.5;

// Scatter lattices, in voxels. These are 3D: a cell is a box in space, and only the few
// cells the shell passes through hold anything. The 3x3x3 neighbourhood is what a sample
// has to search, and the reach of what is placed has to stay inside one cell or that is
// not enough.
// The caps ride the same cells as the trees rather than having a lattice of their own: a
// second 3x3x3 search is the most expensive thing this file could add, and one cap per tree
// cell at a low acceptance rate scatters well enough.
const TREE_CELL = vec3i(34, 34, 34);
const TREE_TRIES: u32 = 2u;

const TREE_REACH = 9.0; // widest a crown gets, from its trunk
const TREE_TALL = 30.0;
const CAP_REACH = 3.4;
const CAP_TALL = 6.5;

// ---------------------------------------------------------------------------
// Direction-only fields
//
// The height of the ground has to depend on which way a point lies from the centre and
// not at all on how far out it is, or the "surface" would be a different distance away
// depending where in the column you sampled it, which is a heightfield that shears. So
// every field below is sampled at the point projected onto the sphere.

fn dir_point(dir: vec3f, scale: f32) -> WorldPoint {
  let q = dir * scale;
  let base = floor(q);
  return wp_make(vec3i(base), q - base);
}

// Ridged noise in three dimensions. `ridged2` in the library samples a 2D lattice, which
// is a plane's tool: on a sphere it would band along whichever axis it dropped.
//
// `octave_weight` is not optional. Without it every octave is drawn at full amplitude
// whatever the sample stands for, so the mountains are a different shape at every clipmap
// level and change as you cross between them. That is what the popping at level changes
// was, and it is the one thing in this file that the library was already doing right.
fn ridged3(p: WorldPoint, k0: u32, octaves: u32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  for (var i = 0u; i < octaves; i++) {
    let k = select(k0 - i, 0u, i > k0);
    let w = octave_weight(k);
    if (w > 0.0) {
      let l = wp_lattice(WorldPoint(p.cell + octave_shift(i + 96u), p.frac), k);
      let n = 1.0 - abs(gnoise3(l, world_seed + (i + 96u) * 0x9E3779B9u));
      sum += amp * w * n * n;
      norm += amp * w;
    }
    amp *= gain;
  }
  return select(0.5, sum / norm, norm > 0.0);
}

// How far above sea level the ground stands, for a direction. Positive is land.
fn relief(dir: vec3f) -> f32 {
  let at = dir_point(dir, RADIUS);
  // Continents: one slow field, biased so rather more of the ball is ocean than land.
  let land = fbm3(at, 10u, 4u, 0.5) * 1.35 - 0.12;
  if (land <= 0.0) {
    // Ocean. The basins deepen away from the coast rather than dropping at it.
    return max(SEA_FLOOR, land * 150.0);
  }
  // Ground on the continents, and ranges where a second slow field agrees.
  let rolling = fbm3(at, 8u, 4u, 0.5) * LAND_AMP;
  let range = smoothstep(0.15, 0.62, fbm3(at, 10u, 2u, 0.5) * 0.5 + 0.5);
  // At a 512-voxel wavelength rather than 256: the ridges are the steepest thing in this
  // world and the square that sharpens their crests doubles the slope again, so halving it
  // here is what keeps the Lipschitz bound at 9 instead of 13.
  let ridges = ridged3(at, 9u, 4u, 0.5) * MOUNTAIN_AMP * range;
  // The coast is a ramp, not a step. How wide that ramp is turns out to matter far more
  // than how it looks: it multiplies the whole relief, so a narrow one moves the ground by
  // a hundred voxels over three, which is a gradient of fifty against a bound of nine. At
  // 0.8 the ramp spans about 24 voxels and the slope is 6.8. It also looks better, because
  // what it draws now is a continental shelf rather than a wall.
  let coast = smoothstep(0.0, 0.8, land);
  return (6.0 + rolling + ridges) * coast;
}

fn surface_radius(dir: vec3f) -> f32 {
  return RADIUS + relief(dir);
}

// 1 at the poles, 0 at the equator.
fn latitude(dir: vec3f) -> f32 {
  return abs(dir.y);
}

// How much snow a place has, 0 to 1, from height and latitude together.
fn snow_amount(dir: vec3f, alt: f32) -> f32 {
  let by_height = smoothstep(SNOW_ALT, SNOW_ALT + 30.0, alt);
  let by_pole = smoothstep(POLE_ICE, POLE_ICE + POLE_FADE, latitude(dir));
  return max(by_height, by_pole);
}

// ---------------------------------------------------------------------------
// Plants
//
// Placement is a 3D lattice rather than the 2D one a flat world uses. Most of its cells
// are empty air or solid rock; only the few the shell passes through can hold a plant, and
// the first thing each neighbour does is ask whether the shell reaches it at all. That
// test is a distance and a subtraction, and it is what keeps 27 neighbours affordable.

fn cell_random(id: vec3i, salt: u32) -> vec3f {
  return vec3f(hash3(id + vec3i(i32(salt) * 7919, 0, 0), world_seed)) * (1.0 / 4294967296.0);
}

// One of the two axes across the surface at `up`. The seed is swapped near the poles, where
// the usual one is parallel to up and the cross product collapses. Everything that needs a
// frame goes through this: it was written out in four places, and four copies of three
// lines is how the trees and the ground they stand on come to disagree.
fn tangent_right(up: vec3f) -> vec3f {
  let seed = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(up.y) > 0.9);
  return normalize(cross(seed, up));
}

// A frame with `up` as its Y axis, so a shape written for a flat world can be planted on a
// ball.
fn local_frame(up: vec3f, at: vec3f) -> vec3f {
  let right = tangent_right(up);
  let fwd = cross(up, right);
  return vec3f(dot(at, right), dot(at, up), dot(at, fwd));
}

fn sub_rand(seed: f32, i: u32) -> f32 {
  return fract(sin(seed * 37.0 + f32(i) * 11.7) * 4375.5453);
}

fn sd_cone_y(p: vec3f, h: f32, r: f32) -> f32 {
  // A cone standing on its base, apex up, bounded so it is a distance and not a cheat.
  let q = vec2f(length(p.xz), p.y);
  let tip = vec2f(0.0, h);
  let edge = vec2f(r, 0.0) - tip;
  let w = q - tip;
  let t = clamp(dot(w, edge) / dot(edge, edge), 0.0, 1.0);
  let side = length(w - edge * t);
  let inside = max(q.y - h, -q.y);
  return select(side, max(side, inside), q.y < h && q.y > 0.0 && q.x < r);
}

// A conifer: a tapered trunk with cone skirts stacked down it, which is the forest's
// conifer with its numbers rounded off.
fn conifer(local: vec3f, height: f32, spread: f32, seed: f32) -> vec2f {
  let trunk_r = max(0.55, 0.34 + height * 0.022);
  let trunk = sd_cylinder(local - vec3f(0.0, height * 0.5, 0.0), height * 0.5, trunk_r);
  var leaves = 1e9;
  let tiers = 4u;
  for (var i = 0u; i < tiers; i++) {
    let t = f32(i) / f32(tiers - 1u); // 0 at the bottom skirt, 1 at the top
    let at = height * (0.34 + t * 0.6);
    let r = spread * (1.0 - t * 0.72) * (0.85 + 0.3 * sub_rand(seed, i));
    let h = height * 0.26 * (1.0 - t * 0.35);
    leaves = min(leaves, sd_cone_y(local - vec3f(0.0, at, 0.0), h, r));
  }
  // The tip, so a conifer ends in a point rather than a cut cone.
  leaves = min(leaves, sd_cone_y(local - vec3f(0.0, height * 0.9, 0.0), height * 0.18, spread * 0.3));
  return select(
    vec2f(trunk, f32(BLOCK_BARK)),
    vec2f(leaves, f32(BLOCK_LEAVES_DARK)),
    leaves < trunk,
  );
}

// A glowing cap on a short stem, the forest's lantern shrunk to planet scale.
fn glowcap(local: vec3f, tall: f32, cap: f32) -> vec2f {
  let stem = sd_cylinder(local - vec3f(0.0, tall * 0.5, 0.0), tall * 0.5, 0.4);
  let dome = sd_ellipsoid(local - vec3f(0.0, tall, 0.0), vec3f(cap, cap * 0.62, cap));
  return select(vec2f(stem, f32(BLOCK_SHROOMSTEM)), vec2f(dome, f32(BLOCK_GLOWCAP)), dome < stem);
}

// Everything growing, as a distance and the block it is made of. `here` is the sample in
// world space and `d_ground` the distance to the ground, which is how a plant knows not to
// grow out of the sea floor.
fn plants(here: vec3f) -> vec2f {
  var best = vec2f(1e9, 0.0);
  if (sample_footprint > TREE_FOOTPRINT) {
    return best;
  }
  // Nothing grows in the mantle or in orbit, and almost every sample is one or the other.
  // This is a length and two comparisons against a bound, and it returns before any noise
  // is touched at all.
  let rh = length(here);
  if (rh < RADIUS + SEA_FLOOR - TREE_TALL || rh > RADIUS + MAX_RELIEF + TREE_TALL) {
    return best;
  }
  let caps_too = sample_footprint <= PLANT_FOOTPRINT;
  let cell = TREE_CELL;
  let reach = TREE_REACH;

  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      for (var k = -1; k <= 1; k++) {
        let shift = vec3i(i * cell.x, j * cell.y, k * cell.z);
        let centre = floor((here - vec3f(shift)) / vec3f(cell)) * vec3f(cell) + vec3f(cell) * 0.5 + vec3f(shift);
        // The cheap rejection, and the reason 27 neighbours is affordable. The first cut
        // is against the shell's *bounds*, which is a length and nothing else: a cell that
        // cannot contain any possible surface is rejected without evaluating the surface.
        // The first version asked `surface_radius` here, which is a stack of 3D noise, and
        // asked it 27 times per sample to throw 25 of the answers away.
        let half_diag = length(vec3f(cell)) * 0.5;
        let cell_r = length(centre);
        if (cell_r + half_diag < RADIUS + SEA_FLOOR || cell_r - half_diag > RADIUS + MAX_RELIEF + TREE_TALL) {
          continue;
        }
        let up = normalize(centre);
        let ground = surface_radius(up);
        if (abs(cell_r - ground) > half_diag + TREE_TALL) {
          continue;
        }
        let id = vec3i(floor((here - vec3f(shift)) / vec3f(cell)));
        let alt = ground - RADIUS;
        if (alt < SHORE || alt > TREE_ALT || latitude(up) > TREE_LAT) {
          continue;
        }
        for (var t = 0u; t < TREE_TRIES; t++) {
          let r = cell_random(id, 20u + t * 5u);
          if (r.x > 0.34) {
            continue;
          }
          // Jitter across the whole cell, on the two axes that lie along the surface.
          let j2 = cell_random(id, 21u + t * 5u);
          let off = (j2.xy - 0.5) * f32(cell.x) * 0.9;
          let right = tangent_right(up);
          let fwd = cross(up, right);
          let base_dir = normalize(up + right * (off.x / RADIUS) + fwd * (off.y / RADIUS));
          let base_r = surface_radius(base_dir);
          let base_alt = base_r - RADIUS;
          if (base_alt < SHORE || base_alt > TREE_ALT) {
            continue;
          }
          let base = base_dir * (base_r - 1.0);
          let local = local_frame(base_dir, here - base);
          let height = TREE_TALL * (0.55 + r.y * 0.45);
          let spread = TREE_REACH * (0.55 + r.z * 0.45);
          // A bound around the whole tree before any of its shape is evaluated.
          let bound = sd_cylinder(local - vec3f(0.0, height * 0.5, 0.0), height * 0.5, spread);
          if (bound > 1.0) {
            best = pick(best, vec2f(bound, f32(BLOCK_BARK)));
            continue;
          }
          best = pick(best, conifer(local, height, spread, r.y));
        }
        if (!caps_too) {
          continue;
        }
        // Glowing caps, on the same cell but far thinner on the ground.
        let rc = cell_random(id, 61u);
        if (rc.x > 0.22) {
          continue;
        }
        let jc = cell_random(id, 62u);
        let offc = (jc.xy - 0.5) * f32(cell.x) * 0.9;
        let right = tangent_right(up);
        let fwd = cross(up, right);
        let cap_dir = normalize(up + right * (offc.x / RADIUS) + fwd * (offc.y / RADIUS));
        let cap_r = surface_radius(cap_dir);
        if (cap_r - RADIUS < SHORE || cap_r - RADIUS > TREE_ALT) {
          continue;
        }
        let cap_base = cap_dir * (cap_r - 0.5);
        let cap_local = local_frame(cap_dir, here - cap_base);
        let tall = CAP_TALL * (0.6 + rc.y * 0.5);
        let cap = CAP_REACH * (0.6 + rc.z * 0.5);
        let cbound = sd_cylinder(cap_local - vec3f(0.0, tall * 0.5, 0.0), tall * 0.5 + cap, cap);
        if (cbound > 0.75) {
          best = pick(best, vec2f(cbound, f32(BLOCK_SHROOMSTEM)));
          continue;
        }
        best = pick(best, glowcap(cap_local, tall, cap));
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The world

fn world_sdf(p: WorldPoint) -> f32 {
  let here = wp_f32(p);
  let r = length(here);
  // Inside the mantle there is nothing to decide: the field is solid and the distance to
  // the surface is all that matters, and skipping the noise here is most of the planet.
  if (r < RADIUS + SEA_FLOOR - 8.0) {
    return r - (RADIUS + SEA_FLOOR);
  }
  let dir = select(normalize(here), vec3f(0.0, 1.0, 0.0), r < 1.0);
  // Once. The first version called this twice, and it is the most expensive function here.
  let surf = surface_radius(dir);
  let ground = r - surf;
  // The sea fills what is under sea level and outside the ground, so it meets the shore
  // instead of running through it. Both halves are 1-Lipschitz in r.
  let sea = max(r - RADIUS, surf - r);
  let grown = plants(here);
  return min(min(ground, sea), grown.x);
}

fn world_material(p: WorldPoint) -> u32 {
  let here = wp_f32(p);
  let r = length(here);
  let dir = select(normalize(here), vec3f(0.0, 1.0, 0.0), r < 1.0);
  let ground = surface_radius(dir);
  let alt = ground - RADIUS;

  // A plant wins wherever it is the nearest surface, which is what puts bark inside a
  // trunk rather than the grass the trunk is standing in.
  let grown = plants(here);
  if (grown.x < 0.0 && grown.x <= r - ground) {
    return u32(grown.y);
  }

  if (r > ground) {
    return BLOCK_WATER; // inside the field and above the ground: the sea
  }

  let depth = ground - r;
  let snow = snow_amount(dir, alt);
  if (snow > 0.5 && depth < SOIL) {
    return BLOCK_SNOW;
  }
  if (depth > SOIL) {
    return BLOCK_STONE;
  }
  if (alt < SHORE) {
    return BLOCK_SAND; // the sea floor and the beaches above it
  }
  // Bare rock where it is steep: the relief a little to each side against the relief
  // here, which is a slope without a gradient to take.
  let right = tangent_right(dir);
  let fwd = cross(dir, right);
  let step = 3.0;
  let a = surface_radius(normalize(dir + right * (step / RADIUS)));
  let b = surface_radius(normalize(dir + fwd * (step / RADIUS)));
  let slope = (abs(a - ground) + abs(b - ground)) / step;
  if (slope > 1.8 || alt > TREE_ALT) {
    return BLOCK_STONE;
  }
  if (latitude(dir) > TREE_LAT) {
    return BLOCK_MOSS; // the cold ground between the forests and the ice
  }
  return BLOCK_GRASS;
}
