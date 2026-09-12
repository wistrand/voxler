// Packs a voxelize batch's field brushes for the GPU (plan-world-modelling phase 5).
// Main thread, no GPU calls: it fills staging arrays the Voxelizer uploads.
//
// Per chunk, the records it needs go in one contiguous run, so the shader indexes
// them with a (start, count) and no indirection. A brush covering several chunks of
// one batch is written once per chunk; a batch holds at most BATCH_SIZE chunks, so
// the duplication is bounded and cheaper than a second level of indices.
//
// Voxel brushes are left out: they are not a field. Their ops are applied to the
// dense ids afterwards (voxel-ops.ts), and the chunk still routes through the
// compressor because the streamer asks the voxel stage, not the field.

import { chunkInRange, chunkKey } from "../world/keys.ts";
import { BRUSH_VOXEL, INSTANCE_WORDS } from "./format.ts";
import type { BrushStore } from "./store.ts";

// Per chunk, so one runaway chunk cannot push another out of the batch. Over these,
// the extra brushes are dropped and counted: a loud limit, not silent corruption.
export const MAX_BRUSHES_PER_CHUNK = 64;
export const MAX_OP_WORDS_PER_CHUNK = 2048;

// What the Voxelizer needs, so src/sdf/ never imports the brush store.
export interface FieldBrushes {
  // Fills `records` and `ops` for `n` chunks (coords as x, y, z triples), and writes
  // (start, count, Lipschitz in 8.8 fixed, 0) per chunk into `ranges`. Returns the
  // number of instances written; `dropped` counts what did not fit.
  pack(coords: Int32Array, n: number, records: Uint32Array, ops: Uint32Array, ranges: Uint32Array): number;
  readonly opWords: number; // words written into `ops` by the last pack
  readonly dropped: number; // instances that did not fit, total
}

export class BrushBatch implements FieldBrushes {
  opWords = 0;
  dropped = 0;
  private readonly store: BrushStore;
  private list = new Int32Array(MAX_BRUSHES_PER_CHUNK * 4);

  constructor(store: BrushStore) {
    this.store = store;
  }

  pack(coords: Int32Array, n: number, records: Uint32Array, ops: Uint32Array, ranges: Uint32Array): number {
    const store = this.store;
    let recordCount = 0;
    let opWords = 0;
    for (let c = 0; c < n; c++) {
      const cx = coords[c * 3], cy = coords[c * 3 + 1], cz = coords[c * 3 + 2];
      const start = recordCount;
      let count = 0;
      let lipschitz = 0;
      if (chunkInRange(cx, cy, cz)) {
        const found = this.gather(chunkKey(cx, cy, cz));
        let chunkOps = 0;
        for (let i = 0; i < found; i++) {
          const id = this.list[i];
          if (store.kindOf(id) === BRUSH_VOXEL) continue;
          const words = store.opsCountOf(id);
          if (
            count === MAX_BRUSHES_PER_CHUNK || chunkOps + words > MAX_OP_WORDS_PER_CHUNK ||
            (recordCount + 1) * INSTANCE_WORDS > records.length || opWords + words > ops.length
          ) {
            this.dropped++;
            continue;
          }
          const at = recordCount * INSTANCE_WORDS;
          const from = store.offsetOf(id);
          for (let w = 0; w < INSTANCE_WORDS; w++) records[at + w] = store.records.u32[from + w];
          // The record's op offset points into the store's pool; rewrite it to this
          // batch's, which is what the shader reads.
          records[at + 5] = opWords;
          const src = store.opsOffsetOf(id);
          for (let w = 0; w < words; w++) ops[opWords + w] = store.ops.u32[src + w];
          opWords += words;
          chunkOps += words;
          lipschitz = Math.max(lipschitz, (store.records.u32[from + 6] >>> 16) / 256);
          recordCount++;
          count++;
        }
      }
      ranges[c * 4] = start;
      ranges[c * 4 + 1] = count;
      ranges[c * 4 + 2] = Math.min(0xffff, Math.round(lipschitz * 256));
      ranges[c * 4 + 3] = 0;
    }
    this.opWords = opWords;
    return recordCount;
  }

  private gather(key: number): number {
    for (;;) {
      try {
        return this.store.instancesIn(key, this.list);
      } catch {
        if (this.list.length >= MAX_BRUSHES_PER_CHUNK * 64) return 0;
        this.list = new Int32Array(this.list.length * 2);
      }
    }
  }
}
