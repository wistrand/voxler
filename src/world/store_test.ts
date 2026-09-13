import { blockBytes, PayloadArena, readParts } from "./arena.ts";
import { ChunkData } from "./chunk.ts";
import { ChunkTable } from "./chunk-table.ts";
import { CHUNK_VOLUME } from "./coords.ts";
import { CHUNK_XZ_MAX, CHUNK_XZ_MIN, CHUNK_Y_MAX, CHUNK_Y_MIN, chunkKey, keyX, keyY, keyZ } from "./keys.ts";
import { ChunkStore } from "./store.ts";
import { hash32 } from "../util/random.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function denseWith(distinct: number, seed: number): Uint16Array {
  const ids = new Uint16Array(CHUNK_VOLUME);
  for (let i = 0; i < CHUNK_VOLUME; i++) ids[i] = 1 + (i < distinct ? i : hash32(seed ^ i) % distinct);
  return ids;
}

function sameContents(a: ChunkData, b: Uint16Array): boolean {
  const out = new Uint16Array(CHUNK_VOLUME);
  a.toDense(out);
  return out.every((v, i) => v === b[i]);
}

Deno.test("chunk keys round-trip at the range limits and around zero", () => {
  const xs = [CHUNK_XZ_MIN, -1, 0, 1, CHUNK_XZ_MAX];
  const ys = [CHUNK_Y_MIN, -1, 0, 1, CHUNK_Y_MAX];
  const seen = new Set<number>();
  for (const x of xs) {
    for (const y of ys) {
      for (const z of xs) {
        const k = chunkKey(x, y, z);
        assert(Number.isSafeInteger(k) && k >= 0, `key ${k} for ${x},${y},${z}`);
        assert(keyX(k) === x && keyY(k) === y && keyZ(k) === z, `round trip ${x},${y},${z}`);
        seen.add(k);
      }
    }
  }
  assert(seen.size === xs.length * ys.length * xs.length, "keys distinct");
});

Deno.test("chunk table matches a Map under random inserts, updates, and deletes", () => {
  const table = new ChunkTable(16); // start small so it grows and rehashes
  const reference = new Map<number, number>();
  for (let step = 0; step < 200_000; step++) {
    const h = hash32(step * 2654435761);
    const key = chunkKey((h % 200) - 100, ((h >>> 8) % 20) - 10, ((h >>> 16) % 200) - 100);
    if (h % 3 === 0) {
      assert(table.delete(key) === reference.delete(key), `delete at step ${step}`);
    } else {
      table.set(key, step);
      reference.set(key, step);
    }
    if (step % 1000 === 0) {
      assert(table.size === reference.size, `size at step ${step}`);
    }
  }
  assert(table.size === reference.size, "final size");
  for (const [k, v] of reference) assert(table.get(k) === v, `get ${k}`);
  let visited = 0;
  table.forEach((k, v) => {
    visited++;
    assert(reference.get(k) === v, `forEach ${k}`);
  });
  assert(visited === reference.size, "forEach visits every entry");
  assert(table.get(chunkKey(5000, 0, 5000)) === -1, "absent key");
});

Deno.test("reserve avoids rehashing while filling to the reserved count", () => {
  const table = new ChunkTable(16);
  table.reserve(10_000);
  const before = table.rehashes;
  for (let i = 0; i < 10_000; i++) table.set(chunkKey(i % 100, 0, Math.floor(i / 100)), i);
  assert(table.rehashes === before, `rehashed ${table.rehashes - before} times`);
});

Deno.test("arena blocks round-trip, reuse freed space, and report full", () => {
  for (const shared of [false, true]) {
    const arena = new PayloadArena(1 << 20, shared);
    assert(arena.shared === shared, `shared flag ${arena.shared}`);
    const ids = denseWith(5, 1);
    const parts = ChunkData.fromDense(ids).toParts();
    const bytes = blockBytes(parts);
    const a = arena.alloc(bytes);
    arena.write(a, parts);
    assert(sameContents(arena.read(a), ids), `read back (shared ${shared})`);
    assert(sameContents(ChunkData.fromParts(readParts(arena.buffer, a)), ids), "readParts view");
    arena.release(a, bytes);
    assert(arena.alloc(bytes) === a, "freed block reused");
    let n = 1;
    while (arena.alloc(bytes) !== -1) n++;
    assert(n * 32768 <= 1 << 20 && n >= 16, `blocks before full: ${n}`); // 5 ids: 16 KiB words -> 32 KiB class
  }
});

Deno.test("store put, read, replace, and remove with stale handles", () => {
  const store = new ChunkStore({ maxChunks: 64, arenaBytes: 4 << 20, shared: false });
  const ids = denseWith(3, 2);
  const h = store.put(1, -2, 3, ChunkData.fromDense(ids));
  assert(h >= 0 && store.count === 1, "put");
  assert(store.handle(1, -2, 3) === h, "handle lookup");
  assert(sameContents(store.read(h)!, ids), "read");
  const used = store.arena.usedBytes;
  for (let i = 0; i < 10; i++) store.put(1, -2, 3, ChunkData.fromDense(denseWith(3, i)));
  assert(store.arena.usedBytes === used, "replacing frees the old block");
  assert(store.handle(1, -2, 3) === h, "replace keeps the handle");
  assert(store.remove(1, -2, 3) && store.count === 0, "remove");
  assert(store.read(h) === null && !store.isLive(h), "old handle is stale");
  assert(store.arena.usedBytes === 0, "arena empty after remove");
  const h2 = store.put(9, 9, 9, ChunkData.uniform(4));
  assert(h2 !== h && store.read(h2)!.uniformId === 4, "uniform chunk, slot reused with a new generation");
  assert(store.blockOffset(h2) === -1 && store.arena.usedBytes === 0, "uniform chunks use no arena");
});

Deno.test("store reports full instead of overflowing", () => {
  const store = new ChunkStore({ maxChunks: 2, arenaBytes: 1 << 20, shared: false });
  assert(store.put(0, 0, 0, ChunkData.uniform(1)) >= 0, "first");
  assert(store.put(1, 0, 0, ChunkData.uniform(1)) >= 0, "second");
  assert(store.put(2, 0, 0, ChunkData.uniform(1)) === -1, "slots full");
  const small = new ChunkStore({ maxChunks: 8, arenaBytes: 64 << 10, shared: false });
  const dense = ChunkData.fromDense(denseWith(200, 3)); // 32 KiB words -> 64 KiB class
  assert(small.put(0, 0, 0, dense) >= 0, "first dense block fits");
  assert(small.put(1, 0, 0, dense) === -1 && small.count === 1, "arena full, slot returned");
});

Deno.test("blockAt reads the same voxels as read(), at every index width", () => {
  // The non-allocating path decodes the block layout by hand, so it is a second reader
  // of a format with one owner (design-formats.md "Chunk storage"). Widths 0, 1, 2, 4, 8
  // and 16 bits, which is every packing the container can produce.
  const store = new ChunkStore({ maxChunks: 64, arenaBytes: 4 << 20, shared: false });
  const cases = [1, 2, 3, 5, 17, 300];
  cases.forEach((distinct, i) => {
    const ids = denseWith(distinct, 7 + i);
    const data = ChunkData.fromDense(ids);
    assert(store.put(i, 0, 0, data) >= 0, `put ${distinct}`);
    const view = store.read(store.handle(i, 0, 0))!;
    for (let v = 0; v < CHUNK_VOLUME; v += 7) {
      const want = view.get(v);
      const got = store.blockAt(i, 0, 0, v);
      assert(got === want, `distinct ${distinct} voxel ${v}: blockAt ${got}, read ${want}`);
    }
  });
  assert(store.blockAt(999, 0, 0, 0) === -1, "a chunk that is not stored reads as -1");
});
