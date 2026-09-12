import { BLOCK_OPAQUE } from "../world/blocks.ts";
import { ChunkData } from "../world/chunk.ts";
import { voxelIndex } from "../world/coords.ts";
import { faceAo, fillShell, PAD_VOLUME, padIndex, vertexAo } from "./ao.ts";
import { BinaryMesher } from "./binary.ts";
import { coverage, diffCoverage } from "./coverage.ts";
import { decodeQuad, FACE_AXIS, FACE_COUNT, FACE_SIGN, FACE_U, FACE_V, type Mesh, newQuad } from "./quad.ts";
import { meshReference } from "./reference.ts";
import { ALL_NEIGHBORS, NEIGHBOR_OFFSETS } from "./neighbors.ts";
import { newPlanes, setPlane } from "./planes.ts";
import { neighborSetups, testChunks } from "./testchunks.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// Independent AO of one unit face, straight from coordinates: opacity from the
// chunk's ids inside, from the shell outside.
function expectedAo(ids: Uint16Array, shell: Uint8Array, p: number[], face: number): number {
  const opaque = (c: number[]) => {
    const inside = c.every((v) => v >= 0 && v <= 31);
    return inside ? (BLOCK_OPAQUE[ids[voxelIndex(c[0], c[1], c[2])]] ? 1 : 0) : shell[padIndex(c[0], c[1], c[2])];
  };
  const n = p.slice();
  n[FACE_AXIS[face]] += FACE_SIGN[face];
  let ao = 0;
  for (let k = 0; k < 4; k++) {
    const du = k === 1 || k === 2 ? 1 : -1;
    const dv = k >= 2 ? 1 : -1;
    const s1 = n.slice(), s2 = n.slice(), c = n.slice();
    s1[FACE_U[face]] += du;
    s2[FACE_V[face]] += dv;
    c[FACE_U[face]] += du;
    c[FACE_V[face]] += dv;
    ao |= vertexAo(opaque(s1), opaque(s2), opaque(c)) << (2 * k);
  }
  return ao;
}

// Every unit face a quad covers must have exactly the quad's AO byte.
function assertAo(mesh: Mesh, ids: Uint16Array, shell: Uint8Array, what: string): void {
  const q = newQuad();
  for (let face = 0; face < FACE_COUNT; face++) {
    for (let i = mesh.groupStart[face]; i < mesh.groupStart[face + 1]; i++) {
      decodeQuad(mesh.quads[i * 2], mesh.quads[i * 2 + 1], q);
      for (let dv = 0; dv < q.h; dv++) {
        for (let du = 0; du < q.w; du++) {
          const p = [q.x, q.y, q.z];
          p[FACE_U[face]] += du;
          p[FACE_V[face]] += dv;
          const want = expectedAo(ids, shell, p, face);
          assert(q.ao === want, `${what}: face ${face} at (${p}): quad AO ${q.ao}, unit face ${want}`);
        }
      }
    }
  }
}

Deno.test("vertexAo: occlusion 0..3, two sides occlude fully", () => {
  assert(vertexAo(0, 0, 0) === 0, "open");
  assert(vertexAo(1, 0, 0) === 1 && vertexAo(0, 1, 0) === 1 && vertexAo(0, 0, 1) === 1, "one");
  assert(vertexAo(1, 0, 1) === 2 && vertexAo(0, 1, 1) === 2, "side and corner");
  assert(vertexAo(1, 1, 0) === 3 && vertexAo(1, 1, 1) === 3, "two sides");
});

Deno.test("faceAo: a wall beside a +Y face occludes its two +U corners, also across the shell", () => {
  // +Y face: U = x, V = z. Opaque voxel at +x in the layer above occludes
  // corners 1 (+U) and 2 (+U+V) by one each: 1 << 2 | 1 << 4.
  const want = (1 << 2) | (1 << 4);
  const inside = new Uint8Array(PAD_VOLUME);
  inside[padIndex(5, 0, 5)] = 1;
  inside[padIndex(6, 1, 5)] = 1;
  assert(faceAo(inside, 5, 0, 5, 2) === want, `inside: ${faceAo(inside, 5, 0, 5, 2)}`);
  const acrossFace = new Uint8Array(PAD_VOLUME);
  acrossFace[padIndex(32, 6, 5)] = 1; // +X neighbor's face layer
  assert(faceAo(acrossFace, 31, 5, 5, 2) === want, "across the +X face");
  const acrossEdge = new Uint8Array(PAD_VOLUME);
  acrossEdge[padIndex(32, 32, 5)] = 1; // the +X+Y edge chunk
  assert(faceAo(acrossEdge, 31, 31, 5, 2) === want, "across the +X+Y edge");
  const open = new Uint8Array(PAD_VOLUME);
  assert(faceAo(open, 0, 0, 0, 5) === 0, "no occluders");
});

Deno.test("baked AO: coverage unchanged, every covered unit face has the quad's AO", () => {
  const mesher = new BinaryMesher();
  for (const t of testChunks()) {
    for (const n of neighborSetups()) {
      const chunk = ChunkData.fromDense(t.ids);
      const expected = coverage(meshReference(t.ids, n.planes)).map;
      for (const merge of [false, true]) {
        const what = `${t.name}, ${n.name}, ${merge ? "greedy" : "unmerged"}`;
        const mesh = mesher.mesh(chunk, n.planes, { merge, shell: n.shell });
        const cov = coverage(mesh);
        assert(cov.overlaps === 0 && cov.outOfBounds === 0 && cov.faceMismatches === 0, `${what}: malformed`);
        const diff = diffCoverage(expected, cov.map);
        assert(diff === null, `${what}: ${diff}`);
        assertAo(mesh, t.ids, n.shell, what);
      }
    }
  }
});

Deno.test("without a shell every AO byte is 0, also after a baked mesh", () => {
  const mesher = new BinaryMesher();
  const t = testChunks().find((c) => c.name === "terrain-like")!;
  const n = neighborSetups()[2];
  const chunk = ChunkData.fromDense(t.ids);
  const baked = mesher.mesh(chunk, n.planes, { shell: n.shell });
  let occluded = 0;
  for (let i = 0; i < baked.count; i++) if (baked.quads[i * 2 + 1] >>> 16 !== 0) occluded++;
  assert(occluded > 0, "terrain has occluded corners");
  const plain = mesher.mesh(chunk, n.planes);
  for (let i = 0; i < plain.count; i++) assert(plain.quads[i * 2 + 1] >>> 16 === 0, `quad ${i}`);
});

// A 3x3x3 grid of chunks around the centre one, as one dense 96^3 id field and as
// 27 ChunkData. Seeded, so failures repeat.
function neighborhood(seed: number): { ids: Uint16Array; chunks: (ChunkData | null)[]; missing: number } {
  const ids = new Uint16Array(96 * 96 * 96);
  let state = seed >>> 0;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0) >>> 16;
  // Leave one neighbor out of the world; it must read as air.
  const missing = 3 + (seed % (ALL_NEIGHBORS - 3));
  for (let i = 0; i < ids.length; i++) ids[i] = next() % 3 === 0 ? 1 : 0;
  const chunks: (ChunkData | null)[] = [];
  for (let i = -1; i < ALL_NEIGHBORS; i++) {
    if (i === missing) {
      chunks.push(null);
      continue;
    }
    const dx = i < 0 ? 0 : NEIGHBOR_OFFSETS[i * 3];
    const dy = i < 0 ? 0 : NEIGHBOR_OFFSETS[i * 3 + 1];
    const dz = i < 0 ? 0 : NEIGHBOR_OFFSETS[i * 3 + 2];
    const dense = new Uint16Array(32 * 32 * 32);
    for (let y = 0; y < 32; y++) {
      for (let z = 0; z < 32; z++) {
        for (let x = 0; x < 32; x++) {
          const wx = x + (dx + 1) * 32, wy = y + (dy + 1) * 32, wz = z + (dz + 1) * 32;
          dense[voxelIndex(x, y, z)] = ids[wx + wz * 96 + wy * 96 * 96];
        }
      }
    }
    chunks.push(ChunkData.fromDense(dense));
  }
  return { ids, chunks, missing };
}

Deno.test("fillShell: every shell cell is the neighbor's voxel, and a missing neighbor is air", () => {
  for (let seed = 1; seed <= 4; seed++) {
    const { ids, chunks, missing } = neighborhood(seed);
    const md = [NEIGHBOR_OFFSETS[missing * 3], NEIGHBOR_OFFSETS[missing * 3 + 1], NEIGHBOR_OFFSETS[missing * 3 + 2]];
    const padded = new Uint8Array(PAD_VOLUME);
    padded.fill(0xff); // the interior stays untouched; only the shell is checked
    fillShell(padded, (i) => chunks[i + 1]);
    let shellCells = 0;
    for (let y = -1; y <= 32; y++) {
      for (let z = -1; z <= 32; z++) {
        for (let x = -1; x <= 32; x++) {
          const outside = x < 0 || x > 31 || y < 0 || y > 31 || z < 0 || z > 31;
          if (!outside) continue;
          shellCells++;
          // Which neighbor owns this cell, and the world voxel behind it.
          const d = [x < 0 ? -1 : x > 31 ? 1 : 0, y < 0 ? -1 : y > 31 ? 1 : 0, z < 0 ? -1 : z > 31 ? 1 : 0];
          const gone = d[0] === md[0] && d[1] === md[1] && d[2] === md[2];
          const want = gone ? 0 : BLOCK_OPAQUE[ids[(x + 32) + (z + 32) * 96 + (y + 32) * 96 * 96]] ? 1 : 0;
          const got = padded[padIndex(x, y, z)];
          assert(got === want, `seed ${seed}: shell (${x}, ${y}, ${z}) is ${got}, want ${want}`);
        }
      }
    }
    assert(shellCells === PAD_VOLUME - 32 * 32 * 32, `seed ${seed}: ${shellCells} shell cells`);
  }
});

Deno.test("a mesh baked over a 3x3x3 neighborhood has the AO of the whole field", () => {
  const mesher = new BinaryMesher();
  for (let seed = 1; seed <= 3; seed++) {
    const { ids, chunks } = neighborhood(seed);
    const padded = new Uint8Array(PAD_VOLUME);
    fillShell(padded, (i) => chunks[i + 1]);
    const planes = newPlanes();
    for (let f = 0; f < FACE_COUNT; f++) setPlane(planes, f, chunks[1 + f]);
    const centre = chunks[0]!;
    const dense = new Uint16Array(32 * 32 * 32);
    for (let i = 0; i < dense.length; i++) dense[i] = centre.get(i);
    const mesh = mesher.mesh(centre, planes, { shell: padded });
    assertAo(mesh, dense, padded, `seed ${seed}`);
    // The shell must agree with the planes the mesher culled against, so the mesh
    // covers exactly what the reference mesher emits.
    const diff = diffCoverage(coverage(meshReference(dense, planes)).map, coverage(mesh).map);
    assert(diff === null, `seed ${seed}: ${diff}`);
    assert(ids.length > 0, "the field backs both the chunk and the shell");
  }
});
