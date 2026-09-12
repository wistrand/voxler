// Far-field brick grid (plan-far-field phases 1-2). Holds the pool and indirection
// buffers the march reads, and builds them on the CPU from the chunk store. Layout
// owned by design-formats.md "Brick and clipmap"; the reduction rule itself is in
// reduce.ts, which the worker job shares.
//
// A brick is 8^3 cells; a cell of level k covers 2^k voxels, so a brick covers
// 8 * 2^k voxels per side. At level 1 that is 16 voxels, half a chunk per side, so a
// brick never straddles a chunk and the build reads one chunk per brick.
//
// The CPU build is the path for regions an edit has changed, where there is no field
// left to sample; unedited terrain comes straight from the world SDF on the GPU
// (far-build.wgsl). Both write this layout, and `?farCheck` compares them.
//
// Slot assignment is the grid index: brick i of the grid owns pool slot i. That
// spends a slot on every empty brick (18 MiB at the default size) and in exchange
// one brick can be rebuilt in place without moving any other, which is what the
// edited-chunk path needs. A real allocator with eviction is phase 3.

import { BLOCK_FAR_SOLID } from "../world/blocks.ts";
import { CHUNK_SIZE } from "../world/coords.ts";
import { chunkInRange, chunkKey } from "../world/keys.ts";
import type { ChunkStore } from "../world/store.ts";
import { ChunkData } from "../world/chunk.ts";
import {
  BRICK_CELL_COUNT,
  BRICK_CELLS,
  BRICK_COLOR_WORDS,
  BRICK_OCCUPANCY_WORDS,
  BRICK_WORDS,
  brickVoxels,
  bricksPerChunkSide,
  cellIndex,
  clearBrick,
  reduceChunkBrick,
} from "./reduce.ts";

export {
  BRICK_CELL_COUNT,
  BRICK_CELLS,
  BRICK_COLOR_WORDS,
  BRICK_OCCUPANCY_WORDS,
  BRICK_WORDS,
  cellIndex,
  CHUNK_SIZE,
};

export interface BrickGridOptions {
  level: number; // k: a cell covers 2^k voxels
  size: number; // B: bricks per side of the grid
}

// Size 32 at level 1 covers 512 voxels, the near field's own radius. The GPU build
// samples the SDF and can cover more; phase 3 stacks levels for the rest.
export const DEFAULT_BRICK_OPTIONS: BrickGridOptions = { level: 1, size: 32 };

export class BrickGrid {
  readonly options: BrickGridOptions;
  // Per brick slot: 0 empty, else slot + 1 (design-formats.md "Entry values"). The
  // fully-solid shorthand is not emitted: it has nowhere to put a color.
  readonly indirection: Uint32Array;
  readonly bricks: Uint32Array;
  // Brick coordinate of the grid's min corner.
  readonly origin = new Int32Array(3);
  brickCount = 0; // occupied bricks

  constructor(options: BrickGridOptions = DEFAULT_BRICK_OPTIONS) {
    this.options = options;
    this.indirection = new Uint32Array(options.size ** 3);
    this.bricks = new Uint32Array(options.size ** 3 * BRICK_WORDS);
  }

  get cellVoxels(): number {
    return 1 << this.options.level;
  }

  get brickVoxels(): number {
    return brickVoxels(this.options.level);
  }

  // Voxels across the whole grid.
  get extentVoxels(): number {
    return this.options.size * this.brickVoxels;
  }

  // Grid slot of a brick coordinate, or -1 outside the grid.
  slotOf(bx: number, by: number, bz: number): number {
    const size = this.options.size;
    const x = bx - this.origin[0], y = by - this.origin[1], z = bz - this.origin[2];
    if (x < 0 || y < 0 || z < 0 || x >= size || y >= size || z >= size) return -1;
    return x + y * size + z * size * size;
  }

  // Moves the grid to cover a world voxel position, clearing it. Returns true when
  // the origin changed.
  recenter(x: number, y: number, z: number): boolean {
    const b = this.brickVoxels;
    const half = this.options.size >> 1;
    const ox = Math.floor(x / b) - half, oy = Math.floor(y / b) - half, oz = Math.floor(z / b) - half;
    if (ox === this.origin[0] && oy === this.origin[1] && oz === this.origin[2]) return false;
    this.origin[0] = ox;
    this.origin[1] = oy;
    this.origin[2] = oz;
    this.clear();
    return true;
  }

  clear(): void {
    this.indirection.fill(0);
    this.brickCount = 0;
  }

  // Rebuilds the whole grid from the chunk store, centred on a world voxel position.
  build(store: ChunkStore, x: number, y: number, z: number): void {
    this.recenter(x, y, z);
    this.clear();
    const size = this.options.size;
    for (let bz = 0; bz < size; bz++) {
      for (let by = 0; by < size; by++) {
        for (let bx = 0; bx < size; bx++) {
          this.buildBrick(store, this.origin[0] + bx, this.origin[1] + by, this.origin[2] + bz);
        }
      }
    }
  }

  // Rebuilds one brick from the store. Returns its slot, or -1 outside the grid.
  buildBrick(store: ChunkStore, bx: number, by: number, bz: number): number {
    const slot = this.slotOf(bx, by, bz);
    if (slot < 0) return -1;
    const per = bricksPerChunkSide(this.options.level);
    const b = this.brickVoxels;
    const cx = Math.floor(bx / per), cy = Math.floor(by / per), cz = Math.floor(bz / per);
    const at = slot * BRICK_WORDS;
    const chunk = readChunk(store, cx, cy, cz);
    const occupied = this.indirection[slot] !== 0;
    let solid = false;
    if (chunk === null) {
      clearBrick(this.bricks, at);
    } else {
      solid = reduceChunkBrick(chunk, this.options.level, bx - cx * per, by - cy * per, bz - cz * per, this.bricks, at);
    }
    this.indirection[slot] = solid ? slot + 1 : 0;
    if (solid !== occupied) this.brickCount += solid ? 1 : -1;
    return slot;
  }

  // Byte range of one slot in the pool buffer, for a partial upload.
  slotBytes(slot: number): [number, number] {
    return [slot * BRICK_WORDS * 4, BRICK_WORDS * 4];
  }
}

// A chunk's voxels, or null when it is not resident or is all air. Uniform chunks
// come back as a uniform container, which the reduction fills without reading voxels.
function readChunk(store: ChunkStore, cx: number, cy: number, cz: number): ChunkData | null {
  if (!chunkInRange(cx, cy, cz)) return null;
  const key = chunkKey(cx, cy, cz);
  if (store.slotOf(key) === -1) return null;
  const chunk = store.read(store.handle(cx, cy, cz));
  if (chunk === null) return null;
  if (chunk.isUniform && BLOCK_FAR_SOLID[chunk.uniformId] !== 1) return null;
  return chunk;
}
