// The "far.bricks" worker job (plan-far-field phases 2-3): one chunk in, its far-field
// bricks out, at every clipmap level whose bricks fit inside a chunk. Pure; registered
// in src/workers/jobs.ts, inputs built by FarEdits (src/far/edits.ts).
//
// Unedited terrain never comes through here: it is sampled from the world SDF on the
// GPU (far-build.wgsl). A chunk an edit has changed has no field left to sample, so
// its bricks are reduced from the voxels, and reducing them on the main thread would
// be meshing's mistake again (CLAUDE.md "Invariants").
//
// The chunk is named the way the mesh job names one (src/mesh/job.ts): [state,
// offset], state >= 0 a uniform block id, REF_BLOCK an arena block at `offset`,
// REF_MISSING no chunk. A uniform chunk reduces without touching voxels.
//
// Output order: for each level in `levels`, that level's bricks of the chunk in
// x, then y, then z. `solid` has one bit per brick in the same order, and the payload
// holds every brick, solid or not, so the reader indexes it directly.

import { readParts } from "../world/arena.ts";
import { ChunkData } from "../world/chunk.ts";
import { REF_BLOCK, REF_MISSING } from "../mesh/job.ts";
import { BRICK_WORDS, bricksPerChunkSide, reduceChunkBrick } from "./reduce.ts";

export interface BrickJobInput {
  sharedId: number; // shared buffer holding the block, or -1: it is in `buffer`
  buffer: ArrayBuffer | null;
  returnBuffer: boolean; // buffer was transferred in: send it back (copy path)
  levels: Int32Array; // k of each level to reduce, ascending
  state: number; // uniform block id, REF_BLOCK, or REF_MISSING
  offset: number; // byte offset of the arena block when state is REF_BLOCK
  cx: number; // chunk coordinate, echoed back so a stale result can be dropped
  cy: number;
  cz: number;
  version: number;
}

export interface BrickJobOutput {
  bricks: ArrayBuffer | null; // count * BRICK_WORDS u32; null when nothing is solid
  count: number; // bricks in the payload, over every level
  solid: number; // bit per brick, in payload order
  missing: boolean; // the chunk was not resident: nothing was reduced, nothing to apply
  input: ArrayBuffer | null; // the copy-path input buffer, sent back for reuse
}

export interface BrickJobContext {
  alloc(bytes: number): ArrayBuffer;
  transfer(buffer: ArrayBuffer): void;
}

function noShared(id: number): SharedArrayBuffer {
  throw new Error(`no shared buffer ${id}`);
}

// Bricks a chunk produces over the given levels.
export function brickCount(levels: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < levels.length; i++) n += bricksPerChunkSide(levels[i]) ** 3;
  return n;
}

// Uniform chunks by id, made once per worker (read-only here).
const uniforms: (ChunkData | undefined)[] = [];

export function runBrickJob(
  input: BrickJobInput,
  ctx: BrickJobContext,
  shared: (id: number) => SharedArrayBuffer = noShared,
): BrickJobOutput {
  const back = input.returnBuffer ? input.buffer : null;
  if (back !== null) ctx.transfer(back);
  const count = brickCount(input.levels);
  if (input.state === REF_MISSING) return { bricks: null, count, solid: 0, missing: true, input: back };
  let chunk: ChunkData;
  if (input.state === REF_BLOCK) {
    const blocks = input.sharedId >= 0 ? shared(input.sharedId) : input.buffer!;
    chunk = ChunkData.fromParts(readParts(blocks, input.offset));
  } else {
    chunk = uniforms[input.state] ??= ChunkData.uniform(input.state);
  }
  const out = ctx.alloc(count * BRICK_WORDS * 4);
  const words = new Uint32Array(out);
  let solid = 0;
  let at = 0;
  for (let l = 0; l < input.levels.length; l++) {
    const level = input.levels[l];
    const per = bricksPerChunkSide(level);
    for (let i = 0; i < per ** 3; i++) {
      const bx = i % per, by = Math.floor(i / per) % per, bz = Math.floor(i / (per * per));
      if (reduceChunkBrick(chunk, level, bx, by, bz, words, at * BRICK_WORDS)) solid |= 1 << at;
      at++;
    }
  }
  if (solid === 0) return { bricks: null, count, solid: 0, missing: false, input: back };
  return { bricks: out, count, solid, missing: false, input: back };
}
