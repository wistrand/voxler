// Job handlers by kind, run inside voxel.worker.ts. Every worker has every handler,
// so any job can run on any worker. Handlers are synchronous and pure: typed arrays
// in, typed arrays out, no DOM or GPU access (CLAUDE.md "Invariants").

import { applyChunkOps } from "../brush/voxel-ops.ts";
import { type BrickJobInput, type BrickJobOutput, runBrickJob } from "../far/brick-job.ts";
import { type MeshJobInput, type MeshJobOutput, runMeshJob } from "../mesh/job.ts";
import { sharedBuffer } from "./shared.ts";
import { blockBytes, writeBlock } from "../world/arena.ts";
import { ChunkData } from "../world/chunk.ts";
import { CHUNK_VOLUME } from "../world/coords.ts";
import type { JobContext, JobHandler } from "./protocol.ts";

export interface SumInput {
  data: Float32Array; // shared (SharedArrayBuffer) or copied per job
  repeat: number; // passes over the data, to make the job take measurable time
}

export interface SumOutput {
  sum: Float64Array; // one element, in a buffer from ctx.alloc
}

// Synthetic job for the pool self-test: sums the array `repeat` times.
function selftestSum(input: unknown, ctx: JobContext): SumOutput {
  const { data, repeat } = input as SumInput;
  let sum = 0;
  for (let r = 0; r < repeat; r++) {
    sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
  }
  const out = new Float64Array(ctx.alloc(8), 0, 1);
  out[0] = sum;
  return { sum: out };
}

export interface CompressInput {
  ids: Uint16Array | null; // 32768 block ids in voxel order (transferred in)
  uniformId: number; // the chunk's single id when `ids` is null
  ops: ArrayBuffer | null; // voxel stage: packed chunk ops (voxel-ops.ts), transferred
  cx: number; // chunk coordinate, for the ops' world positions
  cy: number;
  cz: number;
}

export interface CompressOutput {
  uniform: number; // block id when the chunk turned out uniform, else -1
  block: ArrayBuffer | null; // arena block layout at offset 0 (pooled; recycle it)
  bytes: number; // block size (blockBytes)
  ids: ArrayBuffer | null; // the input buffer, sent back for reuse
}

// Runs the voxel stage (plan-world-modelling phase 3) and then palette-compresses a
// chunk into arena block layout, so the main thread only copies bytes into the arena
// (ChunkStore.putBlock). The stage runs here, on the dense ids, because this is the
// last point where the chunk is dense and the work is off the main thread.
//
// `ids` is null for a chunk the voxelizer found uniform; it is materialized only
// when there are ops to apply to it, which the caller has already checked.
function compressChunk(input: unknown, ctx: JobContext): CompressOutput {
  const { ids, uniformId, ops, cx, cy, cz } = input as CompressInput;
  let dense = ids;
  if (dense === null) {
    dense = new Uint16Array(CHUNK_VOLUME);
    if (uniformId !== 0) dense.fill(uniformId);
  }
  if (ops !== null) applyChunkOps(dense, cx, cy, cz, ops);
  const chunk = ChunkData.fromDense(dense);
  const back = ids === null ? null : (ids.buffer as ArrayBuffer);
  if (back !== null) ctx.transfer(back);
  if (chunk.isUniform) return { uniform: chunk.uniformId, block: null, bytes: 0, ids: back };
  const parts = chunk.toParts();
  const bytes = blockBytes(parts);
  const block = ctx.alloc(bytes);
  writeBlock(block, 0, parts);
  return { uniform: -1, block, bytes, ids: back };
}

// Meshes a chunk against its six neighbors (src/mesh/job.ts).
function meshChunk(input: unknown, ctx: JobContext): MeshJobOutput {
  return runMeshJob(input as MeshJobInput, ctx, sharedBuffer);
}

// Reduces a chunk to far-field bricks (src/far/brick-job.ts).
function chunkBricks(input: unknown, ctx: JobContext): BrickJobOutput {
  return runBrickJob(input as BrickJobInput, ctx, sharedBuffer);
}

export const HANDLERS: Readonly<Record<string, JobHandler>> = {
  "selftest.sum": selftestSum,
  "chunk.compress": compressChunk,
  "chunk.mesh": meshChunk,
  "far.bricks": chunkBricks,
};
