// Shadow rays against the far field's brickmap clipmap. Compiled into the near field's
// draw shader, not into the far field's own march, so it declares its own bindings at
// group 2 and its own copies of the brick reads. The layout it reads is owned by
// design-formats.md "Brick and clipmap"; change one and change the other.
//
// A shadow ray only asks whether anything solid stands between a surface and the light,
// so it needs the occupancy bits and nothing else: no materials, no level stepping, no
// coverage mask. Coverage is the difference that matters. The far field marches *past* a
// cell the near field is drawing, because it has nothing to say about that pixel; a
// shadow ray has to be blocked by it, or every tree the near field draws would stop
// casting a shadow the moment it is meshed.
//
// One level, the finest the clipmap has. Its cells are the smallest the world is sampled
// at outside the near field, and its window still reaches hundreds of voxels, which is
// further than a shadow at this light angle runs.

struct ShadowLevel {
  offset: vec4i, // xyz: render space to this level's grid, in voxels; w: indirection base
  wrap: vec4i, // xyz: the level origin modulo B, for the toroidal index; w unused
  info: vec4f, // x: voxels per cell; y: the level's extent in cells; zw unused
}

struct ShadowParams {
  inv_view_proj: mat4x4f, // unused here; the far field's own params buffer is shared
  eye: vec4f, // camera offset in render space; w unused
  grid: vec4u, // x: bricks per side; yzw unused here
  counts: vec4u,
  camera_chunk: vec4i,
  mask_origin: vec4i,
  level: array<ShadowLevel, 8>, // MAX_LEVELS
}

@group(2) @binding(0) var<uniform> shadow_far: ShadowParams;
@group(2) @binding(1) var<storage, read> shadow_indirection: array<u32>;
@group(2) @binding(2) var<storage, read> shadow_bricks: array<u32>;

const SH_BRICK_CELLS: i32 = 8;
const SH_BRICK_WORDS: u32 = 144u;
const SH_ENTRY_SOLID: u32 = 0x80000000u;
const SH_LEVEL: u32 = 0u; // the finest level the clipmap holds

// How far a shadow ray runs, in voxels. The moon sits low, so a tree throws its shadow
// two or three times its own height; past this the ray is cut and the ground is lit,
// which is cheaper than a long march for a shadow nothing would look for.
const SH_REACH: f32 = 96.0;
// Steps the ray is allowed. An unbounded loop can reset the GPU (gotchas.md).
const SH_BRICK_STEPS: u32 = 40u;
const SH_CELL_STEPS: u32 = 24u;
// How far along the surface normal the ray starts, in cells. The clipmap quantizes the
// surface differently from the mesh the near field drew, so a ray starting on the
// surface itself begins inside the cell that surface is in and shadows everything.
const SH_BIAS_CELLS: f32 = 1.75;

fn sh_entry(b: vec3i) -> u32 {
  let size = i32(shadow_far.grid.x);
  if (any(b < vec3i(0)) || any(b >= vec3i(size))) {
    return 0u;
  }
  let c = (b + shadow_far.level[SH_LEVEL].wrap.xyz) & vec3i(size - 1);
  return shadow_indirection[u32(shadow_far.level[SH_LEVEL].offset.w) +
    u32(c.x + c.y * size + c.z * size * size)];
}

fn sh_solid(brick: u32, cell: vec3i) -> bool {
  let i = u32(cell.x + cell.y * SH_BRICK_CELLS + cell.z * SH_BRICK_CELLS * SH_BRICK_CELLS);
  return (shadow_bricks[brick * SH_BRICK_WORDS + (i >> 5u)] & (1u << (i & 31u))) != 0u;
}

// Walks one occupied brick's cells from `t0`, in cell units. True on the first solid
// cell: a shadow ray stops at anything.
fn sh_march_brick(brick: u32, base: vec3i, p0: vec3f, dir: vec3f, inv: vec3f, t0: f32, t_end: f32) -> bool {
  let step = vec3i(sign(dir));
  var cell = vec3i(floor(p0 + dir * (t0 + 1e-4))) - base * SH_BRICK_CELLS;
  if (any(cell < vec3i(0)) || any(cell >= vec3i(SH_BRICK_CELLS))) {
    return false;
  }
  let next = vec3f(base * SH_BRICK_CELLS + cell + max(step, vec3i(0)));
  var t = (next - p0) * inv;
  let dt = abs(inv);
  var t_cell = t0;
  for (var i = 0u; i < SH_CELL_STEPS; i++) {
    if (t_cell > t_end) {
      return false;
    }
    if (sh_solid(brick, cell)) {
      return true;
    }
    if (t.x <= t.y && t.x <= t.z) {
      t_cell = t.x;
      t.x += dt.x;
      cell.x += step.x;
      if (cell.x < 0 || cell.x >= SH_BRICK_CELLS) { return false; }
    } else if (t.y <= t.z) {
      t_cell = t.y;
      t.y += dt.y;
      cell.y += step.y;
      if (cell.y < 0 || cell.y >= SH_BRICK_CELLS) { return false; }
    } else {
      t_cell = t.z;
      t.z += dt.z;
      cell.z += step.z;
      if (cell.z < 0 || cell.z >= SH_BRICK_CELLS) { return false; }
    }
  }
  return false;
}

// 0 where the light is blocked, 1 where it reaches. `render` is the fragment in render
// space (world minus the camera chunk), `n` its face normal and `dir` the direction to
// the light, normalized.
fn light_shadow(render: vec3f, n: vec3f, dir: vec3f) -> f32 {
  let cell_voxels = shadow_far.level[SH_LEVEL].info.x;
  let extent = shadow_far.level[SH_LEVEL].info.y;
  if (cell_voxels <= 0.0) {
    return 1.0; // no clipmap bound yet (the placeholder group): nothing casts a shadow
  }
  let p0 = (render + n * (SH_BIAS_CELLS * cell_voxels) + vec3f(shadow_far.level[SH_LEVEL].offset.xyz)) /
    cell_voxels;
  if (any(p0 < vec3f(0.0)) || any(p0 >= vec3f(extent))) {
    return 1.0; // outside the clipmap's window: nothing here can say it is shadowed
  }
  let inv = 1.0 / max(abs(dir), vec3f(1e-8)) * sign(dir + vec3f(1e-20));
  let step = vec3i(sign(dir));
  let t_end = SH_REACH / cell_voxels;
  var brick = vec3i(floor(p0 / f32(SH_BRICK_CELLS)));
  let next = vec3f((brick + max(step, vec3i(0))) * SH_BRICK_CELLS);
  var t = (next - p0) * inv;
  let dt = abs(inv) * f32(SH_BRICK_CELLS);
  var t_enter = 0.0;
  for (var i = 0u; i < SH_BRICK_STEPS; i++) {
    if (t_enter > t_end) {
      return 1.0;
    }
    let entry = sh_entry(brick);
    if ((entry & SH_ENTRY_SOLID) != 0u) {
      return 0.0; // solid throughout: no cell walk needed
    }
    if (entry != 0u && sh_march_brick(entry - 1u, brick, p0, dir, inv, t_enter, t_end)) {
      return 0.0;
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
    if (any(brick < vec3i(0)) || any(brick >= vec3i(i32(shadow_far.grid.x)))) {
      return 1.0; // left the window
    }
  }
  return 1.0;
}
