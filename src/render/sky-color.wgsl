// Sky color by view direction, shared by the sky pass and the SDF preview (which
// uses it for misses and fog).

const SKY_HORIZON = vec3f(0.72, 0.80, 0.90);
const SKY_ZENITH = vec3f(0.20, 0.38, 0.70);
const SKY_GROUND = vec3f(0.18, 0.17, 0.16);

fn sky_color(dir: vec3f) -> vec3f {
  let sky = mix(SKY_HORIZON, SKY_ZENITH, sqrt(max(dir.y, 0.0)));
  let ground = mix(SKY_HORIZON * 0.55, SKY_GROUND, sqrt(max(-dir.y, 0.0)));
  return select(ground, sky, dir.y >= 0.0);
}
