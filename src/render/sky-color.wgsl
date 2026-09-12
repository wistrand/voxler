// Sky color by view direction, shared by the sky pass, the SDF preview (which uses it
// for misses and fog) and the far field. The constants come from the world's sky preset
// (src/render/sky.ts), generated in ahead of this file.

// A stable value in [0, 1) per direction cell, for stars. Not the SDF library's hash:
// this file is compiled into the sky pass, which has no world program in it.
fn sky_hash(c: vec3f) -> f32 {
  return fract(sin(dot(c, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

// Points of light in the upper sky. One per cell of a coarse direction grid, at a
// random offset inside it, so they do not sit on a lattice; the cell's own draw decides
// whether it has a star at all, which is what leaves empty sky between them.
fn star_light(dir: vec3f) -> f32 {
  if (STARS <= 0.0 || dir.y <= 0.0) {
    return 0.0;
  }
  // The grid is fine enough that a star is a point rather than a patch, and the star
  // sits well inside its cell so the cell's own edges never clip it into a wedge.
  let grid = dir * 190.0;
  let cell = floor(grid);
  let pick = sky_hash(cell);
  if (pick > 0.045) {
    return 0.0;
  }
  let at = cell + 0.3 + 0.4 * vec3f(sky_hash(cell + 11.0), sky_hash(cell + 23.0), sky_hash(cell + 37.0));
  let d = length(grid - at);
  // Brightness varies per star, and they fade out towards the horizon where the fog is.
  let bright = 0.35 + 0.65 * sky_hash(cell + 53.0);
  return STARS * bright * smoothstep(0.30, 0.0, d) * smoothstep(0.0, 0.35, dir.y);
}

fn sky_color(dir: vec3f) -> vec3f {
  let sky = mix(SKY_HORIZON, SKY_ZENITH, sqrt(max(dir.y, 0.0)));
  let ground = mix(SKY_HORIZON * 0.55, SKY_GROUND, sqrt(max(-dir.y, 0.0)));
  var color = select(ground, sky, dir.y >= 0.0);
  color += vec3f(star_light(dir));
  // The light's own disc and the glow around it, scaled by DISC: 0 draws neither, which
  // is what a daytime sky wants. Scaled rather than branched, because a preset that
  // draws no disc still has to produce a shader that compiles.
  if (DISC > 0.0) {
    let c = dot(normalize(dir), normalize(LIGHT_DIR));
    color += DISC_COLOR * (DISC * 0.18) * smoothstep(HALO_COS, 1.0, c);
    color += DISC_COLOR * DISC * smoothstep(DISC_COS, mix(DISC_COS, 1.0, 0.35), c);
  }
  return color;
}
