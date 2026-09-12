import { FACE_COUNT } from "../mesh/quad.ts";
import { blockFaceTable, BLOCKS, MAX_BLOCK_TYPES } from "../world/blocks.ts";
import { buildTextures, TEXTURE_LAYERS, TEXTURE_MIPS, TEXTURE_SIZE, TEXTURES } from "./textures.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

Deno.test("the mip chain halves to one texel and keeps every layer", () => {
  const data = buildTextures();
  assert(data.layers === TEXTURES.length, `${data.layers} layers`);
  assert(data.levels.length === TEXTURE_MIPS, `${data.levels.length} levels`);
  let size = TEXTURE_SIZE;
  for (let level = 0; level < TEXTURE_MIPS; level++) {
    assert(
      data.levels[level].length === data.layers * size * size * 4,
      `level ${level} is ${data.levels[level].length} bytes for ${size}x${size} x ${data.layers}`,
    );
    size >>= 1;
  }
  assert(size === 0, `the chain stopped at ${size * 2}, not one texel`);
});

Deno.test("a mip level is the average of the four texels above it", () => {
  const data = buildTextures();
  const size = TEXTURE_SIZE;
  const base = data.levels[0];
  const half = data.levels[1];
  for (const layer of [0, 3, TEXTURES.length - 1]) {
    for (const [x, y] of [[0, 0], [5, 9], [15, 15]]) {
      for (let c = 0; c < 4; c++) {
        const at = (sx: number, sy: number) => base[(layer * size * size + sy * size + sx) * 4 + c];
        const want = Math.round((at(x * 2, y * 2) + at(x * 2 + 1, y * 2) + at(x * 2, y * 2 + 1) + at(x * 2 + 1, y * 2 + 1)) / 4);
        const got = half[(layer * (size / 2) * (size / 2) + y * (size / 2) + x) * 4 + c];
        assert(got === want, `layer ${layer} (${x}, ${y}) channel ${c}: ${got}, expected ${want}`);
      }
    }
  }
});

Deno.test("every texture is opaque, in range, and not a flat colour", () => {
  const data = buildTextures();
  const size = TEXTURE_SIZE;
  for (let layer = 0; layer < data.layers; layer++) {
    let min = 255;
    let max = 0;
    for (let i = 0; i < size * size; i++) {
      const at = (layer * size * size + i) * 4;
      assert(data.levels[0][at + 3] === 255, `${TEXTURES[layer].name} texel ${i} is not opaque`);
      for (let c = 0; c < 3; c++) {
        min = Math.min(min, data.levels[0][at + c]);
        max = Math.max(max, data.levels[0][at + c]);
      }
    }
    assert(max > min + 8, `${TEXTURES[layer].name} spans ${min}..${max}: too flat to read as a texture`);
  }
});

Deno.test("generating twice gives the same bytes", () => {
  const a = buildTextures();
  const b = buildTextures();
  for (let level = 0; level < TEXTURE_MIPS; level++) {
    for (let i = 0; i < a.levels[level].length; i++) {
      if (a.levels[level][i] !== b.levels[level][i]) {
        throw new Error(`level ${level} byte ${i} differs between runs`);
      }
    }
  }
});

Deno.test("a texture tiles without a seam at its own edges", () => {
  // Voxel-unit coordinates plus repeat addressing means a tile meets itself, so the
  // noise lattice has to wrap. The first and last column stay within a step of each
  // other; a lattice that did not wrap jumps.
  const data = buildTextures();
  const size = TEXTURE_SIZE;
  for (let layer = 0; layer < data.layers; layer++) {
    if (TEXTURES[layer].name === "brick" || TEXTURES[layer].name === "grass-side") continue; // banded on purpose
    let worst = 0;
    for (let y = 0; y < size; y++) {
      for (let c = 0; c < 3; c++) {
        const left = data.levels[0][(layer * size * size + y * size) * 4 + c];
        const right = data.levels[0][(layer * size * size + y * size + size - 1) * 4 + c];
        worst = Math.max(worst, Math.abs(left - right));
      }
    }
    assert(worst < 96, `${TEXTURES[layer].name} jumps by ${worst} across the wrap`);
  }
});

Deno.test("every block names real textures, and faces map to top, side and bottom", () => {
  const faces = new Uint32Array(MAX_BLOCK_TYPES * FACE_COUNT);
  blockFaceTable(faces);
  for (const b of BLOCKS) {
    for (const name of b.texture) assert(TEXTURE_LAYERS[name] !== undefined, `${b.name} names "${name}"`);
    const [top, side, bottom] = b.texture.map((n) => TEXTURE_LAYERS[n]);
    assert(faces[b.id * FACE_COUNT + 2] === top, `${b.name}: +Y should be the top texture`);
    assert(faces[b.id * FACE_COUNT + 3] === bottom, `${b.name}: -Y should be the bottom texture`);
    for (const face of [0, 1, 4, 5]) {
      assert(faces[b.id * FACE_COUNT + face] === side, `${b.name}: face ${face} should be the side texture`);
    }
  }
  // Grass is the case the split exists for.
  const grass = BLOCKS.find((b) => b.name === "grass")!;
  assert(
    faces[grass.id * FACE_COUNT + 2] !== faces[grass.id * FACE_COUNT + 3],
    "grass should not have the same texture on top and bottom",
  );
  // An unregistered id falls back rather than reading whatever is in memory.
  assert(faces[200 * FACE_COUNT] === TEXTURE_LAYERS[BLOCKS[0].texture[1]], "an unregistered id falls back to id 0");
});

Deno.test("the grass side texture puts its grass at the top of the wall", () => {
  // A face's V axis points up and a texture's v = 0 is its first row, so the grass
  // band belongs in the last rows. Getting this backwards draws a green skirting
  // board, which is what it did the first time.
  const data = buildTextures();
  const size = TEXTURE_SIZE;
  const layer = TEXTURE_LAYERS["grass-side"];
  const greenness = (y: number) => {
    let sum = 0;
    for (let x = 0; x < size; x++) {
      const at = (layer * size * size + y * size + x) * 4;
      sum += data.levels[0][at + 1] - data.levels[0][at];
    }
    return sum / size;
  };
  assert(greenness(size - 1) > 30, `the top row is not grass (green over red ${greenness(size - 1).toFixed(1)})`);
  assert(greenness(0) < 10, `the bottom row is grass (green over red ${greenness(0).toFixed(1)})`);
});
