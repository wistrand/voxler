import { ChunkData } from "../world/chunk.ts";
import { BinaryMesher, NO_MERGE } from "./binary.ts";
import { coverage, diffCoverage } from "./coverage.ts";
import { uniformPlanes } from "./planes.ts";
import { decodeQuad, newQuad } from "./quad.ts";
import { meshReference } from "./reference.ts";
import { neighborSetups, testChunks } from "./testchunks.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// Checks one binary mesh against the reference mesh of the same input: same number
// of quads, well formed, identical coverage.
function assertMatchesReference(mesher: BinaryMesher, ids: Uint16Array, planes: Uint32Array, what: string): void {
  const reference = meshReference(ids, planes);
  const binary = mesher.mesh(ChunkData.fromDense(ids), planes, NO_MERGE);
  assert(binary.count === reference.count, `${what}: ${binary.count} quads, reference ${reference.count}`);
  const cov = coverage(binary);
  assert(cov.overlaps === 0 && cov.outOfBounds === 0 && cov.faceMismatches === 0, `${what}: malformed mesh`);
  const diff = diffCoverage(coverage(reference).map, cov.map);
  assert(diff === null, `${what}: ${diff}`);
}

Deno.test("unmerged binary output equals the reference on every test chunk and neighbor setup", () => {
  const mesher = new BinaryMesher();
  for (const c of testChunks()) {
    for (const n of neighborSetups()) assertMatchesReference(mesher, c.ids, n.planes, `${c.name}, ${n.name}`);
  }
});

Deno.test("uniform chunks skip the column build and still match the reference", () => {
  const mesher = new BinaryMesher();
  const full = new Uint16Array(32768).fill(4);
  for (const n of neighborSetups()) {
    const reference = meshReference(full, n.planes);
    const binary = mesher.mesh(ChunkData.uniform(4), n.planes, NO_MERGE);
    assert(binary.count === reference.count, `${n.name}: ${binary.count} vs ${reference.count}`);
    assert(diffCoverage(coverage(reference).map, coverage(binary).map) === null, `${n.name}: coverage`);
  }
  assert(mesher.mesh(ChunkData.uniform(0), uniformPlanes(false)).count === 0, "uniform air has no faces");
});

Deno.test("greedy output covers exactly what the reference covers, everywhere", () => {
  const mesher = new BinaryMesher();
  for (const c of testChunks()) {
    for (const n of neighborSetups()) {
      const what = `${c.name}, ${n.name}`;
      const reference = meshReference(c.ids, n.planes);
      const greedy = mesher.mesh(ChunkData.fromDense(c.ids), n.planes);
      const cov = coverage(greedy);
      assert(cov.overlaps === 0 && cov.outOfBounds === 0 && cov.faceMismatches === 0, `${what}: malformed mesh`);
      const diff = diffCoverage(coverage(reference).map, cov.map);
      assert(diff === null, `${what}: ${diff}`);
      assert(greedy.count <= reference.count, `${what}: greedy ${greedy.count} > reference ${reference.count}`);
    }
  }
});

// Greedy quad counts when merging was written (plan-meshing phase 3), per neighbor
// setup [empty, opaque, random]. Upper bounds: a better merge may lower them, a
// regression that still covers correctly shows up here.
const GREEDY_BASELINE: Record<string, [number, number, number]> = {
  "empty": [0, 0, 0],
  "full": [6, 0, 1365],
  "single voxel, center": [6, 6, 6],
  "single voxel, corner": [6, 3, 4],
  "checkerboard": [98304, 95232, 96791],
  "random 10%": [14804, 14306, 14577],
  "random 50%": [32664, 31281, 32264],
  "random 90%": [14963, 14282, 15632],
  "random 50%, 5 materials": [46168, 43556, 45014],
  "terrain-like": [3867, 3614, 4259],
  "hills": [1032, 945, 1591],
  "slab x < 8": [6, 1, 457],
  "hills with water": [1032, 945, 1591],
  "water and glass": [13411, 12959, 13587],
  "uniform water": [0, 0, 0],
};

Deno.test("greedy quad counts stay at or below the recorded baseline", () => {
  const mesher = new BinaryMesher();
  const setups = neighborSetups();
  for (const c of testChunks()) {
    const baseline = GREEDY_BASELINE[c.name];
    assert(baseline !== undefined, `no baseline for ${c.name}`);
    setups.forEach((n, i) => {
      const count = mesher.mesh(ChunkData.fromDense(c.ids), n.planes).count;
      assert(count <= baseline[i], `${c.name}, ${n.name}: ${count} quads, baseline ${baseline[i]}`);
    });
  }
});

Deno.test("merged shapes: a full chunk is 6 quads of 32x32, a slab 6", () => {
  const mesher = new BinaryMesher();
  const q = newQuad();
  const full = mesher.mesh(ChunkData.uniform(1), uniformPlanes(false));
  assert(full.count === 6, `full: ${full.count}`);
  for (let i = 0; i < 6; i++) {
    decodeQuad(full.quads[i * 2], full.quads[i * 2 + 1], q);
    assert(q.w === 32 && q.h === 32 && q.face === i, `full quad ${i}: ${q.w}x${q.h} face ${q.face}`);
  }
  const slab = testChunks().find((c) => c.name === "slab x < 8")!;
  assert(mesher.mesh(ChunkData.fromDense(slab.ids), uniformPlanes(false)).count === 6, "slab");
});

Deno.test("a reused mesher leaves nothing behind between chunks", () => {
  const mesher = new BinaryMesher();
  const chunks = testChunks();
  const planes = neighborSetups()[2].planes;
  const first = chunks.find((c) => c.name === "terrain-like")!;
  const before = coverage(mesher.mesh(ChunkData.fromDense(first.ids), planes)).map.slice();
  for (const c of chunks) mesher.mesh(ChunkData.fromDense(c.ids), planes);
  const after = coverage(mesher.mesh(ChunkData.fromDense(first.ids), planes)).map;
  assert(diffCoverage(before, after) === null, "same chunk, same mesh after other chunks");
});
