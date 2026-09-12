import { FACE_COUNT } from "../mesh/quad.ts";
import { TEXTURE_LAYERS, TEXTURE_MIPS, type TextureData } from "../render/textures.ts";
// Block registry: the single source of truth for block ids. WGSL world programs get
// the ids as generated `BLOCK_<NAME>` constants (blockConstantsWgsl), and shaders get
// colors from blockColorTable, so TS and WGSL can't disagree.
// Per-face texture layers name entries in src/render/textures.ts; the near field
// draws those, and `color` is the coarse stand-in the preview and far field use.

export interface BlockType {
  readonly id: number;
  readonly name: string;
  readonly color: readonly [number, number, number]; // display color, 0..1
  readonly opaque: boolean;
  // Texture names (src/render/textures.ts) as [top, side, bottom]. The near field
  // draws these; `color` stays the coarse stand-in for the preview and the far field.
  readonly texture: readonly [string, string, string];
  // Coverage where the block is translucent, 0 clear to 1 solid. Opaque blocks are 1
  // whatever this says; the translucent draw pass blends by it.
  readonly alpha?: number;
  // Far-field color, when the block should look different past the near field than
  // `color` says. Unset means the top texture's average, or `color` without textures
  // (farColorTable).
  readonly far?: readonly [number, number, number];
  // Light the block gives off, 0..1 per channel and beyond for something meant to
  // glare. Added to the lit surface, so a block with emission is visible with the sun
  // down and reads as its own color whatever is lighting it
  // (plan-living-world.md phase 1).
  readonly emission?: readonly [number, number, number];
  // How far the block's faces sway in the wind, in voxels (plan-living-world phase 2).
  readonly sway?: number;
  // How brightly the block lights what is around it, 0 (not a light) to LIGHT_MAX.
  // The level falls by one per voxel from the block, so this is also the light's reach
  // (plan-living-world phase 4). Emission is how a block looks; light is what it does
  // to its neighbours, and a block can have either without the other.
  readonly light?: number;
}

// Brightest a block light can be, and so how many voxels it reaches: the level falls
// by one per voxel. 15 fits the four bits the packed quad has for it
// (design-formats.md "Packed quad").
export const LIGHT_MAX = 15;

// Size of the color table uploaded to shaders; ids at or above it render as id 0.
export const MAX_BLOCK_TYPES = 256;
// f32 per block in that table: color and coverage, then emission and sway.
export const BLOCK_TABLE_STRIDE = 8;
export const BLOCK_TABLE_FLOATS = MAX_BLOCK_TYPES * BLOCK_TABLE_STRIDE;

export const BLOCKS: readonly BlockType[] = [
  { id: 0, name: "air", color: [0, 0, 0], opaque: false, texture: ["stone", "stone", "stone"] },
  { id: 1, name: "stone", color: [0.5, 0.5, 0.52], opaque: true, texture: ["stone", "stone", "stone"] },
  { id: 2, name: "dirt", color: [0.45, 0.32, 0.22], opaque: true, texture: ["dirt", "dirt", "dirt"] },
  { id: 3, name: "grass", color: [0.35, 0.6, 0.25], opaque: true, texture: ["grass", "grass-side", "dirt"] },
  { id: 4, name: "sand", color: [0.86, 0.8, 0.58], opaque: true, texture: ["sand", "sand", "sand"] },
  { id: 5, name: "snow", color: [0.95, 0.96, 0.98], opaque: true, texture: ["snow", "snow", "dirt"] },
  { id: 6, name: "wood", color: [0.55, 0.38, 0.2], opaque: true, texture: ["wood", "wood", "wood"] },
  { id: 7, name: "brick", color: [0.62, 0.26, 0.2], opaque: true, texture: ["brick", "brick", "brick"] },
  { id: 8, name: "metal", color: [0.7, 0.74, 0.8], opaque: true, texture: ["metal", "metal", "metal"] },
  // Leaves sway: a fifth of a voxel is enough to read as movement without the canopy
  // coming apart from the branches it hangs on (plan-living-world phase 2).
  { id: 9, name: "leaves", color: [0.24, 0.45, 0.2], opaque: true, texture: ["leaves", "leaves", "leaves"], sway: 0.2 },
  // Water's far color is not its own: past the near field it is drawn opaque, and
  // what the near field shows there is water blended over whatever it covers. This is
  // that blend over a middling bottom, so the two meet without a step at the shore.
  {
    id: 10,
    name: "water",
    color: [0.2, 0.4, 0.75],
    opaque: false,
    texture: ["water", "water", "water"],
    alpha: 0.6,
    far: [0.42, 0.55, 0.78],
  },
  { id: 11, name: "glass", color: [0.8, 0.9, 0.95], opaque: false, texture: ["glass", "glass", "glass"], alpha: 0.35 },
  // The first emissive block: a glowing mushroom cap, for plan-living-world phase 1.
  // The emission is under 1 on purpose. There is no tonemapping, so anything that
  // takes a lit surface past 1 clips to white and the block loses its color; this
  // reads as a light source in the sun and keeps its hue.
  {
    id: 12,
    name: "glowcap",
    color: [0.62, 0.85, 0.78],
    opaque: true,
    texture: ["glowcap", "glowcap", "glowcap"],
    emission: [0.15, 0.7, 0.5],
    light: 13,
  },
  // The rest of the forest (plan-living-world phase 3). Each cap's emission is capped
  // by its own colour: lit plus emission has to stay under 1 (blocks_test.ts).
  {
    id: 13,
    name: "glowcap_violet",
    color: [0.70, 0.55, 0.95],
    opaque: true,
    texture: ["glowcap-violet", "glowcap-violet", "glowcap-violet"],
    emission: [0.45, 0.15, 0.55],
    light: 13,
  },
  {
    id: 14,
    name: "glowcap_amber",
    color: [0.95, 0.78, 0.45],
    opaque: true,
    texture: ["glowcap-amber", "glowcap-amber", "glowcap-amber"],
    emission: [0.55, 0.35, 0.08],
    light: 13,
  },
  {
    id: 15,
    name: "glowcap_rose",
    color: [0.95, 0.60, 0.70],
    opaque: true,
    texture: ["glowcap-rose", "glowcap-rose", "glowcap-rose"],
    emission: [0.55, 0.10, 0.28],
    light: 13,
  },
  {
    id: 16,
    name: "shroomstem",
    color: [0.86, 0.83, 0.74],
    opaque: true,
    texture: ["shroomstem", "shroomstem", "shroomstem"],
    emission: [0.10, 0.10, 0.08], // the stem catches a little of its own cap's light
  },
  { id: 17, name: "bark", color: [0.34, 0.24, 0.17], opaque: true, texture: ["bark", "bark", "bark"] },
  // Ferns sway further than a canopy does: they are fronds, not branches.
  { id: 18, name: "fern", color: [0.26, 0.53, 0.21], opaque: true, texture: ["fern", "fern", "fern"], sway: 0.35 },
  { id: 19, name: "moss", color: [0.22, 0.42, 0.20], opaque: true, texture: ["moss", "moss", "moss"] },
];

// Light level each block gives off, indexed by any u16 id, 0 for everything that is
// not a light. Same shape as BLOCK_OPAQUE and for the same reason: the flood fill
// (src/mesh/light.ts) reads it once per voxel and cannot afford an object lookup.
export const BLOCK_LIGHT: Uint8Array = (() => {
  const table = new Uint8Array(65536);
  for (const b of BLOCKS) if (b.light) table[b.id] = Math.min(LIGHT_MAX, b.light);
  return table;
})();

// 1 where the block id is opaque, indexed by any u16 id; for kernels (meshing,
// occupancy) that can't afford an object lookup per voxel. Air (0) and registered
// non-opaque blocks are 0; every other id, registered or not, is opaque, so a world
// that returns an unregistered id still renders.
export const BLOCK_OPAQUE: Uint8Array = (() => {
  const table = new Uint8Array(65536).fill(1);
  table[0] = 0;
  for (const b of BLOCKS) table[b.id] = b.opaque ? 1 : 0;
  return table;
})();

// 1 where the block id is solid to the far field: everything but air. The far field
// has no blending, and a sea rendered as its own bed is a worse answer than a sea
// rendered as opaque water: past the near field a translucent block is a surface like
// any other (plan-far-field phase 4).
export const BLOCK_FAR_SOLID: Uint8Array = (() => {
  const table = new Uint8Array(65536).fill(1);
  table[0] = 0;
  return table;
})();

// 1 where the block id is translucent: registered, not air, not opaque. Translucent
// faces are meshed separately (plan-meshing phase 6 rules in src/mesh/binary.ts).
export const BLOCK_TRANSLUCENT: Uint8Array = (() => {
  const table = new Uint8Array(65536);
  for (const b of BLOCKS) if (b.id !== 0 && !b.opaque) table[b.id] = 1;
  return table;
})();

// `const BLOCK_STONE: u32 = 1u;` and so on, one per block.
export function blockConstantsWgsl(): string {
  return BLOCKS.map((b) => `const BLOCK_${b.name.toUpperCase()}: u32 = ${b.id}u;`).join("\n") + "\n";
}

// Texture layer per block id and face (quad.ts face order: +X, -X, +Y, -Y, +Z, -Z),
// indexed `id * FACE_COUNT + face`. Ids past the table, and unregistered ones, read
// as id 0's side layer, matching how blockColorTable() handles them.
export function blockFaceTable(out: Uint32Array): void {
  const layer = (name: string) => {
    const i = TEXTURE_LAYERS[name];
    if (i === undefined) throw new Error(`block texture "${name}" is not a texture layer`);
    return i;
  };
  out.fill(layer(BLOCKS[0].texture[1]));
  for (const b of BLOCKS) {
    const [top, side, bottom] = b.texture;
    for (let face = 0; face < FACE_COUNT; face++) {
      out[b.id * FACE_COUNT + face] = layer(face === 2 ? top : face === 3 ? bottom : side);
    }
  }
}

// Writes the block table into `out` at `offset` floats: BLOCK_TABLE_STRIDE per block,
// MAX_BLOCK_TYPES of them. The first four are the display color and, in alpha, the
// block's coverage (1 for opaque, `alpha` for translucent, which the translucent draw
// pass blends by and the opaque one ignores). The next four are the block's emission
// and, in w, how far it sways. Ids past the table, and unregistered ones, read as id 0.
export function blockColorTable(out: Float32Array, offset: number): void {
  out.fill(0, offset, offset + BLOCK_TABLE_FLOATS);
  for (const b of BLOCKS) {
    const i = offset + b.id * BLOCK_TABLE_STRIDE;
    out[i] = b.color[0];
    out[i + 1] = b.color[1];
    out[i + 2] = b.color[2];
    out[i + 3] = b.opaque ? 1 : b.alpha ?? 1;
    const e = b.emission;
    if (e !== undefined) {
      out[i + 4] = e[0];
      out[i + 5] = e[1];
      out[i + 6] = e[2];
    }
    out[i + 7] = b.sway ?? 0;
  }
}

// Average color of one texture layer: its 1x1 mip, which buildTextures() already
// produced for the near field.
function layerAverage(data: TextureData, layer: number, out: Float32Array, at: number): void {
  const top = data.levels[TEXTURE_MIPS - 1];
  for (let i = 0; i < 3; i++) out[at + i] = top[layer * 4 + i] / 255;
}

// Far-field color table (plan-far-field phase 2), BLOCK_TABLE_STRIDE floats per block
// at `offset`, laid out like the near field's table: color and solidity, then emission.
// Alpha is 1 exactly where BLOCK_FAR_SOLID says the id is solid, so the two
// brick builders (src/far/reduce.ts on the CPU, far-build.wgsl on the GPU) decide
// solidity by one rule and neither needs its own opacity table.
//
// The color is the block's `far` when it has one, else the average of its top
// texture, else `color`. A brick cell is a whole 2^k voxel block seen from far away,
// so the average of what the near field draws there is closer than the flat display
// color. Unregistered ids are opaque, like BLOCK_OPAQUE has them, and take stone's
// color, so a world returning one shows terrain rather than a black hole.
export function farColorTable(out: Float32Array, offset: number, textures: TextureData | null = null): void {
  const stone = BLOCKS[1];
  out.fill(0, offset, offset + BLOCK_TABLE_FLOATS);
  for (let id = 0; id < MAX_BLOCK_TYPES; id++) {
    const i = offset + id * BLOCK_TABLE_STRIDE;
    for (let c = 0; c < 3; c++) out[i + c] = stone.color[c];
    out[i + 3] = BLOCK_FAR_SOLID[id];
  }
  for (const b of BLOCKS) {
    const i = offset + b.id * BLOCK_TABLE_STRIDE;
    const e = b.emission;
    if (e !== undefined) for (let c = 0; c < 3; c++) out[i + 4 + c] = e[c];
    if (b.far !== undefined) {
      for (let c = 0; c < 3; c++) out[i + c] = b.far[c];
    } else if (textures !== null) {
      layerAverage(textures, TEXTURE_LAYERS[b.texture[0]], out, i);
    } else {
      for (let c = 0; c < 3; c++) out[i + c] = b.color[c];
    }
    out[i + 3] = BLOCK_FAR_SOLID[b.id];
  }
}
