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
// The mountains and hills add their own octaves on top, and the range term adds the most
// of any of them because it rides on the square of the ridged noise, which doubles that
// noise's own slope at the crests. 6 covers the sum with room; the preview (P) is where
// an underestimate would show as holes, and it is the check to run after touching any of
// the amplitudes below.
const WORLD_LIPSCHITZ: f32 = 6.0;

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
const MOUNTAIN_AMP = 60.0 * S; // the ridges themselves, about 165 voxels
// What turns ridges into mountains. It rides on a high power of the same ridged noise and
// on the square of the same mask, rather than on a second field: it costs no extra noise
// on the hottest function in the world, and a power that steep leaves the low ground
// exactly where it was and lifts only the crests. The square was the first try and it is
// too gentle a curve: it raised the median ground from 100 to 209, which is over the tree
// line, so the wood became bare rock everywhere instead of a few mountains standing out
// of it. Check the median, not just the peak, after touching this.
const RANGE_AMP = 150.0 * S; // the summits, 400 voxels over the ridges again
// The wood stops here and the rock starts, and the snow well above that. Both moved up
// with the mountains: leave the tree line where it was and the higher ground turns the
// whole wood into bare rock, because what the ranges lift is not only their own summits.
const TREE_LINE = 62.0 * S;
// Tries per tree cell. One to a cell is a stratified sample however far it is jittered:
// no two trees ever close, no gap ever much wider than a cell, and that is the grid.
const TREE_TRIES: u32 = 3u;
// How far a plant's own foot has to stand above the water, and the band of shore over
// which that fades in. Nothing rooted grows in the lake, but the edge of the wood is a
// shore and not a fence: over the band the trees thin out and the ones that stand grow
// smaller, which is what puts a scatter of small trees along the bank instead of a line.
const TREE_DRY = 1.5 * S;
const TREE_SHORE_BAND = 5.0 * S;
const UNDER_DRY = 0.5 * S;
const UNDER_SHORE_BAND = 2.5 * S;
// Snow well above the tree line, not just above it: the band between is bare rock, and
// with summits hundreds of voxels over the ridges there is room for it to read as a
// mountainside rather than as a stripe.
const SNOW_LINE = 95.0 * S;
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
// Past TREE_FOOTPRINT a tree is drawn as a crown and a trunk instead of a tree, and past
// this it is not drawn at all. The gate used to be one number, and what it did past that
// number was leave the trees out of the field entirely, so the far field's second clipmap
// level was where the wood stopped and the hills behind it came out bare
// (gotchas.md "A footprint gate deletes a feature from the far field"). A gate should
// change the representation, not remove the thing.
//
// 12 * S is 33 voxels, which is the 32-voxel cells of the sixth level: a crown is one or
// two cells there, and the level past it reaches further than this world's fog.
const TREE_FAR_FOOTPRINT = 12.0 * S;
// A giant's cap is drawn as a cap only this close. It is much finer than the trees' gate
// because the thinnest thing on a mushroom is the lip under the rim, a voxel or two: past
// a cell of about 3 voxels the lip quantises to a full cell and the cap comes out as a
// flat plate wider than the mushroom, lit by its own glow. A dome is what survives.
const GIANT_DETAIL_FOOTPRINT = 1.0 * S;

// Lattice periods have to be whole voxels, so these are the scaled sizes rounded.
//
// The tree lattice is fine enough that a few tries to a cell close the canopy, and coarse
// enough that a crown plus the jitter still fits what the 3x3 lookup covers: the widest
// crown is 32 voxels and the jitter reaches 20, against the 60 the neighbourhood reaches.
const TREE_CELL = vec3i(40, 1 << 20, 40);
const SHROOM_CELL = vec3i(44, 1 << 20, 44);
// Jellyfish, on a lattice this wide and with a low hit rate on top of it: a lake with
// two or three in it reads as a lake with jellyfish, and one with twenty reads as soup.
const JELLY_CELL = vec3i(112, 1 << 20, 112);
// A bell is a handful of voxels across and it glows, which is the shape of thing that
// becomes a cell-sized lantern the moment a cell is wider than it is, so it keeps the
// finest gate in the world (CLAUDE.md "A world's sample_footprint gates").
const JELLY_FOOTPRINT = 1.0 * S;
// Water has to be deep enough to hang one in without it breaking the surface or resting
// on the bed. Measured from the chunk store rather than guessed: the forest's water is
// the stream's cut and it is 6 to 8 voxels deep, never the twenty a first guess assumed,
// so a jellyfish here is a small one and this threshold is most of what there is.
const JELLY_DEPTH = 2.2 * S;
// Giants stand on their own coarse lattice. As a rare variant of the small ones they
// shared the small lattice, and neighbouring caps merged into one pink plateau with
// stems poking through it.
const GIANT_CELL = vec3i(146, 1 << 20, 146);
// Tries per giant cell, for the same reason as the trees': one to a cell is a lattice.
const GIANT_TRIES: u32 = 3u;
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
// How thick a patch of something is at one point. Read where the plant stands, never at
// its cell's centre: one value to a cell puts the *patches* on the lattice even when the
// plants inside them are jittered, and a patch with square edges is a grid
// (gotchas.md "One per cell is a grid, whatever the jitter").
fn patch_density(p: WorldPoint, k: u32) -> f32 {
  return smoothstep(-0.4, 0.4, fbm2(p, k, 1u, 0.5));
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
// Returns the height in x and, in y, how far down a riser this point is: 0 on a tread
// and 1 at the steepest part of a step. The terracing works that out on the way to the
// height, so handing it back costs nothing, and it is what tells falling water from
// flowing water without measuring a gradient.
fn land_height2(p: WorldPoint, c: f32) -> vec3f {
  let hills = fbm2(p, 10u, 5u, 0.5) * HILL_AMP + 6.0 * S;
  let alp = fbm2(p, 12u, 2u, 0.5) * 0.5 + 0.5; // 0 lowland, 1 the core of a mountain
  let mask = smoothstep(0.15, 0.65, alp);
  let ridge = ridged2(p, 12u, 4u, 0.5);
  let crest = ridge * ridge * ridge;
  let rolling = hills + (ridge * MOUNTAIN_AMP + crest * RANGE_AMP * mask) * mask;
  // Quantize to steps, with the transition spread over BANK voxels of height so the
  // slope stays finite. `smoothstep` over the fraction does that: flat tread, steep
  // riser, no discontinuity.
  let t = rolling / TERRACE_DROP;
  let tread = floor(t);
  let lo = 0.5 - BANK / (2.0 * TERRACE_DROP);
  let hi = 0.5 + BANK / (2.0 * TERRACE_DROP);
  let u = fract(t);
  let riser = smoothstep(lo, hi, u);
  let terraced = (tread + riser) * TERRACE_DROP;
  let gorge = 1.0 - smoothstep(CHANNEL_HALF, CHANNEL_HALF + 20.0 * S, c);
  // The slope of a smoothstep is 6s(1-s) over its own width, so 4s(1-s) is that scaled
  // to peak at 1 in the middle of the riser. Away from the channel the terracing is
  // mixed out, and so is the steepness.
  let sp = clamp((u - lo) / (hi - lo), 0.0, 1.0);
  let steep = select(0.0, 4.0 * sp * (1.0 - sp), u > lo && u < hi) * gorge;
  // How high into the mountains this is, handed back as z: the raw number rather than
  // the mask, because the mask saturates at 1 over most of a range and a threshold on it
  // selects either everything or nothing. Nothing reads it today; the height in x is what
  // the falls turned out to want.
  return vec3f(mix(rolling, terraced, gorge), steep, alp);
}

fn land_height(p: WorldPoint, c: f32) -> f32 {
  return land_height2(p, c).x;
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

// How far the ground stands above the water at one point. Positive is dry land.
//
// Always evaluated at a *plant's own base* and never at the point being shaded. A plant
// whose existence depends on the sample point is a plant that exists for some of its own
// voxels and not others, and what that looks like is a tree sliced down the waterline
// with the rest of it missing
// (gotchas.md "A plant decided per sample point is a plant cut in half").
//
// It has to be cheap, because it runs per plant per sample. The stream costs nothing
// beyond the one field the cut already needs: inside the cut the ground and the water
// surface are the same land height less their own constants, so their difference is the
// cut profile alone and `land_height` cancels out of it. The lake does not cancel, but
// the lake sits seventy voxels under the wood, so the caller's own ground answers for
// whether it could possibly be near, and only down in a valley is the land read at all.
const LAKE_NEAR = 12.0 * S;

fn shore_dry(p: WorldPoint, ground_here: f32) -> f32 {
  let c = channel_distance(p);
  let cut = CHANNEL_DEPTH * (1.0 - smoothstep(0.0, CHANNEL_HALF, c));
  var dry = 1e9;
  if (c < CHANNEL_HALF) {
    dry = 0.6 * S - cut;
  }
  if (ground_here < LAKE_LEVEL + LAKE_NEAR) {
    dry = min(dry, land_height(p, c) - cut - LAKE_LEVEL);
  }
  return dry;
}

// The world position a plant stands at: its cell's centre plus its jitter. `wp_repeat`
// measures from the centre, so this is the point its `local` is measured from.
fn plant_base(id: vec3i, cell: vec3i, jitter: vec2f) -> WorldPoint {
  let at = id * cell + cell / 2 + vec3i(i32(jitter.x), 0, i32(jitter.y));
  return WorldPoint(vec3i(at.x, 0, at.z), vec3f(0.0));
}

// How much of a plant the shore leaves standing, 0 at the water's edge to 1 well inland.
// A hard threshold on this is what used to cut plants in half; a ramp over a band of
// shore thins the wood and shrinks what is left of it as the ground comes down to the
// water, which is what a shore looks like.
fn shore_fade(dry: f32, need: f32, band: f32) -> f32 {
  return smoothstep(need, need + band, dry);
}

// Tree species. A wood of one shape reads as a repeat however well the lattice is
// hidden, so a cell picks from three: broadleaf in the valleys, conifers as the ground
// climbs towards the tree line, and the rare ancient whose crown is several separate
// lobes on long limbs.
const TREE_BROADLEAF: u32 = 0u;
const TREE_CONIFER: u32 = 1u;
const TREE_ANCIENT: u32 = 2u;
const TREE_BIRCH: u32 = 3u;

fn tree_species(r: f32, ground: f32) -> u32 {
  if (r < 0.10) {
    return TREE_ANCIENT;
  }
  let cold = smoothstep(TREE_LINE * 0.40, TREE_LINE * 0.95, ground);
  if (r < 0.28 + 0.60 * cold) {
    return TREE_CONIFER;
  }
  // Birch likes the open, low ground: stands of them down by the water rather than up
  // where the conifers take over.
  if (r < 0.28 + 0.60 * cold + 0.30 * (1.0 - cold)) {
    return TREE_BIRCH;
  }
  return TREE_BROADLEAF;
}

// Which green this tree wears, from its own random and its species. A wood of one leaf
// colour reads as one plant repeated however varied the shapes are, because colour is
// what the eye sorts trees by from a distance.
fn leaf_block(pick_leaf: f32, species: u32) -> f32 {
  if (species == TREE_CONIFER) {
    return select(f32(BLOCK_LEAVES_DARK), f32(BLOCK_LEAVES), pick_leaf > 0.60);
  }
  if (species == TREE_ANCIENT) {
    return f32(BLOCK_LEAVES_DARK);
  }
  if (species == TREE_BIRCH) {
    return f32(BLOCK_LEAVES_PALE);
  }
  return select(f32(BLOCK_LEAVES), f32(BLOCK_LEAVES_PALE), pick_leaf > 0.55);
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
// Horizontal reach of a birch's crown: narrow, because it is a narrow tree.
fn birch_cr(r: vec3f) -> f32 {
  return (2.0 + r.z * 1.4) * S;
}

fn tree_crown(r: vec3f, tall: f32, species: u32) -> vec2f {
  if (species == TREE_BIRCH) {
    let br = birch_cr(r);
    return vec2f(br * 1.3, br * 2.0);
  }
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
fn broadleaf_shape(local: vec3f, r: vec3f, r2: vec3f, tall: f32, leaf: f32) -> vec2f {
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
  return pick(s, vec2f(canopy_bites(leaves, local, crown, cr, r2.y, 7u, 0.40), leaf));
}

// A conifer: a straight tapering trunk with tiers of needles up it. The gaps between
// the tiers show the trunk, and the bites break each tier's rim.
fn conifer_shape(local: vec3f, r: vec3f, r2: vec3f, tall: f32, leaf: f32) -> vec2f {
  let trunk_r = (0.55 + r.y * 0.35) * S;
  var s = vec2f(
    sd_bezier_tube(
      local,
      vec3f(0.0),
      vec3f(0.0, tall * 0.5, 0.0),
      vec3f(0.0, tall * 1.02, 0.0),
      trunk_r * 1.9,
      // Never thinner than a voxel. A taper that ends under half a voxel leaves no voxels
      // at all up there, and the tiers it was carrying come out as three or four separate
      // slabs of needles stacked in the air with nothing joining them
      // (gotchas.md "A trunk that tapers under a voxel leaves its crown in the air").
      max(trunk_r * 0.3, 0.75),
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
  return pick(s, vec2f(leaves, leaf));
}

// An ancient: a squat, thick trunk that forks into limbs, each carrying its own lobe.
// The lobes are never blended together, so the crown is as much gap as leaf.
fn ancient_shape(local: vec3f, r: vec3f, r2: vec3f, tall: f32, leaf: f32) -> vec2f {
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
  return pick(s, vec2f(leaves, leaf));
}

// One tree. `local` is the position relative to the tree's base.
// A birch: a slender white trunk that barely leans, two high branches, and a light
// airy crown. Its own shape rather than a thin broadleaf, because what makes a birch is
// the bare length of trunk under the leaves.
fn birch_shape(local: vec3f, r: vec3f, r2: vec3f, tall: f32, leaf: f32) -> vec2f {
  let lean = (r.x - 0.5) * 0.06;
  let trunk_r = (0.42 + r.y * 0.24) * S;
  let top = vec3f(lean * tall, tall, lean * tall * 0.8);
  var s = vec2f(
    sd_bezier_tube(
      local,
      vec3f(0.0),
      vec3f(lean * tall * 0.5, tall * 0.5, lean * tall * 0.4),
      top,
      trunk_r * 1.5,
      trunk_r * 0.7,
    ),
    f32(BLOCK_BIRCH),
  );
  for (var i = 0u; i < 2u; i++) {
    let a = (r.z + f32(i) * 0.5) * 6.2832;
    let base = top * (0.72 + 0.12 * f32(i));
    let reach = (1.6 + r.y * 1.4) * S;
    let dir = vec3f(cos(a), 0.0, sin(a));
    s = pick(s, vec2f(
      sd_bezier_tube(local, base, base + dir * reach * 0.5 + vec3f(0.0, reach * 0.3, 0.0), base + dir * reach + vec3f(0.0, reach * 0.9, 0.0), trunk_r * 0.6, 0.35 * S),
      f32(BLOCK_BIRCH),
    ));
  }
  let cr = birch_cr(r);
  let crown = top + vec3f(0.0, cr * 0.5, 0.0);
  var leaves = sd_ellipsoid(local - crown, vec3f(cr * 0.8, cr * 0.95, cr * 0.8));
  for (var i = 0u; i < 4u; i++) {
    let a = (sub_rand(r2.x, 80u + i) + f32(i) / 4.0) * 6.2832;
    let off = vec3f(cos(a), 0.0, sin(a)) * cr * (0.4 + 0.4 * sub_rand(r2.z, 90u + i)) +
      vec3f(0.0, (sub_rand(r2.y, 100u + i) - 0.4) * cr, 0.0);
    leaves = op_smin(leaves, sd_sphere(local - crown - off, cr * (0.34 + 0.24 * sub_rand(r2.x, 110u + i))), 0.7 * S);
  }
  return pick(s, vec2f(canopy_bites(leaves, local, crown, cr, r2.y, 9u, 0.46), leaf));
}

fn tree_shape(local: vec3f, r: vec3f, r2: vec3f, tall: f32, species: u32, leaf: f32) -> vec2f {
  if (species == TREE_CONIFER) {
    return conifer_shape(local, r, r2, tall, leaf);
  }
  if (species == TREE_ANCIENT) {
    return ancient_shape(local, r, r2, tall, leaf);
  }
  if (species == TREE_BIRCH) {
    return birch_shape(local, r, r2, tall, leaf);
  }
  return broadleaf_shape(local, r, r2, tall, leaf);
}

// How thick the wood is at a tree cell, 0 in a glade and 1 in the heart of a grove.
// Sampled at the cell's centre, never at the sample point: a density that varied within
// a cell would put a tree there for some voxels and not others.
// How thick the wood is at one point. Read at a tree's own foot and not at its cell's
// centre: a density that holds one value per cell puts the *clumps* on the lattice even
// when the trees inside them are jittered, and clumps with square edges are a grid you
// can see from above however random the trees are within them.
fn grove_density(p: WorldPoint) -> f32 {
  return smoothstep(-0.35, 0.45, fbm2(p, 9u, 2u, 0.5));
}

// A tree too far away to be worth its own shape: a crown and a trunk, two primitives
// against the trunk, three branches, lobed crown and bites of the real one. Placed and
// sized from the same numbers, so it stands where the tree stands and the swap at
// TREE_FOOTPRINT moves nothing sideways.
fn tree_imposter(local: vec3f, tall: f32, crown: vec2f, trunk_r: f32, bark: f32, leaf: f32) -> vec2f {
  let leaves = sd_ellipsoid(local - vec3f(0.0, tall, 0.0), vec3f(crown.x, crown.y, crown.x));
  let trunk = sd_cylinder(local - vec3f(0.0, tall * 0.5, 0.0), tall * 0.5, trunk_r);
  return select(vec2f(trunk, bark), vec2f(leaves, leaf), leaves < trunk);
}

fn trees(p: WorldPoint, ground: f32) -> vec2f {
  var best = vec2f(1e9, 0.0);
  if (ground > TREE_LINE) {
    return best; // above the tree line
  }
  let y = f32(p.cell.y) + p.frac.y;
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let shift = vec3i(i * TREE_CELL.x, 0, j * TREE_CELL.z);
      let q = wp_offset(p, -vec3f(shift));
      let id = wp_repeat_id(q, TREE_CELL);
      // Several tries to a cell, not one. One tree to a cell, however far it is jittered
      // inside that cell, is a stratified sample: never two trees close together and
      // never a gap much wider than a cell, and from above that regularity is the grid.
      // Three independent tries at a third of the chance each has the same count and no
      // memory of the lattice, because two of them can land next to each other and all
      // three can fail (gotchas.md "One per cell is a grid, whatever the jitter").
      for (var k = 0u; k < TREE_TRIES; k++) {
        let salt = k * 4u;
        let r = cell_random(id, 30u + salt);
        let jitter = cell_jitter(id, 31u + salt, TREE_CELL, 1.0);
        var local = wp_repeat_near(q, TREE_CELL, shift);
        // The jitter covers the whole cell, and it has to: at half a cell every tree
        // stood within a quarter cell of a lattice point, which leaves a band down every
        // cell boundary that no tree can ever occupy (gotchas.md "A jittered lattice is
        // still a lattice unless the jitter fills the cell"). It costs nothing, because
        // the 3x3 neighbourhood stays sufficient as long as a plant's reach is under one
        // cell, and a crown is 31 voxels against a 74-voxel cell.
        local.x -= jitter.x;
        local.z -= jitter.y;
        local.y = y - ground;
        let r2 = cell_random(id, 32u + salt);
        let species = tree_species(r2.x, ground);
        // A bound around the biggest this tree could be, before anything that costs a
        // noise field: the grove is at its thickest and the shore has not shrunk it. Both
        // of those only ever make it smaller, so the bound still contains it, and what
        // the bound buys is the right not to read a single field for a tree the sample
        // point is nowhere near.
        var full = (7.0 + r.z * 9.0 + 7.0) * S;
        if (species == TREE_CONIFER) {
          full *= 1.25;
        } else if (species == TREE_ANCIENT) {
          full *= 0.70;
        }
        let crown_full = tree_crown(r, full, species);
        // A thing smaller than a cell cannot be put in that cell without being inflated
        // to it: a 25-voxel crown sampled at 64-voxel cells comes back as a flat slab two
        // or three times the size of the tree, which is worse than leaving it out.
        if (sample_footprint > crown_full.x) {
          continue;
        }
        let height = full + crown_full.y;
        let bound = sd_cylinder(local - vec3f(0.0, height * 0.5, 0.0), height * 0.5, crown_full.x);
        if (bound > 1.0) {
          best = select(best, vec2f(bound, f32(BLOCK_BARK)), bound < best.x);
          continue;
        }
        // Everything that decides whether this tree stands is read at its own foot and
        // never at the point being shaded, or the test varies across the tree's own
        // footprint and cuts it in half. Behind the bound, because these are the two
        // noise fields in the loop.
        let base = plant_base(id, TREE_CELL, jitter);
        let density = grove_density(base);
        if (r.x > 0.22 + 0.61 * density) {
          continue;
        }
        let shore = shore_fade(shore_dry(base, ground), TREE_DRY, TREE_SHORE_BAND);
        if (shore < cell_random(id, 33u + salt).x) {
          continue;
        }
        // Thinner out on the edge of a grove, and smaller again on the shore, which is
        // the other half of the soft edge.
        let tall = full * (0.55 + 0.45 * density) * mix(0.55, 1.0, shore);
        let crown = tree_crown(r, tall, species);
        let leaf = leaf_block(r2.y, species);
        let bark = select(f32(BLOCK_BARK), f32(BLOCK_BIRCH), species == TREE_BIRCH);
        var s = tree_imposter(local, tall, crown, (0.9 + r.y * 0.7) * S, bark, leaf);
        if (sample_footprint <= TREE_FOOTPRINT) {
          s = tree_shape(local, r, r2, tall, species, leaf);
        }
        best = select(best, s, s.x < best.x);
      }
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
  if (ground > TREE_LINE) {
    return vec2f(1e9, 0.0); // undergrowth stops where the wood does
  }
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
      if (r.x > 0.95) {
        continue;
      }
      var local = wp_repeat_near(q, SHROOM_CELL, shift);
      let jitter = cell_jitter(id, 8u, SHROOM_CELL, 1.0);
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
      // Both of these are decided at the clump's own foot and read behind the bound,
      // because they are the noise fields in this loop: a density read at the cell's
      // centre puts the patches on the lattice, and a shore read at the sample point
      // cuts a clump off along the waterline instead of standing it back from one.
      let base = plant_base(id, SHROOM_CELL, jitter);
      if (r.x > 0.10 + 0.85 * patch_density(base, 8u)) {
        continue;
      }
      if (shore_fade(shore_dry(base, ground), UNDER_DRY, UNDER_SHORE_BAND) < cell_random(id, 18u).x) {
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

// The giants: a few to a coarse cell, tall enough to stand clear of the undergrowth and
// far enough apart that two caps never meet.
fn giants(p: WorldPoint, ground: f32) -> vec2f {
  if (ground > TREE_LINE) {
    return vec2f(1e9, 0.0); // undergrowth stops where the wood does
  }
  let y = f32(p.cell.y) + p.frac.y;
  var best = vec2f(1e9, 0.0);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let shift = vec3i(i * GIANT_CELL.x, 0, j * GIANT_CELL.z);
      let q = wp_offset(p, -vec3f(shift));
      let id = wp_repeat_id(q, GIANT_CELL);
      for (var k = 0u; k < GIANT_TRIES; k++) {
        let salt = k * 4u;
        let r = cell_random(id, 50u + salt);
        var local = wp_repeat_near(q, GIANT_CELL, shift);
        let jitter = cell_jitter(id, 51u + salt, GIANT_CELL, 1.0);
        local.x -= jitter.x;
        local.z -= jitter.y;
        local.y = y - ground;
        let stem_h = (6.0 + r.z * 7.0) * S;
        let cap_r = (3.5 + r.y * 3.5) * S;
        let lean = (cell_random(id, 52u + salt).xz - 0.5) * stem_h * 0.22;
        let bound = sd_cylinder(
          local - vec3f(0.0, (stem_h + cap_r) * 0.5, 0.0),
          (stem_h + cap_r) * 0.5 + 0.5 * S,
          cap_r * 1.15 + length(lean),
        );
        if (bound > 0.75) {
          best = select(best, vec2f(bound, f32(BLOCK_SHROOMSTEM)), bound < best.x);
          continue;
        }
        // Where they stand, decided at the foot and behind the bound: a density that
        // varies over its own field rather than a flat chance, so they come in loose
        // stands with stretches of wood between, and never in rows.
        let base = plant_base(id, GIANT_CELL, jitter);
        if (r.x > 0.30 + 0.90 * patch_density(base, 11u)) {
          continue;
        }
        if (shore_fade(shore_dry(base, ground), TREE_DRY, TREE_SHORE_BAND) < cell_random(id, 53u + salt).x) {
          continue;
        }
        // Too far for the lip and the curve of the stem: a straight stem and a dome, in
        // the same place and at the same size, which is what a cap can still be at a cell
        // of a few voxels without turning into a plate.
        if (sample_footprint > GIANT_DETAIL_FOOTPRINT) {
          let stem_far = sd_cylinder(
            local - vec3f(lean.x * 0.4, stem_h * 0.5, lean.y * 0.4),
            stem_h * 0.5,
            1.5 * S,
          );
          let cap_far = sd_ellipsoid(
            local - vec3f(lean.x, stem_h + cap_r * 0.2, lean.y),
            vec3f(cap_r, cap_r * 0.62, cap_r),
          );
          let far_s = select(
            vec2f(stem_far, f32(BLOCK_SHROOMSTEM)),
            vec2f(cap_far, cap_colour(r.z)),
            cap_far < stem_far,
          );
          best = select(best, far_s, far_s.x < best.x);
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
  }
  return best;
}

// Ferns: a few fronds arcing out of one point.
fn ferns(p: WorldPoint, ground: f32) -> vec2f {
  if (ground > TREE_LINE) {
    return vec2f(1e9, 0.0); // undergrowth stops where the wood does
  }
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
      if (r.x > 0.98) {
        continue;
      }
      var local = wp_repeat_near(q, FERN_CELL, shift);
      let jitter = cell_jitter(id, 10u, FERN_CELL, 1.0);
      local.x -= jitter.x;
      local.z -= jitter.y;
      local.y = y - ground;
      let reach = (3.0 + r.y * 3.2) * S;
      let bound = sd_cylinder(local - vec3f(0.0, reach * 0.4, 0.0), reach * 0.9, reach + 0.5 * S);
      if (bound > 0.6) {
        best = select(best, vec2f(bound, f32(BLOCK_FERN)), bound < best.x);
        continue;
      }
      // Both decided at its own foot and read behind the bound: see `mushrooms`.
      let base = plant_base(id, FERN_CELL, jitter);
      if (r.x > 0.55 + 0.43 * patch_density(base, 7u)) {
        continue;
      }
      if (shore_fade(shore_dry(base, ground), UNDER_DRY, UNDER_SHORE_BAND) < cell_random(id, 19u).x) {
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
      if (r.x > 0.95) {
        continue;
      }
      var local = wp_repeat_near(q, ROCK_CELL, shift);
      let jitter = cell_jitter(id, 11u, ROCK_CELL, 1.0);
      local.x -= jitter.x;
      local.z -= jitter.y;
      local.y = y - ground + (1.0 + r.z * 2.0) * S; // sunk into the ground
      let rr = (1.6 + r.z * 3.4) * S;
      // Read where the boulder lies, not at the cell's centre: one value to a cell puts
      // the scatters of them on the lattice. There is no bound to hide this behind, but
      // a boulder is a single ellipsoid and the loop is cheap either way.
      if (r.x > 0.45 + 0.5 * patch_density(plant_base(id, ROCK_CELL, jitter), 6u)) {
        continue;
      }
      let d = sd_ellipsoid(local, vec3f(rr * 1.2, rr * 0.85, rr)) - S * 0.3 * sin(local.x * 1.7 / S) * sin(local.z * 1.3 / S);
      let id_rock = select(f32(BLOCK_STONE), f32(BLOCK_MOSS), r.y > 0.6 && local.y > rr * 0.3);
      best = select(best, vec2f(d, id_rock), d < best.x);
    }
  }
  return best;
}

// Jellyfish drifting in the lakes: a bell with its underside cut off, and a bundle of
// tentacles trailing under it.
//
// This one is a *material* and not a shape. A jellyfish hangs inside water the field has
// already called solid, so adding it to the union would change nothing about the surface
// and would only fight the water for which of the two is more deeply inside. It returns
// its own distance so the caller can ask "is this point in a bell", and the caller
// changes the block id and leaves the field alone. The drift is the block's `sway`, which
// the vertex stage applies to anything with one, so `?wind=0` holds them still.
fn jellyfish(p: WorldPoint, ground: f32, top: f32) -> vec2f {
  var best = vec2f(1e9, 0.0);
  if (top - ground < JELLY_DEPTH) {
    return best;
  }
  let y = f32(p.cell.y) + p.frac.y;
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let shift = vec3i(i * JELLY_CELL.x, 0, j * JELLY_CELL.z);
      let q = wp_offset(p, -vec3f(shift));
      let id = wp_repeat_id(q, JELLY_CELL);
      let r = cell_random(id, 14u);
      if (r.x > 0.55) {
        continue;
      }
      let jitter = cell_jitter(id, 15u, JELLY_CELL, 0.7);
      let at = wp_repeat_near(q, JELLY_CELL, shift);
      // Sized to the water it has to fit in, and wide rather than tall for the same
      // reason: there are six or eight voxels of depth here, so the bell spends what it
      // has across rather than down and comes out five to eight voxels wide.
      let bell_r = (0.90 + 0.60 * r.y) * S;
      let tail = (0.70 + 0.80 * r.z) * S;
      // Hangs at its own depth, clear of the surface above and the bed below.
      let hang = clamp(
        top - (0.8 + 0.5 * fract(r.y * 7.3)) * S,
        ground + tail + bell_r * 0.55,
        top - bell_r * 0.55 - 0.4 * S,
      );
      let local = vec3f(at.x - jitter.x, y - hang, at.z - jitter.y);
      // The bell: a dome with its underside cut away, which is what makes it a bell
      // rather than a ball.
      let dome = sd_ellipsoid(local, vec3f(bell_r, bell_r * 0.55, bell_r));
      let bell = max(dome, -(local.y + bell_r * 0.12));
      // The tentacles, as one trailing bundle: separate threads would be under a voxel
      // each at this size and would come out as a dotted line.
      let lean = (fract(r.z * 11.7) - 0.5) * bell_r * 1.2;
      let strands = sd_bezier_tube(
        local,
        vec3f(0.0, -bell_r * 0.2, 0.0),
        vec3f(lean * 0.35, -tail * 0.55, lean * 0.2),
        vec3f(lean, -tail, lean * 0.6),
        bell_r * 0.42,
        0.28 * S,
      );
      let d = min(bell, strands);
      best = select(best, vec2f(d, f32(BLOCK_JELLY)), d < best.x);
    }
  }
  return best;
}

// How steep the terracing is under a point, 0 on a tread and 1 in the middle of a riser.
// Only the falling water asks for it, and it comes out of the height it already needed.
// A fall wants two things at once, and wanting only the first put one at every step of
// every stream: the stream has to be going over something steep, *and* it has to be
// somewhere a gorge could be. The mountain mask is the second: in the hills the stream
// steps down over shallow ledges and stays a stream, and where it is cut into rock it
// falls. Both are read from the terracing that computes the height anyway.
const FALL_STEEP = 0.80; // below this the stream is flowing, not falling
// What makes a fall rather than a stream going over a ledge, and every one of these was
// arrived at by measuring what share of the stream came out white rather than by
// reasoning about it. Gating on how high the land is was tried first and is wrong: the
// stream is in a valley, so the land at the water is low wherever the water is, and no
// fall was ever produced. What works is asking for the steepest part of the step *and*
// the middle of the channel, so a fall is a chute down the centre of the stream at the
// one place the bed drops away, and the shallows to either side of it stay water.
const FALL_MID = 0.45; // fraction of the channel's half width a fall runs in
// And where along the stream. Steepness alone cannot make a fall rare: the stream
// descends the whole way, so a riser turns up every seven metres of height it loses, and
// gating on the riser gave a quarter of the water white. This is one octave over eight
// thousand voxels, so what it selects is *stretches*: a gorge with a few falls in it and
// then kilometres of ordinary stream, which is how a river actually behaves.
const FALL_GORGE_LO = 0.48;
const FALL_GORGE_HI = 0.64;
const FALL_POOL = 2.0 * S; // how far the bed drops away under a fall
const FALL_LIP = 1.4 * S; // how far the surface rides up over one

fn forest(p: WorldPoint) -> vec2f {
  let y = f32(p.cell.y) + p.frac.y;
  let c = channel_distance(p);
  let land = land_height2(p, c);
  // How much of a fall this point is, from three things that have to agree. The riser is
  // the drop itself; the middle of the channel is where a fall runs, so the shallows to
  // either side of it stay water; and the gorge field is what makes falls rare, because
  // steepness on its own cannot. The stream descends the whole way, so a riser turns up
  // every seven metres of height it loses, and asking only for a riser painted a quarter
  // of the water white.
  //
  // Only the samples on a riser inside the channel pay for the gorge field, which is a
  // small part of the world.
  var fall = 0.0;
  if (land.y > 0.0 && c < CHANNEL_HALF) {
    fall = land.y *
      (1.0 - smoothstep(CHANNEL_HALF * FALL_MID * 0.6, CHANNEL_HALF * FALL_MID, c)) *
      smoothstep(FALL_GORGE_LO, FALL_GORGE_HI, fbm2(p, 10u, 1u, 0.5) * 0.5 + 0.5);
  }
  // A fall needs water to fall. The stream is only 0.6 * S deep, so a drop on its own
  // gives a sheet two voxels tall, which is a white line across the stream and not a
  // waterfall. Under a fall the bed drops away and the surface rides up over the lip,
  // which is what a stream does at a drop: a pool at the foot and a thicker sheet going
  // over. Both are proportional to `fall`, so they are nothing everywhere else.
  let cut = CHANNEL_DEPTH * (1.0 - smoothstep(0.0, CHANNEL_HALF, c)) + fall * FALL_POOL;
  let ground = land.x - cut;
  var top = LAKE_LEVEL;
  if (c < CHANNEL_HALF) {
    top = max(top, land.x - 0.6 * S + fall * FALL_LIP);
  }

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
  //
  // A cascade is not a special case here, it is what the terracing produces: the water
  // surface steps down wherever the ground does, and the face of that step is a sheet of
  // falling water. What marks it is the terrace's own steepness, so the white water is
  // only on the risers, which is where a stream actually breaks. On the treads between
  // them it is the same still water as the rest of the stream.
  let falling = fall > FALL_STEEP && c < CHANNEL_HALF && y > ground;
  s = pick(s, vec2f(max(y - top, ground - y), select(f32(BLOCK_WATER), f32(BLOCK_WHITEWATER), falling)));

  // Jellyfish, inside that water. The field is not touched: the lake's surface and its
  // bed stay where they are and only the block under them changes, which is all a thing
  // suspended inside something already solid can be (see `jellyfish`).
  if (sample_footprint <= JELLY_FOOTPRINT && y < top && y > ground) {
    let jelly = jellyfish(p, ground, top);
    if (jelly.x < 0.0) {
      s.y = jelly.y;
    }
  }

  // Nothing rooted grows below the waterline: a tree standing in the middle of a lake
  // with its trunk under water reads as a mistake, and the shore is more of a shore with
  // a band of bare sand between the wood and the water. Boulders are left alone; a rock
  // in a stream belongs there.
  if (sample_footprint <= TREE_FAR_FOOTPRINT) {
    s = pick(s, trees(p, ground));
    // Giants and boulders keep the fine gate, and for opposite reasons to the trees'.
    // A canopy is broad and continuous, so it survives being drawn coarsely: that is
    // what the imposter above is for. A glowcap is small and bright, and a small bright
    // thing in a coarse cell becomes a cell-sized bright thing: at eight voxels a cap
    // came out as a flat neon plate hanging over the wood, bigger than the mushroom and
    // louder than anything else in the frame. A boulder is a few voxels and there is
    // nothing for an imposter to stand for. Both are better left out at that range
    // (gotchas.md "A footprint gate deletes a feature from the far field").
    if (sample_footprint <= TREE_FOOTPRINT) {
      s = pick(s, giants(p, ground));
      s = pick(s, rocks(p, ground));
    }
  }
  if (sample_footprint <= UNDERGROWTH_FOOTPRINT) {
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

