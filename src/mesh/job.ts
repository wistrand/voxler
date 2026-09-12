// The "chunk.mesh" worker job (plan-meshing phase 6): a chunk and its neighbors in,
// one mesh output buffer (output.ts) out. Pure; registered in src/workers/jobs.ts,
// inputs built by MeshScheduler (src/world/mesh-scheduler.ts).
//
// Input refs, 2 i32 per entry: entry 0 is the chunk, entries 1.. its neighbors in
// neighbors.ts order (the six faces first). Plain meshing sends REF_FACES entries;
// baked AO (input.ao) sends REF_ALL, because the shell needs the edge and corner
// neighbors too. Per entry [state, offset]:
//   state >= 0     uniform chunk of that block id
//   REF_BLOCK      arena block (arena.ts layout) at byte `offset` of `buffer`
//   REF_MISSING    no chunk (outside the world): reads as air
// The blocks are in the shared arena, named by `sharedId` (sent to every worker
// once, WorkerPool.share()), or (copy path, sharedId -1) in `buffer`, a buffer
// holding just these blocks, transferred in and, with `returnBuffer`, sent back in
// the output for reuse.

import { readParts } from "../world/arena.ts";
import { ChunkData } from "../world/chunk.ts";
import { fillShell, PAD_VOLUME } from "./ao.ts";
import { hasLight, type LightSource, LightFill } from "./light.ts";
import { BinaryMesher, hasTranslucent, type MeshOptions } from "./binary.ts";
import { ALL_NEIGHBORS, FACE_NEIGHBORS, NEIGHBOR_OFFSETS } from "./neighbors.ts";
import { CLUSTER_QUADS, ClusterBuilder } from "./cluster.ts";
import { meshOutputBytes, writeMeshOutput } from "./output.ts";
import { newBorders, newPlanes, setBorder, setPlane } from "./planes.ts";
import { voxelIndex } from "../world/coords.ts";
import { FACE_COUNT } from "./quad.ts";

export const REF_BLOCK = -1;
export const REF_MISSING = -2;
export const REF_FACES = 1 + FACE_NEIGHBORS;
export const REF_ALL = 1 + ALL_NEIGHBORS;

export interface MeshJobInput {
  sharedId: number; // shared buffer holding the blocks, or -1: they are in `buffer`
  buffer: ArrayBuffer | null;
  clusterQuads: number; // cluster size, fixed per session (?clusterQuads)
  clusterOrder: number; // ORDER_EMISSION or ORDER_MORTON (?clusterOrder)
  returnBuffer: boolean; // buffer was transferred in: send it back (copy path)
  ao: boolean; // bake AO: refs holds REF_ALL entries, not REF_FACES
  light: boolean; // bake block light (needs the same REF_ALL neighbors as AO)
  refs: Int32Array; // REF_FACES or REF_ALL x [state, offset]
}

export interface MeshJobOutput {
  mesh: ArrayBuffer | null; // output.ts layout, pooled (recycle it); null: no faces
  bytes: number; // meshOutputBytes, 0 when mesh is null
  quads: number; // opaque quads, unpadded
  translucentQuads: number;
  clusters: number;
  input: ArrayBuffer | null; // the copy-path input buffer, sent back for reuse
}

export interface MeshJobContext {
  alloc(bytes: number): ArrayBuffer;
  transfer(buffer: ArrayBuffer): void;
}

function noShared(id: number): SharedArrayBuffer {
  throw new Error(`no shared buffer ${id}`);
}

// Per-worker scratch, reused by every job.
const mesher = new BinaryMesher();
let clusters = new ClusterBuilder(CLUSTER_QUADS);
const planes = newPlanes();
const borders = newBorders();
const options: MeshOptions = { borders: null, shell: null };
const neighbors: (ChunkData | null)[] = new Array(ALL_NEIGHBORS).fill(null);
const shell = new Uint8Array(PAD_VOLUME);
const neighborAt = (i: number) => neighbors[i];

// Neighbor index by chunk offset, [(dx + 1) * 9 + (dy + 1) * 3 + dz + 1]; -1 is the
// meshed chunk itself, which is not in the neighbor list.
const NEIGHBOR_OF_OFFSET = (() => {
  const table = new Int8Array(27).fill(-1);
  for (let i = 0; i < ALL_NEIGHBORS; i++) {
    const dx = NEIGHBOR_OFFSETS[i * 3], dy = NEIGHBOR_OFFSETS[i * 3 + 1], dz = NEIGHBOR_OFFSETS[i * 3 + 2];
    table[(dx + 1) * 9 + (dy + 1) * 3 + dz + 1] = i;
  }
  return table;
})();

// Block light, filled once per job that needs it (light.ts). The chunk being meshed is
// `lightChunk`; `voxelAt` reads it and its neighbors at padded coordinates.
const light = new LightFill();
const lightSources: LightSource[] = [];
let lightChunk: ChunkData | null = null;

function voxelAt(x: number, y: number, z: number): number {
  // >> 5 floors negatives, which is what maps -1 to the chunk below.
  const cx = x >> 5, cy = y >> 5, cz = z >> 5;
  let chunk: ChunkData | null;
  if (cx === 0 && cy === 0 && cz === 0) {
    chunk = lightChunk;
  } else {
    const i = NEIGHBOR_OF_OFFSET[(cx + 1) * 9 + (cy + 1) * 3 + cz + 1];
    chunk = i < 0 ? null : neighbors[i];
  }
  // A chunk outside the world reads as air, so light spills into it rather than
  // stopping at a boundary that is not there.
  return chunk === null ? 0 : chunk.get(voxelIndex(x & 31, y & 31, z & 31));
}
// Uniform chunks by id, made once per worker (read-only here).
const uniforms: (ChunkData | undefined)[] = [];

// Keeps the source list preallocated: the job path never allocates.
function pushLightSource(n: number, dx: number, dy: number, dz: number, chunk: ChunkData): number {
  const src = lightSources[n] ??= { dx: 0, dy: 0, dz: 0, chunk };
  src.dx = dx;
  src.dy = dy;
  src.dz = dz;
  src.chunk = chunk;
  return n + 1;
}

function refChunk(blocks: ArrayBuffer | SharedArrayBuffer | null, refs: Int32Array, i: number): ChunkData | null {
  const state = refs[i * 2];
  if (state === REF_MISSING) return null;
  if (state >= 0) return uniforms[state] ??= ChunkData.uniform(state);
  return ChunkData.fromParts(readParts(blocks!, refs[i * 2 + 1]));
}

// `shared` resolves input.sharedId (the worker's registry, sharedBuffer()).
export function runMeshJob(
  input: MeshJobInput,
  ctx: MeshJobContext,
  shared: (id: number) => SharedArrayBuffer = noShared,
): MeshJobOutput {
  const blocks = input.sharedId >= 0 ? shared(input.sharedId) : input.buffer;
  const chunk = refChunk(blocks, input.refs, 0) ?? ChunkData.uniform(0);
  const count = input.ao ? ALL_NEIGHBORS : FACE_NEIGHBORS;
  for (let i = 0; i < count; i++) neighbors[i] = refChunk(blocks, input.refs, 1 + i);
  for (let f = 0; f < FACE_COUNT; f++) setPlane(planes, f, neighbors[f]);
  const translucent = hasTranslucent(chunk);
  if (translucent) for (let f = 0; f < FACE_COUNT; f++) setBorder(borders, f, neighbors[f]);
  options.borders = translucent ? borders : null;
  if (input.ao) {
    fillShell(shell, neighborAt);
    options.shell = shell;
  } else {
    options.shell = null;
  }
  // Block light, but only when one of the 27 chunks holds a light: filling the grid
  // otherwise would cost every chunk in the world what a handful of them need.
  options.light = null;
  if (input.ao && input.light) {
    let sources = 0;
    if (hasLight(chunk)) sources = pushLightSource(sources, 0, 0, 0, chunk);
    for (let i = 0; i < ALL_NEIGHBORS; i++) {
      const n = neighbors[i];
      if (!hasLight(n)) continue;
      sources = pushLightSource(sources, NEIGHBOR_OFFSETS[i * 3], NEIGHBOR_OFFSETS[i * 3 + 1], NEIGHBOR_OFFSETS[i * 3 + 2], n!);
    }
    if (sources > 0) {
      lightChunk = chunk;
      light.fill(lightSources, sources, voxelAt);
      options.light = light.levels;
    }
  }
  const opaque = mesher.mesh(chunk, planes, options);
  neighbors.fill(null);
  let returned: ArrayBuffer | null = null;
  if (input.returnBuffer) {
    returned = input.buffer as ArrayBuffer;
    ctx.transfer(returned);
  }
  const t = mesher.translucent;
  if (opaque.count + t.count === 0) {
    return { mesh: null, bytes: 0, quads: 0, translucentQuads: 0, clusters: 0, input: returned };
  }
  if (clusters.clusterQuads !== input.clusterQuads) clusters = new ClusterBuilder(input.clusterQuads);
  clusters.build(opaque, input.clusterOrder, t);
  const bytes = meshOutputBytes(clusters);
  const mesh = ctx.alloc(bytes);
  writeMeshOutput(mesh, clusters, opaque.count + t.count);
  return {
    mesh,
    bytes,
    quads: opaque.count,
    translucentQuads: t.count,
    clusters: clusters.clusterCount,
    input: returned,
  };
}
