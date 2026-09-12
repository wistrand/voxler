// Mesh job output: one buffer per meshed chunk, what the renderer uploads. Layout
// owned by agent_docs/design-formats.md "Mesh output". Pure.
//
// offset 0   u32 quadCount       padded quads (clusterCount * cluster size)
//        4   u32 clusterCount
//        8   u32 opaqueClusters  clusters [0, opaqueClusters) are opaque, the rest translucent
//        12  u32 realQuads       quads excluding padding
// 16         quads               quadCount x 2 u32, cluster order
// 16 + 8q    clusters            clusterCount x 4 u32 (cluster descriptors)

import { CLUSTER_WORDS, type ClusterBuilder } from "./cluster.ts";
import { FACE_COUNT } from "./quad.ts";

export const MESH_HEADER_BYTES = 16;

export function meshOutputBytes(b: ClusterBuilder): number {
  return MESH_HEADER_BYTES + b.quadCount * 8 + b.clusterCount * CLUSTER_WORDS * 4;
}

// Writes `b` at offset 0 of `buffer` (at least meshOutputBytes(b) long).
export function writeMeshOutput(buffer: ArrayBuffer, b: ClusterBuilder, realQuads: number): void {
  const header = new Uint32Array(buffer, 0, 4);
  header[0] = b.quadCount;
  header[1] = b.clusterCount;
  header[2] = b.groupStart[FACE_COUNT];
  header[3] = realQuads;
  new Uint32Array(buffer, MESH_HEADER_BYTES, b.quadCount * 2).set(b.quads.subarray(0, b.quadCount * 2));
  new Uint32Array(buffer, MESH_HEADER_BYTES + b.quadCount * 8, b.clusterCount * CLUSTER_WORDS)
    .set(b.clusters.subarray(0, b.clusterCount * CLUSTER_WORDS));
}

export interface MeshOutputView {
  quadCount: number;
  clusterCount: number;
  opaqueClusters: number;
  realQuads: number;
  quads: Uint32Array;
  clusters: Uint32Array;
}

// Views (no copy) of a mesh output buffer.
export function readMeshOutput(buffer: ArrayBuffer): MeshOutputView {
  const header = new Uint32Array(buffer, 0, 4);
  const quadCount = header[0];
  const clusterCount = header[1];
  return {
    quadCount,
    clusterCount,
    opaqueClusters: header[2],
    realQuads: header[3],
    quads: new Uint32Array(buffer, MESH_HEADER_BYTES, quadCount * 2),
    clusters: new Uint32Array(buffer, MESH_HEADER_BYTES + quadCount * 8, clusterCount * CLUSTER_WORDS),
  };
}
