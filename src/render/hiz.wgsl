// Hi-Z depth pyramid (plan-rendering phase 4). Level 0 reduces the depth buffer 2x2
// to half resolution; each later level reduces the one before it. Every texel holds
// the minimum of its footprint, which with reversed-Z is the farthest of the
// nearest surfaces there: nothing at a smaller depth can be seen through that
// region, which is what the cull pass tests against. Standalone.
//
// Odd sizes: halving rounds down, so a 2x2 footprint would leave the source's last
// row or column out of every destination texel and lose its depth for good. Along
// an axis whose source size is odd, each texel reduces 3 samples instead of 2, so
// the edge is always included. (Without this, distant geometry at the bottom of the
// screen was culled as hidden: the levels claimed a coverage they did not have.)

@group(0) @binding(0) var depth_src: texture_depth_2d;
@group(0) @binding(1) var depth_dst: texture_storage_2d<r32float, write>;

// Separate slots from the pair above: one module, two entry points, and a pipeline
// only binds what its entry point uses.
@group(0) @binding(2) var level_src: texture_2d<f32>;
@group(0) @binding(3) var level_dst: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn reduce_depth(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depth_dst);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let src_size = vec2i(textureDimensions(depth_src));
  let base = vec2i(id.xy) * 2;
  // One extra sample along an axis the halving rounded down.
  let extra = src_size - vec2i(size) * 2;
  var m = 1.0;
  for (var dy = 0; dy <= 1 + extra.y; dy++) {
    for (var dx = 0; dx <= 1 + extra.x; dx++) {
      let p = min(base + vec2i(dx, dy), src_size - vec2i(1));
      m = min(m, textureLoad(depth_src, p, 0));
    }
  }
  textureStore(depth_dst, id.xy, vec4f(m, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn reduce_level(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(level_dst);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let src_size = vec2i(textureDimensions(level_src));
  let base = vec2i(id.xy) * 2;
  // One extra sample along an axis the halving rounded down.
  let extra = src_size - vec2i(size) * 2;
  var m = 1.0;
  for (var dy = 0; dy <= 1 + extra.y; dy++) {
    for (var dx = 0; dx <= 1 + extra.x; dx++) {
      let p = min(base + vec2i(dx, dy), src_size - vec2i(1));
      m = min(m, textureLoad(level_src, p, 0).r);
    }
  }
  textureStore(level_dst, id.xy, vec4f(m, 0.0, 0.0, 0.0));
}
