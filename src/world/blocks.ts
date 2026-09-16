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
  // Tiles a second the block's texture scrolls down its faces. For water going over a
  // drop: motion the eye reads without the geometry moving, which is the difference
  // between a waterfall and a sheet of quads flickering against its neighbours.
  readonly flow?: number;
  // How far the block's faces sway in the wind, in voxels (plan-living-world phase 2).
  readonly sway?: number;
  // How brightly the block lights what is around it, 0 (not a light) to LIGHT_MAX.
  // The level falls by one per voxel from the block, so this is also the light's reach
  // (plan-living-world phase 4). Emission is how a block looks; light is what it does
  // to its neighbours, and a block can have either without the other.
  readonly light?: number;
  // The body a translucent block belongs to. Two blocks of one fluid meet with no face
  // between them, the way two voxels of one block do: a sea drawn as shallow and deep
  // water is one body of water, and a wall of translucent faces down every depth
  // contour, one from each side at the same plane, flickers as their draw order
  // changes. Unset means the block is its own body.
  readonly fluid?: string;
}

// Brightest a block light can be, and so how many voxels it reaches: the level falls
// by one per voxel. 15 fits the four bits the packed quad has for it
// (design-formats.md "Packed quad").
export const LIGHT_MAX = 15;

// Size of the color table uploaded to shaders; ids at or above it render as id 0.
export const MAX_BLOCK_TYPES = 256;
// f32 per block in that table: color and coverage, then emission and sway, then flow.
export const BLOCK_TABLE_STRIDE = 12;
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
    // What the near field's translucent water over a lit sand bed comes out as on
    // screen (sampled at 77, 107, 150 of 255), so the far field's flat water meets it
    // without a step at the near field's edge.
    far: [0.30, 0.42, 0.59],
    fluid: "water",
  },
  { id: 11, name: "glass", color: [0.8, 0.9, 0.95], opaque: false, texture: ["glass", "glass", "glass"], alpha: 0.35 },
  // Falling water: the face of a cascade, where the stream goes over a terrace riser.
  // Whiter and less see-through than still water, because that is what broken water is,
  // and it sways further than any plant in the world: the sway is the only motion the
  // engine has and a sheet of water is the thing in the scene most obviously in motion.
  {
    id: 26,
    name: "whitewater",
    color: [0.78, 0.88, 0.96],
    // Opaque, unlike the still water it runs into. Broken water is not see-through, and
    // a translucent sheet sitting in the same voxels as the stream sorts against it
    // differently frame to frame, which is a flicker.
    opaque: true,
    texture: ["whitewater", "whitewater", "whitewater"],
    far: [0.72, 0.82, 0.92],
    // It flows rather than sways. Moving the faces of a sheet of water pushes them into
    // the blocks around it; scrolling the texture down them is the same motion with none
    // of that (gotchas.md "Animate flowing water with the texture, not the geometry").
    flow: 1.1,
  },
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
    // The stem glows too, a warm cream well under the caps, so a mushroom is lit from
    // the ground up rather than a lantern on a pale post; and it lights the ground at
    // its foot, which a giant's cap is too far above to reach.
    emission: [0.40, 0.40, 0.34],
    light: 9,
  },
  { id: 17, name: "bark", color: [0.34, 0.24, 0.17], opaque: true, texture: ["bark", "bark", "bark"] },
  // Ferns sway further than a canopy does: they are fronds, not branches.
  { id: 18, name: "fern", color: [0.26, 0.53, 0.21], opaque: true, texture: ["fern", "fern", "fern"], sway: 0.35 },
  { id: 19, name: "moss", color: [0.22, 0.42, 0.20], opaque: true, texture: ["moss", "moss", "moss"] },
  // Monument Valley (src/worlds/monument.wgsl). The colours are the real stratigraphy's:
  // iron oxide reddens everything, and manganese oxide is what darkens the caprock.
  {
    id: 20,
    name: "redsand",
    color: [0.72, 0.42, 0.28],
    opaque: true,
    texture: ["redsand", "redsand", "redsand"],
  },
  // Organ Rock: dark red-brown siltstone, and the only layer here that erodes to a
  // slope rather than a cliff, which is what puts a skirt round the foot of every butte.
  {
    id: 21,
    name: "organrock",
    color: [0.55, 0.29, 0.21],
    opaque: true,
    texture: ["organrock", "organrock", "organrock"],
  },
  // De Chelly: the massive wind-blown sandstone that makes the cliffs, pale orange to
  // reddish brown and cross-bedded.
  {
    id: 22,
    name: "sandstone",
    color: [0.78, 0.48, 0.31],
    opaque: true,
    texture: ["sandstone", "sandstone", "sandstone"],
  },
  // Shinarump: the thin hard cap that is the reason the butte under it still stands.
  {
    id: 23,
    name: "caprock",
    // Light enough to still read as rock on a face the sun never reaches. At 0.42 it
    // went to 28/255 under the desert sky's ambient alone, which is a hole in the
    // silhouette rather than a caprock.
    color: [0.56, 0.47, 0.42],
    opaque: true,
    texture: ["caprock", "caprock", "caprock"],
  },
  // Desert scrub: grey-green, not leaf green. A saltbush on red sand is nearly the same
  // value as the sand it stands on, which is why the floor reads as empty from a
  // distance and not as a lawn.
  { id: 24, name: "sage", color: [0.40, 0.43, 0.31], opaque: true, texture: ["sage", "sage", "sage"] },
  // Two more greens for the canopy. A wood where every tree wears the same leaf reads as
  // one plant repeated however varied the shapes are, and the colour is what the eye
  // sorts trees by at a distance.
  { id: 27, name: "leaves-dark", color: [0.15, 0.31, 0.17], opaque: true, texture: ["leaves-dark", "leaves-dark", "leaves-dark"], sway: 0.2 },
  { id: 28, name: "leaves-pale", color: [0.44, 0.60, 0.26], opaque: true, texture: ["leaves-pale", "leaves-pale", "leaves-pale"], sway: 0.2 },
  // Birch bark: near-white with the dark dashes that are the whole reason a birch is
  // recognisable from across a wood.
  { id: 29, name: "birch", color: [0.86, 0.86, 0.81], opaque: true, texture: ["birch", "birch", "birch"] },
  // The election map (src/worlds/sweden.wgsl): one block per Riksdag party, in the
  // order docs/sweden/sweden-election.ts indexes them. The colours are Valmyndigheten's own (the
  // `fargkod` in its result files), except two: S is eased off pure red so a lit face
  // keeps some shade, and SD is the yellow the broadcasters use, because the
  // authority's steel blue is a stone's throw from M's light blue at a distance.
  { id: 30, name: "party-s", color: [0.85, 0.12, 0.12], opaque: true, texture: ["party-s", "party-s", "party-s"] },
  { id: 31, name: "party-m", color: [0.40, 0.75, 0.90], opaque: true, texture: ["party-m", "party-m", "party-m"] },
  { id: 32, name: "party-sd", color: [0.95, 0.80, 0.20], opaque: true, texture: ["party-sd", "party-sd", "party-sd"] },
  { id: 33, name: "party-v", color: [0.77, 0.00, 0.00], opaque: true, texture: ["party-v", "party-v", "party-v"] },
  { id: 34, name: "party-c", color: [0.39, 0.66, 0.11], opaque: true, texture: ["party-c", "party-c", "party-c"] },
  { id: 35, name: "party-kd", color: [0.11, 0.36, 0.69], opaque: true, texture: ["party-kd", "party-kd", "party-kd"] },
  { id: 36, name: "party-l", color: [0.20, 0.60, 1.00], opaque: true, texture: ["party-l", "party-l", "party-l"] },
  { id: 37, name: "party-mp", color: [0.00, 0.50, 0.00], opaque: true, texture: ["party-mp", "party-mp", "party-mp"] },
  // The map itself: paper for the land, ink for the borders and the marker pins.
  // The land of each municipality in a pale wash of the party that won it: the party
  // colours above mixed a little over half into paper, so the bubbles stacked over it
  // stay the loud thing.
  { id: 38, name: "won-s", color: [0.86, 0.52, 0.46], opaque: true, texture: ["won-s", "won-s", "won-s"] },
  { id: 40, name: "won-m", color: [0.65, 0.80, 0.81], opaque: true, texture: ["won-m", "won-m", "won-m"] },
  { id: 41, name: "won-sd", color: [0.90, 0.82, 0.50], opaque: true, texture: ["won-sd", "won-sd", "won-sd"] },
  { id: 42, name: "won-v", color: [0.82, 0.46, 0.41], opaque: true, texture: ["won-v", "won-v", "won-v"] },
  { id: 44, name: "won-c", color: [0.65, 0.76, 0.46], opaque: true, texture: ["won-c", "won-c", "won-c"] },
  { id: 45, name: "won-kd", color: [0.52, 0.62, 0.72], opaque: true, texture: ["won-kd", "won-kd", "won-kd"] },
  { id: 46, name: "won-l", color: [0.56, 0.73, 0.86], opaque: true, texture: ["won-l", "won-l", "won-l"] },
  { id: 47, name: "won-mp", color: [0.47, 0.69, 0.41], opaque: true, texture: ["won-mp", "won-mp", "won-mp"] },
  // The map's open sea, darker than the water along its coasts, so the sea has depth
  // in it from above: the far field draws it flat, and `far` is what it draws.
  {
    id: 43,
    name: "water-deep",
    color: [0.16, 0.32, 0.64],
    opaque: false,
    texture: ["water", "water", "water"],
    alpha: 0.7,
    far: [0.26, 0.38, 0.55],
    fluid: "water",
  },
  { id: 39, name: "map-ink", color: [0.24, 0.22, 0.20], opaque: true, texture: ["map-ink", "map-ink", "map-ink"] },
  // A jellyfish's bell, hanging in the forest's lakes. Opaque rather than translucent
  // on purpose: it sits inside water that is already translucent, and two translucent
  // surfaces one behind the other is a sorting problem for something six voxels across.
  // It sways further than anything on land, because what it is doing is drifting.
  {
    id: 25,
    name: "jelly",
    color: [0.55, 0.82, 0.95],
    opaque: true,
    texture: ["jelly", "jelly", "jelly"],
    emission: [0.18, 0.48, 0.58],
    light: 11,
    sway: 0.7,
  },
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

// The fluid a block belongs to, as a small number, 0 for none (`fluid` above).
export const BLOCK_FLUID: Uint8Array = (() => {
  const table = new Uint8Array(65536);
  const names: string[] = [];
  for (const b of BLOCKS) {
    if (b.fluid === undefined) continue;
    let i = names.indexOf(b.fluid);
    if (i < 0) i = names.push(b.fluid) - 1;
    table[b.id] = i + 1;
  }
  return table;
})();

// Whether a translucent face between `a` and `b` is hidden: the same block, or two
// blocks of one fluid.
export function sameFluid(a: number, b: number): boolean {
  return a === b || (BLOCK_FLUID[a] !== 0 && BLOCK_FLUID[a] === BLOCK_FLUID[b]);
}

// `const BLOCK_STONE: u32 = 1u;` and so on, one per block.
export function blockConstantsWgsl(): string {
  // A block's name becomes a WGSL identifier, so anything that is not one becomes an
  // underscore: `leaves-dark` is `BLOCK_LEAVES_DARK`. Without this a hyphenated name
  // compiles to `BLOCK_LEAVES-DARK` and every shader that includes the block constants
  // fails to parse, which is every shader that evaluates a world.
  return BLOCKS.map((b) => `const BLOCK_${wgslName(b.name)}: u32 = ${b.id}u;`).join("\n") + "\n";
}

// The WGSL constant suffix for a block name.
export function wgslName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
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
    out[i + 8] = b.flow ?? 0;
  }
}

// Average color of one texture layer: its 1x1 mip, which buildTextures() already
// produced for the near field.
function layerAverage(data: TextureData, layer: number, out: Float32Array, at: number): void {
  const top = data.levels[TEXTURE_MIPS - 1];
  for (let i = 0; i < 3; i++) out[at + i] = top[layer * 4 + i] / 255;
}

// Far-field color table (plan-far-field phase 2), BLOCK_TABLE_STRIDE floats per block
// at `offset`, laid out like the near field's table: color and solidity, then emission
// and, where the near field's table keeps the sway, the block's light level. The far
// field has no baked light to read (that lives in the mesh, and the far field has no
// mesh), so it works the light out at the hit from the emitters in the cells around it
// and needs their levels to do it (src/far/far.wgsl `gathered_light`).
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
    out[i + 7] = b.light ?? 0;
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
