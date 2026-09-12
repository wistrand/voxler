// World: primitives and operators around the origin on a grass floor, with
// repeated pillars across the rest of the plane. Contract:
// agent_docs/design-formats.md "World program".

// smin, the ellipsoid bound, and the Bezier tube are not exact distances.
const WORLD_LIPSCHITZ: f32 = 1.25;

// Pillars stand at the centers of 128-voxel cells, (64 + 128 i, 64 + 128 j), so the
// nearest ones are at (+-64, +-64), clear of the showcase objects.
const PILLAR_PERIOD = vec3i(128, 1 << 20, 128);

fn pillars(p: WorldPoint) -> f32 {
  let id = wp_repeat_id(p, PILLAR_PERIOD);
  var q = wp_repeat(p, PILLAR_PERIOD);
  q.y = f32(p.cell.y) + p.frac.y - 20.0;
  let height = 12.0 + f32(hash3(id, world_seed).x % 16u);
  return sd_cylinder(q, height, 3.0);
}

// (distance, block id)
fn scene(p: WorldPoint) -> vec2f {
  let q = wp_local(p, vec3i(0, 0, 0));
  var s = vec2f(q.y, f32(BLOCK_GRASS)); // floor
  s = pick(s, vec2f(sd_sphere(q - vec3f(0.0, 12.0, 0.0), 10.0), f32(BLOCK_STONE)));

  // Rounded box with a sphere carved out of it.
  let bq = q - vec3f(32.0, 9.0, 0.0);
  s = pick(s, vec2f(op_subtract(sd_round_box(bq, vec3f(9.0), 2.0), sd_sphere(bq - vec3f(0.0, 5.0, -6.0), 7.0)), f32(BLOCK_BRICK)));

  // Standing torus.
  s = pick(s, vec2f(sd_torus((q - vec3f(-32.0, 14.0, 0.0)).xzy, vec2f(11.0, 3.0)), f32(BLOCK_METAL)));

  // Three spheres blended with smin.
  let blob = op_smin(
    op_smin(sd_sphere(q - vec3f(-6.0, 6.0, 36.0), 6.0), sd_sphere(q - vec3f(6.0, 8.0, 36.0), 7.0), 4.0),
    sd_ellipsoid(q - vec3f(0.0, 14.0, 40.0), vec3f(4.0, 8.0, 4.0)),
    4.0,
  );
  s = pick(s, vec2f(blob, f32(BLOCK_SAND)));

  // Arch along a Bezier curve.
  let arch = sd_bezier_tube(q, vec3f(-22.0, -2.0, -36.0), vec3f(0.0, 46.0, -36.0), vec3f(22.0, -2.0, -36.0), 4.0, 2.5);
  s = pick(s, vec2f(arch, f32(BLOCK_WOOD)));

  s = pick(s, vec2f(pillars(p), f32(BLOCK_STONE)));
  return s;
}

fn world_sdf(p: WorldPoint) -> f32 {
  return scene(p).x;
}

fn world_material(p: WorldPoint) -> u32 {
  let s = scene(p);
  let y = f32(p.cell.y) + p.frac.y;
  if (u32(s.y) == BLOCK_GRASS && y < -1.0) {
    return select(BLOCK_STONE, BLOCK_DIRT, y > -5.0);
  }
  return u32(s.y);
}
