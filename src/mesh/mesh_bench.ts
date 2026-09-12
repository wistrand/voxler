// Mesher throughput (plan-meshing phases 2+ verify). Run with `deno task bench`.
// Compares the reference mesher with the binary mesher on the same inputs, times
// the column build, clustering, and the whole worker job. CLAUDE.md target: a
// surface chunk under 0.5 ms.

import { blockBytes, PayloadArena } from "../world/arena.ts";
import { ChunkData } from "../world/chunk.ts";
import { BinaryMesher, NO_MERGE } from "./binary.ts";
import { CLUSTER_QUADS, ClusterBuilder, ORDER_EMISSION, ORDER_MORTON } from "./cluster.ts";
import { REF_BLOCK, REF_FACES, runMeshJob } from "./job.ts";
import { newPlanes, setPlane } from "./planes.ts";
import { meshReference } from "./reference.ts";
import { neighborSetups, testChunks } from "./testchunks.ts";

const { planes, shell } = neighborSetups()[2]; // random neighbors
const cases = ["hills", "terrain-like", "random 50%", "checkerboard"].map((name) => {
  const c = testChunks().find((t) => t.name === name)!;
  return { name, ids: c.ids, chunk: ChunkData.fromDense(c.ids) };
});
const mesher = new BinaryMesher();

for (const c of cases) {
  const unmerged = mesher.mesh(c.chunk, planes, NO_MERGE).count;
  const greedy = mesher.mesh(c.chunk, planes).count;
  Deno.bench(`reference, ${c.name} (${unmerged} quads)`, { group: c.name, baseline: true }, () => {
    meshReference(c.ids, planes);
  });
  Deno.bench(`binary unmerged, ${c.name}`, { group: c.name }, () => {
    mesher.mesh(c.chunk, planes, NO_MERGE);
  });
  Deno.bench(`binary greedy, ${c.name} (${greedy} quads)`, { group: c.name }, () => {
    mesher.mesh(c.chunk, planes);
  });
  const baked = mesher.mesh(c.chunk, planes, { shell }).count;
  Deno.bench(`binary greedy + baked AO, ${c.name} (${baked} quads)`, { group: c.name }, () => {
    mesher.mesh(c.chunk, planes, { shell });
  });
  Deno.bench(`column build only, ${c.name}`, { group: c.name }, () => {
    mesher.buildColumns(c.chunk);
  });
}

// Clustering alone, on the greedy mesh of each case (plan-meshing phase 4).
const clusters = new ClusterBuilder();
for (const c of cases) {
  const mesh = new BinaryMesher().mesh(c.chunk, planes);
  Deno.bench(`cluster, emission order, ${c.name}`, { group: `cluster ${c.name}`, baseline: true }, () => {
    clusters.build(mesh, ORDER_EMISSION);
  });
  Deno.bench(`cluster, morton order, ${c.name}`, { group: `cluster ${c.name}` }, () => {
    clusters.build(mesh, ORDER_MORTON);
  });
}

// The whole worker job (phase 7): read the chunk and six neighbors from arena
// blocks, build planes, mesh, cluster, write the output buffer. Surface case: hills
// with hills beside it, stone below, air above.
{
  const arena = new PayloadArena(1 << 20, false);
  const refs = new Int32Array(REF_FACES * 2);
  const hills = ChunkData.fromDense(testChunks().find((t) => t.name === "hills")!.ids);
  const place = (i: number, chunk: ChunkData) => {
    if (chunk.isUniform) {
      refs[i * 2] = chunk.uniformId;
      return;
    }
    const parts = chunk.toParts();
    const offset = arena.alloc(blockBytes(parts));
    arena.write(offset, parts);
    refs[i * 2] = REF_BLOCK;
    refs[i * 2 + 1] = offset;
  };
  // Entry 0 the chunk, then faces +X -X +Y -Y +Z -Z.
  [hills, hills, hills, ChunkData.uniform(0), ChunkData.uniform(1), hills, hills].forEach((c, i) => place(i, c));
  const input = {
    sharedId: -1,
    buffer: arena.buffer as ArrayBuffer,
    returnBuffer: false,
    refs,
    clusterQuads: CLUSTER_QUADS,
    clusterOrder: ORDER_EMISSION,
    ao: false,
  };
  const out = new ArrayBuffer(1 << 20);
  const ctx = { alloc: () => out, transfer: () => {} };
  const quads = runMeshJob(input, ctx).quads;
  Deno.bench(`mesh job, hills with hills around (${quads} quads)`, { group: "job", baseline: true }, () => {
    runMeshJob(input, ctx);
  });
  const planesOut = newPlanes();
  Deno.bench("neighbor planes, 6 dense hills neighbors", { group: "job" }, () => {
    for (let f = 0; f < 6; f++) setPlane(planesOut, f, hills);
  });
}
