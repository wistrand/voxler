// Block textures (plan-rendering phase 5), generated rather than loaded: the project
// takes no runtime dependency and ships no image assets, and a painted 32^2 tile is a
// few lines of arithmetic. Pure: `buildTextures()` returns bytes, and the GPU upload
// is a separate call.
//
// One layer per named texture, in a `texture_2d_array`, so a block's face picks a
// layer and the sampler tiles it with repeat addressing. Voxel-unit texture
// coordinates mean one tile per voxel whatever a greedy quad's size
// (src/render/near.wgsl).
//
// Mip levels are box-filtered here rather than on the GPU: it happens once at
// startup, the chain is tiny, and generating it on the CPU keeps the result the same
// on every machine, which a test can check.

import "../gpu/globals.ts";
import { hash32 } from "../util/random.ts";

export const TEXTURE_SIZE = 32;
export const TEXTURE_MIPS = 6; // 32, 16, 8, 4, 2, 1

// Value noise on the tile's own grid, so a texture tiles without a seam: the lattice
// wraps at `period`.
function noise(seed: number, x: number, y: number, period: number): number {
  const fx = x / (TEXTURE_SIZE / period), fy = y / (TEXTURE_SIZE / period);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const at = (ix: number, iy: number) =>
    hash32(seed ^ (((ix + period) % period) * 73856093) ^ (((iy + period) % period) * 19349663)) / 4294967296;
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
}

// Several octaves of the above, in [0, 1].
function fbm(seed: number, x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let period = 4;
  for (let o = 0; o < octaves && period <= TEXTURE_SIZE; o++) {
    sum += noise(seed + o * 1013, x, y, period) * amp;
    amp *= 0.5;
    period *= 2;
  }
  return Math.min(1, sum * 2);
}

type Painter = (x: number, y: number, out: Float64Array) => void;

function mix(out: Float64Array, r: number, g: number, b: number, t: number): void {
  out[0] += (r - out[0]) * t;
  out[1] += (g - out[1]) * t;
  out[2] += (b - out[2]) * t;
}

function flat(r: number, g: number, b: number, seed: number, amount: number, octaves = 3): Painter {
  return (x, y, out) => {
    const n = (fbm(seed, x, y, octaves) - 0.5) * amount;
    out[0] = r + n;
    out[1] = g + n;
    out[2] = b + n;
  };
}

// Specks of a second colour over a base, for gravel and grain.
function specks(base: Painter, seed: number, r: number, g: number, b: number, density: number): Painter {
  return (x, y, out) => {
    base(x, y, out);
    if (hash32(seed ^ (x * 374761393) ^ (y * 668265263)) / 4294967296 < density) mix(out, r, g, b, 0.6);
  };
}

const BRICK_ROWS = 4;
const BRICK_COLS = 2;

function brick(x: number, y: number, out: Float64Array): void {
  const rowHeight = TEXTURE_SIZE / BRICK_ROWS;
  const row = Math.floor(y / rowHeight);
  const shift = (row % 2) * (TEXTURE_SIZE / BRICK_COLS / 2);
  const u = (x + shift) % (TEXTURE_SIZE / BRICK_COLS);
  const inMortar = y % rowHeight < 1.5 || u < 1.5;
  const n = (fbm(7, x, y, 2) - 0.5) * 0.1;
  if (inMortar) {
    out[0] = 0.72 + n;
    out[1] = 0.70 + n;
    out[2] = 0.66 + n;
    return;
  }
  out[0] = 0.62 + n;
  out[1] = 0.26 + n;
  out[2] = 0.20 + n;
}

// Vertical grain with a few darker rings.
function wood(x: number, y: number, out: Float64Array): void {
  const rings = Math.sin((x + fbm(11, x, y, 2) * 6) * 1.1) * 0.5 + 0.5;
  const grain = fbm(12, x, y * 4, 3) * 0.25;
  const t = rings * 0.35 + grain;
  out[0] = 0.55 - t * 0.28;
  out[1] = 0.38 - t * 0.22;
  out[2] = 0.20 - t * 0.12;
}

// Dirt below, grass over the top few rows. A face's V axis points up (quad.ts
// FACE_V) and a texture's v = 0 is its first row, so the grass goes in the last rows,
// not the first: painting it at the top of the image puts it at the foot of the wall.
function grassSide(x: number, y: number, out: Float64Array): void {
  DIRT(x, y, out);
  const edge = 6 + fbm(21, x, y, 2) * 5;
  if (y > TEXTURE_SIZE - 1 - edge) mix(out, 0.33, 0.58, 0.24, 1);
}

const DIRT = specks(flat(0.45, 0.32, 0.22, 3, 0.18), 31, 0.32, 0.24, 0.18, 0.12);

// Vertical bark ridges: a few deep grooves with fine grain between them.
function bark(x: number, y: number, out: Float64Array): void {
  const ridge = Math.abs(Math.sin((x + fbm(33, x, y * 0.3, 2) * 7) * 0.9));
  const grain = fbm(34, x * 3, y, 3) * 0.3;
  const t = (1 - ridge) * 0.55 + grain * 0.5;
  out[0] = 0.34 - t * 0.18;
  out[1] = 0.24 - t * 0.13;
  out[2] = 0.17 - t * 0.10;
}

// Frond blades: bright leaf with darker veins running up it.
function fern(x: number, y: number, out: Float64Array): void {
  const blade = Math.abs(Math.sin((x + Math.sin(y * 0.4) * 2.5) * 0.7));
  const n = fbm(35, x, y, 3) * 0.25;
  const t = blade * 0.45 + n;
  out[0] = 0.19 + t * 0.22;
  out[1] = 0.44 + t * 0.26;
  out[2] = 0.16 + t * 0.15;
}

// A glowing cap: pale flesh with brighter flecks, tinted per colour so each
// mushroom reads as its own species before the emission is added.
function cap(r: number, g: number, b: number, seed: number): Painter {
  return specks(flat(r, g, b, seed, 0.10), seed + 11, Math.min(1, r + 0.3), Math.min(1, g + 0.3), Math.min(1, b + 0.3), 0.25);
}

export interface TextureDef {
  readonly name: string;
  readonly paint: Painter;
}

// One entry per layer, in layer order. A block names these (src/world/blocks.ts).
export const TEXTURES: readonly TextureDef[] = [
  { name: "stone", paint: specks(flat(0.50, 0.50, 0.52, 1, 0.16), 41, 0.40, 0.40, 0.42, 0.10) },
  { name: "dirt", paint: DIRT },
  { name: "grass", paint: specks(flat(0.35, 0.60, 0.25, 5, 0.20), 43, 0.28, 0.50, 0.20, 0.14) },
  { name: "grass-side", paint: grassSide },
  { name: "sand", paint: flat(0.86, 0.80, 0.58, 7, 0.10, 4) },
  { name: "snow", paint: flat(0.95, 0.96, 0.98, 9, 0.05, 2) },
  { name: "wood", paint: wood },
  { name: "brick", paint: brick },
  { name: "metal", paint: flat(0.70, 0.74, 0.80, 13, 0.07, 2) },
  { name: "leaves", paint: specks(flat(0.24, 0.45, 0.20, 15, 0.30), 45, 0.16, 0.32, 0.14, 0.25) },
  { name: "water", paint: flat(0.20, 0.40, 0.75, 17, 0.08, 2) },
  { name: "glass", paint: flat(0.80, 0.90, 0.95, 19, 0.04, 2) },
  // Glowing mushroom caps, one per species (plan-living-world phases 1 and 3).
  { name: "glowcap", paint: cap(0.62, 0.85, 0.78, 21) },
  { name: "glowcap-violet", paint: cap(0.70, 0.55, 0.95, 23) },
  { name: "glowcap-amber", paint: cap(0.95, 0.78, 0.45, 25) },
  { name: "glowcap-rose", paint: cap(0.95, 0.60, 0.70, 27) },
  { name: "shroomstem", paint: specks(flat(0.86, 0.83, 0.74, 29, 0.08), 51, 0.70, 0.68, 0.60, 0.15) },
  { name: "bark", paint: bark },
  { name: "fern", paint: fern },
  { name: "moss", paint: specks(flat(0.22, 0.42, 0.20, 37, 0.22), 53, 0.30, 0.52, 0.24, 0.30) },
];

export const TEXTURE_LAYERS: Readonly<Record<string, number>> = Object.fromEntries(
  TEXTURES.map((t, i) => [t.name, i]),
);

// Bytes for every layer's mip chain, laid out level by level so one writeTexture per
// level covers all layers: level 0 for every layer, then level 1, and so on.
export interface TextureData {
  readonly levels: Uint8Array[]; // rgba8, layer-major within a level
  readonly layers: number;
}

export function buildTextures(): TextureData {
  const layers = TEXTURES.length;
  const levels: Uint8Array[] = [];
  let size = TEXTURE_SIZE;
  const rgb = new Float64Array(3);
  const base = new Uint8Array(layers * size * size * 4);
  for (let layer = 0; layer < layers; layer++) {
    const paint = TEXTURES[layer].paint;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        paint(x, y, rgb);
        const at = (layer * size * size + y * size + x) * 4;
        for (let i = 0; i < 3; i++) base[at + i] = Math.round(Math.min(1, Math.max(0, rgb[i])) * 255);
        base[at + 3] = 255;
      }
    }
  }
  levels.push(base);
  for (let level = 1; level < TEXTURE_MIPS; level++) {
    const from = levels[level - 1];
    const half = size >> 1;
    const out = new Uint8Array(layers * half * half * 4);
    for (let layer = 0; layer < layers; layer++) {
      for (let y = 0; y < half; y++) {
        for (let x = 0; x < half; x++) {
          for (let c = 0; c < 4; c++) {
            const src = (sx: number, sy: number) => from[(layer * size * size + sy * size + sx) * 4 + c];
            const sum = src(x * 2, y * 2) + src(x * 2 + 1, y * 2) + src(x * 2, y * 2 + 1) + src(x * 2 + 1, y * 2 + 1);
            out[(layer * half * half + y * half + x) * 4 + c] = Math.round(sum / 4);
          }
        }
      }
    }
    levels.push(out);
    size = half;
  }
  return { levels, layers };
}

// Creates the array texture and uploads every level. `label` names it for errors.
export function createBlockTextures(device: GPUDevice, data: TextureData = buildTextures()): GPUTexture {
  const texture = device.createTexture({
    label: "block textures",
    size: [TEXTURE_SIZE, TEXTURE_SIZE, data.layers],
    mipLevelCount: TEXTURE_MIPS,
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  let size = TEXTURE_SIZE;
  for (let level = 0; level < TEXTURE_MIPS; level++) {
    device.queue.writeTexture(
      { texture, mipLevel: level },
      data.levels[level],
      { bytesPerRow: size * 4, rowsPerImage: size },
      [size, size, data.layers],
    );
    size >>= 1;
  }
  return texture;
}
