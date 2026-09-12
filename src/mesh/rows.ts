// Bit rows straight from a chunk's packed palette indices (plan-meshing phase 7), so
// the mesher never expands a chunk to dense ids. Pure.
//
// A row is the 32 voxels x = 0..31 at one (z, y), voxel index r * 32 + x with
// r = z + 32 * y; row(r) returns bit x set where the voxel's palette index has its
// flag set (opaque, or a given id). With w bits per index a row is exactly w
// words, so for w <= 8 each byte of those words maps to up to 8 row bits through a
// 256-entry table built per chunk. 16-bit chunks read one index per voxel.
//
// transpose32() turns 32 rows into 32 columns: bit j of a[i] <-> bit i of a[j].

import { BLOCK_OPAQUE } from "../world/blocks.ts";
import type { ChunkData } from "../world/chunk.ts";

export class RowReader {
  private readonly table = new Uint32Array(256); // byte -> row bits (w <= 8)
  private readonly flags = new Uint8Array(65536); // palette index -> 0/1
  private words: Uint32Array | null = null;
  private bits = 0;
  private uniform = 0; // row value for uniform chunks: 0 or all ones

  // Flags every palette index whose id is opaque.
  beginOpaque(chunk: ChunkData): void {
    const n = chunk.paletteLength;
    for (let k = 0; k < n; k++) this.flags[k] = BLOCK_OPAQUE[chunk.paletteAt(k)];
    this.begin(chunk);
  }

  // Flags the palette index of `id`, if present.
  beginId(chunk: ChunkData, id: number): void {
    const n = chunk.paletteLength;
    for (let k = 0; k < n; k++) this.flags[k] = chunk.paletteAt(k) === id ? 1 : 0;
    this.begin(chunk);
  }

  private begin(chunk: ChunkData): void {
    const bits = chunk.bitsPerVoxel;
    this.bits = bits;
    this.words = chunk.indexWords();
    if (bits === 0) {
      this.uniform = this.flags[0] ? -1 : 0;
      return;
    }
    if (bits > 8) return;
    const perByte = 8 / bits;
    const mask = (1 << bits) - 1;
    const flags = this.flags;
    for (let v = 0; v < 256; v++) {
      let m = 0;
      for (let s = 0; s < perByte; s++) m |= flags[(v >>> (s * bits)) & mask] << s;
      this.table[v] = m;
    }
  }

  // Row r (z + 32 * y) as 32 bits, bit x = flag of voxel (x, y, z). Int32 semantics:
  // a full row is -1.
  row(r: number): number {
    const words = this.words;
    const t = this.table;
    switch (this.bits) {
      case 0:
        return this.uniform;
      case 1: {
        const w = words![r];
        return t[w & 255] | (t[(w >>> 8) & 255] << 8) | (t[(w >>> 16) & 255] << 16) | (t[w >>> 24] << 24);
      }
      case 2: {
        const w0 = words![r * 2], w1 = words![r * 2 + 1];
        return t[w0 & 255] | (t[(w0 >>> 8) & 255] << 4) | (t[(w0 >>> 16) & 255] << 8) | (t[w0 >>> 24] << 12) |
          (t[w1 & 255] << 16) | (t[(w1 >>> 8) & 255] << 20) | (t[(w1 >>> 16) & 255] << 24) | (t[w1 >>> 24] << 28);
      }
      case 4: {
        let m = 0;
        const base = r * 4;
        for (let i = 0; i < 4; i++) {
          const w = words![base + i];
          const s = i * 8;
          m |= (t[w & 255] << s) | (t[(w >>> 8) & 255] << (s + 2)) | (t[(w >>> 16) & 255] << (s + 4)) |
            (t[w >>> 24] << (s + 6));
        }
        return m;
      }
      case 8: {
        let m = 0;
        const base = r * 8;
        for (let i = 0; i < 8; i++) {
          const w = words![base + i];
          const s = i * 4;
          m |= (t[w & 255] << s) | (t[(w >>> 8) & 255] << (s + 1)) | (t[(w >>> 16) & 255] << (s + 2)) |
            (t[w >>> 24] << (s + 3));
        }
        return m;
      }
      default: { // 16 bits: two indices per word
        let m = 0;
        const base = r * 16;
        const f = this.flags;
        for (let i = 0; i < 16; i++) {
          const w = words![base + i];
          m |= (f[w & 0xffff] << (2 * i)) | (f[w >>> 16] << (2 * i + 1));
        }
        return m;
      }
    }
  }

  // Flag of one voxel (voxel index i).
  voxel(i: number): number {
    const bits = this.bits;
    if (bits === 0) return this.uniform & 1;
    const perWord = 32 / bits;
    return this.flags[(this.words![(i / perWord) | 0] >>> ((i % perWord) * bits)) & ((1 << bits) - 1)];
  }
}

// In-place transpose of a 32 x 32 bit matrix: afterwards bit j of a[i] is the old
// bit i of a[j] (bit 0 = least significant). Hacker's Delight, block swaps.
export function transpose32(a: Uint32Array): void {
  let m = 0x0000ffff;
  for (let j = 16; j !== 0; j >>= 1, m ^= m << j) {
    for (let k = 0; k < 32; k = (k + j + 1) & ~j) {
      const t = ((a[k] >>> j) ^ a[k + j]) & m;
      a[k + j] ^= t;
      a[k] ^= t << j;
    }
  }
}

const scratch = new Uint32Array(32);

// Y and Z columns from X columns (layouts in binary.ts): cy[x + 32z] bit y and
// cz[x + 32y] bit z are both bit x of cx[z + 32y].
export function columnsFromRows(cx: Uint32Array, cy: Uint32Array, cz: Uint32Array): void {
  const t = scratch;
  for (let y = 0; y < 32; y++) {
    for (let z = 0; z < 32; z++) t[z] = cx[z + 32 * y];
    transpose32(t);
    cz.set(t, 32 * y);
  }
  for (let z = 0; z < 32; z++) {
    for (let y = 0; y < 32; y++) t[y] = cx[z + 32 * y];
    transpose32(t);
    cy.set(t, 32 * z);
  }
}
