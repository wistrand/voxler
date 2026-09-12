// World: infinite noise terrain with rolling hills, ridged mountains, caves, and a
// sea at y = 0.
// All noise is sampled through WorldPoint lattices, so it is exact (no banding)
// at any distance. Contract: agent_docs/design-formats.md "World program".

// Heightfield slopes stay under about 1.5 and cave carving adds less than that
// (estimated from octave amplitudes and wavelengths, not measured).
const WORLD_LIPSCHITZ: f32 = 2.0;

const SNOW_LINE = 70.0;
// Sea level. Water fills the space below it that is above the ground: caves under the
// sea stay dry, which keeps the material rule to one height lookup instead of a
// second cave evaluation, and there are no cave mouths in the sea floor to explain a
// flood through. 30 rather than 0 because this world's surface runs from about 20 to
// 105 (measured over a 400 x 400 patch), so a sea at 0 would never show.
const SEA_LEVEL = 30.0;
const BEACH_LEVEL = SEA_LEVEL + 3.0;
// terrain_height never exceeds hills (40) + mountains (110). Above SKIP_ABOVE the
// SDF returns y - MAX_HEIGHT without any noise: at most the true distance, and at
// least 10, so it never produces a false surface at the cutoff.
const MAX_HEIGHT = 150.0;
const SKIP_ABOVE = 160.0;
// Caves are defined by noise near zero, and skipped octaves read as zero, so caves
// are left out when a sample covers more than this many voxels.
const CAVE_MAX_FOOTPRINT = 8.0;

fn terrain_height(p: WorldPoint) -> f32 {
  let hills = fbm2(p, 9u, 6u, 0.5) * 40.0; // wavelengths 512 .. 16 voxels
  let mask = smoothstep(0.1, 0.6, fbm2(p, 11u, 2u, 0.5) * 0.5 + 0.5); // where mountains rise
  let mountains = ridged2(p, 9u, 4u, 0.5) * 110.0 * mask;
  return hills + mountains;
}

fn caves(p: WorldPoint) -> f32 {
  // Tunnels where two 3D noise fields are both near zero; about 4 voxels wide.
  let a = fbm3(p, 6u, 2u, 0.5);
  let b = fbm3(WorldPoint(p.cell + vec3i(9001, 0, 0), p.frac), 6u, 2u, 0.5);
  return (length(vec2f(a, b)) - 0.06) * 40.0;
}

fn world_sdf(p: WorldPoint) -> f32 {
  let y = f32(p.cell.y) + p.frac.y;
  if (y > SKIP_ABOVE) {
    return y - MAX_HEIGHT; // above every peak, and above the sea
  }
  let h = terrain_height(p);
  let ground = y - h;
  // The sea: below SEA_LEVEL and outside the ground, so it meets the shore instead of
  // running through it. Both halves are 1-Lipschitz, so the bound is unchanged.
  let sea = max(y - SEA_LEVEL, h - y);
  if (ground > 8.0 || sample_footprint > CAVE_MAX_FOOTPRINT) {
    return op_union(ground, sea); // well above the surface, or too coarse for caves
  }
  return op_union(op_subtract(ground, caves(p)), sea);
}

fn world_material(p: WorldPoint) -> u32 {
  let y = f32(p.cell.y) + p.frac.y;
  let h = terrain_height(p);
  if (y > h) {
    return BLOCK_WATER; // solid above the ground means the sea
  }
  let depth = h - y;
  if (h > SNOW_LINE && depth < 3.0) {
    return BLOCK_SNOW;
  }
  if (depth < 1.5) {
    return select(BLOCK_GRASS, BLOCK_SAND, h < BEACH_LEVEL);
  }
  if (depth < 5.0) {
    return BLOCK_DIRT;
  }
  return BLOCK_STONE;
}
