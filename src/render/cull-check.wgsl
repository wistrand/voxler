// Cull correctness check (plan-rendering phase 3): compares the near field drawn
// with culling (a) and without (b), pixel by pixel. A depth difference, or a pixel
// covered in b but not in a, is a cull bug. A color difference at equal depth is
// not: where two faces meet at an edge both can reach a pixel at the same depth,
// and the one drawn first wins; the culled and unculled draws list clusters in
// different orders (atomic append). Those are counted apart. Standalone.

@group(0) @binding(0) var color_a: texture_2d<f32>;
@group(0) @binding(1) var color_b: texture_2d<f32>;
@group(0) @binding(2) var depth_a: texture_depth_2d;
@group(0) @binding(3) var depth_b: texture_depth_2d;
// depth differs, covered in b but not in a (culled away), color differs at equal depth
@group(0) @binding(4) var<storage, read_write> diff: array<atomic<u32>, 3>;

@compute @workgroup_size(8, 8)
fn compare(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depth_a);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let p = vec2i(id.xy);
  let da = textureLoad(depth_a, p, 0);
  let db = textureLoad(depth_b, p, 0);
  if (da != db) {
    atomicAdd(&diff[0], 1u);
  } else if (any(textureLoad(color_a, p, 0) != textureLoad(color_b, p, 0))) {
    atomicAdd(&diff[2], 1u);
  }
  if (db > 0.0 && da == 0.0) {
    atomicAdd(&diff[1], 1u);
  }
}
