import { random01 } from "../util/random.ts";
import { ChunkData } from "./chunk.ts";
import { CHUNK_SIZE, CHUNK_VOLUME, voxelIndex } from "./coords.ts";
import { chunkKey } from "./keys.ts";
import { DEFAULT_RAYCAST, newRayHit, type RayHit, raycastVoxels } from "./raycast.ts";
import { ChunkStore } from "./store.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// The oracle: sample the ray at a fine step and take the first solid voxel. Slow and
// obviously correct, which is the point; it also catches a traversal that skips a
// voxel, because a skipped voxel shows up as a different first hit.
function reference(
  ids: Map<number, number>,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): { hit: boolean; x: number; y: number; z: number; id: number } {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const nx = dx / len, ny = dy / len, nz = dz / len;
  const step = 1 / 512;
  let last = -1;
  for (let t = 0; t <= maxDistance; t += step) {
    const x = Math.floor(ox + nx * t), y = Math.floor(oy + ny * t), z = Math.floor(oz + nz * t);
    const at = voxelKey(x, y, z);
    if (at === last) continue;
    last = at;
    const id = ids.get(at) ?? 0;
    if (id !== 0) return { hit: true, x, y, z, id };
  }
  return { hit: false, x: 0, y: 0, z: 0, id: 0 };
}

function voxelKey(x: number, y: number, z: number): number {
  return (x + 512) + (y + 512) * 1024 + (z + 512) * 1024 * 1024;
}

// A world of chunks in [0, 2)^3: a mix of uniform air, uniform stone and dense ones,
// with the voxel ids also returned as a flat map for the oracle.
function world(seed: number): { store: ChunkStore; ids: Map<number, number> } {
  const store = new ChunkStore({ maxChunks: 256, arenaBytes: 8 << 20, shared: false });
  const ids = new Map<number, number>();
  for (let cx = -1; cx <= 1; cx++) {
    for (let cy = -1; cy <= 1; cy++) {
      for (let cz = -1; cz <= 1; cz++) {
        const r = random01(seed, (cx + 1) * 9 + (cy + 1) * 3 + (cz + 1));
        let chunk: ChunkData;
        if (r < 0.55) {
          chunk = ChunkData.uniform(0); // uniform air: the case the skip is for
        } else if (r < 0.7) {
          chunk = ChunkData.uniform(1);
          for (let i = 0; i < CHUNK_VOLUME; i++) setId(ids, cx, cy, cz, i, 1);
        } else {
          const dense = new Uint16Array(CHUNK_VOLUME);
          for (let i = 0; i < CHUNK_VOLUME; i++) {
            const v = random01(seed * 31 + (cx + 1) * 9 + (cy + 1) * 3 + (cz + 1), i) < 0.06 ? 1 + (i % 3) : 0;
            dense[i] = v;
            if (v !== 0) setId(ids, cx, cy, cz, i, v);
          }
          chunk = ChunkData.fromDense(dense);
        }
        if (store.put(cx, cy, cz, chunk) === -1) throw new Error("store full");
      }
    }
  }
  return { store, ids };
}

function setId(ids: Map<number, number>, cx: number, cy: number, cz: number, i: number, id: number): void {
  const x = cx * CHUNK_SIZE + (i & 31);
  const z = cz * CHUNK_SIZE + ((i >>> 5) & 31);
  const y = cy * CHUNK_SIZE + (i >>> 10);
  ids.set(voxelKey(x, y, z), id);
}

Deno.test("the traversal finds the same first voxel as a finely sampled ray", () => {
  const out: RayHit = newRayHit();
  for (let seed = 1; seed <= 6; seed++) {
    const { store, ids } = world(seed);
    for (let i = 0; i < 500; i++) {
      const r = (j: number) => random01(seed * 997 + i, j);
      const ox = r(0) * 64 - 32, oy = r(1) * 64 - 32, oz = r(2) * 64 - 32;
      // Skip origins inside something solid: the oracle and the traversal agree
      // there trivially, and the interesting case is a ray crossing chunks.
      if ((ids.get(voxelKey(Math.floor(ox), Math.floor(oy), Math.floor(oz))) ?? 0) !== 0) continue;
      const dx = r(3) * 2 - 1, dy = r(4) * 2 - 1, dz = r(5) * 2 - 1;
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const want = reference(ids, ox, oy, oz, dx, dy, dz, 40);
      const got = raycastVoxels(store, ox, oy, oz, dx, dy, dz, out, { maxDistance: 40, opaqueOnly: false });
      // The reference walks past the loaded chunks; the traversal stops there.
      const inside = want.hit && want.x >= -32 && want.x < 64 && want.y >= -32 && want.y < 64 &&
        want.z >= -32 && want.z < 64;
      if (!inside) continue;
      assert(got === want.hit, `seed ${seed} ray ${i}: hit ${got}, reference ${want.hit}`);
      if (!got) continue;
      assert(
        out.x === want.x && out.y === want.y && out.z === want.z,
        `seed ${seed} ray ${i}: hit (${out.x}, ${out.y}, ${out.z}), reference (${want.x}, ${want.y}, ${want.z})`,
      );
      assert(out.id === want.id, `seed ${seed} ray ${i}: id ${out.id}, reference ${want.id}`);
    }
  }
});

Deno.test("the voxel a ray came from is the neighbour across the face it entered", () => {
  const store = new ChunkStore({ maxChunks: 64, arenaBytes: 1 << 20, shared: false });
  const dense = new Uint16Array(CHUNK_VOLUME);
  dense[voxelIndex(16, 16, 16)] = 1;
  if (store.put(0, 0, 0, ChunkData.fromDense(dense)) === -1) throw new Error("store full");
  const out = newRayHit();
  const cases: [number[], number[], number[], number][] = [
    [[0.5, 16.5, 16.5], [1, 0, 0], [15, 16, 16], 1], // entered through -X
    [[31.5, 16.5, 16.5], [-1, 0, 0], [17, 16, 16], 0],
    [[16.5, 0.5, 16.5], [0, 1, 0], [16, 15, 16], 3],
    [[16.5, 31.5, 16.5], [0, -1, 0], [16, 17, 16], 2],
    [[16.5, 16.5, 0.5], [0, 0, 1], [16, 16, 15], 5],
    [[16.5, 16.5, 31.5], [0, 0, -1], [16, 16, 17], 4],
  ];
  for (const [origin, dir, from, face] of cases) {
    const ok = raycastVoxels(store, origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], out);
    assert(ok, `ray from ${origin} along ${dir} missed`);
    assert(out.x === 16 && out.y === 16 && out.z === 16, `hit (${out.x}, ${out.y}, ${out.z})`);
    assert(out.face === face, `entered through face ${out.face}, expected ${face}`);
    assert(
      out.fromX === from[0] && out.fromY === from[1] && out.fromZ === from[2],
      `came from (${out.fromX}, ${out.fromY}, ${out.fromZ}), expected ${from}`,
    );
  }
});

Deno.test("a ray starting inside a solid voxel hits it with no face", () => {
  const store = new ChunkStore({ maxChunks: 64, arenaBytes: 1 << 20, shared: false });
  if (store.put(0, 0, 0, ChunkData.uniform(1)) === -1) throw new Error("store full");
  const out = newRayHit();
  assert(raycastVoxels(store, 8.5, 8.5, 8.5, 1, 0, 0, out), "should hit at once");
  assert(out.x === 8 && out.y === 8 && out.z === 8, `hit (${out.x}, ${out.y}, ${out.z})`);
  assert(out.face === -1 && out.distance === 0, `face ${out.face}, distance ${out.distance}`);
  assert(out.fromX === 8 && out.fromY === 8 && out.fromZ === 8, "came from itself");
});

Deno.test("a ray stops at the edge of what is loaded, and at its maximum distance", () => {
  const store = new ChunkStore({ maxChunks: 64, arenaBytes: 1 << 20, shared: false });
  if (store.put(0, 0, 0, ChunkData.uniform(0)) === -1) throw new Error("store full");
  const out = newRayHit();
  assert(!raycastVoxels(store, 1.5, 1.5, 1.5, 1, 0, 0, out), "nothing loaded past the chunk");
  if (store.put(1, 0, 0, ChunkData.uniform(1)) === -1) throw new Error("store full");
  assert(raycastVoxels(store, 1.5, 1.5, 1.5, 1, 0, 0, out), "now it hits the next chunk");
  assert(out.x === CHUNK_SIZE, `hit x ${out.x}`);
  assert(
    !raycastVoxels(store, 1.5, 1.5, 1.5, 1, 0, 0, out, { maxDistance: 4, opaqueOnly: false }),
    "and not within four voxels",
  );
  assert(DEFAULT_RAYCAST.maxDistance > 0, "the default reaches somewhere");
});

Deno.test("uniform air chunks are crossed without visiting their voxels", () => {
  // Thirty-one chunks of air in a row, then stone: a traversal that stepped voxel by
  // voxel would read the store about a thousand times.
  const store = new ChunkStore({ maxChunks: 64, arenaBytes: 1 << 20, shared: false });
  for (let cx = 0; cx < 20; cx++) {
    if (store.put(cx, 0, 0, ChunkData.uniform(cx === 19 ? 1 : 0)) === -1) throw new Error("store full");
  }
  let reads = 0;
  const counting = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "read") reads++;
      return Reflect.get(target, prop, receiver);
    },
  }) as ChunkStore;
  const out = newRayHit();
  assert(
    raycastVoxels(counting, 0.5, 0.5, 0.5, 1, 0.01, 0.01, out, { maxDistance: 1024, opaqueOnly: false }),
    "should reach the stone",
  );
  assert(out.x === 19 * CHUNK_SIZE, `hit x ${out.x}, expected ${19 * CHUNK_SIZE}`);
  assert(reads === 0, `${reads} chunk reads across uniform chunks`);
});
