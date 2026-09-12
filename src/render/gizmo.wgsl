// Axis gizmo: world X (red), Y (green), Z (blue) rotated by the view, drawn as
// lines in a small corner viewport. Requires camera.wgsl.

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  var colors = array<vec3f, 3>(
    vec3f(0.95, 0.25, 0.25),
    vec3f(0.35, 0.90, 0.35),
    vec3f(0.30, 0.45, 1.00),
  );
  let axis = index / 2u;
  let unit = vec3f(f32(axis == 0u), f32(axis == 1u), f32(axis == 2u));
  let dir = select(vec3f(0.0), unit, (index & 1u) == 1u); // even vertex: origin
  let v = (camera.view * vec4f(dir, 0.0)).xyz;
  var out: VsOut;
  out.position = vec4f(v.xy * 0.8, 0.5, 1.0);
  out.color = colors[axis];
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
