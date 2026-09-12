// Draw builtins self-test (plan-rendering phase 1). Each draw covers one pixel of an
// r32uint target (the viewport selects it) and writes the vertex_index and
// instance_index it saw, so the CPU can check that both include the draw's
// firstVertex and firstInstance, and which winding counts as front-facing.
// Standalone: needs no other source.

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) ids: vec2u,
}

// A triangle covering the whole viewport; `ccw` picks its winding in NDC (y up).
fn cover(vertex: u32, instance: u32, ccw: bool) -> VsOut {
  var corner = vertex % 3u;
  if (!ccw && corner != 0u) {
    corner = 3u - corner; // swap the last two corners
  }
  let p = vec2f(f32((corner << 1u) & 2u), f32(corner & 2u)) * 2.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(p, 0.5, 1.0); // (-1,-1) (3,-1) (-1,3): counter-clockwise
  out.ids = vec2u(vertex, instance);
  return out;
}

@vertex
fn vs_ccw(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VsOut {
  return cover(vertex, instance, true);
}

@vertex
fn vs_cw(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VsOut {
  return cover(vertex, instance, false);
}

@fragment
fn fs(in: VsOut) -> @location(0) u32 {
  return (in.ids.x << 16u) | (in.ids.y & 0xffffu);
}
