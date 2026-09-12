// Quad clusters (plan-meshing phase 4): each face group of a mesh is split into
// clusters of up to `clusterQuads` quads, padded with zero quads, with a tight AABB
// per cluster. The cluster is the unit of GPU culling. Descriptor layout owned by
// agent_docs/design-formats.md "Cluster descriptor"; the cull shader (plan-rendering)
// must mirror decodeCluster(). Pure.
//
// Descriptor, 4 u32 per cluster:
//   x  offset of the cluster's first quad, in quads, from the chunk's first quad
//      (the renderer adds the arena base on upload)
//   y  chunk slot 0-19 (left 0; the renderer fills it), face 20-22, translucent 23,
//      quad count 24-31
//   z  AABB min x 0-4, y 5-9, z 10-14; max x 15-19, y 20-24, z 25-29 (inclusive)
//   w  reserved
// AABBs bound the voxels whose faces the quads lie on; the cull shader extends
// positive faces by one along the normal.
//
// Quad order within a face group, before splitting:
//   ORDER_EMISSION  mesher order (slice by slice along the face axis); the default
//   ORDER_MORTON    sorted by the Morton code of each quad's center (radix sort,
//                   stable, no allocation once warm)
// Emission order gave smaller AABBs on surface chunks (plan-meshing phase 4 table);
// the rendering bench's cull rate makes the final call.

import { FACE_COUNT, FACE_U, FACE_V, type Mesh } from "./quad.ts";

// Set by the plan-rendering phase 1 sweep (least padding and vertex work on real
// terrain; research-voxel-rendering.md "Vertex format and draw submission"). The
// descriptor's 8-bit count caps it at 255.
export const CLUSTER_QUADS = 32;
export const CLUSTER_WORDS = 4;
// Cluster groups in a build: opaque faces 0-5, translucent faces 0-5.
export const CLUSTER_GROUPS = 2 * FACE_COUNT;

export const ORDER_EMISSION = 0;
export const ORDER_MORTON = 1;

export interface Cluster {
  offset: number;
  slot: number;
  face: number;
  translucent: boolean;
  count: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export function newCluster(): Cluster {
  return {
    offset: 0,
    slot: 0,
    face: 0,
    translucent: false,
    count: 0,
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 0,
    maxY: 0,
    maxZ: 0,
  };
}

export function encodeClusterY(slot: number, face: number, translucent: boolean, count: number): number {
  return (slot | (face << 20) | ((translucent ? 1 : 0) << 23) | (count << 24)) >>> 0;
}

export function encodeClusterAabb(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number {
  return (minX | (minY << 5) | (minZ << 10) | (maxX << 15) | (maxY << 20) | (maxZ << 25)) >>> 0;
}

// Decodes descriptor `i` of `words`.
export function decodeCluster(words: Uint32Array, i: number, out: Cluster): Cluster {
  const b = i * CLUSTER_WORDS;
  const y = words[b + 1];
  const z = words[b + 2];
  out.offset = words[b];
  out.slot = y & 0xfffff;
  out.face = (y >>> 20) & 7;
  out.translucent = ((y >>> 23) & 1) !== 0;
  out.count = y >>> 24;
  out.minX = z & 31;
  out.minY = (z >>> 5) & 31;
  out.minZ = (z >>> 10) & 31;
  out.maxX = (z >>> 15) & 31;
  out.maxY = (z >>> 20) & 31;
  out.maxZ = (z >>> 25) & 31;
  return out;
}

// Mean AABB volume (voxels) and surface area (voxel faces) over clusters
// [start, end), written to out[0] and out[1]. Proxies for cull efficiency: area
// tracks the mean projected size of a box over view directions, volume favors flat
// boxes. Measurement only.
export function meanClusterSize(words: Uint32Array, start: number, end: number, out: Float64Array): Float64Array {
  out[0] = 0;
  out[1] = 0;
  if (end <= start) return out;
  const c = newCluster();
  for (let i = start; i < end; i++) {
    decodeCluster(words, i, c);
    const dx = c.maxX - c.minX + 1, dy = c.maxY - c.minY + 1, dz = c.maxZ - c.minZ + 1;
    out[0] += dx * dy * dz;
    out[1] += 2 * (dx * dy + dy * dz + dx * dz);
  }
  out[0] /= end - start;
  out[1] /= end - start;
  return out;
}

// Bits 0-5 spread to 0, 3, 6, 9, 12, 15.
const SPREAD6 = new Uint32Array(64);
for (let v = 0; v < 64; v++) {
  let s = 0;
  for (let b = 0; b < 6; b++) s |= ((v >>> b) & 1) << (3 * b);
  SPREAD6[v] = s;
}

const RADIX_BITS = 9; // two passes over the 18-bit Morton code
const RADIX = 1 << RADIX_BITS;

export class ClusterBuilder {
  // Padded quads in cluster order, 2 words per quad; quadCount includes padding
  // (clusterCount * clusterQuads).
  quads = new Uint32Array(0);
  quadCount = 0;
  // Descriptors, CLUSTER_WORDS per cluster.
  clusters = new Uint32Array(0);
  clusterCount = 0;
  // First cluster of each group: opaque faces 0-5, then translucent faces 0-5
  // (group 6 + face); groupStart[CLUSTER_GROUPS] = clusterCount.
  readonly groupStart = new Int32Array(CLUSTER_GROUPS + 1);

  // Sort scratch, sized to the largest face group seen.
  private keys = new Uint32Array(0);
  private orderA = new Uint32Array(0);
  private orderB = new Uint32Array(0);
  private readonly counts = new Uint32Array(RADIX);

  constructor(readonly clusterQuads = CLUSTER_QUADS) {
    if (!Number.isInteger(clusterQuads) || clusterQuads < 1 || clusterQuads > 255) {
      throw new Error(`cluster size ${clusterQuads} outside 1..255`);
    }
  }

  // Clusters an opaque mesh and, optionally, a translucent one, replacing the
  // previous output. Opaque clusters come first. Returns this; valid until the next
  // call.
  build(opaque: Mesh, order = ORDER_EMISSION, translucent: Mesh | null = null): this {
    this.reserve(opaque, translucent);
    this.quadCount = 0;
    this.clusterCount = 0;
    this.add(opaque, order, false);
    if (translucent !== null) this.add(translucent, order, true);
    else this.groupStart.fill(this.clusterCount, FACE_COUNT);
    this.groupStart[CLUSTER_GROUPS] = this.clusterCount;
    return this;
  }

  private add(mesh: Mesh, order: number, translucent: boolean): void {
    const cq = this.clusterQuads;
    const src = mesh.quads;
    const dst = this.quads;
    const desc = this.clusters;
    const groupBase = translucent ? FACE_COUNT : 0;
    let quadCount = this.quadCount;
    let clusterCount = this.clusterCount;
    for (let face = 0; face < FACE_COUNT; face++) {
      this.groupStart[groupBase + face] = clusterCount;
      const start = mesh.groupStart[face];
      const n = mesh.groupStart[face + 1] - start;
      if (n === 0) continue;
      const fu = FACE_U[face], fv = FACE_V[face];
      const sorted = order === ORDER_MORTON ? this.sortMorton(src, start, n, fu, fv) : null;
      for (let first = 0; first < n; first += cq) {
        const count = Math.min(cq, n - first);
        let minX = 31, minY = 31, minZ = 31, maxX = 0, maxY = 0, maxZ = 0;
        for (let k = 0; k < count; k++) {
          const q = start + (sorted === null ? first + k : sorted[first + k]);
          const w0 = src[q * 2];
          dst[(quadCount + k) * 2] = w0;
          dst[(quadCount + k) * 2 + 1] = src[q * 2 + 1];
          const x = w0 & 31, y = (w0 >>> 5) & 31, z = (w0 >>> 10) & 31;
          const wm = (w0 >>> 15) & 31, hm = (w0 >>> 20) & 31;
          // Last voxel covered: min corner + (w-1) along U + (h-1) along V.
          const x1 = x + (fu === 0 ? wm : 0) + (fv === 0 ? hm : 0);
          const y1 = y + (fu === 1 ? wm : 0) + (fv === 1 ? hm : 0);
          const z1 = z + (fu === 2 ? wm : 0) + (fv === 2 ? hm : 0);
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x1 > maxX) maxX = x1;
          if (y1 > maxY) maxY = y1;
          if (z1 > maxZ) maxZ = z1;
        }
        dst.fill(0, (quadCount + count) * 2, (quadCount + cq) * 2); // padding quads
        const b = clusterCount * CLUSTER_WORDS;
        desc[b] = quadCount;
        desc[b + 1] = encodeClusterY(0, face, translucent, count);
        desc[b + 2] = encodeClusterAabb(minX, minY, minZ, maxX, maxY, maxZ);
        desc[b + 3] = 0;
        quadCount += cq;
        clusterCount++;
      }
    }
    this.quadCount = quadCount;
    this.clusterCount = clusterCount;
  }

  // Grows the output and scratch buffers to fit both meshes. Allocates only when
  // the input is larger than any before it.
  private reserve(opaque: Mesh, translucent: Mesh | null): void {
    const cq = this.clusterQuads;
    let clusters = 0;
    let largest = 0;
    for (let face = 0; face < FACE_COUNT; face++) {
      const n = opaque.groupStart[face + 1] - opaque.groupStart[face];
      const t = translucent ? translucent.groupStart[face + 1] - translucent.groupStart[face] : 0;
      clusters += Math.ceil(n / cq) + Math.ceil(t / cq);
      largest = Math.max(largest, n, t);
    }
    if (this.quads.length < clusters * cq * 2) this.quads = new Uint32Array(clusters * cq * 2);
    if (this.clusters.length < clusters * CLUSTER_WORDS) this.clusters = new Uint32Array(clusters * CLUSTER_WORDS);
    if (this.keys.length < largest) {
      this.keys = new Uint32Array(largest);
      this.orderA = new Uint32Array(largest);
      this.orderB = new Uint32Array(largest);
    }
  }

  // Indexes 0..n-1 of the face group starting at quad `start`, ordered by the
  // Morton code of each quad's center. Centers are taken as min + max voxel per axis
  // (0..62, 6 bits), so the code is 18 bits.
  private sortMorton(src: Uint32Array, start: number, n: number, fu: number, fv: number): Uint32Array {
    const keys = this.keys;
    let a = this.orderA;
    let b = this.orderB;
    for (let i = 0; i < n; i++) {
      const w0 = src[(start + i) * 2];
      const x = w0 & 31, y = (w0 >>> 5) & 31, z = (w0 >>> 10) & 31;
      const wm = (w0 >>> 15) & 31, hm = (w0 >>> 20) & 31;
      const cx = 2 * x + (fu === 0 ? wm : 0) + (fv === 0 ? hm : 0);
      const cy = 2 * y + (fu === 1 ? wm : 0) + (fv === 1 ? hm : 0);
      const cz = 2 * z + (fu === 2 ? wm : 0) + (fv === 2 ? hm : 0);
      keys[i] = SPREAD6[cx] | (SPREAD6[cy] << 1) | (SPREAD6[cz] << 2);
      a[i] = i;
    }
    const counts = this.counts;
    for (let shift = 0; shift < 2 * RADIX_BITS; shift += RADIX_BITS) {
      counts.fill(0);
      for (let i = 0; i < n; i++) counts[(keys[a[i]] >>> shift) & (RADIX - 1)]++;
      let sum = 0;
      for (let r = 0; r < RADIX; r++) {
        const c = counts[r];
        counts[r] = sum;
        sum += c;
      }
      for (let i = 0; i < n; i++) b[counts[(keys[a[i]] >>> shift) & (RADIX - 1)]++] = a[i];
      const t = a;
      a = b;
      b = t;
    }
    return a;
  }
}
