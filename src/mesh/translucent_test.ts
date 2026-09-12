import { ChunkData } from "../world/chunk.ts";
import { CHUNK_VOLUME, voxelIndex } from "../world/coords.ts";
import { BinaryMesher, NO_MERGE } from "./binary.ts";
import { coverage, diffCoverage } from "./coverage.ts";
import { newBorders, uniformPlanes } from "./planes.ts";
import { FACE_POS_X } from "./quad.ts";
import { meshReference, meshReferenceTranslucent } from "./reference.ts";
import { GLASS, neighborSetups, testChunks, WATER } from "./testchunks.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const STONE = 1;

// Unmerged opaque and translucent face counts for a chunk given as voxel list.
function faces(
  voxels: [number, number, number, number][],
  planes = uniformPlanes(false),
  borders: Uint16Array | null = null,
): [number, number] {
  const ids = new Uint16Array(CHUNK_VOLUME);
  for (const [x, y, z, id] of voxels) ids[voxelIndex(x, y, z)] = id;
  const mesher = new BinaryMesher();
  const opaque = mesher.mesh(ChunkData.fromDense(ids), planes, { merge: false, borders }).count;
  return [opaque, mesher.translucent.count];
}

Deno.test("translucent rules inside a chunk", () => {
  let [o, t] = faces([[5, 5, 5, WATER]]);
  assert(o === 0 && t === 6, `lone water: ${o} opaque, ${t} translucent`);
  [o, t] = faces([[5, 5, 5, WATER], [6, 5, 5, STONE]]);
  assert(o === 6 && t === 5, `water by stone: stone keeps 6 faces, water loses 1 (${o}, ${t})`);
  [o, t] = faces([[5, 5, 5, WATER], [6, 5, 5, WATER]]);
  assert(o === 0 && t === 10, `two waters hide their shared faces (${t})`);
  [o, t] = faces([[5, 5, 5, WATER], [6, 5, 5, GLASS]]);
  assert(o === 0 && t === 12, `water by glass: both shared faces show (${t})`);
});

Deno.test("translucent rules across the chunk border", () => {
  // Water at x = 31; the +X border decides its +X face.
  const across = (id: number, withBorders: boolean) => {
    const planes = uniformPlanes(false);
    if (id === STONE) planes.fill(0xffffffff, FACE_POS_X * 32, FACE_POS_X * 32 + 32);
    const borders = newBorders().fill(id, FACE_POS_X * 1024, FACE_POS_X * 1024 + 1024);
    return faces([[31, 5, 5, WATER]], planes, withBorders ? borders : null)[1];
  };
  assert(across(0, true) === 6, "air across: face shows");
  assert(across(STONE, true) === 5, "stone across: face hidden");
  assert(across(WATER, true) === 5, "water across: face hidden");
  assert(across(GLASS, true) === 6, "glass across: face shows");
  assert(across(WATER, false) === 6, "no border ids: water across counts as different");
});

Deno.test("uniform translucent chunks: hidden by the same id and by opaque, shown to air", () => {
  const mesher = new BinaryMesher();
  const water = ChunkData.uniform(WATER);
  assert(mesher.mesh(water, uniformPlanes(false)).count === 0, "no opaque faces");
  assert(mesher.translucent.count === 6, `air around: ${mesher.translucent.count}`);
  mesher.mesh(water, uniformPlanes(true));
  assert(mesher.translucent.count === 0, "stone around");
  mesher.mesh(water, uniformPlanes(false), { borders: newBorders().fill(WATER) });
  assert(mesher.translucent.count === 0, "water around");
});

Deno.test("translucent output matches the reference on every test chunk and neighbor setup", () => {
  const mesher = new BinaryMesher();
  for (const c of testChunks()) {
    const chunk = ChunkData.fromDense(c.ids);
    for (const n of neighborSetups()) {
      for (const borders of [n.borders, null]) {
        const what = `${c.name}, ${n.name}, ${borders ? "borders" : "no borders"}`;
        const reference = meshReferenceTranslucent(c.ids, n.planes, borders);
        const expected = coverage(reference).map;
        mesher.mesh(chunk, n.planes, { merge: false, borders });
        assert(mesher.translucent.count === reference.count, `${what}: ${mesher.translucent.count} vs ${reference.count}`);
        assert(diffCoverage(expected, coverage(mesher.translucent).map) === null, `${what}: unmerged coverage`);
        const opaque = mesher.mesh(chunk, n.planes, { borders });
        const cov = coverage(mesher.translucent);
        assert(cov.overlaps === 0 && cov.outOfBounds === 0 && cov.faceMismatches === 0, `${what}: malformed`);
        const diff = diffCoverage(expected, cov.map);
        assert(diff === null, `${what}: greedy ${diff}`);
        // Translucent voxels never hide opaque faces.
        const opaqueDiff = diffCoverage(coverage(meshReference(c.ids, n.planes)).map, coverage(opaque).map);
        assert(opaqueDiff === null, `${what}: opaque ${opaqueDiff}`);
      }
    }
  }
});

// Greedy translucent quad counts when phase 6 landed, per setup [empty, opaque,
// random], with border ids. Upper bounds, as GREEDY_BASELINE in binary_test.ts.
const TRANSLUCENT_BASELINE: Record<string, [number, number, number]> = {
  "hills with water": [48, 28, 93],
  "water and glass": [12872, 12365, 12779],
  "uniform water": [6, 0, 1223],
};

Deno.test("greedy translucent quad counts stay at or below the recorded baseline", () => {
  const mesher = new BinaryMesher();
  for (const c of testChunks()) {
    const baseline = TRANSLUCENT_BASELINE[c.name] ?? [0, 0, 0];
    neighborSetups().forEach((n, i) => {
      mesher.mesh(ChunkData.fromDense(c.ids), n.planes, { borders: n.borders });
      const count = mesher.translucent.count;
      assert(count <= baseline[i], `${c.name}, ${n.name}: ${count} translucent quads, baseline ${baseline[i]}`);
    });
  }
});

Deno.test("NO_MERGE and default meshes leave the translucent mesh empty for opaque-only chunks", () => {
  const mesher = new BinaryMesher();
  const hills = testChunks().find((c) => c.name === "hills with water")!;
  mesher.mesh(ChunkData.fromDense(hills.ids), uniformPlanes(false));
  assert(mesher.translucent.count > 0, "water meshed");
  const terrain = testChunks().find((c) => c.name === "terrain-like")!;
  mesher.mesh(ChunkData.fromDense(terrain.ids), uniformPlanes(false), NO_MERGE);
  assert(mesher.translucent.count === 0 && mesher.translucent.groupStart[6] === 0, "reset between chunks");
});
