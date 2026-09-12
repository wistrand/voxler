// Draws the far-field march's color over the frame, behind the near field. The
// pipeline's depth state keeps it to pixels the near pass left cleared; this discards
// the ones the march missed, so the sky drawn after it still shows through.
// Standalone: needs no other source.
//
// The march runs at a fraction of the frame's resolution (plan-far-field phase 5), so
// this is also the upsample. It is a bilinear filter that ignores texels the march
// skipped: a texel whose whole footprint the near field covered holds nothing, and
// letting it into the blend bleeds holes along the near field's silhouette, which is
// the worst place for them. Weighting by alpha drops them instead.

@group(0) @binding(0) var far_color: texture_2d<f32>;
@group(0) @binding(1) var far_sampler: sampler;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  // One oversized triangle covering the viewport.
  let ndc = vec2f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0);
  var out: VsOut;
  out.position = vec4f(ndc, 0.0, 1.0);
  out.uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(far_color));
  let p = in.uv * size - 0.5;
  let base = floor(p);
  let f = p - base;
  let lo = vec2i(base);
  var color = vec3f(0.0);
  var weight = 0.0;
  for (var i = 0; i < 4; i++) {
    let at = clamp(lo + vec2i(i & 1, i >> 1), vec2i(0), vec2i(size) - vec2i(1));
    let texel = textureLoad(far_color, at, 0);
    let wx = select(1.0 - f.x, f.x, (i & 1) == 1);
    let wy = select(1.0 - f.y, f.y, (i >> 1) == 1);
    let w = wx * wy * texel.a;
    color += texel.rgb * w;
    weight += w;
  }
  if (weight <= 0.0) {
    discard; // every texel here was a miss or was never marched
  }
  return vec4f(color / weight, 1.0);
}
