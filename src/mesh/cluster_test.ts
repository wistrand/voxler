import { ChunkData } from "../world/chunk.ts";
import { BinaryMesher } from "./binary.ts";
import {
  CLUSTER_GROUPS,
  CLUSTER_QUADS,
  ClusterBuilder,
  decodeCluster,
  encodeClusterAabb,
  encodeClusterY,
  newCluster,
  ORDER_EMISSION,
  ORDER_MORTON,
} from "./cluster.ts";
import { coverage, diffCoverage } from "./coverage.ts";
import { decodeQuad, FACE_COUNT, FACE_U, FACE_V, type Mesh, newQuad } from "./quad.ts";
import { neighborSetups, testChunks } from "./testchunks.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// The real (non-padding) quads of a cluster build's opaque (base 0) or translucent
// (base FACE_COUNT) groups, gathered back into a Mesh.
function unpad(b: ClusterBuilder, base = 0): Mesh {
  const c = newCluster();
  const quads = new Uint32Array(b.quadCount * 2);
  const groupStart = new Int32Array(FACE_COUNT + 1);
  let count = 0;
  for (let face = 0; face < FACE_COUNT; face++) {
    groupStart[face] = count;
    for (let i = b.groupStart[base + face]; i < b.groupStart[base + face + 1]; i++) {
      decodeCluster(b.clusters, i, c);
      quads.set(b.quads.subarray(c.offset * 2, (c.offset + c.count) * 2), count * 2);
      count += c.count;
    }
  }
  groupStart[FACE_COUNT] = count;
  return { quads, count, groupStart };
}

// Structure checks from plan-meshing "Cluster checks": contiguous padded layout,
// one face per cluster, every quad inside a tight AABB, zero padding quads.
function assertWellFormed(b: ClusterBuilder, mesh: Mesh, what: string, base = 0): void {
  const cq = b.clusterQuads;
  const c = newCluster();
  const q = newQuad();
  const translucent = base !== 0;
  assert(b.quadCount === b.clusterCount * cq, `${what}: padded quad count`);
  assert(b.groupStart[CLUSTER_GROUPS] === b.clusterCount, `${what}: group end`);
  let total = 0;
  for (let face = 0; face < FACE_COUNT; face++) {
    const g = base + face;
    const n = mesh.groupStart[face + 1] - mesh.groupStart[face];
    const clusters = b.groupStart[g + 1] - b.groupStart[g];
    assert(clusters === Math.ceil(n / cq), `${what}: group ${g} has ${clusters} clusters for ${n} quads`);
    for (let i = b.groupStart[g]; i < b.groupStart[g + 1]; i++) {
      decodeCluster(b.clusters, i, c);
      const where = `${what}: cluster ${i}`;
      assert(c.offset === i * cq, `${where}: offset ${c.offset}`);
      assert(c.face === face && c.slot === 0 && c.translucent === translucent, `${where}: header`);
      assert(c.count >= 1 && c.count <= cq, `${where}: count ${c.count}`);
      assert(b.clusters[i * 4 + 3] === 0, `${where}: reserved word`);
      total += c.count;
      let minX = 99, minY = 99, minZ = 99, maxX = -1, maxY = -1, maxZ = -1;
      for (let k = 0; k < c.count; k++) {
        const j = c.offset + k;
        decodeQuad(b.quads[j * 2], b.quads[j * 2 + 1], q);
        assert(q.face === face && q.id !== 0, `${where}: quad ${k} face ${q.face} id ${q.id}`);
        const hi = [q.x, q.y, q.z];
        hi[FACE_U[face]] += q.w - 1;
        hi[FACE_V[face]] += q.h - 1;
        minX = Math.min(minX, q.x);
        minY = Math.min(minY, q.y);
        minZ = Math.min(minZ, q.z);
        maxX = Math.max(maxX, hi[0]);
        maxY = Math.max(maxY, hi[1]);
        maxZ = Math.max(maxZ, hi[2]);
      }
      assert(
        c.minX === minX && c.minY === minY && c.minZ === minZ && c.maxX === maxX && c.maxY === maxY &&
          c.maxZ === maxZ,
        `${where}: AABB (${c.minX},${c.minY},${c.minZ})-(${c.maxX},${c.maxY},${c.maxZ}), ` +
          `quads span (${minX},${minY},${minZ})-(${maxX},${maxY},${maxZ})`,
      );
      for (let k = c.count; k < cq; k++) {
        const j = c.offset + k;
        assert(b.quads[j * 2] === 0 && b.quads[j * 2 + 1] === 0, `${where}: padding quad ${k} not zero`);
      }
    }
  }
  assert(total === mesh.count, `${what}: ${total} quads in clusters, mesh has ${mesh.count}`);
}

Deno.test("cluster descriptor fields round trip at their limits", () => {
  const words = new Uint32Array([4000000000, encodeClusterY(0xfffff, 5, true, 255), encodeClusterAabb(1, 2, 3, 31, 30, 29), 0]);
  const c = decodeCluster(words, 0, newCluster());
  assert(c.offset === 4000000000 && c.slot === 0xfffff && c.face === 5 && c.translucent && c.count === 255, "y word");
  assert(c.minX === 1 && c.minY === 2 && c.minZ === 3 && c.maxX === 31 && c.maxY === 30 && c.maxZ === 29, "AABB");
  assert(decodeCluster(new Uint32Array([0, encodeClusterY(7, 0, false, 1), 0, 0]), 0, c).slot === 7, "slot");
});

Deno.test("clusters are well formed and cover the mesh exactly, both orders, several sizes", () => {
  const mesher = new BinaryMesher();
  for (const size of [1, 32, CLUSTER_QUADS, 128, 255]) {
    const b = new ClusterBuilder(size);
    for (const t of testChunks()) {
      for (const n of neighborSetups()) {
        const mesh = mesher.mesh(ChunkData.fromDense(t.ids), n.planes, { borders: n.borders });
        const translucent = mesher.translucent;
        const expected = size === CLUSTER_QUADS ? coverage(mesh).map : null;
        const expectedT = size === CLUSTER_QUADS ? coverage(translucent).map : null;
        for (const order of [ORDER_EMISSION, ORDER_MORTON]) {
          const what = `size ${size}, ${t.name}, ${n.name}, order ${order}`;
          b.build(mesh, order, translucent);
          assertWellFormed(b, mesh, what);
          assertWellFormed(b, translucent, `${what}, translucent`, FACE_COUNT);
          if (expected !== null && expectedT !== null) {
            for (const [base, map] of [[0, expected], [FACE_COUNT, expectedT]] as const) {
              const cov = coverage(unpad(b, base));
              assert(cov.overlaps === 0 && cov.faceMismatches === 0, `${what}: malformed`);
              const diff = diffCoverage(map, cov.map);
              assert(diff === null, `${what}, groups from ${base}: ${diff}`);
            }
          }
        }
      }
    }
  }
});

Deno.test("without a translucent mesh the translucent groups are empty", () => {
  const mesher = new BinaryMesher();
  const b = new ClusterBuilder();
  const t = testChunks().find((c) => c.name === "hills with water")!;
  b.build(mesher.mesh(ChunkData.fromDense(t.ids), neighborSetups()[0].planes));
  for (let g = FACE_COUNT; g <= CLUSTER_GROUPS; g++) assert(b.groupStart[g] === b.clusterCount, `group ${g}`);
});

Deno.test("emission order keeps the mesher's quad order", () => {
  const mesher = new BinaryMesher();
  const b = new ClusterBuilder();
  const t = testChunks().find((c) => c.name === "terrain-like")!;
  const mesh = mesher.mesh(ChunkData.fromDense(t.ids), neighborSetups()[2].planes);
  const flat = unpad(b.build(mesh, ORDER_EMISSION));
  for (let i = 0; i < mesh.count * 2; i++) assert(flat.quads[i] === mesh.quads[i], `word ${i}`);
});

Deno.test("morton order sorts each face group by the Morton code of quad centers", () => {
  const mesher = new BinaryMesher();
  const b = new ClusterBuilder();
  const t = testChunks().find((c) => c.name === "random 50%")!;
  const mesh = mesher.mesh(ChunkData.fromDense(t.ids), neighborSetups()[0].planes);
  const flat = unpad(b.build(mesh, ORDER_MORTON));
  const q = newQuad();
  // Independent Morton code: interleave bit b of (cx, cy, cz) at 3b, 3b+1, 3b+2.
  const morton = (i: number) => {
    decodeQuad(flat.quads[i * 2], flat.quads[i * 2 + 1], q);
    const c = [2 * q.x, 2 * q.y, 2 * q.z];
    c[FACE_U[q.face]] += q.w - 1;
    c[FACE_V[q.face]] += q.h - 1;
    let code = 0;
    for (let bit = 0; bit < 6; bit++) {
      for (let a = 0; a < 3; a++) code += ((c[a] >>> bit) & 1) * 2 ** (3 * bit + a);
    }
    return code;
  };
  for (let face = 0; face < FACE_COUNT; face++) {
    for (let i = flat.groupStart[face] + 1; i < flat.groupStart[face + 1]; i++) {
      assert(morton(i - 1) <= morton(i), `face ${face}, quad ${i} out of order`);
    }
  }
});

Deno.test("a reused cluster builder leaves nothing behind", () => {
  const mesher = new BinaryMesher();
  const b = new ClusterBuilder();
  const planes = neighborSetups()[2].planes;
  const small = testChunks().find((c) => c.name === "hills")!;
  const big = testChunks().find((c) => c.name === "checkerboard")!;
  const first = b.build(mesher.mesh(ChunkData.fromDense(small.ids), planes), ORDER_MORTON);
  const quads = first.quads.slice(0, first.quadCount * 2);
  const clusters = first.clusters.slice(0, first.clusterCount * 4);
  b.build(mesher.mesh(ChunkData.fromDense(big.ids), planes), ORDER_MORTON);
  const again = b.build(mesher.mesh(ChunkData.fromDense(small.ids), planes), ORDER_MORTON);
  assert(again.quadCount * 2 === quads.length && again.clusterCount * 4 === clusters.length, "counts");
  for (let i = 0; i < quads.length; i++) assert(again.quads[i] === quads[i], `quad word ${i}`);
  for (let i = 0; i < clusters.length; i++) assert(again.clusters[i] === clusters[i], `cluster word ${i}`);
});

Deno.test("cluster size outside 1..255 is rejected", () => {
  for (const size of [0, 256, 1.5]) {
    let threw = false;
    try {
      new ClusterBuilder(size);
    } catch {
      threw = true;
    }
    assert(threw, `size ${size}`);
  }
});
