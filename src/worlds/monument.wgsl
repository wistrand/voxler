// World: Monument Valley, on the Arizona/Utah border. A flat red desert floor with
// isolated sandstone buttes standing a few hundred voxels out of it.
// Contract: agent_docs/design-formats.md "World program".
//
// The shape of a butte here is not invented. It is the stratigraphy, which is what makes
// the silhouette recognisable (sources in agent_docs/plan-monument-valley.md):
//
//   Shinarump conglomerate   a thin hard cap; the reason the butte still stands
//   Moenkopi formation       thin, darker red, just under the cap
//   de Chelly sandstone      wind-blown, cross-bedded, erodes to a *vertical cliff*
//                            and is most of the height
//   Organ Rock shale         weaker siltstone, erodes to a *slope*, so it forms the
//                            skirt that flares out at the foot of every cliff
//   Cutler red siltstone     the valley floor itself, red from iron oxide
//
// Cliff over slope is the whole silhouette: a vertical wall that stops dead and turns
// into a talus cone. Get that wrong and it reads as a rock, not as Monument Valley.
//
// Everything is a pure function of position, so there is no placement pass: the
// voxelizer, the preview and the far field all see the same valley.

// A cliff face is vertical, which costs 1, and the relief cut into it adds its own
// gradient: about 2.0 at the wall's amplitude and wavelength below, more on the talus.
// 4.0 covers the sum. Still under the forest's 5, which is why this world's far-field
// build stays cheap. An underestimate here deletes rock, so if the relief grows, this
// grows first.
const WORLD_LIPSCHITZ: f32 = 4.0;

// Voxels per metre. The real buttes stand about 300 m over the floor, so at 1.0 a butte
// is 300 voxels: tall enough that the near field only ever holds part of one, which is
// the point of the world. The layer heights below are metres.
const M = 1.0;

const FLOOR_Y = 40.0 * M; // mean valley floor; the swells ride on top of it
// How far the floor swells, and over what distance. Both numbers are small, and it is
// the ratio that matters rather than either of them: the slope is what a voxel floor
// pays for. A shallow ramp in a voxel world is a contour map, one-voxel terraces whose
// side faces catch no sun and read as ruled black lines across an otherwise flat plain
// (gotchas.md "A wall at an angle the grid does not like"), and the floor is the worst
// case in the world for it because nothing else is this close to level. At 4 voxels over
// a 2,048-voxel lattice a terrace edge turns up every couple of hundred voxels and reads
// as a bench; at the 9-over-512 this started with, one turned up every twenty-six and
// the valley floor came out corduroy.
const SWELL_AMP = 4.0 * M;
const SWELL_LATTICE = 11u;

// Layer tops, as absolute elevations. Not as a fraction of each butte's own height: the
// beds are regional and flat-lying, one dune field and one floodplain after another laid
// down across the whole area, and a monument is what is left where the rest was carried
// off. So a contact stands at the same height on every butte in sight, and it is the bed
// that decides the height rather than the butte
// (plan-monument-valley.md "One layer cake, and the summits are accordant").
//
// The thicknesses are the measured section in the park, at one voxel to the metre:
// Organ Rock 300 ft exposed of a 600 ft unit, de Chelly 400 ft, a thin Moenkopi remnant,
// Shinarump 50 ft, and Chinle above that on the few highest remnants.
const ORGAN_TOP = FLOOR_Y + 95.0 * M; // top of the scree slope
const CHELLY_TOP = FLOOR_Y + 225.0 * M; // top of the cliff
const MOENKOPI_TOP = FLOOR_Y + 262.0 * M; // top of the red beds under the cap
const SHINARUMP_TOP = FLOOR_Y + 278.0 * M; // top of the cap
const CHINLE_TOP = FLOOR_Y + 330.0 * M; // as high as anything here still reaches

// Buttes stand a kilometre or two apart, and in groups: the valley is mostly floor, and
// the floor is most of what makes the monuments read as monuments. A cell this wide with
// a low hit rate leaves long empty stretches between the groups.
const BUTTE_CELL = vec3i(1150, 1 << 20, 1150);
// A butte reaches at most this far from its own centre, thumb included, and is jittered
// by at most the rest of a cell, so the 3x3 neighbourhood below can never miss one.
const BUTTE_REACH = 310.0 * M;
// Nearly the whole cell. A lattice shows through as rows whenever the jitter leaves a
// band down the middle of every cell that a butte can never reach; the only budget it has
// to respect is that jitter plus reach stays inside one cell, or the 3x3 neighbourhood
// the lookups walk would miss one. 0.8 * 1150 / 2 + 310 is 770, against a 1150 cell.
const BUTTE_JITTER = 0.80;

// What kind of monument a cell grows. The three shapes in the valley are not a
// continuum: a mesa is broad and low, a butte is taller than it is wide, and a spire is
// a splinter (the Totem Pole is over a hundred metres of sandstone a few metres across).
const KIND_MESA: u32 = 0u;
const KIND_BUTTE: u32 = 1u;
const KIND_SPIRE: u32 = 2u;

// Lobes round a butte's plan. The footprint is several overlapping circles blended into
// one irregular outline: not a polygon, and not a circle either.
//
// A polygon came first, on exact multiples of 45 degrees, to keep the walls on the grid:
// a wall at an arbitrary angle staircases, and the mesher merges the side faces of those
// steps into long quads that read as ruled lines
// (gotchas.md "A wall at an angle the grid does not like"). It worked and it was wrong.
// Every butte came out the same boxy octagon at the same orientation, which reads as
// architecture rather than rock. Curvature is the way out: a lobed outline is never
// straight for long, so its staircase never runs far enough in one direction to rule a
// line, and the relief on top of it breaks up what is left.
const PLAN_LOBES: u32 = 5u;

// Sparse low scrub, only close enough to see.
const SCRUB_CELL = vec3i(23, 1 << 20, 23);
const SCRUB_FOOTPRINT = 1.5;

fn cell_random(id: vec3i, salt: u32) -> vec3f {
  return vec3f(hash3(id + vec3i(i32(salt) * 7919, 0, 0), world_seed)) * (1.0 / 4294967296.0);
}

// Stable numbers in [0, 1) for the choices inside one butte.
fn sub_rand(seed: f32, i: u32) -> f32 {
  return fract(sin(seed * 91.7 + f32(i) * 13.31) * 43758.5453);
}

// Where in its cell a butte stands. The random that decides whether a cell has one is
// r.x, so the jitter draws its own, or every butte would sit on the same side of its
// cell and the lattice would show through (gotchas.md, the forest learned this).
fn cell_jitter(id: vec3i, salt: u32, cell: vec3i, amount: f32) -> vec2f {
  let j = cell_random(id, salt);
  return (j.xz - 0.5) * vec2f(f32(cell.x), f32(cell.z)) * amount;
}

// The desert floor: long shallow dunes over a nearly level plain, and a broad basin or
// two so the valley is not a table.
fn ground_height(p: WorldPoint) -> f32 {
  let basin = fbm2(p, 13u, 2u, 0.5) * 7.0 * M;
  let swell = fbm2(p, SWELL_LATTICE, 2u, 0.5) * SWELL_AMP;
  return FLOOR_Y + basin + swell;
}

// How thick the buttes stand here, 0 in open desert and 1 in a group. Sampled at the
// cell's centre, never at the sample point: a density that varied within a cell would
// put a butte there for some voxels and not others.
fn group_density(id: vec3i) -> f32 {
  let centre = WorldPoint(id * BUTTE_CELL + BUTTE_CELL / 2, vec3f(0.0));
  return smoothstep(-0.30, 0.40, fbm2(centre, 12u, 2u, 0.5));
}

// Distance from `local` to a butte's plan: PLAN_LOBES overlapping circles blended into
// one outline. `op_smin` underestimates the true distance where the lobes meet, which is
// the direction region skipping needs it to err in. Negative inside.
fn plan_distance(local: vec2f, seed: f32, base: f32) -> f32 {
  // The first lobe sits on the centre and the rest hang off it, so the outline is one
  // mass with bays and headlands rather than a ring of blobs.
  var d = length(local) - base * (0.52 + 0.22 * sub_rand(seed, 39u));
  for (var i = 1u; i < PLAN_LOBES; i++) {
    let a = (f32(i) + 0.85 * sub_rand(seed, 20u + i)) / f32(PLAN_LOBES) * 6.2832;
    let off = base * (0.22 + 0.42 * sub_rand(seed, 40u + i));
    let r = base * (0.30 + 0.34 * sub_rand(seed, 50u + i));
    d = op_smin(d, length(local - vec2f(cos(a), sin(a)) * off) - r, base * 0.22);
  }
  return d;
}

// The vertical streaking down a cliff face, as *colour* rather than shape: desert
// varnish, the dark manganese and iron stain that runs down these walls where water
// does. Sampled from xz only, so it runs straight up the wall.
//
// Colour and not geometry on purpose. Any displacement of a wall that the voxel grid
// does not divide exactly turns it into a staircase a voxel at a time, and the side face
// of a one-voxel step seen near head-on rasterizes as a dark hairline; a wall's worth of
// them reads as ruled lines rather than as rock (gotchas.md "A wall at an angle the grid
// does not like"). Staining a flat wall has the same effect on the eye and no geometry
// at all.
fn varnish(p: WorldPoint) -> f32 {
  return fbm2(p, 4u, 3u, 0.5);
}

// What is left of the shape: a slow, shallow undulation, long enough in wavelength that
// its steps are tens of voxels apart rather than every few.
fn fluting(p: WorldPoint, amount: f32) -> f32 {
  return fbm2(p, 7u, 1u, 0.5) * amount;
}

// Relief: how far the rock stands out from its plan at this point. Sampled in three
// dimensions, unlike the varnish and the fluting, and that is the whole point of it. A
// wall whose profile is the same at every height is an extrusion; one whose profile
// changes with height has brows, undercuts and overhangs, because where the relief grows
// as the wall rises the rock above stands out past the rock below.
// Short wavelength and few octaves on purpose. A relief that is smooth and shallow puts
// the wall on a gentle slope, and a gentle slope in a voxel world is a staircase of
// one-voxel steps whose side faces draw contour lines across the rock
// (gotchas.md "A wall at an angle the grid does not like"). Steeper relief steps by
// several voxels at a time, which reads as ledges and broken rock instead.
fn relief(p: WorldPoint, amount: f32) -> f32 {
  return fbm3(p, 5u, 2u, 0.5) * amount;
}

// How far the rock leans in and out over its height. The talus gets more than the cliff:
// a scree slope is gullies and buttresses, a cliff is a wall with a few brows on it.
const RELIEF_WALL = 16.0 * M;
const RELIEF_TALUS = 26.0 * M;
// Relief on the summit itself. Bigger than the wall's, because a top seen from below is
// all silhouette and a few voxels of wander there is worth more than on a face.
const CREST_RELIEF = 13.0 * M;

// One butte, or one thumb of one. `local` is xz relative to its centre, `ay` is the
// sample's absolute elevation and `ground` the floor under it. Returns (distance, id).
//
// Every body here is the same layer cake, clipped by its own plan and its own summit:
// the cake is regional, so a tier, a thumb and a pinnacle all run the same beds at the
// same heights as the mass they stand on. What one body has that another does not is
// how far up the cake it survived.
//
// The profile from the ground up: a talus cone (slope), then a vertical cliff that ends
// dead flat, then a thin cap a little wider than the cliff so it overhangs. The overhang
// is what a hard cap on a softer layer actually does, and it reads from a long way off.
fn butte_body(
  local: vec2f,
  ay: f32,
  ground: f32,
  summit: f32, // the elevation this body is eroded down to
  base: f32,
  seed: f32,
  flute: f32,
  stain: f32,
  bulge: f32, // relief at this point, positive where the rock stands proud of its plan
  wob: f32, // how far the beds wander off level here, in [-1, 1]
  crest: f32, // relief on the summit itself, in voxels
) -> vec2f {
  let plan = plan_distance(local, seed, base);

  // Relief is an absolute number of voxels and a stack can be seven voxels across, so an
  // unclamped one cuts a thin body into pieces: solid where the relief is positive, gone
  // where it is negative, which leaves fragments hanging in the air with nothing under
  // them. Capping it against the body's own size keeps every part of it connected to the
  // part below, whatever the relief is doing.
  let cap_relief = base * 0.30;
  let lean = clamp(bulge, -cap_relief, cap_relief);

  // The contacts wander by a few metres, because a perfectly level line round a butte
  // where the scree meets the cliff is the one thing that never happens in rock. `wob`
  // is sampled from the world point rather than from anything this butte owns, so the
  // wander is one field across the valley and neighbouring monuments wander together.
  let talus_y = ORGAN_TOP + wob * 9.0 * M;
  let cliff_y = CHELLY_TOP + wob * 5.0 * M;
  let moenkopi_y = MOENKOPI_TOP + wob * 3.0 * M;
  let shinarump_y = SHINARUMP_TOP + wob * 3.0 * M;
  // The summit is not a plane either: `crest` breaks it up at a few tens of voxels, so
  // the top reads as weathered rock rather than as a table.
  let top = summit + wob * 3.0 * M + crest;
  // Height within this body, for the two profiles that are measured from its foot.
  let y = ay - ground;

  // How far this layer stands out past the plan. Subtracting from a distance widens the
  // shape, so a larger number is a wider layer.
  //
  // The skirt flares to its widest at the ground and meets the cliff at the plan itself,
  // which is the one sloping surface in the stack; the wall is cut back by its fluting;
  // the cap stands a little proud of the wall, because a hard layer on a softer one
  // holds an overhang.
  var out_by = -flute + lean;
  // The varnish: dark streaks down the sandstone, strongest under the cap where the
  // water comes over, fading out before the talus.
  let run = smoothstep(0.0, 0.25, 1.0 - y / max(cliff_y - ground, 1.0)) * 0.35 + 0.65;
  var block = select(f32(BLOCK_SANDSTONE), f32(BLOCK_ORGANROCK), stain * run > 0.26);
  if (ay < talus_y) {
    // The skirt, with its own relief on top of the cone: gullies and buttresses rather
    // than a smooth pile.
    // The talus carries more relief than the wall, but under the same cap: on a wide
    // butte the cap never binds, and on a thin stack it is what keeps the foot attached.
    let scree = clamp(bulge * (RELIEF_TALUS / RELIEF_WALL), -cap_relief, cap_relief);
    out_by = base * 0.42 * (1.0 - clamp(y / max(talus_y - ground, 1.0), 0.0, 1.0)) + scree;
    block = f32(BLOCK_ORGANROCK);
  } else if (ay > shinarump_y) {
    // Chinle above the cap: soft again, so it steps back in and it is red rather than
    // dark. Only the few highest remnants carry any of it.
    out_by = -base * 0.03 + lean * 0.3;
    block = f32(BLOCK_ORGANROCK);
  } else if (ay > moenkopi_y) {
    // The cap. A hard bed on a softer one stands proud and holds an overhang, and it is
    // what keeps a butte standing: the monuments eroded down past this contact are the
    // ones being eaten away, and they show bare Moenkopi or bare de Chelly instead.
    out_by = base * 0.018 + lean * 0.3;
    block = f32(BLOCK_CAPROCK);
  } else if (ay > cliff_y) {
    out_by = base * 0.012 + lean * 0.3;
    block = f32(BLOCK_ORGANROCK);
  }

  // A prism of that plan, from the ground to the top of whatever bed is left on it.
  let side = plan - out_by;
  let below = ground - ay;
  let above = ay - top;
  let outside = length(max(vec2f(side, max(below, above)), vec2f(0.0)));
  let inside = min(max(side, max(below, above)), 0.0);
  return vec2f(outside + inside, block);
}

// The buttes. One to a cell where the density allows, jittered inside it, and some of
// them with a thumb: a second slender stack beside the main one, which is what makes a
// Mitten a mitten.
fn buttes(p: WorldPoint, ground: f32) -> vec2f {
  var best = vec2f(1e9, 0.0);
  let ay = f32(p.cell.y) + p.frac.y;
  let y = ay - ground;
  // How far the beds wander off level here. One field over the whole valley, sampled
  // from the world point and not from any one butte, so every monument in a view
  // wanders with its neighbours instead of each having its own idea of where the
  // contacts are.
  let wob = fbm2(p, 6u, 2u, 0.5);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let shift = vec3i(i * BUTTE_CELL.x, 0, j * BUTTE_CELL.z);
      let q = wp_offset(p, -vec3f(shift));
      let id = wp_repeat_id(q, BUTTE_CELL);
      let r = cell_random(id, 1u);
      // Nearly empty desert between nearly full groups, rather than a flat rate
      // everywhere: a picket fence of monuments on the horizon is not what the valley
      // looks like, and each one that is not there is far-field march and brick pool
      // spent on the ones that are
      // (plan-monument-valley.md "Fewer monuments, sampled finer").
      if (r.x > 0.15 + 0.85 * group_density(id)) {
        continue;
      }
      let jitter = cell_jitter(id, 2u, BUTTE_CELL, BUTTE_JITTER);
      let at = wp_repeat_near(q, BUTTE_CELL, shift);
      let local = vec2f(at.x - jitter.x, at.z - jitter.y);

      // Mesa, butte or spire, and the three are different shapes rather than one shape
      // at three sizes: a mesa is broad and low, a butte is taller than it is wide, and
      // a spire is a splinter.
      var kind = KIND_BUTTE;
      if (r.y < 0.26) {
        kind = KIND_MESA;
      } else if (r.y > 0.88) {
        kind = KIND_SPIRE;
      }
      var base = (44.0 + r.z * 42.0) * M;
      if (kind == KIND_MESA) {
        base = (105.0 + r.z * 95.0) * M;
      } else if (kind == KIND_SPIRE) {
        base = (7.0 + r.z * 9.0) * M;
      }

      // Where the top of this one stands. Erosion does not stop at an arbitrary height:
      // it strips a soft bed and then stalls on the hard one under it, so summits gather
      // at the resistant contacts rather than spreading evenly, and the monuments in one
      // view top out level with each other. Width decides which contact a monument is
      // likely to have reached: a wide remnant shelters its own cap and keeps the whole
      // section, and a splinter has long since lost it.
      let e = cell_random(id, 3u);
      var stripped = e.x;
      if (kind == KIND_MESA) {
        stripped = stripped * 0.62;
      } else if (kind == KIND_SPIRE) {
        stripped = 0.62 + stripped * 0.38;
      }
      var summit = SHINARUMP_TOP; // the whole section, cap and all
      if (stripped > 0.85) {
        summit = mix(ORGAN_TOP + 30.0 * M, CHELLY_TOP - 20.0 * M, e.y); // eaten into the wall
      } else if (stripped > 0.62) {
        summit = CHELLY_TOP; // stripped to the bench at the top of the cliff
      } else if (stripped > 0.40) {
        summit = MOENKOPI_TOP; // the cap has gone, the red beds under it have not
      }
      // A few metres either way, so the tops are accordant rather than identical.
      summit = summit + (e.z - 0.5) * 12.0 * M;

      // A cheap bound around the whole cell's monument, before any of the shaping above
      // is evaluated. The head room is for the stacks and pinnacles below, which stand
      // past the main summit but never past the top of the section.
      let crown = min(CHINLE_TOP, summit + 88.0 * M) + CREST_RELIEF;
      let bound = max(length(local) - BUTTE_REACH, max(-y - 4.0 * M, ay - crown - 8.0 * M));
      if (bound > 1.0) {
        best = select(best, vec2f(bound, f32(BLOCK_SANDSTONE)), bound < best.x);
        continue;
      }

      let seed = r.z;
      let flute = fluting(q, select(4.0, 1.0, kind == KIND_SPIRE) * M);
      let stain = varnish(q);
      // A spire is a splinter; give it a fraction of the relief or it stops being one.
      let bulge = relief(q, RELIEF_WALL * select(1.0, 0.35, kind == KIND_SPIRE));
      // Summit relief at a few tens of voxels, so a top is broken rather than level.
      let crest = fbm2(q, 5u, 2u, 0.5) * CREST_RELIEF;
      var s = butte_body(local, ay, ground, summit, base, seed, flute, stain, bulge, wob, crest);

      // The summit carries on upward as one or two smaller stacks, each standing on the
      // one under it. This is what stops a butte reading as a table: a real one steps up
      // in tiers, and the tier above is the same rock with the same layers, so it brings
      // its own cap and its own banding with it.
      let stacks = u32(sub_rand(seed, 20u) * 2.7);
      var stack_base = base;
      var stack_summit = summit;
      var stack_at = local;
      for (var k = 0u; k < stacks; k++) {
        let a = sub_rand(seed, 21u + k * 3u) * 6.2832;
        let off = stack_base * (0.10 + 0.26 * sub_rand(seed, 22u + k * 3u));
        stack_base = stack_base * (0.40 + 0.26 * sub_rand(seed, 23u + k * 3u));
        // A tier carries the section further up than the shoulder it stands on, and it
        // stops where the section does: there is no rock above the Chinle to stand a
        // tier in, so a monument that already reaches the top grows none.
        stack_summit = min(CHINLE_TOP, stack_summit + (14.0 + 30.0 * sub_rand(seed, 24u + k * 3u)) * M);
        stack_at = stack_at - vec2f(cos(a), sin(a)) * off;
        s = pick(s, butte_body(
          stack_at, ay, ground, stack_summit, stack_base, seed + 5.0 + f32(k),
          flute * 0.7, stain, bulge * 0.8, wob, crest * 0.7,
        ));
      }

      // The thumb: a separate slender stack standing clear of the main mass, which is
      // what makes a Mitten a mitten. Far enough out that the two do not merge, which is
      // the whole point of it, and never on a spire, which is already one.
      if (kind == KIND_BUTTE && sub_rand(seed, 3u) > 0.4) {
        let a = sub_rand(seed, 4u) * 6.2832;
        let away = base * (1.9 + 0.7 * sub_rand(seed, 5u));
        let thumb_base = base * (0.17 + 0.10 * sub_rand(seed, 6u));
        // Lower than the mass beside it, and by a whole bed or two: the thumb is the
        // part that lost its cap first.
        let thumb_summit = summit - (25.0 + 55.0 * sub_rand(seed, 7u)) * M;
        let to = local - vec2f(cos(a), sin(a)) * away;
        s = pick(s, butte_body(
          to, ay, ground, thumb_summit, thumb_base, seed + 1.7,
          flute * 0.4, stain, bulge * 0.5, wob, crest * 0.6,
        ));
      }

      // Pinnacles: slender stacks standing on the butte's own shoulder and carrying on
      // past its summit, which is how the Three Sisters read from the valley. They are
      // part of the same mass rather than beside it, so they blend in at the foot.
      if (kind != KIND_SPIRE) {
        let spikes = u32(sub_rand(seed, 8u) * 3.0);
        for (var k = 0u; k < spikes; k++) {
          let a = sub_rand(seed, 9u + k * 3u) * 6.2832;
          let away = base * (0.30 + 0.48 * sub_rand(seed, 10u + k * 3u));
          let sp_base = base * (0.09 + 0.09 * sub_rand(seed, 11u + k * 3u));
          let sp_summit = min(CHINLE_TOP, summit + (6.0 + 40.0 * sub_rand(seed, 12u + k * 3u)) * M);
          let to = local - vec2f(cos(a), sin(a)) * away;
          let spike = butte_body(
            to, ay, ground, sp_summit, sp_base, seed + 3.1 + f32(k),
            flute * 0.3, stain, bulge * 0.6, wob, crest * 0.5,
          );
          s = vec2f(op_smin(s.x, spike.x, 6.0 * M), select(s.y, spike.y, spike.x < s.x));
        }
      }
      best = select(best, s, s.x < best.x);
    }
  }
  return best;
}

// Low desert scrub: a ragged clump a voxel or two high, so the floor is not bare.
fn scrub(p: WorldPoint, ground: f32) -> vec2f {
  let y = f32(p.cell.y) + p.frac.y - ground;
  var best = vec2f(1e9, 0.0);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let shift = vec3i(i * SCRUB_CELL.x, 0, j * SCRUB_CELL.z);
      let q = wp_offset(p, -vec3f(shift));
      let id = wp_repeat_id(q, SCRUB_CELL);
      let r = cell_random(id, 4u);
      // Patchy, and thin even in a patch: desert, not prairie.
      if (r.x > 0.15 + 0.80 * smoothstep(-0.2, 0.4, fbm2(q, 8u, 2u, 0.5))) {
        continue;
      }
      let jitter = cell_jitter(id, 5u, SCRUB_CELL, 0.8);
      let at = wp_repeat_near(q, SCRUB_CELL, shift);
      let local = vec3f(at.x - jitter.x, y, at.z - jitter.y);
      let size = (0.9 + r.y * 1.4) * M;
      let d = sd_ellipsoid(local - vec3f(0.0, size * 0.45, 0.0), vec3f(size, size * 0.7, size * 0.85));
      best = select(best, vec2f(d, f32(BLOCK_SAGE)), d < best.x);
    }
  }
  return best;
}

fn valley(p: WorldPoint) -> vec2f {
  let ground = ground_height(p);
  let y = f32(p.cell.y) + p.frac.y;

  // The floor: red sand, with the siltstone it weathered from showing through in
  // patches. A depth rule alone drew a dark line down every dune slope, because at a
  // slope the topmost solid voxel's centre sits several voxels under the height field.
  var surface = f32(BLOCK_REDSAND);
  if (ground - y > 8.0 * M || fbm2(p, 7u, 2u, 0.5) > 0.34) {
    surface = f32(BLOCK_ORGANROCK);
  }
  var s = vec2f(y - ground, surface);
  s = pick(s, buttes(p, ground));
  if (sample_footprint <= SCRUB_FOOTPRINT) {
    s = pick(s, scrub(p, ground));
  }
  return s;
}

fn world_sdf(p: WorldPoint) -> f32 {
  return valley(p).x;
}

fn world_material(p: WorldPoint) -> u32 {
  return u32(valley(p).y);
}
