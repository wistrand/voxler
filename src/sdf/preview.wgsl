// Sphere-traced preview of the world SDF: one full-screen triangle rendered into
// offscreen color and depth targets at a reduced resolution (SdfPreview), then
// upscaled into the main pass by preview-blit.wgsl. Requires camera.wgsl,
// sky-color.wgsl, shading.wgsl, the generated block constants, sdf/lib.wgsl,
// brush/brush.wgsl, and a world program.
//
// Field brushes come from a camera-centred grid (src/brush/grid.ts) rather than a
// per-chunk run: a ray crosses many chunks, so it looks its cell up as it goes.
// Brushes outside the grid are not in the field the preview traces; the field stays
// consistent, so the trace shows no artifacts, it just does not show them.

struct World {
  seed: u32,
  // Chunk coordinate of the brush grid's min corner. Three scalars and not a vec3i:
  // a vec3 aligns to 16 bytes, which would push `colors` past the header the CPU
  // writes (design-formats.md "World uniform").
  grid_x: i32,
  grid_y: i32,
  grid_z: i32,
  colors: array<vec4f, 512>, // MAX_BLOCK_TYPES x 2: color and coverage, emission and sway
}

@group(1) @binding(0) var<uniform> world: World;
@group(1) @binding(1) var<storage, read> brush_records: array<u32>;
@group(1) @binding(2) var<storage, read> brush_ops: array<u32>;
// Per grid cell: first record, record count, Lipschitz bound (8.8 fixed), unused.
@group(1) @binding(3) var<storage, read> brush_cells: array<vec4u>;

const GRID_X: i32 = 32;
const GRID_Y: i32 = 16;
const GRID_Z: i32 = 32;

// The brush run covering a point, or an empty one outside the grid.
fn brush_cell(p: WorldPoint) -> vec4u {
  let c = (p.cell >> vec3u(5u)) - vec3i(world.grid_x, world.grid_y, world.grid_z);
  if (any(c < vec3i(0)) || c.x >= GRID_X || c.y >= GRID_Y || c.z >= GRID_Z) {
    return vec4u(0u);
  }
  return brush_cells[u32(c.x + c.z * GRID_X + c.y * GRID_X * GRID_Z)];
}

// The world program folded with the brushes covering the point: (distance, block id),
// id 0 meaning the world program's own material still decides.
fn world_field(p: WorldPoint) -> vec2f {
  let cell = brush_cell(p);
  return brush_fold(p, cell.x, cell.y, vec2f(world_sdf(p), 0.0));
}

// Step length bound at a point: a brush with a steeper field than the world's must
// not be stepped over.
fn field_lipschitz(p: WorldPoint) -> f32 {
  return max(WORLD_LIPSCHITZ, f32(brush_cell(p).z) * (1.0 / 256.0));
}

const MAX_STEPS: u32 = 256u;
const MAX_DIST: f32 = 16384.0;
const MIN_STEP: f32 = 0.01;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
}

struct FsOut {
  @location(0) color: vec4f,
  @location(1) depth: f32, // reversed-Z depth, written into the main pass by the blit
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: VsOut;
  out.ndc = p * 2.0 - 1.0;
  out.position = vec4f(out.ndc, 0.0, 1.0);
  return out;
}

// Render-space position to a world point: integer camera chunk origin plus a small
// f32 offset, so marching stays exact far from the world origin.
fn world_at(r: vec3f) -> WorldPoint {
  return wp_make(camera.chunk.xyz * 32, r);
}

fn view_dir(ndc: vec2f) -> vec3f {
  // With reversed-Z infinite projection, depth 0 unprojects to a direction (w = 0).
  return normalize((camera.inv_view_proj * vec4f(ndc, 0.0, 1.0)).xyz);
}

fn sdf_normal(p: WorldPoint, e: f32) -> vec3f {
  // Tetrahedron sampling: 4 evaluations.
  let k = vec2f(1.0, -1.0);
  return normalize(
    k.xyy * world_field(wp_offset(p, k.xyy * e)).x +
      k.yyx * world_field(wp_offset(p, k.yyx * e)).x +
      k.yxy * world_field(wp_offset(p, k.yxy * e)).x +
      k.xxx * world_field(wp_offset(p, k.xxx * e)).x,
  );
}

@fragment
fn fs(in: VsOut) -> FsOut {
  world_seed = world.seed;
  let dir = view_dir(in.ndc);
  // Angle one preview pixel spans, from the ndc step between neighboring pixels.
  let pixel_angle = length(view_dir(in.ndc + vec2f(0.0, fwidth(in.ndc).y)) - dir);
  let origin = camera.offset.xyz;

  // A camera inside solid first marches out of it (stepping on -d), then traces
  // normally: flying through terrain shows what lies beyond, not a wall at t = 0.
  var t = 0.0;
  var hit = false;
  sample_footprint = 0.0;
  var inside = world_field(world_at(origin)).x < 0.0;
  for (var i = 0u; i < MAX_STEPS; i++) {
    sample_footprint = t * pixel_angle;
    let at = world_at(origin + dir * t);
    let d = world_field(at).x;
    let lipschitz = field_lipschitz(at);
    if (inside) {
      if (d >= 0.0) {
        inside = false;
      } else {
        t += max(-d / lipschitz, MIN_STEP);
        continue;
      }
    }
    if (d < 0.5 * sample_footprint + 0.001) {
      hit = true;
      break;
    }
    t += max(d / lipschitz, MIN_STEP);
    if (t > MAX_DIST) {
      break;
    }
  }

  var out: FsOut;
  if (!hit) {
    out.color = vec4f(sky_color(dir), 1.0);
    out.depth = 0.0; // reversed-Z: infinitely far
    return out;
  }

  let r = origin + dir * t;
  let p = world_at(r);
  let n = sdf_normal(p, max(0.01, 0.5 * sample_footprint));
  let s = world_field(p);
  // Half a voxel inside the surface, along the normal. The trace stops just outside it,
  // and a material function that asks which side of something a point is on answers for
  // the air: terrain's sea rule ("solid above the ground is water") painted every hill
  // blue.
  let solid = wp_offset(p, n * -0.5);
  let id = select(world_material(solid), u32(s.y), s.y != 0.0);
  let known = min(id, 255u);
  let albedo = world.colors[known * 2u].rgb;
  let glow = world.colors[known * 2u + 1u].rgb;
  out.color = vec4f(apply_fog(albedo * surface_light(n) + glow * albedo, dir, t), 1.0);
  let clip = camera.view_proj * vec4f(r, 1.0);
  out.depth = clamp(clip.z / clip.w, 0.0, 1.0);
  return out;
}
