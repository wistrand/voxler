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
  eye: vec4f, // camera offset in render space; w: the fog horizon, unused here
  grid: vec4u, // x: bricks per side; yzw unused here
  counts: vec4u, // z: 1 to use the axes word
  camera_chunk: vec4i,
  mask_origin: vec4i,
  level: array<ShadowLevel, 8>, // MAX_LEVELS
}

@group(2) @binding(0) var<uniform> shadow_far: ShadowParams;
@group(2) @binding(1) var<storage, read> shadow_indirection: array<u32>;
@group(2) @binding(2) var<storage, read> shadow_bricks: array<u32>;

const SH_BRICK_CELLS: i32 = 8;
const SH_BRICK_WORDS: u32 = 145u;
const SH_ENTRY_SOLID: u32 = 0x80000000u;
// The axes word (src/far/reduce.ts `BRICK_AXES_WORD`): see `sh_brick_can_hit`.
const SH_AXES_WORD: u32 = 144u;
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

// The same indirection read at any level, for the point test below. `sh_entry` is the
// fixed-level version the ray uses and is left alone: a shadow ray only ever wants the
// finest level, and paying for an index it already knows would be a waste on every step
// of every ray.
fn sh_entry_level(level: u32, b: vec3i) -> u32 {
  let size = i32(shadow_far.grid.x);
  if (any(b < vec3i(0)) || any(b >= vec3i(size))) {
    return 0u;
  }
  let c = (b + shadow_far.level[level].wrap.xyz) & vec3i(size - 1);
  return shadow_indirection[u32(shadow_far.level[level].offset.w) +
    u32(c.x + c.y * size + c.z * size * size)];
}

// Whether anything solid stands at `render` (render space, world minus the camera chunk),
// asked of the finest clipmap level whose window still reaches that far. False where no
// level reaches, which is not the same as "there is nothing there": a caller that needs
// to know the difference should check `sh_ground_reaches()`.
//
// A point test rather than a ray. What the bird flock wants is "is there ground just
// under me", and a march for that is more than the question is worth.
fn sh_solid_at(render: vec3f) -> bool {
  for (var level = 0u; level < shadow_far.counts.x; level++) {
    let cell_voxels = shadow_far.level[level].info.x;
    if (cell_voxels <= 0.0) {
      continue;
    }
    let p = (render + vec3f(shadow_far.level[level].offset.xyz)) / cell_voxels;
    if (any(p < vec3f(0.0)) || any(p >= vec3f(shadow_far.level[level].info.y))) {
      continue; // outside this level's window; the next one out is wider
    }
    let cell = vec3i(floor(p));
    let brick = cell >> vec3u(3u); // SH_BRICK_CELLS is 8
    let entry = sh_entry_level(level, brick);
    if ((entry & SH_ENTRY_SOLID) != 0u) {
      return true;
    }
    if (entry == 0u) {
      return false;
    }
    return sh_solid(entry - 1u, cell - brick * SH_BRICK_CELLS);
  }
  return false;
}

// True when a clipmap is bound at all. `?far=0` builds none, and then nothing can be
// asked about the ground.
fn sh_ground_reaches() -> bool {
  return shadow_far.counts.x > 0u && shadow_far.level[0].info.x > 0.0;
}

// The same test as `brick_can_hit` in far.wgsl: whether the ray's run of rows through
// the brick, on every axis, meets a row that holds anything. A shadow ray toward a low
// light crosses the same half-empty surface bricks the march does.
fn sh_brick_can_hit(axes: u32, base: vec3i, p0: vec3f, dir: vec3f, t0: f32, t1: f32) -> bool {
  let a = p0 + dir * (t0 + 1e-4) - vec3f(base * SH_BRICK_CELLS);
  let b = p0 + dir * (t1 + 1e-4) - vec3f(base * SH_BRICK_CELLS);
  let lo = clamp(vec3i(floor(min(a, b))), vec3i(0), vec3i(SH_BRICK_CELLS - 1));
  let hi = clamp(vec3i(floor(max(a, b))), vec3i(0), vec3i(SH_BRICK_CELLS - 1));
  let run = ((vec3u(1u) << vec3u(hi - lo + 1)) - vec3u(1u)) << vec3u(lo);
  let rows = vec3u(axes & 0xffu, (axes >> 8u) & 0xffu, (axes >> 16u) & 0xffu);
  return all((run & rows) != vec3u(0u));
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
    if (entry != 0u) {
      let t_exit = min(t.x, min(t.y, t.z));
      if (
        (shadow_far.counts.z == 0u ||
          sh_brick_can_hit(shadow_bricks[(entry - 1u) * SH_BRICK_WORDS + SH_AXES_WORD], brick, p0, dir, t_enter, min(t_exit, t_end))) &&
        sh_march_brick(entry - 1u, brick, p0, dir, inv, t_enter, t_end)
      ) {
        return 0.0;
      }
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
