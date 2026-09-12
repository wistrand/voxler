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

export const SKIES: Readonly<Record<string, Sky>> = { day: DAY, night: NIGHT };
export const DEFAULT_SKY = "day";

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
