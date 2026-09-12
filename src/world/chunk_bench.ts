// Chunk container throughput and memory (plan-voxel-data phase 1 verify).
// Run with `deno task bench`. Inputs: a terrain-like chunk (4 ids in horizontal
// layers plus scattered caves), a noisy 200-id chunk, and a uniform chunk.

import { ChunkData } from "./chunk.ts";
import { CHUNK_VOLUME, voxelIndex } from "./coords.ts";

function terrainLike(): Uint16Array {
  const ids = new Uint16Array(CHUNK_VOLUME);
  let s = 1;
  for (let y = 0; y < 32; y++) {
    for (let z = 0; z < 32; z++) {
      for (let x = 0; x < 32; x++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const id = y < 10 ? 1 : y < 14 ? 2 : y === 14 ? 3 : 0; // stone, dirt, grass, air
        ids[voxelIndex(x, y, z)] = y < 14 && s % 23 === 0 ? 0 : id; // cave holes
      }
    }
  }
  return ids;
}

function noisy(distinct: number): Uint16Array {
  const ids = new Uint16Array(CHUNK_VOLUME);
  let s = 7;
  for (let i = 0; i < CHUNK_VOLUME; i++) ids[i] = (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) % distinct;
  return ids;
}

const terrain = terrainLike();
const many = noisy(200);
const out = new Uint16Array(CHUNK_VOLUME);
const terrainChunk = ChunkData.fromDense(terrain);
const manyChunk = ChunkData.fromDense(many);

console.log("chunk payload bytes:");
for (const [name, chunk] of [
  ["uniform", ChunkData.uniform(1)],
  ["terrain-like, 4 ids", terrainChunk],
  ["noisy, 200 ids", manyChunk],
] as const) {
  console.log(`  ${name.padEnd(22)} ${String(chunk.byteSize).padStart(6)} B  (${chunk.bitsPerVoxel} bits/voxel)`);
}

Deno.bench("fromDense, terrain-like (4 ids)", () => {
  ChunkData.fromDense(terrain);
});

Deno.bench("fromDense, 200 ids", () => {
  ChunkData.fromDense(many);
});

Deno.bench("toDense, terrain-like", () => {
  terrainChunk.toDense(out);
});

Deno.bench("toDense, 200 ids", () => {
  manyChunk.toDense(out);
});

Deno.bench("get x 32768, terrain-like", () => {
  let sum = 0;
  for (let i = 0; i < CHUNK_VOLUME; i++) sum += terrainChunk.get(i);
  if (sum < 0) throw new Error("unreachable");
});
