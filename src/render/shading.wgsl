// Direct lighting, sky ambient, and fog, shared by every surface in the scene so
// the SDF preview, the near field, and (later) the far field agree. Requires
// sky-color.wgsl. Pure functions; no bindings.

// LIGHT_DIR, LIGHT_COLOR, AMBIENT, AMBIENT_SKY, FOG_DENSITY and BLOCK_LIGHT_STRENGTH
// come from the world's sky preset (src/render/sky.ts), generated in ahead of this file.

// Block light: what a glowing block adds to the surfaces around it. The baked level is
// one number, not a colour, so every light in the world shares this one hue; a forest of
// glowing fungus is what it is tuned for (plan-living-world phase 4). How much of it a
// surface at level 15 gets is the sky preset's BLOCK_LIGHT_STRENGTH: more at night,
// where a glowing plant is most of what lights anything.
const BLOCK_LIGHT_COLOR = vec3f(0.62, 1.00, 0.86);

// Light on a surface with normal `n`, as a multiplier on its albedo. `sun` is how much
// of the direct light reaches it, 0 in shadow to 1 in the open; the ambient term is not
// shadowed, because the sky reaches a surface whatever is between it and the moon.
fn surface_light_shadowed(n: vec3f, sun: f32) -> vec3f {
  let diffuse = max(dot(n, normalize(LIGHT_DIR)), 0.0);
  return vec3f(AMBIENT + AMBIENT_SKY * n.y) + LIGHT_COLOR * (0.8 * diffuse * sun);
}

fn surface_light(n: vec3f) -> vec3f {
  return surface_light_shadowed(n, 1.0);
}

// Light a surface gets from nearby glowing blocks, as a multiplier on its albedo.
// `level` is the baked block-light level, 0 to 15. Squared, so the fall-off reads as a
// pool around the light rather than a flat wash out to its whole reach.
fn block_light(level: f32) -> vec3f {
  let t = clamp(level * (1.0 / 15.0), 0.0, 1.0);
  return BLOCK_LIGHT_COLOR * (BLOCK_LIGHT_STRENGTH * t * t);
}

// Blends a shaded color into the sky over distance `dist` along `dir`.
fn apply_fog(color: vec3f, dir: vec3f, dist: f32) -> vec3f {
  return mix(color, sky_color(dir), 1.0 - exp(-dist * FOG_DENSITY));
}
