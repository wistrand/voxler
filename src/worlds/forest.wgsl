// World: a fantasy forest. Terraced ground with a stream that steps down it in
// cascades, standing water in the hollows, trees with branches and ragged canopies,
// glowing mushrooms in four colours, ferns and boulders.
// Contract: agent_docs/design-formats.md "World program"; the features it needs are
// plan-living-world.md phases 1 and 2 (emission and sway).
//
// Everything here is a pure function of position: no placement pass and no per-instance
// data, so the voxelizer, the preview and the far field all see the same forest, and an
// edit to it survives regeneration like any other chunk.
//
// The ground is terraced by quantizing a heightfield, and the stream and its water
// surface are terraced by the same function, so the water steps down wherever the ground
// does: a cascade is not a special case, it is what the shared terracing produces. The
// transition of a step runs over BANK voxels rather than none, which is what keeps the
// field Lipschitz (a sheer cliff in a heightfield has no bound, and region skipping
// would cut through it).

// The steepest thing here is a terrace edge: TERRACE_DROP over BANK voxels, about 2.8.
// The mountains and hills add their own octaves on top; 5 covers the sum with room,
// and the preview is where an underestimate would show as holes.
const WORLD_LIPSCHITZ: f32 = 5.0;

// Voxels per unit of the forest's design scale. Everything below is written at a
// human scale and multiplied by this, so the whole wood can be made finer or coarser
// in one place: a tree 12 voxels tall is a handful of blocks, and the same tree at 33
// has bark, branches and a ragged edge. The cost is voxels: bigger objects fill more
// of every chunk they touch.
const S = 2.75;

const TERRACE_DROP = 7.0 * S; // height of one step
const BANK = 2.5 * S; // horizontal run of a step, so its slope is TERRACE_DROP / BANK
const LAKE_LEVEL = 8.0 * S; // standing water fills anything below this: valley lakes
const HILL_AMP = 22.0 * S;
const MOUNTAIN_AMP = 60.0 * S; // peaks stand about 165 voxels over the valley floor
const TREE_LINE = 46.0 * S; // no forest above this
const SNOW_LINE = 62.0 * S;
const CHANNEL_HALF = 6.0 * S; // half width of the stream's cut
const CHANNEL_DEPTH = 3.5 * S;
const SOIL = 4.0 * S; // dirt above stone

// Vegetation is left out of coarse samples. This is a budget as much as a look: the far
// field samples this world eight times over, once per clipmap level, and a sample that
// walks four 3x3 lattices of trees, mushrooms, ferns and rocks is an order dearer than
// one that sums noise. The undergrowth only survives in the finest level's cells, where
// it is still a voxel or two across; the canopies carry the forest out to about a
// thousand voxels, past which fog has most of it anyway.
const UNDERGROWTH_FOOTPRINT = 1.2 * S;
// Trees survive to the far field's second level and no further. Three species with
// carved canopies cost several times what the first cut did, and the far field samples
// this world once per level: at 3.0 * S the trees reached the third level and the grove
// bench's far build ran past the frame budget.
const TREE_FOOTPRINT = 1.6 * S;

// Lattice periods have to be whole voxels, so these are the scaled sizes rounded.
const TREE_CELL = vec3i(74, 1 << 20, 74);
const SHROOM_CELL = vec3i(44, 1 << 20, 44);
// Giants stand on their own coarse lattice. As a rare variant of the small ones they
// shared the small lattice, and neighbouring caps merged into one pink plateau with
// stems poking through it.
const GIANT_CELL = vec3i(146, 1 << 20, 146);
const FERN_CELL = vec3i(19, 1 << 20, 19);
const ROCK_CELL = vec3i(63, 1 << 20, 63);

// A hash cell's three random numbers in [0, 1).
fn cell_random(id: vec3i, salt: u32) -> vec3f {
  return vec3f(hash3(id + vec3i(i32(salt) * 7919, 0, 0), world_seed)) * (1.0 / 4294967296.0);
}

// Where in its cell an item stands, in voxels from the cell's centre. The random that
// decides whether a cell has an item at all is r.x, so the jitter has to come from a
// different draw: reusing it puts every accepted item on the same side of its cell,
// which reads as a grid however wide the jitter is. `amount` is the fraction of the
// cell it can wander over, and jitter plus the item's own reach has to stay inside one
// cell or the 3x3 neighbourhood the lookups walk would miss it.
fn cell_jitter(id: vec3i, salt: u32, cell: vec3i, amount: f32) -> vec2f {
  let j = cell_random(id, salt);
  return (j.xz - 0.5) * vec2f(f32(cell.x), f32(cell.z)) * amount;
}

// How thick the undergrowth is at a cell, 0 in a bare patch and 1 in a thicket, varying
// over a few hundred voxels. Sampled at the cell's centre for the same reason
// grove_density is. A fixed hit rate per cell spreads plants evenly over the floor,
// which reads as a pattern as much as a lattice does; clumping them leaves bare ground
// between the patches.
// One octave, not two: this runs for every cell of three lattices at every sample the
// far field takes, and a second octave cost it 4 ms a frame in the grove bench for a
// pattern nothing can see at that scale.
fn patch_density(id: vec3i, cell: vec3i, k: u32) -> f32 {
  let centre = WorldPoint(id * cell + cell / 2, vec3f(0.0));
  return smoothstep(-0.4, 0.4, fbm2(centre, k, 1u, 0.5));
}

// Distance from the stream's centre line, in voxels. The line is where a ridged noise
// crosses zero, which meanders the way a stream does.
fn channel_distance(p: WorldPoint) -> f32 {
  return abs(fbm2(p, 10u, 3u, 0.5)) * 90.0 * S;
}

// Ground before the stream is cut into it. Rolling away from the water and terraced
// near it: the steps are what the stream falls down, and a forest floor made entirely
// of them reads as a staircase rather than a wood.
//
// Hills everywhere, ridged mountains where a slow mask says so, and the lake level far
// enough up that the valleys between them hold water.
fn land_height(p: WorldPoint, c: f32) -> f32 {
  let hills = fbm2(p, 10u, 5u, 0.5) * HILL_AMP + 6.0 * S;
  let mask = smoothstep(0.15, 0.65, fbm2(p, 12u, 2u, 0.5) * 0.5 + 0.5);
  let rolling = hills + ridged2(p, 12u, 4u, 0.5) * MOUNTAIN_AMP * mask;
  // Quantize to steps, with the transition spread over BANK voxels of height so the
  // slope stays finite. `smoothstep` over the fraction does that: flat tread, steep
  // riser, no discontinuity.
  let t = rolling / TERRACE_DROP;
  let tread = floor(t);
  let riser = smoothstep(0.5 - BANK / (2.0 * TERRACE_DROP), 0.5 + BANK / (2.0 * TERRACE_DROP), fract(t));
  let terraced = (tread + riser) * TERRACE_DROP;
  let gorge = 1.0 - smoothstep(CHANNEL_HALF, CHANNEL_HALF + 20.0 * S, c);
  return mix(rolling, terraced, gorge);
}

// The ground, with the stream cut into it.
fn ground_height(p: WorldPoint) -> f32 {
  let c = channel_distance(p);
  let cut = CHANNEL_DEPTH * (1.0 - smoothstep(0.0, CHANNEL_HALF, c));
  return land_height(p, c) - cut;
}

// Top of the water: the lake everywhere, and the stream's own surface inside its cut.
// Both are terraced, so where the ground steps down the water does too.
fn water_top(p: WorldPoint) -> f32 {
  let c = channel_distance(p);
  var top = LAKE_LEVEL;
  if (c < CHANNEL_HALF) {
    top = max(top, land_height(p, c) - 0.6 * S);
  }
  return top;
}

// Tree species. A wood of one shape reads as a repeat however well the lattice is
// hidden, so a cell picks from three: broadleaf in the valleys, conifers as the ground
// climbs towards the tree line, and the rare ancient whose crown is several separate
// lobes on long limbs.
const TREE_BROADLEAF: u32 = 0u;
const TREE_CONIFER: u32 = 1u;
const TREE_ANCIENT: u32 = 2u;

fn tree_species(r: f32, ground: f32) -> u32 {
  if (r < 0.10) {
    return TREE_ANCIENT;
  }
  let cold = smoothstep(TREE_LINE * 0.40, TREE_LINE * 0.95, ground);
  if (r < 0.28 + 0.60 * cold) {
    return TREE_CONIFER;
  }
  return TREE_BROADLEAF;
}

// Stable numbers in [0, 1) for the many small choices inside one object (which way a
// limb points, how big a bite out of a canopy is, where in a clump a mushroom stands).
// Hashing a cell per choice would be truer random; these only have to look unrelated to
// each other and stay put for the object.
fn sub_rand(seed: f32, i: u32) -> f32 {
  return fract(sin(seed * 91.7 + f32(i) * 13.31) * 43758.5453);
}

// A cone standing on its foot at y = 0, radius r there and a point at height h.
// Divided by the slope, so it underestimates the distance rather than overestimating
// it however wide the cone is.
fn sd_cone_y(p: vec3f, h: f32, r: f32) -> f32 {
  let side = (length(p.xz) * h - r * (h - p.y)) * inverseSqrt(h * h + r * r);
  return max(max(side, -p.y), p.y - h);
}

// Bites out of a leaf mass: spheres subtracted from it, so the canopy has gaps a ray
// can see through and an edge that is not a smooth blob. Subtraction is a max of two
// fields, so the result is still a distance field.
fn canopy_bites(leaves: f32, local: vec3f, centre: vec3f, cr: f32, seed: f32, count: u32, scale: f32) -> f32 {
  var d = leaves;
  for (var i = 0u; i < count; i++) {
    let a = sub_rand(seed, i * 3u) * 6.2832;
    let t = sub_rand(seed, i * 3u + 1u);
    let dir = normalize(vec3f(cos(a), (t - 0.4) * 1.4, sin(a)));
    // Out near the rim, so a bite takes a notch out of the silhouette rather than
    // hollowing the middle where nothing would ever see it.
    let at = centre + dir * cr * (0.70 + 0.55 * sub_rand(seed, i * 3u + 2u));
    d = op_subtract(d, sd_sphere(local - at, cr * scale * (0.6 + 0.8 * t)));
  }
  return d;
}

// Per-species crown sizes, the one place each is written down. tree_crown() turns them
// into the bound trees() tests, so a crown can never grow past what the bound covers.
fn broadleaf_cr(r: vec3f) -> f32 {
  return (3.4 + r.z * 2.6) * S;
}

fn conifer_cr(r: vec3f) -> f32 {
  return (2.0 + r.y * 1.6) * S;
}

fn ancient_reach(r: vec3f) -> f32 {
  return (4.0 + r.y * 2.5) * S;
}

// Horizontal reach of a tree's crown (x) and how far its leaves rise above the top of
// the trunk (y). A bound short of these cuts the canopy off in a flat plane, which is
// exactly what it looks like from the side, so keep the margins here generous.
fn tree_crown(r: vec3f, tall: f32, species: u32) -> vec2f {
  if (species == TREE_CONIFER) {
    return vec2f(conifer_cr(r) * 1.3, tall * 0.30);
  }
  if (species == TREE_ANCIENT) {
    let reach = ancient_reach(r);
    return vec2f(reach * 1.9, reach * 1.3);
  }
  let cr = broadleaf_cr(r);
  return vec2f(cr * 1.9, 1.2 * S + cr * 1.5);
}

// A broadleaf: leaning trunk, three branches spiralling up it, and a crown of lobes
// with bites taken out.
fn broadleaf_shape(local: vec3f, r: vec3f, r2: vec3f, tall: f32) -> vec2f {
  let lean = (r.x - 0.5) * 0.12;
  let trunk_r = (0.9 + r.y * 0.7) * S;
  var s = vec2f(
    sd_bezier_tube(
      local,
      vec3f(0.0, 0.0, 0.0),
      vec3f(lean * tall * 0.5, tall * 0.5, lean * tall * 0.4),
      vec3f(lean * tall, tall, lean * tall * 0.8),
      trunk_r * 1.8,
      trunk_r * 0.6,
    ),
    f32(BLOCK_BARK),
  );
  let top = vec3f(lean * tall, tall, lean * tall * 0.8);
  for (var i = 0u; i < 3u; i++) {
    let a = (r.z + f32(i) * 0.41) * 6.2832;
    let base = top * (0.55 + 0.15 * f32(i));
    let reach = (2.5 + r.y * 2.0) * S * (1.0 - 0.2 * f32(i));
    let dir = vec3f(cos(a), 0.0, sin(a));
    let tip = base + dir * reach + vec3f(0.0, reach * 0.7, 0.0);
    let mid = base + dir * reach * 0.5 + vec3f(0.0, reach * 0.15, 0.0);
    s = pick(s, vec2f(sd_bezier_tube(local, base, mid, tip, trunk_r * 0.5, 0.5 * S), f32(BLOCK_BARK)));
  }
  // The crown is a small core with six lobes hung off it, blended just enough to hold
  // together. One big ellipsoid with lobes sunk into it reads as a smooth dome however
  // many lobes are added; a small core lets the lobes make the outline.
  let cr = broadleaf_cr(r);
  let crown = top + vec3f(0.0, 1.2 * S, 0.0);
  var leaves = sd_ellipsoid(local - crown, vec3f(cr * 0.75, cr * 0.55, cr * 0.75));
  for (var i = 0u; i < 6u; i++) {
    let a = (sub_rand(r2.x, 40u + i) + f32(i) / 6.0) * 6.2832;
    let up = (sub_rand(r2.y, 50u + i) - 0.35) * cr * 1.0;
    let off = vec3f(cos(a), 0.0, sin(a)) * cr * (0.55 + 0.45 * sub_rand(r2.z, 60u + i)) + vec3f(0.0, up, 0.0);
    let lobe = sd_sphere(local - crown - off, cr * (0.42 + 0.28 * sub_rand(r2.x, 70u + i)));
    leaves = op_smin(leaves, lobe, 0.8 * S);
  }
  return pick(s, vec2f(canopy_bites(leaves, local, crown, cr, r2.y, 7u, 0.40), f32(BLOCK_LEAVES)));
}

// A conifer: a straight tapering trunk with tiers of needles up it. The gaps between
// the tiers show the trunk, and the bites break each tier's rim.
fn conifer_shape(local: vec3f, r: vec3f, r2: vec3f, tall: f32) -> vec2f {
  let trunk_r = (0.55 + r.y * 0.35) * S;
  var s = vec2f(
    sd_bezier_tube(
      local,
      vec3f(0.0),
      vec3f(0.0, tall * 0.5, 0.0),
      vec3f(0.0, tall * 1.02, 0.0),
      trunk_r * 1.9,
      trunk_r * 0.3,
    ),
    f32(BLOCK_BARK),
  );
  let cr = conifer_cr(r);
  var leaves = 1e9;
  let tiers = 6u;
  for (var i = 0u; i < tiers; i++) {
    let f = f32(i) / f32(tiers - 1u);
    let y = tall * (0.25 + 0.72 * f);
    let rw = cr * (1.0 - 0.78 * f) * (0.80 + 0.40 * sub_rand(r2.x, i));
    let hw = tall * (0.15 + 0.06 * sub_rand(r2.z, i));
    let tier = sd_cone_y(local - vec3f(0.0, y, 0.0), hw, rw);
    leaves = min(leaves, canopy_bites(tier, local, vec3f(0.0, y + hw * 0.35, 0.0), rw, r2.y + f32(i) * 0.7, 3u, 0.24));
  }
  return pick(s, vec2f(leaves, f32(BLOCK_LEAVES)));
}

// An ancient: a squat, thick trunk that forks into limbs, each carrying its own lobe.
// The lobes are never blended together, so the crown is as much gap as leaf.
fn ancient_shape(local: vec3f, r: vec3f, r2: vec3f, tall: f32) -> vec2f {
  let trunk_r = (1.8 + r.y * 1.0) * S;
  let fork = tall * 0.45;
  var s = vec2f(
    sd_bezier_tube(
      local,
      vec3f(0.0),
      vec3f(0.0, fork * 0.5, 0.0),
      vec3f(0.0, fork, 0.0),
      trunk_r * 2.0,
      trunk_r,
    ),
    f32(BLOCK_BARK),
  );
  let reach = ancient_reach(r);
  let limbs = 5u;
  var leaves = 1e9;
  for (var i = 0u; i < limbs; i++) {
    let a = (r.z + f32(i) / f32(limbs)) * 6.2832;
    let dir = vec3f(cos(a), 0.0, sin(a));
    let len = reach * (0.70 + 0.45 * sub_rand(r2.x, i));
    let rise = tall * (0.35 + 0.30 * sub_rand(r2.y, i));
    let base = vec3f(0.0, fork * 0.9, 0.0);
    let tip = base + dir * len + vec3f(0.0, rise, 0.0);
    let mid = base + dir * len * 0.45 + vec3f(0.0, rise * 0.8, 0.0);
    s = pick(s, vec2f(sd_bezier_tube(local, base, mid, tip, trunk_r * 0.8, 0.4 * S), f32(BLOCK_BARK)));
    let lobe_r = reach * (0.32 + 0.16 * sub_rand(r2.z, i));
    let centre = tip + vec3f(0.0, lobe_r * 0.35, 0.0);
    var lobe = sd_ellipsoid(local - centre, vec3f(lobe_r, lobe_r * 0.7, lobe_r));
    lobe = canopy_bites(lobe, local, centre, lobe_r, r2.x + f32(i) * 1.7, 4u, 0.34);
    leaves = min(leaves, lobe);
  }
  return pick(s, vec2f(leaves, f32(BLOCK_LEAVES)));
}

// One tree. `local` is the position relative to the tree's base.
fn tree_shape(local: vec3f, r: vec3f, r2: vec3f, tall: f32, species: u32) -> vec2f {
  if (species == TREE_CONIFER) {
    return conifer_shape(local, r, r2, tall);
  }
  if (species == TREE_ANCIENT) {
    return ancient_shape(local, r, r2, tall);
  }
  return broadleaf_shape(local, r, r2, tall);
}

// How thick the wood is at a tree cell, 0 in a glade and 1 in the heart of a grove.
// Sampled at the cell's centre, never at the sample point: a density that varied within
// a cell would put a tree there for some voxels and not others.
fn grove_density(id: vec3i) -> f32 {
  let centre = WorldPoint(id * TREE_CELL + TREE_CELL / 2, vec3f(0.0));
  return smoothstep(-0.35, 0.45, fbm2(centre, 9u, 2u, 0.5));
}

fn trees(p: WorldPoint, ground: f32) -> vec2f {
  var best = vec2f(1e9, 0.0);
  let y = f32(p.cell.y) + p.frac.y;
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let shift = vec3i(i * TREE_CELL.x, 0, j * TREE_CELL.z);
      let q = wp_offset(p, -vec3f(shift));
      let id = wp_repeat_id(q, TREE_CELL);
      let r = cell_random(id, 1u);
      // Groves, not a grid. One tree to a cell on its own reads as rows from any
      // distance; a density that clumps over a few hundred voxels turns the same cells
      // into thickets with glades between them, and the jitter below hides what is
      // left of the lattice.
      let density = grove_density(id);
      if (r.x > 0.25 + 0.7 * density) {
        continue;
      }
      if (ground > TREE_LINE) {
        continue; // above the tree line
      }
      let r2 = cell_random(id, 6u);
      let species = tree_species(r2.x, ground);
      // Trees in the thick of a grove grow taller than the ones out on its edge.
      var tall = (7.0 + r.z * 9.0 + density * 7.0) * S;
      if (species == TREE_CONIFER) {
        tall *= 1.25;
      } else if (species == TREE_ANCIENT) {
        tall *= 0.70;
      }
      var local = wp_repeat(q, TREE_CELL);
      // Jitter within the cell, and stand the tree on the ground under its own trunk.
      // The jitter plus the widest crown has to stay inside one cell, or the 3x3
      // neighbourhood above would miss a tree that reaches into this one.
      let jitter = cell_jitter(id, 7u, TREE_CELL, 0.5);
      local.x -= jitter.x;
      local.z -= jitter.y;
      local.y = y - ground;
      // A bound around the whole tree: far from it, this is a safe underestimate and
      // the branches and canopy never have to be evaluated.
      let crown = tree_crown(r, tall, species);
      let height = tall + crown.y;
      let bound = sd_cylinder(local - vec3f(0.0, height * 0.5, 0.0), height * 0.5, crown.x);
      if (bound > 1.0) {
        best = select(best, vec2f(bound, f32(BLOCK_BARK)), bound < best.x);
        continue;
      }
      let s = tree_shape(local, r, r2, tall, species);
      best = select(best, s, s.x < best.x);
    }
  }
  return best;
}

// A mushroom cap, with its underside at y = 0 of `local` and radius `r`. `dome` is how
// tall the dome is as a fraction of the radius.
//
// Three things make a lump of voxels read as a cap: the dome is cut off under its
// equator, so it is a cap and not a ball on a stick; a thin lip runs a little wider than
// the dome, which is the overhang the eye reads as a mushroom from any angle; and the
// rim tapers rather than ending in a wall.
fn cap_shape(local: vec3f, r: f32, dome: f32) -> f32 {
  let d = max(sd_ellipsoid(local, vec3f(r, r * dome, r)), -local.y - r * 0.16);
  let lip = max(sd_ellipsoid(local, vec3f(r * 1.08, r * 0.26, r * 1.08)), -local.y - r * 0.10);
  return op_smin(d, lip, r * 0.22);
}

// Which of the four glowing caps a cell grows. The colour is the cell's, so every
// mushroom in one clump is the same species.
fn cap_colour(t: f32) -> f32 {
  let species = u32(t * 4.0) % 4u;
  if (species == 1u) {
    return f32(BLOCK_GLOWCAP_VIOLET);
  }
  if (species == 2u) {
    return f32(BLOCK_GLOWCAP_AMBER);
  }
  if (species == 3u) {
    return f32(BLOCK_GLOWCAP_ROSE);
  }
  return f32(BLOCK_GLOWCAP);
}

// One small mushroom standing at `local`: a stem that flares at the foot and a cap.
fn shroom_shape(local: vec3f, stem_h: f32, cap_r: f32, lean: vec2f, colour: f32) -> vec2f {
  let top = vec3f(lean.x, stem_h, lean.y);
  let stem = sd_bezier_tube(
    local,
    vec3f(0.0),
    vec3f(lean.x * 0.35, stem_h * 0.55, lean.y * 0.35),
    top,
    0.62 * S,
    0.38 * S,
  );
  let s = vec2f(stem, f32(BLOCK_SHROOMSTEM));
  return pick(s, vec2f(cap_shape(local - top, cap_r, 0.78), colour));
}

// How far one cluster's mushrooms wander from the cell's spot, and how big the largest
// of them gets. The bound below is built from these, so a mushroom can never grow past
// what the bound covers.
const SHROOM_SPREAD = 2.4 * S;
const SHROOM_STEM_MAX = 4.8 * S;
const SHROOM_CAP_MAX = 1.8 * S;
const SHROOM_LEAN_MAX = 0.35 * S;
const SHROOM_CLUSTER = 3u;

// Mushrooms: clumps of small glowing caps, and the occasional giant one. The colour is
// the cell's, so a clump shares a species.
fn mushrooms(p: WorldPoint, ground: f32) -> vec2f {
  let y = f32(p.cell.y) + p.frac.y;
  var best = vec2f(1e9, 0.0);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let shift = vec3i(i * SHROOM_CELL.x, 0, j * SHROOM_CELL.z);
      let q = wp_offset(p, -vec3f(shift));
      let id = wp_repeat_id(q, SHROOM_CELL);
      let r = cell_random(id, 2u);
      // The density costs a noise sample, so reject on the cell's own random first:
      // the cells past the gate's ceiling never need it.
      if (r.x > 0.22) {
        continue;
      }
      if (r.x > 0.02 + 0.20 * patch_density(id, SHROOM_CELL, 8u)) {
        continue;
      }
      var local = wp_repeat(q, SHROOM_CELL);
      let jitter = cell_jitter(id, 8u, SHROOM_CELL, 0.9);
      local.x -= jitter.x;
      local.z -= jitter.y;
      local.y = y - ground;
      // One bound for the whole clump, built from the constants above so no mushroom in
      // it can grow past what the bound covers. It reaches below the ground too: the
      // stem's foot flares, and a bound that does not contain the shape is not an
      // underestimate of the distance to it.
      let reach = SHROOM_SPREAD + SHROOM_LEAN_MAX + SHROOM_CAP_MAX * 1.15;
      let tall = SHROOM_STEM_MAX + SHROOM_CAP_MAX + 0.8 * S;
      let bound = sd_cylinder(local - vec3f(0.0, tall * 0.5 - 0.8 * S, 0.0), tall * 0.5, reach);
      if (bound > 0.75) {
        best = select(best, vec2f(bound, f32(BLOCK_SHROOMSTEM)), bound < best.x);
        continue;
      }
      let colour = cap_colour(r.y);
      // A clump, not one: mushrooms come up in groups, and three of different heights
      // around one spot read as a clump where a single stalk reads as a marker pin.
      // One to three to a clump: every clump the same size is its own kind of pattern.
      let count = 1u + u32(r.z * f32(SHROOM_CLUSTER));
      for (var k = 0u; k < min(count, SHROOM_CLUSTER); k++) {
        let a = (sub_rand(r.y, k) + f32(k) / f32(SHROOM_CLUSTER)) * 6.2832;
        let away = SHROOM_SPREAD * (0.25 + 0.75 * sub_rand(r.z, k)) * f32(min(k, 1u));
        let at = local - vec3f(cos(a) * away, 0.0, sin(a) * away);
        let size = 0.45 + 0.55 * sub_rand(r.x, k + 7u);
        let stem_h = SHROOM_STEM_MAX * (0.35 + 0.65 * size);
        let cap_r = SHROOM_CAP_MAX * (0.45 + 0.55 * size);
        let lean = vec2f(cos(a), sin(a)) * (SHROOM_LEAN_MAX * sub_rand(r.y, k + 13u));
        let s = shroom_shape(at, stem_h, cap_r, lean, colour);
        best = select(best, s, s.x < best.x);
      }
    }
  }
  return best;
}

// The giants: one to a coarse cell, tall enough to stand clear of the undergrowth and
// far enough apart that two caps never meet.
fn giants(p: WorldPoint, ground: f32) -> vec2f {
  let y = f32(p.cell.y) + p.frac.y;
  var best = vec2f(1e9, 0.0);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let shift = vec3i(i * GIANT_CELL.x, 0, j * GIANT_CELL.z);
      let q = wp_offset(p, -vec3f(shift));
      let id = wp_repeat_id(q, GIANT_CELL);
      let r = cell_random(id, 5u);
      if (r.x > 0.42) {
        continue;
      }
      var local = wp_repeat(q, GIANT_CELL);
      let jitter = cell_jitter(id, 9u, GIANT_CELL, 0.7);
      local.x -= jitter.x;
      local.z -= jitter.y;
      local.y = y - ground;
      let stem_h = (6.0 + r.z * 7.0) * S;
      let cap_r = (3.5 + r.y * 3.5) * S;
      let lean = (cell_random(id, 12u).xz - 0.5) * stem_h * 0.22;
      let bound = sd_cylinder(
        local - vec3f(0.0, (stem_h + cap_r) * 0.5, 0.0),
        (stem_h + cap_r) * 0.5 + 0.5 * S,
        cap_r * 1.15 + length(lean),
      );
      if (bound > 0.75) {
        best = select(best, vec2f(bound, f32(BLOCK_SHROOMSTEM)), bound < best.x);
        continue;
      }
      // A stem that widens at the foot and curves as it rises, and a domed cap.
      let top = vec3f(lean.x, stem_h, lean.y);
      let stem = sd_bezier_tube(
        local,
        vec3f(0.0),
        vec3f(lean.x * 0.2, stem_h * 0.55, lean.y * 0.2),
        top,
        1.6 * S,
        0.75 * S,
      );
      var s = vec2f(stem, f32(BLOCK_SHROOMSTEM));
      s = pick(s, vec2f(cap_shape(local - top, cap_r, 0.62), cap_colour(r.z)));
      best = select(best, s, s.x < best.x);
    }
  }
  return best;
}

// Ferns: a few fronds arcing out of one point.
fn ferns(p: WorldPoint, ground: f32) -> vec2f {
  let y = f32(p.cell.y) + p.frac.y;
  var best = vec2f(1e9, 0.0);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let shift = vec3i(i * FERN_CELL.x, 0, j * FERN_CELL.z);
      let q = wp_offset(p, -vec3f(shift));
      let id = wp_repeat_id(q, FERN_CELL);
      let r = cell_random(id, 3u);
      // The density costs a noise sample, so reject on the cell's own random first:
      // the cells past the gate's ceiling never need it.
      if (r.x > 0.80) {
        continue;
      }
      if (r.x > 0.15 + 0.65 * patch_density(id, FERN_CELL, 7u)) {
        continue;
      }
      var local = wp_repeat(q, FERN_CELL);
      let jitter = cell_jitter(id, 10u, FERN_CELL, 0.9);
      local.x -= jitter.x;
      local.z -= jitter.y;
      local.y = y - ground;
      let reach = (3.0 + r.y * 3.2) * S;
      let bound = sd_cylinder(local - vec3f(0.0, reach * 0.4, 0.0), reach * 0.9, reach + 0.5 * S);
      if (bound > 0.6) {
        best = select(best, vec2f(bound, f32(BLOCK_FERN)), bound < best.x);
        continue;
      }
      var d = 1e9;
      for (var k = 0u; k < 5u; k++) {
        let a = (r.z + f32(k) * 0.2) * 6.2832;
        let dir = vec3f(cos(a), 0.0, sin(a));
        let tip = dir * reach + vec3f(0.0, reach * 0.35, 0.0);
        let mid = dir * reach * 0.4 + vec3f(0.0, reach * 0.75, 0.0);
        d = min(d, sd_bezier_tube(local, vec3f(0.0), mid, tip, 0.45 * S, 0.12 * S));
      }
      best = select(best, vec2f(d, f32(BLOCK_FERN)), d < best.x);
    }
  }
  return best;
}

// Boulders, half buried, with moss on the ones that sit in the open.
fn rocks(p: WorldPoint, ground: f32) -> vec2f {
  let y = f32(p.cell.y) + p.frac.y;
  var best = vec2f(1e9, 0.0);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let shift = vec3i(i * ROCK_CELL.x, 0, j * ROCK_CELL.z);
      let q = wp_offset(p, -vec3f(shift));
      let id = wp_repeat_id(q, ROCK_CELL);
      let r = cell_random(id, 4u);
      // The density costs a noise sample, so reject on the cell's own random first:
      // the cells past the gate's ceiling never need it.
      if (r.x > 0.62) {
        continue;
      }
      if (r.x > 0.12 + 0.5 * patch_density(id, ROCK_CELL, 6u)) {
        continue;
      }
      var local = wp_repeat(q, ROCK_CELL);
      let jitter = cell_jitter(id, 11u, ROCK_CELL, 0.9);
      local.x -= jitter.x;
      local.z -= jitter.y;
      local.y = y - ground + (1.0 + r.z * 2.0) * S; // sunk into the ground
      let rr = (1.6 + r.z * 3.4) * S;
      let d = sd_ellipsoid(local, vec3f(rr * 1.2, rr * 0.85, rr)) - S * 0.3 * sin(local.x * 1.7 / S) * sin(local.z * 1.3 / S);
      let id_rock = select(f32(BLOCK_STONE), f32(BLOCK_MOSS), r.y > 0.6 && local.y > rr * 0.3);
      best = select(best, vec2f(d, id_rock), d < best.x);
    }
  }
  return best;
}

fn forest(p: WorldPoint) -> vec2f {
  let y = f32(p.cell.y) + p.frac.y;
  let ground = ground_height(p);
  let top = water_top(p);

  // Ground: dirt over stone, mossy where the stream has not cut through.
  var surface = f32(BLOCK_GRASS);
  let depth = ground - y;
  if (depth > SOIL) {
    surface = f32(BLOCK_STONE);
  } else if (ground > SNOW_LINE) {
    surface = f32(BLOCK_SNOW);
  } else if (ground > TREE_LINE) {
    surface = f32(BLOCK_STONE); // bare rock between the tree line and the snow
  } else if (depth > 0.8 * S) {
    surface = f32(BLOCK_DIRT);
  } else if (y < top + 1.0 * S) {
    surface = f32(BLOCK_SAND); // the stream's banks and the lake shore
  } else if (fbm2(p, 4u, 2u, 0.5) > -0.35) {
    surface = f32(BLOCK_MOSS); // a forest floor is mostly moss, with grass in the gaps
  }
  var s = vec2f(y - ground, surface);

  // Water: below its surface and above the bed. Both halves are 1-Lipschitz.
  s = pick(s, vec2f(max(y - top, ground - y), f32(BLOCK_WATER)));

  // Nothing rooted grows below the waterline: a tree standing in the middle of a lake
  // with its trunk under water reads as a mistake, and the shore is more of a shore with
  // a band of bare sand between the wood and the water. Boulders are left alone; a rock
  // in a stream belongs there.
  let dry = ground - top;
  if (sample_footprint <= TREE_FOOTPRINT) {
    if (dry > 1.5 * S) {
      s = pick(s, trees(p, ground));
      s = pick(s, giants(p, ground));
    }
    s = pick(s, rocks(p, ground));
  }
  if (sample_footprint <= UNDERGROWTH_FOOTPRINT && dry > 0.5 * S) {
    s = pick(s, mushrooms(p, ground));
    s = pick(s, ferns(p, ground));
  }
  return s;
}

fn world_sdf(p: WorldPoint) -> f32 {
  return forest(p).x;
}

fn world_material(p: WorldPoint) -> u32 {
  return u32(forest(p).y);
}
