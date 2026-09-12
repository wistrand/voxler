// Upscales the offscreen preview into the main pass: bilinear color, nearest depth
// (depth written as frag_depth so later passes, the grid, test against it).
// Standalone: needs no other source.

@group(1) @binding(0) var preview_color: texture_2d<f32>;
@group(1) @binding(1) var preview_depth: texture_2d<f32>; // r32float, not filterable
@group(1) @binding(2) var preview_sampler: sampler;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

struct FsOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: VsOut;
  out.position = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y); // texture v grows downward
  return out;
}

@fragment
fn fs(in: VsOut) -> FsOut {
  var out: FsOut;
  out.color = textureSampleLevel(preview_color, preview_sampler, in.uv, 0.0);
  let size = vec2i(textureDimensions(preview_depth));
  let texel = clamp(vec2i(in.uv * vec2f(size)), vec2i(0), size - 1);
  out.depth = textureLoad(preview_depth, texel, 0).r;
  return out;
}
