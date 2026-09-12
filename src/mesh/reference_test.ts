import { ChunkData } from "../world/chunk.ts";
import { CHUNK_VOLUME, voxelIndex } from "../world/coords.ts";
import { BLOCK_OPAQUE } from "../world/blocks.ts";
import { coverage, diffCoverage } from "./coverage.ts";
import { newPlanes, planeBit, setPlane, uniformPlanes } from "./planes.ts";
import {
  decodeQuad,
  encodeWord0,
  encodeWord1,
  FACE_AXIS,
  FACE_COUNT,
  FACE_NEG_X,
  FACE_POS_X,
  FACE_SIGN,
  FACE_U,
  FACE_V,
  newQuad,
  quadCorners,
} from "./quad.ts";
import { meshReference } from "./reference.ts";
import { neighborSetups, testChunks } from "./testchunks.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const EMPTY = uniformPlanes(false);
const OPAQUE = uniformPlanes(true);

function chunk(name: string): Uint16Array {
  const c = testChunks().find((t) => t.name === name);
  if (!c) throw new Error(`no test chunk ${name}`);
  return c.ids;
}

Deno.test("quad words round-trip at the field limits", () => {
  const q = decodeQuad(encodeWord0(31, 31, 31, 32, 32, 5), encodeWord1(65535, 255), newQuad());
  assert(q.x === 31 && q.y === 31 && q.z === 31, "position");
  assert(q.w === 32 && q.h === 32 && q.face === 5, "size and face");
  assert(q.id === 65535 && q.ao === 255, "id and ao");
  const z = decodeQuad(encodeWord0(0, 0, 0, 1, 1, 0), encodeWord1(0, 0), newQuad());
  assert(z.x === 0 && z.w === 1 && z.h === 1 && z.face === 0 && z.id === 0, "zeros");
});

Deno.test("corners of a +X quad sit one voxel out and follow (z, y) tangents", () => {
  const q = decodeQuad(encodeWord0(31, 0, 0, 2, 3, FACE_POS_X), encodeWord1(1, 0), newQuad());
  const c = quadCorners(q, new Float64Array(12));
  const expected = [32, 0, 0, 32, 0, 2, 32, 3, 2, 32, 3, 0];
  assert(c.every((v, i) => v === expected[i]), `corners ${Array.from(c)}`);
});

Deno.test("hand-computed quad counts", () => {
  const cases: [string, Uint32Array, number][] = [
    ["empty", EMPTY, 0],
    ["full", EMPTY, 6 * 1024],
    ["full", OPAQUE, 0],
    ["single voxel, center", EMPTY, 6],
    ["single voxel, center", OPAQUE, 6],
    ["single voxel, corner", EMPTY, 6],
    ["single voxel, corner", OPAQUE, 3], // its +X, +Y, +Z faces touch opaque neighbors
    ["checkerboard", EMPTY, 16384 * 6],
    ["checkerboard", OPAQUE, 16384 * 6 - 6 * 512], // half of each border layer culled
    ["slab x < 8", EMPTY, 1024 + 1024 + 4 * 256], // +X inner face, -X border, 4 thin sides
    ["slab x < 8", OPAQUE, 1024], // only the inner +X face
  ];
  for (const [name, planes, expected] of cases) {
    const mesh = meshReference(chunk(name), planes);
    assert(mesh.count === expected, `${name}: ${mesh.count} quads, expected ${expected}`);
  }
});

Deno.test("two touching voxels hide the faces between them", () => {
  const ids = new Uint16Array(CHUNK_VOLUME);
  ids[voxelIndex(3, 3, 3)] = 1;
  ids[voxelIndex(4, 3, 3)] = 1;
  const mesh = meshReference(ids, EMPTY);
  assert(mesh.count === 10, `${mesh.count} quads`);
  const q = newQuad();
  for (let i = mesh.groupStart[FACE_POS_X]; i < mesh.groupStart[FACE_POS_X + 1]; i++) {
    decodeQuad(mesh.quads[i * 2], mesh.quads[i * 2 + 1], q);
    assert(q.x === 4, "+X face only on the right voxel");
  }
  for (let i = mesh.groupStart[FACE_NEG_X]; i < mesh.groupStart[FACE_NEG_X + 1]; i++) {
    decodeQuad(mesh.quads[i * 2], mesh.quads[i * 2 + 1], q);
    assert(q.x === 3, "-X face only on the left voxel");
  }
});

Deno.test("single center voxel: one quad per face, grouped, with its id", () => {
  const mesh = meshReference(chunk("single voxel, center"), EMPTY);
  const q = newQuad();
  for (let face = 0; face < FACE_COUNT; face++) {
    assert(mesh.groupStart[face + 1] - mesh.groupStart[face] === 1, `face ${face} group size`);
    decodeQuad(mesh.quads[mesh.groupStart[face] * 2], mesh.quads[mesh.groupStart[face] * 2 + 1], q);
    assert(q.face === face && q.x === 16 && q.y === 16 && q.z === 16 && q.id === 2, `face ${face} quad`);
  }
});

// Independent visibility rule for the oracle itself: a 34^3 padded opacity grid
// (neighbor planes written into the padding), face visible iff solid(p) and not
// solid(p + normal).
function paddedCoverage(ids: Uint16Array, planes: Uint32Array): Uint16Array {
  const P = 34;
  const solid = new Uint8Array(P * P * P);
  const at = (x: number, y: number, z: number) => (x + 1) + (y + 1) * P + (z + 1) * P * P;
  for (let i = 0; i < CHUNK_VOLUME; i++) solid[at(i & 31, i >>> 10, (i >>> 5) & 31)] = BLOCK_OPAQUE[ids[i]];
  for (let face = 0; face < FACE_COUNT; face++) {
    const p = [0, 0, 0];
    p[FACE_AXIS[face]] = FACE_SIGN[face] > 0 ? 32 : -1;
    for (let v = 0; v < 32; v++) {
      for (let u = 0; u < 32; u++) {
        p[FACE_U[face]] = u;
        p[FACE_V[face]] = v;
        solid[at(p[0], p[1], p[2])] = planeBit(planes, face, u, v) ? 1 : 0;
      }
    }
  }
  const map = new Uint16Array(FACE_COUNT * CHUNK_VOLUME);
  for (let face = 0; face < FACE_COUNT; face++) {
    const n = [0, 0, 0];
    n[FACE_AXIS[face]] = FACE_SIGN[face];
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      const x = i & 31, y = i >>> 10, z = (i >>> 5) & 31;
      if (solid[at(x, y, z)] && !solid[at(x + n[0], y + n[1], z + n[2])]) map[face * CHUNK_VOLUME + i] = ids[i];
    }
  }
  return map;
}

Deno.test("reference mesh coverage matches an independent padded-grid rule on every test chunk", () => {
  for (const c of testChunks()) {
    for (const n of neighborSetups()) {
      const mesh = meshReference(c.ids, n.planes);
      const cov = coverage(mesh);
      const what = `${c.name}, ${n.name}`;
      assert(cov.overlaps === 0 && cov.outOfBounds === 0 && cov.faceMismatches === 0, `${what}: malformed mesh`);
      const diff = diffCoverage(paddedCoverage(c.ids, n.planes), cov.map);
      assert(diff === null, `${what}: ${diff}`);
    }
  }
});

Deno.test("planes built from neighbor chunks use the face's tangent axes", () => {
  const ids = new Uint16Array(CHUNK_VOLUME);
  ids[voxelIndex(31, 5, 7)] = 1; // on the -X neighbor's touching layer (x = 31)
  ids[voxelIndex(9, 0, 4)] = 1; // on the +Y neighbor's touching layer (y = 0)
  const neighbor = ChunkData.fromDense(ids);
  const planes = newPlanes();
  setPlane(planes, FACE_NEG_X, neighbor);
  setPlane(planes, 2, neighbor); // +Y
  assert(planeBit(planes, FACE_NEG_X, 7, 5), "-X plane: u = z 7, v = y 5");
  assert(planeBit(planes, 2, 9, 4), "+Y plane: u = x 9, v = z 4");
  let bits = 0;
  for (let i = 0; i < planes.length; i++) for (let b = planes[i]; b; b &= b - 1) bits++;
  assert(bits === 2, `exactly two bits set, got ${bits}`);
  setPlane(planes, FACE_POS_X, ChunkData.uniform(1));
  assert(planeBit(planes, FACE_POS_X, 31, 31) && planeBit(planes, FACE_POS_X, 0, 0), "uniform opaque neighbor");
  setPlane(planes, FACE_POS_X, null);
  assert(!planeBit(planes, FACE_POS_X, 3, 3), "missing neighbor reads as empty");
});
