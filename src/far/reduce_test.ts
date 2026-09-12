import { BLOCK_FAR_SOLID, BLOCK_TABLE_FLOATS, BLOCK_TABLE_STRIDE, BLOCKS, farColorTable, MAX_BLOCK_TYPES } from "../world/blocks.ts";
import { buildTextures, TEXTURE_LAYERS, TEXTURE_MIPS } from "../render/textures.ts";
import { ChunkData } from "../world/chunk.ts";
import { CHUNK_VOLUME, voxelIndex } from "../world/coords.ts";
import { random01 } from "../util/random.ts";
import {
  BRICK_CELLS,
  BRICK_WORDS,
  cellBlock,
  cellIndex,
  cellSolid,
  reduceBricks,
  reduceChunkBrick,
} from "./reduce.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function denseChunk(fill: (x: number, y: number, z: number) => number): ChunkData {
  const dense = new Uint16Array(CHUNK_VOLUME);
  for (let y = 0; y < 32; y++) {
    for (let z = 0; z < 32; z++) {
      for (let x = 0; x < 32; x++) dense[voxelIndex(x, y, z)] = fill(x, y, z);
    }
  }
  return ChunkData.fromDense(dense);
}

Deno.test("a uniform chunk reduces without reading voxels", () => {
  const words = new Uint32Array(BRICK_WORDS);
  // ChunkData.uniform has no voxel storage at all, so a reduction that read one
  // would throw rather than quietly return air.
  assert(reduceChunkBrick(ChunkData.uniform(4), 1, 0, 0, 0, words, 0), "a solid uniform chunk gives a solid brick");
  for (let i = 0; i < BRICK_CELLS ** 3; i++) {
    assert(cellSolid(words, 0, i), `cell ${i} is not solid`);
    assert(cellBlock(words, 0, i) === 4, `cell ${i} has id ${cellBlock(words, 0, i)}`);
  }
  assert(!reduceChunkBrick(ChunkData.uniform(0), 1, 0, 0, 0, words, 0), "air reduces to no brick");
  // Water is solid to the far field: it has no blending, and drawing a sea as its own
  // bed is worse than drawing it as opaque water.
  assert(reduceChunkBrick(ChunkData.uniform(10), 1, 0, 0, 0, words, 0), "water is solid in the far field");
});

Deno.test("a cell is solid when any voxel in it is opaque, and takes an id from it", () => {
  const chunk = denseChunk((x, y, z) => (x === 5 && y === 9 && z === 30 ? 7 : 0));
  const words = new Uint32Array(BRICK_WORDS);
  // Level 1: 2-voxel cells, so voxel (5, 9, 30) is cell (2, 4, 15), in brick
  // (0, 0, 1) of the chunk.
  assert(reduceChunkBrick(chunk, 1, 0, 0, 1, words, 0), "the brick holding the voxel is solid");
  let solid = 0;
  for (let i = 0; i < BRICK_CELLS ** 3; i++) if (cellSolid(words, 0, i)) solid++;
  assert(solid === 1, `${solid} solid cells for one opaque voxel`);
  const i = cellIndex(2, 4, 7);
  assert(cellSolid(words, 0, i), "the solid cell is the one the voxel lands in");
  assert(cellBlock(words, 0, i) === 7, `the cell has id ${cellBlock(words, 0, i)}`);
  assert(!reduceChunkBrick(chunk, 1, 1, 0, 1, words, 0), "the neighboring brick is empty");
});

Deno.test("level 2 from level 1 bricks matches level 2 straight from the chunk", () => {
  const fill = (x: number, y: number, z: number) => {
    const v = random01(11, x * 4096 + y * 64 + z);
    if (v < 0.1) return 1 + Math.floor(v * 70) % 5; // opaque
    if (v < 0.14) return 10; // water, solid to the far field like everything but air
    return 0;
  };
  const chunk = denseChunk(fill);
  // The chunk's eight level-1 bricks, in the octant order reduceBricks expects.
  const src = new Uint32Array(8 * BRICK_WORDS);
  const offsets = new Int32Array(8).fill(-1);
  for (let o = 0; o < 8; o++) {
    const bx = o & 1, by = (o >> 1) & 1, bz = (o >> 2) & 1;
    if (reduceChunkBrick(chunk, 1, bx, by, bz, src, o * BRICK_WORDS)) offsets[o] = o * BRICK_WORDS;
  }
  const fromLevel1 = new Uint32Array(BRICK_WORDS);
  const direct = new Uint32Array(BRICK_WORDS);
  assert(reduceBricks(src, offsets, fromLevel1, 0), "the reduced brick has solid cells");
  assert(reduceChunkBrick(chunk, 2, 0, 0, 0, direct, 0), "the direct brick has solid cells");
  for (let z = 0; z < BRICK_CELLS; z++) {
    for (let y = 0; y < BRICK_CELLS; y++) {
      for (let x = 0; x < BRICK_CELLS; x++) {
        const i = cellIndex(x, y, z);
        assert(
          cellSolid(fromLevel1, 0, i) === cellSolid(direct, 0, i),
          `cell (${x}, ${y}, ${z}) solid ${cellSolid(fromLevel1, 0, i)} against ${cellSolid(direct, 0, i)}`,
        );
        if (!cellSolid(direct, 0, i)) continue;
        // Either route names an id that is actually in the cell; which one depends on
        // the scan order, so the test asks for membership, not equality.
        const id = cellBlock(fromLevel1, 0, i);
        let found = false;
        for (let vz = 0; vz < 4 && !found; vz++) {
          for (let vy = 0; vy < 4 && !found; vy++) {
            for (let vx = 0; vx < 4 && !found; vx++) {
              if (fill(x * 4 + vx, y * 4 + vy, z * 4 + vz) === id) found = true;
            }
          }
        }
        assert(found, `cell (${x}, ${y}, ${z}) has id ${id}, which is not in its voxels`);
      }
    }
  }
});

Deno.test("an empty octant leaves its cells empty", () => {
  const src = new Uint32Array(BRICK_WORDS);
  reduceChunkBrick(ChunkData.uniform(1), 1, 0, 0, 0, src, 0);
  const offsets = new Int32Array([0, -1, -1, -1, -1, -1, -1, -1]);
  const out = new Uint32Array(BRICK_WORDS);
  assert(reduceBricks(src, offsets, out, 0), "the one solid octant gives a solid brick");
  let solid = 0;
  for (let i = 0; i < BRICK_CELLS ** 3; i++) if (cellSolid(out, 0, i)) solid++;
  assert(solid === (BRICK_CELLS / 2) ** 3, `${solid} solid cells, expected one octant's ${(BRICK_CELLS / 2) ** 3}`);
  for (let z = 0; z < BRICK_CELLS / 2; z++) {
    for (let y = 0; y < BRICK_CELLS / 2; y++) {
      for (let x = 0; x < BRICK_CELLS / 2; x++) {
        assert(cellSolid(out, 0, cellIndex(x, y, z)), `cell (${x}, ${y}, ${z}) of the solid octant is empty`);
      }
    }
  }
});

Deno.test("the far color table marks exactly the solid ids and averages their texture", () => {
  const colors = new Float32Array(BLOCK_TABLE_FLOATS);
  farColorTable(colors, 0, null);
  for (let id = 0; id < MAX_BLOCK_TYPES; id++) {
    const want = BLOCK_FAR_SOLID[id];
    const got = colors[id * BLOCK_TABLE_STRIDE + 3];
    assert(got === want, `id ${id} alpha ${got}, solid ${want}`);
  }
  const grass = BLOCKS.find((b) => b.name === "grass")!;
  for (let c = 0; c < 3; c++) {
    const got = colors[grass.id * BLOCK_TABLE_STRIDE + c];
    assert(Math.abs(got - grass.color[c]) < 1e-6, `far color ${got} against the display color ${grass.color[c]}`);
  }
  const textures = buildTextures();
  farColorTable(colors, 0, textures);
  const top = textures.levels[TEXTURE_MIPS - 1];
  const layer = TEXTURE_LAYERS[grass.texture[0]];
  for (let c = 0; c < 3; c++) {
    const want = top[layer * 4 + c] / 255;
    const got = colors[grass.id * BLOCK_TABLE_STRIDE + c];
    assert(Math.abs(got - want) < 1e-6, `grass far color ${got} against ${want}`);
  }
});
