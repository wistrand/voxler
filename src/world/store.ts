// Chunk store: chunk table (key -> slot), slot records with generation counters,
// and the payload arena. Main thread only; workers read payloads through the arena
// buffer (shared path) or copies (copy path). ChunkStreamer (streaming.ts) decides
// what is resident.
//
// Handles pack (slot, generation) into one number: a handle kept across a remove
// reads as stale instead of silently pointing at whatever reuses the slot.
// Replacing a stored chunk (put on the same key) keeps its handle: the handle names
// the chunk, not a version of its data. Edit versions are tracked by the mesh
// scheduler.
//
// Deferred frees (shared arena): workers read blocks straight from the arena, so a
// block released while a job may still read it must not be reused yet. With
// `deferFrees` set, released blocks are retired with the current `freeStamp` and
// only return to the arena through reclaim(safeStamp), once every job that might
// read them has ended (MeshScheduler owns the stamps).

import { BLOCK_OPAQUE } from "./blocks.ts";
import { blockBytes, PayloadArena } from "./arena.ts";
import { ChunkData } from "./chunk.ts";
import { ChunkTable } from "./chunk-table.ts";
import { chunkKey } from "./keys.ts";

const SLOT_LIMIT = 1 << 22; // slots per store; handle = generation * SLOT_LIMIT + slot
const NO_BLOCK = -1;

export interface StoreOptions {
  maxChunks: number; // slot count; also sizes the table
  arenaBytes: number;
  shared: boolean; // SharedArrayBuffer arena when the page can share memory
}

export class ChunkStore {
  readonly arena: PayloadArena;
  uniformCount = 0; // stored chunks without an arena block
  deferFrees = false;
  freeStamp = 0; // stamp given to blocks retired now
  // Retired blocks, FIFO with non-decreasing stamps: [offset, bytes, stamp] triples.
  private retired = new Float64Array(3 * 256);
  private retiredHead = 0; // triple index
  private retiredTail = 0;
  retiredBytes = 0;
  private readonly table: ChunkTable;
  private readonly slotKey: Float64Array;
  private readonly slotGen: Uint32Array;
  private readonly slotUniform: Int32Array; // block id when uniform, -1 when in the arena
  private readonly slotOffset: Int32Array; // arena byte offset, NO_BLOCK when none
  private readonly slotBytes: Int32Array; // bytes requested for the block
  private readonly freeSlots: Int32Array;
  private freeCount: number;

  constructor(options: StoreOptions) {
    const n = options.maxChunks;
    if (n > SLOT_LIMIT) throw new Error(`maxChunks ${n} exceeds ${SLOT_LIMIT}`);
    this.arena = new PayloadArena(options.arenaBytes, options.shared);
    this.table = new ChunkTable(n);
    this.slotKey = new Float64Array(n);
    this.slotGen = new Uint32Array(n);
    this.slotUniform = new Int32Array(n).fill(-1);
    this.slotOffset = new Int32Array(n).fill(NO_BLOCK);
    this.slotBytes = new Int32Array(n);
    this.freeSlots = new Int32Array(n);
    for (let i = 0; i < n; i++) this.freeSlots[i] = n - 1 - i; // pop gives slot 0 first
    this.freeCount = n;
  }

  get count(): number {
    return this.table.size;
  }

  get capacity(): number {
    return this.slotKey.length;
  }

  // Stores or replaces a chunk. Returns its handle, or -1 when the store or the
  // arena is full (the caller evicts and retries).
  put(cx: number, cy: number, cz: number, chunk: ChunkData): number {
    const key = chunkKey(cx, cy, cz);
    if (chunk.isUniform) return this.putUniform(key, chunk.uniformId);
    const parts = chunk.toParts();
    const slot = this.claim(key);
    if (slot === -1) return -1;
    const bytes = blockBytes(parts);
    const offset = this.arena.alloc(bytes);
    if (offset === -1) return this.failClaim(slot, key);
    this.arena.write(offset, parts);
    return this.commitBlock(slot, key, offset, bytes);
  }

  putUniform(key: number, id: number): number {
    const slot = this.claim(key);
    if (slot === -1) return -1;
    this.slotUniform[slot] = id;
    this.uniformCount++;
    return this.commit(slot, key);
  }

  // Stores a block serialized with writeBlock() at offset 0 of `block` (a worker's
  // compress output); `bytes` is its blockBytes(). Copies it into the arena.
  putBlock(key: number, block: ArrayBuffer, bytes: number): number {
    const slot = this.claim(key);
    if (slot === -1) return -1;
    const offset = this.arena.alloc(bytes);
    if (offset === -1) return this.failClaim(slot, key);
    this.arena.writeRaw(offset, block, bytes);
    return this.commitBlock(slot, key, offset, bytes);
  }

  hasKey(key: number): boolean {
    return this.table.get(key) !== -1;
  }

  // Current handle for a chunk, or -1 when not stored.
  handle(cx: number, cy: number, cz: number): number {
    const slot = this.table.get(chunkKey(cx, cy, cz));
    return slot === -1 ? -1 : this.slotGen[slot] * SLOT_LIMIT + slot;
  }

  // True while the handle's chunk is still stored in that slot.
  isLive(handle: number): boolean {
    const slot = handle % SLOT_LIMIT;
    return handle >= 0 && this.slotGen[slot] === Math.floor(handle / SLOT_LIMIT) &&
      this.table.get(this.slotKey[slot]) === slot;
  }

  // A read-only view of the chunk (no copy for arena chunks), or null when stale.
  read(handle: number): ChunkData | null {
    if (!this.isLive(handle)) return null;
    const slot = handle % SLOT_LIMIT;
    const uniform = this.slotUniform[slot];
    return uniform >= 0 ? ChunkData.uniform(uniform) : this.arena.read(this.slotOffset[slot]);
  }

  // One voxel's block id from a stored chunk, or -1 when the chunk is not stored.
  // `index` is a `voxelIndex()` within the chunk. Allocates nothing, unlike `read()`,
  // which is what anything walking a column of voxels needs (arena.ts `blockAt`).
  blockAt(cx: number, cy: number, cz: number, index: number): number {
    const slot = this.table.get(chunkKey(cx, cy, cz));
    return slot === -1 ? -1 : this.blockAtSlot(slot, index);
  }

  // The same, for a caller that already has the slot from `slotOf()`. A column of voxels
  // crosses one chunk every 32 steps, so holding the slot across them turns a hash probe
  // per voxel into one per chunk, and a uniform chunk (open air, deep rock) answers
  // without touching the arena at all. `raycast.ts` does the same.
  blockAtSlot(slot: number, index: number): number {
    const uniform = this.slotUniform[slot];
    return uniform >= 0 ? uniform : this.arena.blockAt(this.slotOffset[slot], index);
  }

  // Arena byte offset of a stored chunk's block, or -1 for uniform or stale. With a
  // shared arena, workers read the block at this offset (arena.ts readParts()).
  blockOffset(handle: number): number {
    if (!this.isLive(handle)) return -1;
    return this.slotOffset[handle % SLOT_LIMIT];
  }

  // Slot of a stored key, or -1. With the slot getters below, for building job
  // inputs without allocating handles.
  slotOf(key: number): number {
    return this.table.get(key);
  }

  // Block id of a uniform chunk's slot, or -1 when the chunk is in the arena.
  slotUniformId(slot: number): number {
    return this.slotUniform[slot];
  }

  slotBlockOffset(slot: number): number {
    return this.slotOffset[slot];
  }

  // True when nothing in the chunk at `slot` can have a face inside it: a uniform
  // opaque block, or an arena chunk whose whole palette is opaque (`PayloadArena.allOpaque`).
  slotAllOpaque(slot: number): boolean {
    const uniform = this.slotUniform[slot];
    if (uniform >= 0) return BLOCK_OPAQUE[uniform] === 1;
    return this.arena.allOpaque(this.slotOffset[slot]);
  }

  // True when the face of the chunk at `slot` on `axis` at coordinate `at` (0 or 31)
  // is opaque all over, so a chunk against it has no face there
  // (`PayloadArena.faceAllOpaque`).
  slotFaceAllOpaque(slot: number, axis: number, at: number): boolean {
    const uniform = this.slotUniform[slot];
    if (uniform >= 0) return BLOCK_OPAQUE[uniform] === 1;
    return this.arena.faceAllOpaque(this.slotOffset[slot], axis, at);
  }

  slotBlockBytes(slot: number): number {
    return this.slotBytes[slot];
  }

  get retiredCount(): number {
    return this.retiredTail - this.retiredHead;
  }

  // Returns retired blocks with stamp <= safeStamp to the arena.
  reclaim(safeStamp: number): void {
    const r = this.retired;
    while (this.retiredHead < this.retiredTail && r[this.retiredHead * 3 + 2] <= safeStamp) {
      const i = this.retiredHead * 3;
      this.arena.release(r[i], r[i + 1]);
      this.retiredBytes -= r[i + 1];
      this.retiredHead++;
    }
    if (this.retiredHead === this.retiredTail) this.retiredHead = this.retiredTail = 0;
  }

  remove(cx: number, cy: number, cz: number): boolean {
    return this.removeKey(chunkKey(cx, cy, cz));
  }

  removeKey(key: number): boolean {
    const slot = this.table.get(key);
    if (slot === -1) return false;
    this.removeSlot(slot, key);
    return true;
  }

  // Slot for a key: its existing slot with the old payload released, or a free one.
  // -1 when there are no free slots.
  private claim(key: number): number {
    const slot = this.table.get(key);
    if (slot !== -1) {
      this.releasePayload(slot);
      return slot;
    }
    if (this.freeCount === 0) return -1;
    return this.freeSlots[--this.freeCount];
  }

  // Undo a claim whose arena allocation failed: a new slot goes back to the free
  // list; an existing chunk (its payload already released) is removed.
  private failClaim(slot: number, key: number): number {
    if (this.table.get(key) === slot) this.removeSlot(slot, key);
    else this.freeSlots[this.freeCount++] = slot;
    return -1;
  }

  private commitBlock(slot: number, key: number, offset: number, bytes: number): number {
    this.slotUniform[slot] = -1;
    this.slotOffset[slot] = offset;
    this.slotBytes[slot] = bytes;
    return this.commit(slot, key);
  }

  private commit(slot: number, key: number): number {
    if (this.table.get(key) !== slot) {
      this.slotKey[slot] = key;
      this.table.set(key, slot);
    }
    return this.slotGen[slot] * SLOT_LIMIT + slot;
  }

  private removeSlot(slot: number, key: number): void {
    this.releasePayload(slot);
    this.table.delete(key);
    // 31-bit generations keep handles (generation * 2^22 + slot) below 2^53.
    this.slotGen[slot] = (this.slotGen[slot] + 1) & 0x7fffffff;
    this.freeSlots[this.freeCount++] = slot;
  }

  private retire(offset: number, bytes: number): void {
    if (this.retiredTail * 3 + 3 > this.retired.length) {
      // Compact to the front; grow when more than half is live. Rare: the list
      // drains every frame once jobs settle.
      const liveWords = (this.retiredTail - this.retiredHead) * 3;
      if (liveWords + 3 > this.retired.length / 2) {
        const grown = new Float64Array(this.retired.length * 2);
        grown.set(this.retired.subarray(this.retiredHead * 3, this.retiredTail * 3));
        this.retired = grown;
      } else {
        this.retired.copyWithin(0, this.retiredHead * 3, this.retiredTail * 3);
      }
      this.retiredTail -= this.retiredHead;
      this.retiredHead = 0;
    }
    const i = this.retiredTail * 3;
    this.retired[i] = offset;
    this.retired[i + 1] = bytes;
    this.retired[i + 2] = this.freeStamp;
    this.retiredTail++;
    this.retiredBytes += bytes;
  }

  private releasePayload(slot: number): void {
    const offset = this.slotOffset[slot];
    if (offset !== NO_BLOCK) {
      if (this.deferFrees) this.retire(offset, this.slotBytes[slot]);
      else this.arena.release(offset, this.slotBytes[slot]);
      this.slotOffset[slot] = NO_BLOCK;
    } else if (this.slotUniform[slot] >= 0) {
      this.uniformCount--;
    }
    this.slotUniform[slot] = -1;
  }
}
