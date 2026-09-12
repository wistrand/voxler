// Far-field ray march (plan-far-field phases 1-4): one invocation per pixel of the far
// target. Requires sky-color.wgsl and shading.wgsl.
//
// Three levels of traversal. The outermost walks the clipmap: every level is centred
// on the camera, so a ray starts inside the finest one and steps up when it leaves a
// level's window, each step doubling the cell size. Inside a level, the brick DDA
// walks the indirection grid a brick at a time (an empty brick costs one step
// whatever its size, which is where the empty-space skipping comes from) and the cell
// DDA walks an occupied brick's 8^3 cells from where the ray entered it. Every loop is
// capped: an unbounded loop can reset the GPU (gotchas.md).
//
// Coordinates: each level marches in its own cell units, with the ray origin given by
// adding that level's integer voxel offset to the render-space eye and dividing by the
// cell size. No absolute f32 world position is ever formed (CLAUDE.md "Invariants").
// `t` is carried between levels in voxels, the one unit they share.
//
// Indirection is toroidal: a brick's grid cell is `brick mod B` per axis, so scrolling
// rewrites only the slab that came into the window (src/far/clipmap.ts).
//
// Compositing with the near field (phase 4) is three things: a pixel the near field
// already drew is skipped before any marching, a cell inside a chunk the near field is
// drawing is marched past rather than hit (the raster pass leaves gaps on purpose, and
// a coarse cell filling one pokes through the geometry in front of it), and the hit is
// lit and fogged by src/render/shading.wgsl, the same functions the near field and the
// preview use.

struct LevelParams {
  offset: vec4i, // xyz: render space to this level's grid, in voxels; w: indirection base
  wrap: vec4i, // xyz: the level origin modulo B, for the toroidal index; w unused
  info: vec4f, // x: voxels per cell; y: the level's extent in cells; zw unused
}

struct FarParams {
  inv_view_proj: mat4x4f,
  eye: vec4f, // camera offset in render space; w unused
  grid: vec4u, // bricks per side, max brick steps, max cell steps, debug view
  counts: vec4u, // x: levels, y: 1 when the beam pre-pass ran; zw unused
  camera_chunk: vec4i, // the camera's chunk, for world voxel coordinates; w unused
  mask_origin: vec4i, // coverage window's min corner, in chunks; w unused
  level: array<LevelParams, 8>, // MAX_LEVELS
}

struct FarColors {
  // Two vec4f per block, like the near field's table: color and solidity, then
  // emission (design-formats.md "Block table").
  color: array<vec4f, 512>,
}

@group(0) @binding(0) var<uniform> far: FarParams;
@group(0) @binding(1) var<uniform> block_colors: FarColors;
@group(0) @binding(2) var<storage, read> indirection: array<u32>;
@group(0) @binding(3) var<storage, read> bricks: array<u32>;
// One bit per chunk the near field is drawing (src/far/coverage.ts).
@group(0) @binding(4) var<storage, read> coverage: array<u32>;
@group(0) @binding(5) var near_depth: texture_depth_2d;
@group(0) @binding(6) var out_color: texture_storage_2d<rgba16float, write>;
// The beam pre-pass writes one start distance per tile (beam_far), and the march reads
// it (march_far). Two bind groups, because a texture cannot be written and sampled in
// one pass.
@group(0) @binding(7) var out_beam: texture_storage_2d<r32float, write>;
@group(0) @binding(8) var beam_in: texture_2d<f32>;

const BRICK_CELLS: i32 = 8;
const BRICK_WORDS: u32 = 144u;
const OCCUPANCY_WORDS: u32 = 16u;
// A brick that is solid throughout with one block id is the entry itself, with no
// pool slot and no cell walk (design-formats.md "Brick and clipmap").
const ENTRY_SOLID: u32 = 0x80000000u;

// Coverage window, in step with src/far/coverage.ts.
const COVERAGE_X: i32 = 64;
const COVERAGE_Y: i32 = 32;
const COVERAGE_Z: i32 = 64;

// True where the near field is drawing the chunk holding this voxel.
fn near_covers(voxel: vec3i) -> bool {
  let c = voxel >> vec3u(5u);
  let rel = c - far.mask_origin.xyz;
  if (any(rel < vec3i(0)) || rel.x >= COVERAGE_X || rel.y >= COVERAGE_Y || rel.z >= COVERAGE_Z) {
    return false;
  }
  let i = u32((c.x & (COVERAGE_X - 1)) + (c.y & (COVERAGE_Y - 1)) * COVERAGE_X +
    (c.z & (COVERAGE_Z - 1)) * COVERAGE_X * COVERAGE_Y);
  return (coverage[i >> 5u] & (1u << (i & 31u))) != 0u;
}

// Debug views (`?far=steps` and `?far=bricks`).
const DEBUG_NONE: u32 = 0u;
const DEBUG_STEPS: u32 = 1u;
const DEBUG_BRICKS: u32 = 2u;
const DEBUG_LEVELS: u32 = 3u;

// March pixels per beam tile, in step with src/far/far-field.ts.
const BEAM_TILE: u32 = 8u;
// Nothing within reach: start the march past every level, where it finds nothing fast.
const BEAM_MISS: f32 = 1e9;

fn brick_entry(level: u32, b: vec3i) -> u32 {
  let size = i32(far.grid.x);
  if (any(b < vec3i(0)) || any(b >= vec3i(size))) {
    return 0u;
  }
  // Toroidal: the window's brick b is at (origin + b) mod B.
  let c = (b + far.level[level].wrap.xyz) & vec3i(size - 1);
  return indirection[u32(far.level[level].offset.w) + u32(c.x + c.y * size + c.z * size * size)];
}

fn cell_solid(brick: u32, cell: vec3i) -> bool {
  let i = u32(cell.x + cell.y * BRICK_CELLS + cell.z * BRICK_CELLS * BRICK_CELLS);
  return (bricks[brick * BRICK_WORDS + (i >> 5u)] & (1u << (i & 31u))) != 0u;
}

fn cell_block(brick: u32, cell: vec3i) -> u32 {
  let i = u32(cell.x + cell.y * BRICK_CELLS + cell.z * BRICK_CELLS * BRICK_CELLS);
  let word = bricks[brick * BRICK_WORDS + OCCUPANCY_WORDS + (i >> 2u)];
  return (word >> ((i & 3u) * 8u)) & 0xffu;
}

struct Hit {
  hit: bool,
  // The first surface on this ray is one the near field is drawing, so the far field
  // has nothing to say about the pixel and stops. Marching past it would put the ray
  // inside solid ground and surface it again at the edge of the meshed region, which
  // is a line of side faces along that whole edge.
  stopped: bool,
  block: u32,
  axis: u32,
  level: u32,
  t: f32, // distance along the ray, in voxels
  steps: u32,
  bricks: u32,
}

// Walks one occupied brick's cells from `t0`, in this level's cell units. `p0` is the
// ray origin in cell units and `inv` the reciprocal direction.
fn march_brick(
  brick: u32,
  base: vec3i,
  p0: vec3f,
  dir: vec3f,
  inv: vec3f,
  t0: f32,
  world_base: vec3i, // the level's origin, in world voxels
  cell_voxels: i32,
  entry_face: u32, // the axis the ray crossed to enter this brick
  out: ptr<function, Hit>,
) -> bool {
  let step = vec3i(sign(dir));
  // A hair past the entry, so this is the cell the ray is actually in. Clamping into
  // the brick instead would invent a cell on a ray that only grazes its corner, and
  // the march would report a hit the ray never reaches.
  var cell = vec3i(floor(p0 + dir * (t0 + 1e-4))) - base * BRICK_CELLS;
  if (any(cell < vec3i(0)) || any(cell >= vec3i(BRICK_CELLS))) {
    return false;
  }
  let world_cell = base * BRICK_CELLS + cell;
  // Distance to the next crossing on each axis, from the ray origin.
  let next = vec3f(world_cell + max(step, vec3i(0)));
  var t = (next - p0) * inv;
  let dt = abs(inv);
  // The face the ray came in through, not a fixed axis: a ray can enter a level or a
  // brick already inside solid ground (the levels quantize a surface differently, so
  // one level's ground starts where another's stopped), and calling that an X face
  // shades it with ambient alone. That is a dark line one cell wide along every level
  // boundary, which is what it looked like.
  var axis = entry_face;
  var t_cell = t0;
  for (var i = 0u; i < far.grid.z; i++) {
    (*out).steps++;
    if (cell_solid(brick, cell)) {
      let voxel = (base * BRICK_CELLS + cell) * cell_voxels + world_base;
      if (near_covers(voxel)) {
        (*out).stopped = true;
        return true;
      }
      (*out).hit = true;
      (*out).block = cell_block(brick, cell);
      (*out).axis = axis;
      (*out).t = t_cell;
      return true;
    }
    if (t.x <= t.y && t.x <= t.z) {
      t_cell = t.x;
      t.x += dt.x;
      cell.x += step.x;
      axis = 0u;
      if (cell.x < 0 || cell.x >= BRICK_CELLS) { return false; }
    } else if (t.y <= t.z) {
      t_cell = t.y;
      t.y += dt.y;
      cell.y += step.y;
      axis = 1u;
      if (cell.y < 0 || cell.y >= BRICK_CELLS) { return false; }
    } else {
      t_cell = t.z;
      t.z += dt.z;
      cell.z += step.z;
      axis = 2u;
      if (cell.z < 0 || cell.z >= BRICK_CELLS) { return false; }
    }
  }
  return false;
}

// Marches one level from `t_voxels`. Returns the distance, in voxels, at which the ray
// left the level's window, or a hit through `out`.
fn march_level(level: u32, dir: vec3f, t_voxels: f32, out: ptr<function, Hit>) -> f32 {
  let cell_voxels = far.level[level].info.x;
  let extent = far.level[level].info.y; // cells across the window
  let p0 = (far.eye.xyz + vec3f(far.level[level].offset.xyz)) / cell_voxels;
  // The level's origin in world voxels: the camera chunk less the offset that took
  // render space into this level's grid. Integers throughout.
  let world_base = far.camera_chunk.xyz * 32 - far.level[level].offset.xyz;
  let inv = 1.0 / max(abs(dir), vec3f(1e-8)) * sign(dir + vec3f(1e-20));
  let step = vec3i(sign(dir));
  var t_enter = t_voxels / cell_voxels;
  let entry_point = p0 + dir * (t_enter + 1e-4);
  if (any(entry_point < vec3f(0.0)) || any(entry_point >= vec3f(extent))) {
    return t_voxels; // the window does not hold the ray here: try the next level
  }
  var brick = vec3i(floor(entry_point / f32(BRICK_CELLS)));
  let next = vec3f((brick + max(step, vec3i(0))) * BRICK_CELLS);
  var t = (next - p0) * inv;
  let dt = abs(inv) * f32(BRICK_CELLS);
  let size = i32(far.grid.x);
  // The face the ray crossed to enter the current brick, for shading a brick that is
  // solid throughout: there is no cell walk to report one.
  var face = 1u;
  for (var i = 0u; i < far.grid.y; i++) {
    (*out).bricks++;
    let entry = brick_entry(level, brick);
    if ((entry & ENTRY_SOLID) != 0u) {
      // Solid throughout: the hit is where the ray entered. A brick can span several
      // chunks at a coarse level, so the coverage test is on the cell the ray enters;
      // a cell of the pool is tested the same way.
      let voxel = vec3i(floor(p0 + dir * (t_enter + 1e-4)) * cell_voxels) + world_base;
      if (near_covers(voxel)) {
        (*out).stopped = true;
        return t_enter * cell_voxels;
      }
      (*out).hit = true;
      (*out).block = entry & 0xffu;
      (*out).axis = face;
      (*out).level = level;
      (*out).t = t_enter * cell_voxels;
      return t_enter * cell_voxels;
    } else if (entry != 0u && march_brick(entry - 1u, brick, p0, dir, inv, t_enter, world_base, i32(cell_voxels), face, out)) {
      if ((*out).stopped) {
        return t_enter * cell_voxels;
      }
      (*out).level = level;
      (*out).t = (*out).t * cell_voxels; // cell units to voxels
      return (*out).t;
    }
    if (t.x <= t.y && t.x <= t.z) {
      t_enter = t.x;
      t.x += dt.x;
      brick.x += step.x;
      face = 0u;
    } else if (t.y <= t.z) {
      t_enter = t.y;
      t.y += dt.y;
      brick.y += step.y;
      face = 1u;
    } else {
      t_enter = t.z;
      t.z += dt.z;
      brick.z += step.z;
      face = 2u;
    }
    if (any(brick < vec3i(0)) || any(brick >= vec3i(size))) {
      return t_enter * cell_voxels; // left the window: the next level carries on
    }
  }
  return t_enter * cell_voxels; // out of steps
}

// Walks one level's bricks without descending into cells: the beam pre-pass only wants
// to know how far the ray can travel before anything could be in its way. Returns the
// distance in voxels, negative when the level held nothing (the caller carries on with
// its magnitude as the exit).
fn beam_level(level: u32, dir: vec3f, t_voxels: f32) -> f32 {
  let cell_voxels = far.level[level].info.x;
  let extent = far.level[level].info.y;
  let p0 = (far.eye.xyz + vec3f(far.level[level].offset.xyz)) / cell_voxels;
  let inv = 1.0 / max(abs(dir), vec3f(1e-8)) * sign(dir + vec3f(1e-20));
  let step = vec3i(sign(dir));
  var t_enter = t_voxels / cell_voxels;
  let entry_point = p0 + dir * (t_enter + 1e-4);
  if (any(entry_point < vec3f(0.0)) || any(entry_point >= vec3f(extent))) {
    return -t_voxels;
  }
  var brick = vec3i(floor(entry_point / f32(BRICK_CELLS)));
  let next = vec3f((brick + max(step, vec3i(0))) * BRICK_CELLS);
  var t = (next - p0) * inv;
  let dt = abs(inv) * f32(BRICK_CELLS);
  let size = i32(far.grid.x);
  for (var i = 0u; i < far.grid.y; i++) {
    if (brick_entry(level, brick) != 0u) {
      // Back off two bricks: the tile's other rays diverge from this one, and one of
      // them can meet a brick this one passes beside. Two bricks is 32 voxels at the
      // finest level and more at every other, against a divergence of a few voxels over
      // the distance where the first brick turns up.
      return max(0.0, t_enter * cell_voxels - 2.0 * f32(BRICK_CELLS) * cell_voxels);
    }
    if (t.x <= t.y && t.x <= t.z) {
      t_enter = t.x;
      t.x += dt.x;
      brick.x += step.x;
    } else if (t.y <= t.z) {
      t_enter = t.y;
      t.y += dt.y;
      brick.y += step.y;
    } else {
      t_enter = t.z;
      t.z += dt.z;
      brick.z += step.z;
    }
    if (any(brick < vec3i(0)) || any(brick >= vec3i(size))) {
      return -(t_enter * cell_voxels);
    }
  }
  return -(t_enter * cell_voxels);
}

// One ray per tile, bricks only: where the full march can start without missing
// anything (plan-far-field phase 5, Laine and Karras's beam optimization). Conservative
// by a brick rather than by construction: a tile's rays diverge by a few voxels over
// the distance where they first meet a brick, and a brick is 16 voxels at the finest
// level and more at every other.
@compute @workgroup_size(8, 8)
fn beam_far(@builtin(global_invocation_id) gid: vec3u) {
  let tiles = textureDimensions(out_beam);
  if (gid.x >= tiles.x || gid.y >= tiles.y) {
    return;
  }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(tiles);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let a = far.inv_view_proj * vec4f(ndc, 1.0, 1.0);
  let b = far.inv_view_proj * vec4f(ndc, 0.5, 1.0);
  let dir = normalize(b.xyz / b.w - a.xyz / a.w);
  var t = 0.0;
  var start = BEAM_MISS;
  for (var level = 0u; level < far.counts.x; level++) {
    let got = beam_level(level, dir, t);
    if (got >= 0.0) {
      start = got;
      break;
    }
    t = max(-got, t);
  }
  textureStore(out_beam, vec2i(gid.xy), vec4f(start, 0.0, 0.0, 0.0));
}

fn march(dir: vec3f, start: f32) -> Hit {
  var out = Hit(false, false, 0u, 0u, 0u, 0.0, 0u, 0u);
  var t = start;
  for (var level = 0u; level < far.counts.x; level++) {
    let t_exit = march_level(level, dir, t, &out);
    if (out.hit || out.stopped) {
      return out;
    }
    t = max(t_exit, t);
  }
  return out;
}

@compute @workgroup_size(8, 8)
fn march_far(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(out_color);
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }
  // Pixels the near field already drew: the raster pass wins, and marching them would
  // be work the blit's depth test throws away after the fact. Reversed-Z, cleared to 0,
  // so anything above 0 is geometry.
  //
  // The march can run at a fraction of the frame's resolution, so one invocation covers
  // a block of the depth buffer and is only skipped when the whole block is covered.
  // The four corners of the block stand in for it: at half resolution that is the whole
  // block, and below that a gap in the near field narrower than the block can be missed.
  let depth_size = vec2f(textureDimensions(near_depth));
  let ratio = depth_size / vec2f(size);
  let lo = vec2i(floor(vec2f(gid.xy) * ratio));
  let hi = vec2i(ceil((vec2f(gid.xy) + 1.0) * ratio)) - vec2i(1);
  let covered = min(
    min(textureLoad(near_depth, lo, 0), textureLoad(near_depth, vec2i(hi.x, lo.y), 0)),
    min(textureLoad(near_depth, vec2i(lo.x, hi.y), 0), textureLoad(near_depth, hi, 0)),
  );
  if (covered > 0.0) {
    textureStore(out_color, vec2i(gid.xy), vec4f(0.0));
    return;
  }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(size);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  // Unproject two points and take the direction between them, so the ray is right
  // whatever the projection.
  let a = far.inv_view_proj * vec4f(ndc, 1.0, 1.0);
  let b = far.inv_view_proj * vec4f(ndc, 0.5, 1.0);
  let dir = normalize(b.xyz / b.w - a.xyz / a.w);
  // Where the beam pre-pass says this tile's rays can start. Without it, zero.
  var start = 0.0;
  if (far.counts.y != 0u) {
    start = textureLoad(beam_in, vec2i(gid.xy / BEAM_TILE), 0).r;
  }
  let result = march(dir, start);

  var color = vec4f(0.0);
  if (far.grid.w == DEBUG_STEPS) {
    let heat = f32(result.steps + result.bricks) / 256.0;
    color = vec4f(heat, 1.0 - heat, select(0.0, 0.4, result.hit), 1.0);
  } else if (far.grid.w == DEBUG_BRICKS) {
    let heat = f32(result.bricks) / 128.0;
    color = vec4f(heat, heat * 0.4, 1.0 - heat, 1.0);
  } else if (far.grid.w == DEBUG_LEVELS && result.hit) {
    // One hue per level, so the rings are visible.
    let l = f32(result.level) / max(1.0, f32(far.counts.x - 1u));
    color = vec4f(l, 1.0 - l, 0.5 * fract(f32(result.level) * 0.5), 1.0);
  } else if (result.hit) {
    // The face the ray crossed last, pointing back along the ray on that axis. Lit and
    // fogged by shading.wgsl, the near field's own functions, or the two fields would
    // meet at a visible line.
    var n = vec3f(0.0);
    n[result.axis] = -sign(dir[result.axis]);
    let known = min(result.block, 255u);
    let albedo = block_colors.color[known * 2u].rgb;
    let glow = block_colors.color[known * 2u + 1u].rgb;
    color = vec4f(apply_fog(albedo * surface_light(n) + glow * albedo, dir, result.t), 1.0);
  }
  textureStore(out_color, vec2i(gid.xy), color);
}
