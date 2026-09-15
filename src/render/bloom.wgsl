// Bloom over the glowing blocks (`?bloom=1`). Three fragment entry points over one
// full-screen triangle, driven by src/render/bloom.ts.
//
// The source is not the frame: it is the emission the near field wrote to a second
// colour attachment (`fs_bloom` in near.wgsl), already fogged, so a cap far out blooms as
// faintly as it is drawn and nothing that merely happens to be bright, moonlit snow, ever
// blooms at all. There is no HDR here to threshold; the emission channel is the
// threshold.
//
// The blur is the dual filter: each downsample averages a 13-tap pattern into a target
// half the size, each upsample spreads a 9-tap tent into a target twice the size and
// adds it to what is there. The radius is a property of how many levels there are, so it
// scales with the frame rather than being a pixel count that reads differently at every
// resolution.
//
// The composite is a screen blend, set as blend factors on the pipeline
// (src + dst - src*dst), never a plain add: nothing tonemaps in this engine, and an add
// around a cluster of caps would clip to white where screen cannot.

struct BloomParams {
  strength: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

@group(0) @binding(0) var bloom_sampler: sampler;
@group(0) @binding(1) var bloom_in: texture_2d<f32>;
@group(0) @binding(2) var<uniform> bloom: BloomParams;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

// One triangle over the whole target, no vertex buffer.
@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let x = f32(i32(i & 1u) * 4 - 1);
  let y = f32(i32(i >> 1u) * 4 - 1);
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

fn texel_size() -> vec2f {
  return 1.0 / vec2f(textureDimensions(bloom_in));
}

fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(bloom_in, bloom_sampler, uv, 0.0).rgb;
}

// Downsample by two: the 13-tap pattern, a centre box of four weighted a half and eight
// outer taps weighted a quarter each over their own boxes. Sampling with the bilinear
// filter turns every tap into a 2x2 average, which is what makes 13 taps cover 36 texels.
@fragment
fn fs_down(in: VsOut) -> @location(0) vec4f {
  let t = texel_size();
  let uv = in.uv;
  let a = tap(uv + t * vec2f(-2.0, -2.0));
  let b = tap(uv + t * vec2f(0.0, -2.0));
  let c = tap(uv + t * vec2f(2.0, -2.0));
  let d = tap(uv + t * vec2f(-2.0, 0.0));
  let e = tap(uv);
  let f = tap(uv + t * vec2f(2.0, 0.0));
  let g = tap(uv + t * vec2f(-2.0, 2.0));
  let h = tap(uv + t * vec2f(0.0, 2.0));
  let i = tap(uv + t * vec2f(2.0, 2.0));
  let j = tap(uv + t * vec2f(-1.0, -1.0));
  let k = tap(uv + t * vec2f(1.0, -1.0));
  let l = tap(uv + t * vec2f(-1.0, 1.0));
  let m = tap(uv + t * vec2f(1.0, 1.0));
  var sum = (j + k + l + m) * 0.5;
  sum += (a + b + d + e) * 0.125;
  sum += (b + c + e + f) * 0.125;
  sum += (d + e + g + h) * 0.125;
  sum += (e + f + h + i) * 0.125;
  return vec4f(sum * 0.25, 1.0);
}

// Upsample by two: a 3x3 tent. The pipeline adds the result to the target, so each
// level's blur lands on top of the one above it on the way back up.
@fragment
fn fs_up(in: VsOut) -> @location(0) vec4f {
  let t = texel_size();
  let uv = in.uv;
  var sum = tap(uv + t * vec2f(-1.0, -1.0));
  sum += tap(uv + t * vec2f(0.0, -1.0)) * 2.0;
  sum += tap(uv + t * vec2f(1.0, -1.0));
  sum += tap(uv + t * vec2f(-1.0, 0.0)) * 2.0;
  sum += tap(uv) * 4.0;
  sum += tap(uv + t * vec2f(1.0, 0.0)) * 2.0;
  sum += tap(uv + t * vec2f(-1.0, 1.0));
  sum += tap(uv + t * vec2f(0.0, 1.0)) * 2.0;
  sum += tap(uv + t * vec2f(1.0, 1.0));
  return vec4f(sum / 16.0, 1.0);
}

// The blurred glow, scaled, for the screen blend the pipeline applies over the frame.
@fragment
fn fs_composite(in: VsOut) -> @location(0) vec4f {
  return vec4f(clamp(tap(in.uv) * bloom.strength, vec3f(0.0), vec3f(1.0)), 1.0);
}
