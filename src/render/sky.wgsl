// Sky background: one full-screen triangle, colored by view direction.
// Requires camera.wgsl and sky-color.wgsl.

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  // Vertices 0, 1, 2 map to (0, 0), (2, 0), (0, 2): a triangle covering the screen.
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: VsOut;
  out.ndc = p * 2.0 - 1.0;
  out.position = vec4f(out.ndc, 0.0, 1.0);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  // With reversed-Z infinite projection, depth 0 is at infinity: the unprojected
  // point has w = 0, so xyz is the view direction.
  let dir = normalize((camera.inv_view_proj * vec4f(in.ndc, 0.0, 1.0)).xyz);
  return vec4f(sky_color(dir), 1.0);
}
