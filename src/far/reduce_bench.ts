// Brick reduction throughput (plan-far-field phase 2 verify). Run with
// `deno task bench`. The unit is one chunk: at level 1 that is eight bricks, the work
// one edited chunk costs a worker.

import { ChunkData } from "../world/chunk.ts";
import { testChunks } from "../mesh/testchunks.ts";
import { BRICK_WORDS, bricksPerChunkSide, reduceBricks, reduceChunkBrick } from "./reduce.ts";

const cases = ["hills", "terrain-like", "random 50%", "checkerboard"].map((name) => {
  const c = testChunks().find((t) => t.name === name)!;
  return { name, chunk: ChunkData.fromDense(c.ids) };
});
const words = new Uint32Array(8 * BRICK_WORDS);
const uniform = ChunkData.uniform(1);

for (const c of cases) {
  const per = bricksPerChunkSide(1);
  Deno.bench(`level 1, whole chunk (${per ** 3} bricks), ${c.name}`, { group: c.name, baseline: true }, () => {
    for (let i = 0; i < per ** 3; i++) {
      reduceChunkBrick(c.chunk, 1, i % per, Math.floor(i / per) % per, Math.floor(i / (per * per)), words, i * BRICK_WORDS);
    }
  });
  Deno.bench(`level 2, whole chunk (1 brick), ${c.name}`, { group: c.name }, () => {
    reduceChunkBrick(c.chunk, 2, 0, 0, 0, words, 0);
  });
}

// The two paths a coarse level can take, on one chunk's worth of cells.
const src = new Uint32Array(8 * BRICK_WORDS);
const offsets = new Int32Array(8);
const hills = cases[0].chunk;
for (let o = 0; o < 8; o++) {
  const solid = reduceChunkBrick(hills, 1, o & 1, (o >> 1) & 1, (o >> 2) & 1, src, o * BRICK_WORDS);
  offsets[o] = solid ? o * BRICK_WORDS : -1;
}
Deno.bench("level 2 from eight level-1 bricks", { group: "level 2", baseline: true }, () => {
  reduceBricks(src, offsets, words, 0);
});
Deno.bench("level 2 straight from the chunk", { group: "level 2" }, () => {
  reduceChunkBrick(hills, 2, 0, 0, 0, words, 0);
});
Deno.bench("level 1, uniform chunk (no voxels read)", () => {
  reduceChunkBrick(uniform, 1, 0, 0, 0, words, 0);
});
