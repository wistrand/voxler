// Brick reduction (plan-far-field phase 2). Pure functions over typed arrays, so they
// run in workers, in `deno test`, and in `deno bench` (CLAUDE.md "Invariants").
// Layout owned by design-formats.md "Brick and clipmap".
//
// Two reductions, both by the same rule:
//   - level 1 or 2 from a chunk container, the path for regions an edit has changed,
//     where there is no field left to sample;
//   - level k+1 from eight level-k bricks, which is how the coarse levels are built
//     without reading voxels again.
//
// Reduction rule: a cell is solid when any voxel (or sub-cell) in it is solid, and
// takes the first such one's block id in scan order. "Any solid" keeps thin features
// and thickens them; "majority" keeps volume and loses them at distance, and a
// vanishing feature reads as a hole while a thickened one reads as distance.
// Solidity is BLOCK_FAR_SOLID: everything but air, translucent blocks included. The
// far field has no blending, and a sea drawn as its own bed is worse than a sea drawn
// as opaque water.
//
// The two routes to a level-2 brick (straight from the chunk, or from its level-1
// bricks) agree cell for cell on what is solid. The color can differ where a cell
// holds more than one block id, because each route takes the first in its own scan
// order; both are ids actually in the cell.

import { BLOCK_FAR_SOLID } from "../world/blocks.ts";
import type { ChunkData } from "../world/chunk.ts";
import { CHUNK_SIZE, voxelIndex } from "../world/coords.ts";

export const BRICK_CELLS = 8;
export const BRICK_CELL_COUNT = BRICK_CELLS ** 3;
export const BRICK_OCCUPANCY_WORDS = BRICK_CELL_COUNT / 32; // 16
export const BRICK_COLOR_WORDS = BRICK_CELL_COUNT / 4; // 128, one u8 block id per cell
// One word after the colours: which cell rows hold anything, per axis. Bit x of the low
// byte is set when any solid cell has that x, bits 8..15 the same for y and 16..23 for
// z. A ray whose segment through the brick touches no occupied row on some axis cannot
// hit the brick, and the march skips the cell walk on that (design-formats.md "Brick and
// clipmap"). Written wherever a brick is: `setCell`, `fillBrick`, and the two GPU
// builders in far-build.wgsl.
export const BRICK_AXES_WORD = BRICK_OCCUPANCY_WORDS + BRICK_COLOR_WORDS; // 144
export const BRICK_WORDS = BRICK_AXES_WORD + 1; // 145

// Indirection entry values (design-formats.md "Brick and clipmap"): 0 empty, the high
// bit set for a brick that is solid throughout with one block id in the low byte, and
// otherwise slot + 1 into the brick pool. The shorthand is what keeps the pool to the
// surface: underground every brick is solid stone, and there are far more of those
// than there are bricks holding a surface.
export const ENTRY_SOLID = 0x80000000;

export function entrySolidId(entry: number): number {
  return entry & 0xFF;
}

// Pool slot an entry points at, or -1 when it holds no brick.
export function entrySlot(entry: number): number {
  if (entry === 0 || (entry & ENTRY_SOLID) !== 0) return -1;
  return entry - 1;
}

// Cell order inside a brick, as the shader reads it.
export function cellIndex(x: number, y: number, z: number): number {
  return x + y * BRICK_CELLS + z * BRICK_CELLS * BRICK_CELLS;
}

// Voxels per side of a brick at level k.
export function brickVoxels(level: number): number {
  return BRICK_CELLS << level;
}

// Bricks per side of a chunk at level k: 2 at level 1, 1 at level 2. Coarser levels
// span more than a chunk and are built from level 2 by reduceBricks().
// False for a level whose bricks are bigger than a chunk, which a chunk reduction
// cannot produce on its own.
export function tilesChunk(level: number): boolean {
  return CHUNK_SIZE % brickVoxels(level) === 0;
}

export function bricksPerChunkSide(level: number): number {
  const n = CHUNK_SIZE / brickVoxels(level);
  if (!Number.isInteger(n) || n < 1) throw new Error(`level ${level} does not tile a chunk`);
  return n;
}

export function setCell(words: Uint32Array, at: number, i: number, id: number): void {
  words[at + (i >>> 5)] |= 1 << (i & 31);
  words[at + BRICK_OCCUPANCY_WORDS + (i >>> 2)] |= Math.min(id, 255) << ((i & 3) * 8);
  // Cell order is x + y*8 + z*64.
  words[at + BRICK_AXES_WORD] |= (1 << (i & 7)) | (1 << (8 + ((i >>> 3) & 7))) | (1 << (16 + (i >>> 6)));
}

// The axes word of a brick: bit x, 8 + y and 16 + z for every solid cell.
export function brickAxes(words: Uint32Array, at: number): number {
  return words[at + BRICK_AXES_WORD];
}

export function cellSolid(words: Uint32Array, at: number, i: number): boolean {
  return (words[at + (i >>> 5)] & (1 << (i & 31))) !== 0;
}

export function cellBlock(words: Uint32Array, at: number, i: number): number {
  return (words[at + BRICK_OCCUPANCY_WORDS + (i >>> 2)] >>> ((i & 3) * 8)) & 0xFF;
}

export function clearBrick(words: Uint32Array, at: number): void {
  words.fill(0, at, at + BRICK_WORDS);
}

// Every cell solid with one id, without touching voxels: what a uniform chunk
// reduces to.
export function fillBrick(words: Uint32Array, at: number, id: number): void {
  const byte = Math.min(id, 255);
  words.fill(0xFFFFFFFF, at, at + BRICK_OCCUPANCY_WORDS);
  words.fill(byte * 0x01010101, at + BRICK_OCCUPANCY_WORDS, at + BRICK_AXES_WORD);
  words[at + BRICK_AXES_WORD] = 0xFFFFFF;
}

// One brick of a chunk at `level`, brick (sx, sy, sz) of bricksPerChunkSide(level)^3.
// Returns false when nothing in it is solid, leaving `words` cleared.
export function reduceChunkBrick(
  chunk: ChunkData,
  level: number,
  sx: number,
  sy: number,
  sz: number,
  words: Uint32Array,
  at: number,
): boolean {
  clearBrick(words, at);
  if (chunk.isUniform) {
    const id = chunk.uniformId;
    if (BLOCK_FAR_SOLID[id] !== 1) return false;
    fillBrick(words, at, id);
    return true;
  }
  const step = 1 << level; // voxels per cell
  const base = brickVoxels(level);
  const ox = sx * base, oy = sy * base, oz = sz * base;
  let any = false;
  for (let cz = 0; cz < BRICK_CELLS; cz++) {
    for (let cy = 0; cy < BRICK_CELLS; cy++) {
      for (let cx = 0; cx < BRICK_CELLS; cx++) {
        let id = 0;
        for (let vz = 0; vz < step && id === 0; vz++) {
          for (let vy = 0; vy < step && id === 0; vy++) {
            for (let vx = 0; vx < step && id === 0; vx++) {
              const v = chunk.get(voxelIndex(ox + cx * step + vx, oy + cy * step + vy, oz + cz * step + vz));
              if (BLOCK_FAR_SOLID[v] === 1) id = v;
            }
          }
        }
        if (id === 0) continue;
        any = true;
        setCell(words, at, cellIndex(cx, cy, cz), id);
      }
    }
  }
  return any;
}

// One level k+1 brick from the eight level-k bricks under it. `src` holds the source
// words and `offsets` their positions in octant order (x + 2y + 4z), -1 for an empty
// octant. Returns false when all eight are empty.
export function reduceBricks(
  src: Uint32Array,
  offsets: ArrayLike<number>,
  words: Uint32Array,
  at: number,
): boolean {
  clearBrick(words, at);
  let any = false;
  const half = BRICK_CELLS >> 1; // 4: cells of one octant in the output brick
  for (let o = 0; o < 8; o++) {
    const from = offsets[o];
    if (from < 0) continue;
    const ox = (o & 1) * half, oy = ((o >> 1) & 1) * half, oz = ((o >> 2) & 1) * half;
    for (let cz = 0; cz < half; cz++) {
      for (let cy = 0; cy < half; cy++) {
        for (let cx = 0; cx < half; cx++) {
          let id = 0;
          for (let sz = 0; sz < 2 && id === 0; sz++) {
            for (let sy = 0; sy < 2 && id === 0; sy++) {
              for (let sx = 0; sx < 2 && id === 0; sx++) {
                const i = cellIndex(cx * 2 + sx, cy * 2 + sy, cz * 2 + sz);
                if (cellSolid(src, from, i)) id = cellBlock(src, from, i);
              }
            }
          }
          if (id === 0) continue;
          any = true;
          setCell(words, at, cellIndex(ox + cx, oy + cy, oz + cz), id);
        }
      }
    }
  }
  return any;
}
