import { ChunkData, widthFor } from "./chunk.ts";
import { CHUNK_VOLUME, voxelIndex } from "./coords.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// Deterministic pseudo-random ints for test data.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
}

// Dense ids using exactly `distinct` different ids (all appear at least once).
function denseWith(distinct: number, seed: number): Uint16Array {
  const r = rng(seed);
  const ids = new Uint16Array(CHUNK_VOLUME);
  for (let i = 0; i < CHUNK_VOLUME; i++) ids[i] = 100 + (i < distinct ? i : r() % distinct);
  return ids;
}

function assertSame(chunk: ChunkData, expected: Uint16Array, what: string): void {
  const out = new Uint16Array(CHUNK_VOLUME);
  chunk.toDense(out);
  for (let i = 0; i < CHUNK_VOLUME; i++) {
    if (out[i] !== expected[i]) throw new Error(`${what}: voxel ${i} is ${out[i]}, expected ${expected[i]}`);
    if (i % 997 === 0 && chunk.get(i) !== expected[i]) throw new Error(`${what}: get(${i}) disagrees`);
  }
}

Deno.test("widths are the smallest power of two that fits", () => {
  const cases: [number, number][] = [[1, 0], [2, 1], [3, 2], [4, 2], [5, 4], [16, 4], [17, 8], [256, 8], [257, 16]];
  for (const [n, bits] of cases) assert(widthFor(n) === bits, `widthFor(${n}) = ${widthFor(n)}, expected ${bits}`);
});

Deno.test("fromDense round-trips at every width", () => {
  for (const distinct of [1, 2, 3, 4, 5, 16, 17, 256, 257, 1000]) {
    const ids = denseWith(distinct, distinct);
    const chunk = ChunkData.fromDense(ids);
    assert(chunk.bitsPerVoxel === widthFor(distinct), `${distinct} ids: ${chunk.bitsPerVoxel} bits`);
    assert(chunk.paletteLength === distinct, `${distinct} ids: palette ${chunk.paletteLength}`);
    assert(chunk.isUniform === (distinct === 1), `${distinct} ids: uniform flag`);
    assertSame(chunk, ids, `${distinct} ids`);
  }
});

Deno.test("set grows the palette through every width and matches a reference", () => {
  const r = rng(42);
  const reference = new Uint16Array(CHUNK_VOLUME).fill(7);
  const chunk = ChunkData.uniform(7);
  const everSet = new Set<number>([7]);
  const put = (i: number, id: number) => {
    reference[i] = id;
    chunk.set(i, id);
    everSet.add(id);
  };
  // Ids 0..299 in order first, so every width from 1 to 16 bits is crossed, then
  // random overwrites. (Don't rely on `r() % n` covering all n: this LCG's low bits
  // cycle with short periods.)
  for (let id = 0; id < 300; id++) put((id * 97) % CHUNK_VOLUME, id);
  for (let step = 0; step < 40_000; step++) put(r() % CHUNK_VOLUME, step < 20_000 ? (r() >>> 16) % 300 : 7);
  assertSame(chunk, reference, "after random sets");
  // No compaction ran, so the palette holds every id ever set.
  assert(chunk.paletteLength === everSet.size, `palette ${chunk.paletteLength}, ids set ${everSet.size}`);
  assert(chunk.bitsPerVoxel === 16, `expected 16 bits after ${everSet.size} ids, got ${chunk.bitsPerVoxel}`);
});

Deno.test("compact drops unused ids and returns to uniform", () => {
  const chunk = ChunkData.uniform(1);
  for (let i = 0; i < 20; i++) chunk.set(i, 10 + i); // 21 ids: 8 bits
  assert(chunk.bitsPerVoxel === 8, `8 bits, got ${chunk.bitsPerVoxel}`);
  for (let i = 2; i < 20; i++) chunk.set(i, 1); // only 1, 10, 11 remain in use
  chunk.compact();
  assert(chunk.paletteLength === 3 && chunk.bitsPerVoxel === 2, `3 ids at 2 bits, got ${chunk.paletteLength} at ${chunk.bitsPerVoxel}`);
  assert(chunk.get(0) === 10 && chunk.get(1) === 11 && chunk.get(2) === 1, "contents kept");
  chunk.set(0, 1);
  chunk.set(1, 1);
  chunk.compact();
  assert(chunk.isUniform && chunk.uniformId === 1, "back to uniform");
});

Deno.test("setting a uniform chunk to its own id keeps it uniform", () => {
  const chunk = ChunkData.uniform(5);
  chunk.set(123, 5);
  assert(chunk.isUniform && chunk.byteSize === 2, "still uniform, 2 bytes");
});

Deno.test("voxel index order is x + z*32 + y*1024", () => {
  assert(voxelIndex(1, 0, 0) === 1, "x");
  assert(voxelIndex(0, 0, 1) === 32, "z");
  assert(voxelIndex(0, 1, 0) === 1024, "y");
  assert(voxelIndex(31, 31, 31) === CHUNK_VOLUME - 1, "last");
  const chunk = ChunkData.uniform(0);
  chunk.set(voxelIndex(3, 4, 5), 9);
  assert(chunk.get(3 + 5 * 32 + 4 * 1024) === 9, "set via voxelIndex");
});

Deno.test("parts round-trip for uniform and packed chunks", () => {
  for (const distinct of [1, 3, 300]) {
    const ids = denseWith(distinct, 9);
    const back = ChunkData.fromParts(ChunkData.fromDense(ids).toParts());
    assertSame(back, ids, `parts with ${distinct} ids`);
  }
});

Deno.test("payload size per width", () => {
  const cases: [number, number][] = [[1, 2], [2, 4096 + 4], [4, 8192 + 8], [16, 16384 + 32], [256, 32768 + 512]];
  for (const [distinct, bytes] of cases) {
    const size = ChunkData.fromDense(denseWith(distinct, 3)).byteSize;
    assert(size === bytes, `${distinct} ids: ${size} bytes, expected ${bytes}`);
  }
});
