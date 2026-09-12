// Direct lighting, sky ambient, and fog, shared by every surface in the scene so
// the SDF preview, the near field, and (later) the far field agree. Requires
// sky-color.wgsl. Pure functions; no bindings.

const SUN_DIR = vec3f(0.42, 0.82, 0.38); // not normalized; normalized at use
const SUN_COLOR = vec3f(1.00, 0.96, 0.88);
const AMBIENT = 0.30; // sky light reaching a surface facing the horizon
const AMBIENT_SKY = 0.15; // extra for an up-facing one, less for down-facing
const FOG_DENSITY: f32 = 0.00035;

// Light on a surface with normal `n`, as a multiplier on its albedo.
fn surface_light(n: vec3f) -> vec3f {
  let diffuse = max(dot(n, normalize(SUN_DIR)), 0.0);
  return vec3f(AMBIENT + AMBIENT_SKY * n.y) + SUN_COLOR * (0.8 * diffuse);
}

// Blends a shaded color into the sky over distance `dist` along `dir`.
fn apply_fog(color: vec3f, dir: vec3f, dist: f32) -> vec3f {
  return mix(color, sky_color(dir), 1.0 - exp(-dist * FOG_DENSITY));
}
