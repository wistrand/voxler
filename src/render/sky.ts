// Sky and lighting presets, one per world. Generated into WGSL and prepended to every
// shader that lights or fogs a surface (sky-color.wgsl and shading.wgsl read these
// names), so the near field, the SDF preview, the far field and the sky pass cannot
// disagree about what time of day it is.
//
// This is the one lighting model with different numbers in it, not a second model: a
// world picks a preset and every surface path reads the same constants
// (CLAUDE.md "Conventions").

export interface Sky {
  readonly name: string;
  // Direction to the light (sun or moon), not normalized; the disc is drawn here too.
  readonly lightDir: readonly [number, number, number];
  readonly lightColor: readonly [number, number, number];
  readonly ambient: number; // sky light on a surface facing the horizon
  readonly ambientSky: number; // extra for an up-facing one, less for down-facing
  readonly horizon: readonly [number, number, number];
  readonly zenith: readonly [number, number, number];
  readonly ground: readonly [number, number, number]; // below the horizon
  readonly fogDensity: number;
  // What a surface at block-light level 15 gets on top of the sky's own light. Higher
  // at night, where a glowing plant is most of what lights anything.
  readonly blockLight: number;
  // How bright the light's disc is drawn, 0 for none. The sun is left off: it is too
  // bright to put in an untonemapped frame.
  readonly disc: number;
  // Angular radius of the disc in the sky, as cos(angle). A moon is about half a degree
  // across, which is far too small to see in a voxel scene, so this is the size it is
  // drawn at rather than the size it is. Kept strictly under 1 whatever `disc` says:
  // `smoothstep` with equal ends is a WGSL compile error, not a runtime one, so a preset
  // that never draws a disc would still fail to build the shader.
  readonly discCos: number;
  readonly discColor: readonly [number, number, number];
  // How far the glow around the disc spreads, as cos(angle). Always under discCos.
  readonly haloCos: number;
  // Stars, as a density over the sky hemisphere; 0 draws none.
  readonly stars: number;
}

const DAY: Sky = {
  name: "day",
  lightDir: [0.42, 0.82, 0.38],
  lightColor: [1.0, 0.96, 0.88],
  ambient: 0.3,
  ambientSky: 0.15,
  horizon: [0.72, 0.8, 0.9],
  zenith: [0.2, 0.38, 0.7],
  ground: [0.18, 0.17, 0.16],
  fogDensity: 0.00035,
  blockLight: 0.55,
  disc: 0.0, // staring into the sun is not the look
  discCos: 0.9995,
  discColor: [1.0, 0.97, 0.9],
  haloCos: 0.97,
  stars: 0.0,
};

// A forest night. The moon is low and to one side so trunks throw the light sideways
// across the ground, and everything else is dim enough that a glowing mushroom is the
// brightest thing in the frame.
const NIGHT: Sky = {
  name: "night",
  lightDir: [0.55, 0.42, -0.72],
  lightColor: [0.34, 0.42, 0.62],
  ambient: 0.11,
  ambientSky: 0.07,
  horizon: [0.055, 0.075, 0.125],
  zenith: [0.015, 0.025, 0.06],
  ground: [0.02, 0.022, 0.03],
  fogDensity: 0.0005,
  blockLight: 1.0,
  disc: 1.0,
  discCos: 0.9985,
  discColor: [0.95, 0.96, 1.0],
  haloCos: 0.96,
  stars: 1.0,
};

// High desert at midday. Two things set it apart from `day`: the air is clear, so the
// far field carries for miles instead of dissolving a few thousand voxels out; and the
// light is harder and warmer, which is what puts the near-black shadow on the east face
// of every butte. The density is what the clipmap's reach can pay for rather than what
// desert air actually is: the monument world marches 16,384 voxels, and the haze has to
// have taken the view before the last level ends.
const DESERT: Sky = {
  name: "desert",
  lightDir: [0.38, 0.88, 0.28],
  lightColor: [1.0, 0.94, 0.82],
  ambient: 0.26,
  ambientSky: 0.18,
  horizon: [0.78, 0.80, 0.82],
  zenith: [0.16, 0.33, 0.66],
  ground: [0.34, 0.22, 0.16],
  fogDensity: 0.00014,
  blockLight: 0.4,
  disc: 0.0,
  discCos: 0.9995,
  discColor: [1.0, 0.97, 0.9],
  haloCos: 0.97,
  stars: 0.0,
};

// Space, for a world small enough to see all of. Every other preset here fogs the view
// out at a few thousand voxels, which is right for a world that goes on and wrong for a
// ball 5,200 voxels across: seen from far enough away to fit in the frame, the planet was
// the colour of the sky. So the air is thin enough to see through from orbit, and the
// price is paid at ground level, where there is no haze to give distance away.
//
// Dark sky and stars rather than blue, because the same air that would make it blue is the
// air that was hiding the planet. Sunlight is hard and white with little to fill the
// shadows, which is what an airless sky does to a landscape.
const SPACE: Sky = {
  name: "space",
  lightDir: [0.48, 0.62, 0.62],
  lightColor: [1.0, 0.97, 0.92],
  // Not as low as an airless sky would really be. A curved surface made of axis-aligned
  // voxels is a staircase, and seen at a grazing angle it is all risers: with ambient at
  // 0.16 every one of them went black and the planet read as though it were full of holes,
  // which is what the combing across the oceans was. Lifting the fill turns them back into
  // steps. The direct light stays hard, which is what carries the airless look
  // (gotchas.md "A curved world is a staircase, and ambient is what stops it reading as
  // holes").
  //
  // 0.45 in total and not a hair more: `src/world/blocks_test.ts` holds every sky against
  // the brightest emissive block, because nothing tonemaps and a glowcap under a brighter
  // fill than this clips to white and stops being green. 0.30 and 0.20 broke it, which is
  // the test doing its job.
  ambient: 0.28,
  ambientSky: 0.17,
  horizon: [0.035, 0.045, 0.07],
  zenith: [0.01, 0.012, 0.025],
  ground: [0.02, 0.02, 0.028],
  // A twentieth of the day sky's: about a tenth of the light lost across a view of the
  // whole planet, which reads as distance without hiding it. The clipmap's reach is trimmed to where fog has taken
  // the view, so this is also what buys the levels that reach the far side of the planet.
  fogDensity: 0.00002,
  blockLight: 0.85,
  disc: 0.0, // a sun bright enough to look at is too bright for an untonemapped frame
  discCos: 0.9995,
  discColor: [1.0, 1.0, 0.97],
  haloCos: 0.985,
  stars: 1.0,
};

export const SKIES: Readonly<Record<string, Sky>> = { day: DAY, night: NIGHT, desert: DESERT, space: SPACE };
export const DEFAULT_SKY = "day";

// What is left of a surface at the far end of the view, under which drawing it and
// drawing nothing are the same picture. `apply_fog()` mixes toward `sky_color(dir)` and
// that is exactly what the sky pass puts behind a miss, so a hit this fogged differs from
// a miss by this fraction of the gap between the surface and the sky: half a percent is
// about one value in 8-bit.
const FOG_RESIDUAL = 0.005;

// How far the view carries before fog has taken it, in voxels. Fog is
// `1 - exp(-dist * FOG_DENSITY)`, so this is where that reaches 1 - FOG_RESIDUAL.
// Infinite for a world with no fog at all.
//
// This is the distance past which a clipmap level is marching for nothing, which makes
// it the ceiling on the far field's reach: fog density and reach are one decision, not
// two (CLAUDE.md "A new world", gotchas.md "A wider clipmap level can be cheaper").
export function fogHorizonVoxels(sky: Sky): number {
  if (!(sky.fogDensity > 0)) return Infinity;
  return Math.log(1 / FOG_RESIDUAL) / sky.fogDensity;
}

function vec3(v: readonly [number, number, number]): string {
  return `vec3f(${v.map((c) => c.toFixed(5)).join(", ")})`;
}

// `const SKY_ZENITH = vec3f(...)` and so on, one per field. Prepend to any shader that
// includes sky-color.wgsl or shading.wgsl.
export function skyConstantsWgsl(sky: Sky): string {
  return [
    `const LIGHT_DIR = ${vec3(sky.lightDir)};`,
    `const LIGHT_COLOR = ${vec3(sky.lightColor)};`,
    `const AMBIENT: f32 = ${sky.ambient};`,
    `const AMBIENT_SKY: f32 = ${sky.ambientSky};`,
    `const SKY_HORIZON = ${vec3(sky.horizon)};`,
    `const SKY_ZENITH = ${vec3(sky.zenith)};`,
    `const SKY_GROUND = ${vec3(sky.ground)};`,
    `const FOG_DENSITY: f32 = ${sky.fogDensity};`,
    `const BLOCK_LIGHT_STRENGTH: f32 = ${sky.blockLight};`,
    `const DISC: f32 = ${sky.disc};`,
    // Clamped so the two ends of every smoothstep below are distinct: WGSL rejects
    // equal ends at compile time, whatever branch guards the call.
    `const DISC_COS: f32 = ${Math.min(sky.discCos, 0.9999)};`,
    `const DISC_COLOR = ${vec3(sky.discColor)};`,
    `const HALO_COS: f32 = ${Math.min(sky.haloCos, sky.discCos - 1e-4, 0.9998)};`,
    `const STARS: f32 = ${sky.stars};`,
    "",
  ].join("\n");
}
