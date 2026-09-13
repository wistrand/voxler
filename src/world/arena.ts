// Payload arena: chunk payloads (palette + packed index words) in one buffer, so
// mesh workers can read a chunk and its neighbors without copies when the buffer is
// a SharedArrayBuffer. Same API over a plain ArrayBuffer (the copy path: blocks are
// copied out per job instead). Block layout: agent_docs/design-formats.md
// "Payload arena".
//
// Allocation: power-of-two size classes from 256 B to 256 KiB, bump allocation for
// new blocks, a free list per class. No coalescing across classes. Only the main
// thread allocates and writes; workers only read.

import { allocShared } from "../workers/buffers.ts";
import { ChunkData, type ChunkParts } from "./chunk.ts";

const HEADER_BYTES = 16; // u32 bits, u32 palette length, u32 word count, u32 reserved
const MIN_CLASS_LOG = 8; // 256 B
const MAX_CLASS_LOG = 18; // 256 KiB: 16-bit width (64 KiB words) with a full palette
const CLASSES = MAX_CLASS_LOG - MIN_CLASS_LOG + 1;

function pad4(n: number): number {
  return (n + 3) & ~3;
}

// Bytes a chunk's block needs (before rounding up to a size class).
export function blockBytes(parts: ChunkParts): number {
  return HEADER_BYTES + pad4(parts.palette.length * 2) + (parts.words ? parts.words.byteLength : 0);
}

function classOf(bytes: number): number {
  let log = MIN_CLASS_LOG;
  while ((1 << log) < bytes) log++;
  return log - MIN_CLASS_LOG;
}

// log2(bits) for the packed index widths, as in chunk.ts `get()`.
const LOG2: Readonly<Record<number, number>> = { 1: 0, 2: 1, 4: 2, 8: 3, 16: 4 };

export class PayloadArena {
  readonly buffer: ArrayBuffer | SharedArrayBuffer;
  readonly shared: boolean;
  private top = 0; // bump pointer, bytes
  private readonly freeLists: number[][] = Array.from({ length: CLASSES }, () => []);
  private used = 0; // bytes in live blocks (class sizes)
  // Whole-buffer views, built once, so `blockAt()` can decode a voxel without making a
  // view per call. Read-only: everything that writes goes through writeBlock().
  private readonly u32: Uint32Array;
  private readonly u16: Uint16Array;

  // `shared`: SharedArrayBuffer when the page can share memory, else ArrayBuffer.
  constructor(bytes: number, shared: boolean) {
    this.buffer = shared ? allocShared(bytes) : new ArrayBuffer(bytes);
    // The SharedArrayBuffer global is missing in non-isolated pages; guard the check.
    this.shared = typeof SharedArrayBuffer === "function" && this.buffer instanceof SharedArrayBuffer;
    this.u32 = new Uint32Array(this.buffer);
    this.u16 = new Uint16Array(this.buffer);
  }

  get capacityBytes(): number {
    return this.buffer.byteLength;
  }

  // Bytes in live blocks, rounded to their size classes.
  get usedBytes(): number {
    return this.used;
  }

  // Bytes ever carved from the buffer (live plus free-listed).
  get reservedBytes(): number {
    return this.top;
  }

  // Byte offset of a block holding `bytes`, or -1 when the arena is full.
  alloc(bytes: number): number {
    const c = classOf(bytes);
    if (c >= CLASSES) throw new Error(`arena block of ${bytes} B exceeds the largest class`);
    const size = 1 << (c + MIN_CLASS_LOG);
    let offset = this.freeLists[c].pop();
    if (offset === undefined) {
      if (this.top + size > this.buffer.byteLength) return -1;
      offset = this.top;
      this.top += size;
    }
    this.used += size;
    return offset;
  }

  // Returns a block allocated with the same byte count.
  release(offset: number, bytes: number): void {
    const c = classOf(bytes);
    this.freeLists[c].push(offset);
    this.used -= 1 << (c + MIN_CLASS_LOG);
  }

  // Writes a chunk's parts into a block allocated with blockBytes(parts).
  write(offset: number, parts: ChunkParts): void {
    writeBlock(this.buffer, offset, parts);
  }

  // Copies a block already serialized with writeBlock() (by a worker, at offset 0 of
  // `source`) into an allocated block. `bytes` is its blockBytes().
  writeRaw(offset: number, source: ArrayBuffer, bytes: number): void {
    new Uint8Array(this.buffer, offset, bytes).set(new Uint8Array(source, 0, bytes));
  }

  // A read-only ChunkData view of a block: no copy. Don't call set() or compact()
  // on it; edits go through ChunkStore.put().
  read(offset: number): ChunkData {
    return ChunkData.fromParts(readParts(this.buffer, offset));
  }

  // One voxel's block id out of a block, allocating nothing. `read()` builds three
  // typed-array views, a `ChunkParts` and a `ChunkData` every call, which is right for a
  // job that then reads the whole chunk and wrong for anything that walks a column of
  // voxels: the follow flyover reads a few thousand a frame, and at five objects each
  // that is the GC in the frame path (CLAUDE.md "Never allocate in the per-frame path").
  // `index` is a `voxelIndex()`. Decodes the same layout as `ChunkData.get()`.
  blockAt(offset: number, index: number): number {
    const w = offset >>> 2;
    const bits = this.u32[w];
    const palette = (offset + HEADER_BYTES) >>> 1; // in u16s
    if (bits === 0) return this.u16[palette];
    const words = (offset + HEADER_BYTES + pad4(this.u32[w + 1] * 2)) >>> 2;
    const perWordLog = 5 - LOG2[bits];
    const shift = (index & ((1 << perWordLog) - 1)) * bits;
    return this.u16[palette + ((this.u32[words + (index >>> perWordLog)] >>> shift) & ((1 << bits) - 1))];
  }
}

// Serializes a chunk's parts in block layout at `offset` of any buffer: the arena,
// or a worker's pooled output buffer (then copied in with writeRaw()).
export function writeBlock(buffer: ArrayBuffer | SharedArrayBuffer, offset: number, parts: ChunkParts): void {
  const paletteLength = parts.palette.length;
  const wordCount = parts.words ? parts.words.length : 0;
  const header = new Uint32Array(buffer, offset, 4);
  header[0] = parts.bits;
  header[1] = paletteLength;
  header[2] = wordCount;
  header[3] = 0;
  new Uint16Array(buffer, offset + HEADER_BYTES, paletteLength).set(parts.palette);
  if (parts.words) {
    new Uint32Array(buffer, offset + HEADER_BYTES + pad4(paletteLength * 2), wordCount).set(parts.words);
  }
}

// Views of a block's parts in any buffer holding an arena (a worker's view of the
// shared buffer, or a block copied out on the copy path at offset 0).
export function readParts(buffer: ArrayBuffer | SharedArrayBuffer, offset: number): ChunkParts {
  const header = new Uint32Array(buffer, offset, 4);
  const bits = header[0];
  const paletteLength = header[1];
  const wordCount = header[2];
  const palette = new Uint16Array(buffer, offset + HEADER_BYTES, paletteLength);
  const words = wordCount > 0
    ? new Uint32Array(buffer, offset + HEADER_BYTES + pad4(paletteLength * 2), wordCount)
    : null;
  return { bits, palette, words };
}
