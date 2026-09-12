// Debug grid on the world plane y = 0: one quad per chunk around the camera chunk,
// voxel lines, brighter chunk lines, the world X axis in red and Z axis in blue.
// Positions use the same integer-then-f32 path real geometry will use, so any
// precision loss far from the origin shows up here as jitter. Requires camera.wgsl.

override grid_radius: i32 = 8; // chunks each side of the camera chunk; set from TS

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,                     // x, z inside the chunk, 0..32
  @location(1) @interpolate(flat) chunk: vec2i,  // chunk x, z
  @location(2) rel: vec3f,                       // position minus the eye
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );
  let side = 2 * grid_radius + 1;
  let cell = vec2i(i32(ii) % side, i32(ii) / side) - vec2i(grid_radius);
  let local = corners[vi] * 32.0;
  // Integer until the last step: chunk distance from the camera chunk, in voxels.
  let base = vec3i(cell.x, -camera.chunk.y, cell.y) * 32;
  let pos = vec3f(base) + vec3f(local.x, 0.0, local.y);
  var out: VsOut;
  out.position = camera.view_proj * vec4f(pos, 1.0);
  out.local = local;
  out.chunk = camera.chunk.xz + cell;
  out.rel = pos - camera.offset.xyz;
  return out;
}

// Per axis: 1 on a line at integer p, falling to 0 about one pixel away.
fn line_mask(p: vec2f) -> vec2f {
  let w = max(fwidth(p), vec2f(1e-6));
  let d = abs(fract(p - 0.5) - 0.5) / w;
  return 1.0 - min(d, vec2f(1.0));
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let voxel = line_mask(in.local);
  let chunk = line_mask(in.local / 32.0);
  // Voxel lines fade out before they get dense enough to alias.
  let density = max(fwidth(in.local.x), fwidth(in.local.y));
  let voxel_alpha = max(voxel.x, voxel.y) * 0.25 * (1.0 - smoothstep(0.2, 0.5, density));
  let chunk_alpha = max(chunk.x, chunk.y) * 0.6;

  // World x == 0 is the line at local x == 0 of chunk 0 (or local x == 32 of chunk -1).
  let on_x0 = (in.chunk.x == 0 && in.local.x < 16.0) || (in.chunk.x == -1 && in.local.x >= 16.0);
  let on_z0 = (in.chunk.y == 0 && in.local.y < 16.0) || (in.chunk.y == -1 && in.local.y >= 16.0);
  let z_axis = select(0.0, chunk.x, on_x0); // the line x == 0 runs along Z
  let x_axis = select(0.0, chunk.y, on_z0); // the line z == 0 runs along X

  var color = vec3f(0.92);
  color = mix(color, vec3f(0.95, 0.25, 0.25), x_axis);
  color = mix(color, vec3f(0.30, 0.45, 1.00), z_axis);
  let alpha = max(max(voxel_alpha, chunk_alpha), max(x_axis, z_axis));

  let fade_end = f32(grid_radius) * 32.0;
  let fade = 1.0 - smoothstep(0.6 * fade_end, fade_end, length(in.rel));
  return vec4f(color, alpha * fade);
}
