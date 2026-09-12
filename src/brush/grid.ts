// A camera-centred grid over the field brushes near the camera
// (plan-world-modelling phase 6), for consumers that sample anywhere rather than
// per chunk. The voxelizer knows which chunk each sample belongs to and takes a
// per-chunk run (batch.ts); a sphere-traced ray does not, so it looks its cell up
// as it goes.
//
// Cells are chunk-sized and the grid is a fixed box around the camera chunk, so the
// lookup is arithmetic and needs no hashing in the shader. Brushes outside it are
// simply not in the field the preview traces: the field stays consistent, so the
// trace shows no artifacts, it just does not show those brushes. That is acceptable
// for an authoring aid and would not be for the voxelizer, which is why the two use
// different structures.

import { chunkInRange, chunkKey } from "../world/keys.ts";
import { CHUNK_SIZE } from "../world/coords.ts";
import { BRUSH_VOXEL, INSTANCE_WORDS } from "./format.ts";
import type { BrushStore } from "./store.ts";

// Powers of two, so the shader indexes with shifts. 32 x 16 x 32 chunks covers the
// default streaming range (radius 16, height 6) with room to spare.
export const GRID_X = 32;
export const GRID_Y = 16;
export const GRID_Z = 32;
export const GRID_CELLS = GRID_X * GRID_Y * GRID_Z;

export const MAX_GRID_RECORDS = 4096;
export const MAX_GRID_OP_WORDS = 65536;

export class BrushGrid {
  // Per cell: first record, record count, Lipschitz bound (8.8 fixed), unused.
  readonly cells = new Uint32Array(GRID_CELLS * 4);
  readonly records = new Uint32Array(MAX_GRID_RECORDS * INSTANCE_WORDS);
  readonly ops = new Uint32Array(MAX_GRID_OP_WORDS);
  // Chunk coordinate of the grid's min corner.
  readonly origin = new Int32Array(3);
  recordCount = 0;
  opWords = 0;
  dropped = 0;

  private readonly store: BrushStore;
  private readonly counts = new Uint32Array(GRID_CELLS);
  private list = new Int32Array(256);
  private built = -1; // store version the grid was built from
  private cx = Number.NaN;
  private cy = Number.NaN;
  private cz = Number.NaN;

  constructor(store: BrushStore) {
    this.store = store;
  }

  // Rebuilds when the camera moved to another chunk or a brush changed. Returns true
  // when the buffers need uploading again.
  update(cx: number, cy: number, cz: number): boolean {
    if (this.built === this.store.version && cx === this.cx && cy === this.cy && cz === this.cz) return false;
    this.built = this.store.version;
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
    this.origin[0] = cx - GRID_X / 2;
    this.origin[1] = cy - GRID_Y / 2;
    this.origin[2] = cz - GRID_Z / 2;
    this.build();
    return true;
  }

  private build(): void {
    this.cells.fill(0);
    this.counts.fill(0);
    this.recordCount = 0;
    this.opWords = 0;
    // Two passes over the cells the brushes cover: count, then fill. The second pass
    // reads the same cell lists, so a brush lands in each of its cells once.
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        let start = 0;
        for (let i = 0; i < GRID_CELLS; i++) {
          this.cells[i * 4] = start;
          start += this.counts[i];
          this.counts[i] = 0;
        }
        this.recordCount = Math.min(start, MAX_GRID_RECORDS);
      }
      for (let y = 0; y < GRID_Y; y++) {
        for (let z = 0; z < GRID_Z; z++) {
          for (let x = 0; x < GRID_X; x++) {
            const wx = this.origin[0] + x, wy = this.origin[1] + y, wz = this.origin[2] + z;
            if (!chunkInRange(wx, wy, wz)) continue;
            const cell = x + z * GRID_X + y * GRID_X * GRID_Z;
            const n = this.gather(chunkKey(wx, wy, wz));
            for (let i = 0; i < n; i++) {
              const id = this.list[i];
              if (this.store.kindOf(id) === BRUSH_VOXEL) continue;
              if (pass === 0) {
                this.counts[cell]++;
                continue;
              }
              this.place(cell, id);
            }
          }
        }
      }
    }
  }

  private place(cell: number, id: number): void {
    const store = this.store;
    const words = store.opsCountOf(id);
    const at = this.cells[cell * 4] + this.counts[cell];
    if (at >= MAX_GRID_RECORDS || this.opWords + words > MAX_GRID_OP_WORDS) {
      this.dropped++;
      return;
    }
    const from = store.offsetOf(id);
    const to = at * INSTANCE_WORDS;
    for (let w = 0; w < INSTANCE_WORDS; w++) this.records[to + w] = store.records.u32[from + w];
    this.records[to + 5] = this.opWords;
    const src = store.opsOffsetOf(id);
    for (let w = 0; w < words; w++) this.ops[this.opWords + w] = store.ops.u32[src + w];
    this.opWords += words;
    this.counts[cell]++;
    this.cells[cell * 4 + 1] = this.counts[cell];
    const bound = (store.records.u32[from + 6] >>> 16) / 256;
    this.cells[cell * 4 + 2] = Math.max(this.cells[cell * 4 + 2], Math.min(0xffff, Math.round(bound * 256)));
  }

  private gather(key: number): number {
    for (;;) {
      try {
        return this.store.instancesIn(key, this.list);
      } catch {
        if (this.list.length >= 16384) return 0;
        this.list = new Int32Array(this.list.length * 2);
      }
    }
  }
}

export { CHUNK_SIZE };
