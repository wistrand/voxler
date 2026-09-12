// Chunk voxel container: one block id for a uniform chunk, or a palette plus
// bit-packed palette indices. Layout and rationale: agent_docs/design-formats.md
// "Chunk storage". Pure: no DOM or GPU access, so it runs in workers and tests.
//
// Index widths are 0 (uniform), 1, 2, 4, 8, or 16 bits: powers of two, so an index
// never straddles a u32 word. get() and toDense() allocate nothing. set() widens
// and repacks only when a new id doesn't fit; compact() shrinks back.

import { CHUNK_VOLUME } from "./coords.ts";

// log2(bits) for the supported widths; index = bits.
const LOG2: Readonly<Record<number, number>> = { 1: 0, 2: 1, 4: 2, 8: 3, 16: 4 };

// Smallest supported width that holds `n` palette entries (0 when n <= 1).
export function widthFor(n: number): number {
  if (n <= 1) return 0;
  if (n <= 2) return 1;
  if (n <= 4) return 2;
  if (n <= 16) return 4;
  if (n <= 256) return 8;
  return 16;
}

// Plain typed arrays for moving a chunk between threads (transfer the buffers).
export interface ChunkParts {
  bits: number;
  palette: Uint16Array; // exactly the used length
  words: Uint32Array | null; // null when bits == 0
}

// Module scratch for compressing: id -> palette index, stamped so it never needs
// clearing. One copy per module instance, so each worker has its own.
const lookupStamp = new Uint32Array(65536);
const lookupIndex = new Uint16Array(65536);
const paletteScratch = new Uint16Array(65536);
const countScratch = new Uint32Array(65536);
let stamp = 0;

function nextStamp(): number {
  stamp = (stamp + 1) >>> 0;
  if (stamp === 0) {
    lookupStamp.fill(0);
    stamp = 1;
  }
  return stamp;
}

function wordCount(bits: number): number {
  return (CHUNK_VOLUME * bits) >>> 5;
}

// Packs `index(i)` for every voxel into fresh words of the given width.
function pack(bits: number, indexAt: (i: number) => number): Uint32Array {
  const words = new Uint32Array(wordCount(bits));
  const perWordLog = 5 - LOG2[bits];
  const perWordMask = (1 << perWordLog) - 1;
  for (let i = 0; i < CHUNK_VOLUME; i++) {
    words[i >>> perWordLog] |= indexAt(i) << ((i & perWordMask) * bits);
  }
  return words;
}

export class ChunkData {
  private bits: number;
  private palette: Uint16Array; // capacity may exceed paletteSize
  private paletteSize: number;
  private words: Uint32Array | null;

  private constructor(bits: number, palette: Uint16Array, paletteSize: number, words: Uint32Array | null) {
    this.bits = bits;
    this.palette = palette;
    this.paletteSize = paletteSize;
    this.words = words;
  }

  static uniform(id: number): ChunkData {
    const palette = new Uint16Array(1);
    palette[0] = id;
    return new ChunkData(0, palette, 1, null);
  }

  // Compresses 32768 ids in voxel order. A chunk with one distinct id comes out
  // uniform.
  static fromDense(ids: Uint16Array): ChunkData {
    const s = nextStamp();
    let n = 0;
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      const id = ids[i];
      if (lookupStamp[id] !== s) {
        lookupStamp[id] = s;
        lookupIndex[id] = n;
        paletteScratch[n++] = id;
      }
    }
    if (n === 1) return ChunkData.uniform(ids[0]);
    // Hot path (every voxelized chunk): packing inlined rather than through pack().
    const bits = widthFor(n);
    const words = new Uint32Array(wordCount(bits));
    const perWordLog = 5 - LOG2[bits];
    const perWordMask = (1 << perWordLog) - 1;
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      words[i >>> perWordLog] |= lookupIndex[ids[i]] << ((i & perWordMask) * bits);
    }
    return new ChunkData(bits, paletteScratch.slice(0, n), n, words);
  }

  static fromParts(parts: ChunkParts): ChunkData {
    if (parts.bits === 0) return ChunkData.uniform(parts.palette[0]);
    return new ChunkData(parts.bits, parts.palette, parts.palette.length, parts.words);
  }

  get isUniform(): boolean {
    return this.bits === 0;
  }

  // The chunk's id when uniform; the first palette entry otherwise.
  get uniformId(): number {
    return this.palette[0];
  }

  get bitsPerVoxel(): number {
    return this.bits;
  }

  get paletteLength(): number {
    return this.paletteSize;
  }

  // Palette entry i (0 <= i < paletteLength). Entries are distinct ids; some may be
  // unused by any voxel until compact().
  paletteAt(i: number): number {
    return this.palette[i];
  }

  // The packed index words themselves (no copy), null when uniform. Read-only: for
  // kernels that work on indices directly (src/mesh/rows.ts). Voxel i's index is
  // bits [(i % (32 / bits)) * bits, +bits) of word floor(i / (32 / bits)).
  indexWords(): Uint32Array | null {
    return this.words;
  }

  // Payload bytes: index words plus palette capacity (object overhead excluded).
  get byteSize(): number {
    return (this.words ? this.words.byteLength : 0) + this.palette.byteLength;
  }

  // Block id at a voxel index (coords.ts voxelIndex()).
  get(i: number): number {
    const bits = this.bits;
    if (bits === 0) return this.palette[0];
    const perWordLog = 5 - LOG2[bits];
    const shift = (i & ((1 << perWordLog) - 1)) * bits;
    return this.palette[(this.words![i >>> perWordLog] >>> shift) & ((1 << bits) - 1)];
  }

  set(i: number, id: number): void {
    let index = this.indexOf(id);
    if (index < 0) {
      if (this.bits === 0 && this.palette[0] === id) return;
      index = this.addToPalette(id);
    }
    if (this.bits === 0) return; // uniform and id is its id
    const bits = this.bits;
    const perWordLog = 5 - LOG2[bits];
    const shift = (i & ((1 << perWordLog) - 1)) * bits;
    const mask = ((1 << bits) - 1) << shift;
    const w = i >>> perWordLog;
    this.words![w] = (this.words![w] & ~mask) | (index << shift);
  }

  // Expands into 32768 ids in voxel order.
  toDense(out: Uint16Array): void {
    const bits = this.bits;
    const palette = this.palette;
    if (bits === 0) {
      out.fill(palette[0], 0, CHUNK_VOLUME);
      return;
    }
    const words = this.words!;
    const perWordLog = 5 - LOG2[bits];
    const perWordMask = (1 << perWordLog) - 1;
    const mask = (1 << bits) - 1;
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      out[i] = palette[(words[i >>> perWordLog] >>> ((i & perWordMask) * bits)) & mask];
    }
  }

  // Drops palette entries no voxel uses, shrinks the width, and turns into a
  // uniform chunk when one id remains. Call after edits, not per voxel.
  compact(): void {
    if (this.bits === 0) return;
    const n = this.paletteSize;
    countScratch.fill(0, 0, n);
    for (let i = 0; i < CHUNK_VOLUME; i++) countScratch[this.rawIndex(i)]++;
    let used = 0;
    for (let k = 0; k < n; k++) {
      if (countScratch[k] > 0) {
        lookupIndex[k] = used; // old index -> new index (reuses the scratch)
        paletteScratch[used++] = this.palette[k];
      }
    }
    if (used === n && widthFor(n) === this.bits && this.palette.length === n) return;
    if (used === 1) {
      this.palette = paletteScratch.slice(0, 1);
      this.paletteSize = 1;
      this.bits = 0;
      this.words = null;
      return;
    }
    const bits = widthFor(used);
    const words = pack(bits, (i) => lookupIndex[this.rawIndex(i)]);
    this.palette = paletteScratch.slice(0, used);
    this.paletteSize = used;
    this.bits = bits;
    this.words = words;
  }

  // Copies of the arrays, trimmed, ready to transfer to another thread.
  toParts(): ChunkParts {
    return {
      bits: this.bits,
      palette: this.palette.slice(0, this.paletteSize),
      words: this.words ? this.words.slice() : null,
    };
  }

  private rawIndex(i: number): number {
    const bits = this.bits;
    const perWordLog = 5 - LOG2[bits];
    return (this.words![i >>> perWordLog] >>> ((i & ((1 << perWordLog) - 1)) * bits)) & ((1 << bits) - 1);
  }

  private indexOf(id: number): number {
    const palette = this.palette;
    for (let k = 0; k < this.paletteSize; k++) if (palette[k] === id) return k;
    return -1;
  }

  // Appends an id, widening and repacking when the current width is full.
  private addToPalette(id: number): number {
    const index = this.paletteSize;
    const needed = widthFor(index + 1);
    if (needed !== this.bits) {
      const oldBits = this.bits;
      this.words = oldBits === 0 ? new Uint32Array(wordCount(needed)) : pack(needed, (i) => this.rawIndex(i));
      this.bits = needed;
    }
    if (index >= this.palette.length) {
      const grown = new Uint16Array(Math.min(65536, Math.max(4, this.palette.length * 2)));
      grown.set(this.palette);
      this.palette = grown;
    }
    this.palette[index] = id;
    this.paletteSize = index + 1;
    return index;
  }
}
