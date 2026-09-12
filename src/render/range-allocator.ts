// Range allocator for GPU arenas (plan-rendering phase 2): hands out [offset,
// offset + size) ranges of a fixed capacity in abstract units (quads, clusters).
// Pure CPU bookkeeping; the caller owns the buffer. No allocation per operation.
//
// Two-level segregated fit (TLSF, Masmano et al. 2004): free blocks sit in size
// classes (first level: power of two; second level: 8 linear steps within it), found
// through two bitmaps, so alloc and free are O(1). Every block, free or used, is
// also in an address-ordered list, and free() merges a block with free neighbors,
// so free space is always maximal runs.
//
// alloc() returns a block handle (not the offset: offsetOf(handle)); free() takes
// the handle. alloc fails (-1) only when no free run is large enough, or when the
// block table is full (`maxBlocks`, counted in `blockFailures`).

const SL_BITS = 3;
const SL_COUNT = 1 << SL_BITS; // second-level classes per first level
const SMALL = SL_COUNT; // sizes below this map to first level 0, one class each
const FL_COUNT = 32;
const NONE = -1;

function msb(x: number): number {
  return 31 - Math.clz32(x);
}

export class RangeAllocator {
  readonly capacity: number;
  usedUnits = 0;
  usedBlocks = 0;
  freeBlocks = 0;
  blockFailures = 0;
  // Block table: address list (prev/next), free-class list (prev/next), flags.
  private readonly offset: Int32Array;
  private readonly size: Int32Array;
  private readonly prevAddr: Int32Array;
  private readonly nextAddr: Int32Array;
  private readonly prevFree: Int32Array;
  private readonly nextFree: Int32Array;
  private readonly isFree: Uint8Array;
  private readonly spare: Int32Array; // unused block entries
  private spareCount: number;
  private lastBlock: number; // highest-address block
  private flBitmap = 0;
  private readonly slBitmap = new Uint32Array(FL_COUNT);
  private readonly heads = new Int32Array(FL_COUNT * SL_COUNT).fill(NONE);
  // Class of the last mapping (avoids returning pairs).
  private fl = 0;
  private sl = 0;

  constructor(capacity: number, maxBlocks: number) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity >= 2 ** 31) {
      throw new Error(`capacity ${capacity} outside 1..2^31-1`);
    }
    this.capacity = capacity;
    const n = maxBlocks + 1;
    this.offset = new Int32Array(n);
    this.size = new Int32Array(n);
    this.prevAddr = new Int32Array(n);
    this.nextAddr = new Int32Array(n);
    this.prevFree = new Int32Array(n);
    this.nextFree = new Int32Array(n);
    this.isFree = new Uint8Array(n);
    this.spare = new Int32Array(n);
    for (let i = 0; i < n; i++) this.spare[i] = n - 1 - i;
    this.spareCount = n;
    const b = this.newBlock(0, capacity);
    this.prevAddr[b] = this.nextAddr[b] = NONE;
    this.lastBlock = b;
    this.insertFree(b);
  }

  get freeUnits(): number {
    return this.capacity - this.usedUnits;
  }

  // End of the highest used block: ranges at or past it are all free.
  get highWater(): number {
    const b = this.lastBlock;
    return this.isFree[b] ? this.offset[b] : this.capacity;
  }

  offsetOf(block: number): number {
    return this.offset[block];
  }

  sizeOf(block: number): number {
    return this.size[block];
  }

  // A block of `units` (>= 1), or -1.
  alloc(units: number): number {
    if (units < 1 || units > this.capacity) return NONE;
    if (this.spareCount === 0) {
      this.blockFailures++; // a split may need a new entry
      return NONE;
    }
    let b = this.findFree(units);
    if (b === NONE) return NONE;
    this.removeFree(b);
    const rest = this.size[b] - units;
    if (rest > 0) {
      const r = this.newBlock(this.offset[b] + units, rest);
      this.size[b] = units;
      // Link r after b in address order.
      const next = this.nextAddr[b];
      this.prevAddr[r] = b;
      this.nextAddr[r] = next;
      this.nextAddr[b] = r;
      if (next !== NONE) this.prevAddr[next] = r;
      else this.lastBlock = r;
      this.insertFree(r);
    }
    this.isFree[b] = 0;
    this.usedUnits += units;
    this.usedBlocks++;
    return b;
  }

  free(block: number): void {
    if (this.isFree[block]) throw new Error(`block ${block} freed twice`);
    this.usedUnits -= this.size[block];
    this.usedBlocks--;
    let b = block;
    const prev = this.prevAddr[b];
    if (prev !== NONE && this.isFree[prev]) {
      this.removeFree(prev);
      this.size[prev] += this.size[b];
      this.unlinkAddr(b);
      b = prev;
    }
    const next = this.nextAddr[b];
    if (next !== NONE && this.isFree[next]) {
      this.removeFree(next);
      this.size[b] += this.size[next];
      this.unlinkAddr(next);
    }
    this.insertFree(b);
  }

  // Size of the largest free run. Walks the highest non-empty class: for stats,
  // not the frame path.
  largestFree(): number {
    if (this.flBitmap === 0) return 0;
    const fl = msb(this.flBitmap);
    let best = 0;
    for (let sl = SL_COUNT - 1; sl >= 0 && best === 0; sl--) {
      if (((this.slBitmap[fl] >>> sl) & 1) === 0) continue;
      for (let b = this.heads[fl * SL_COUNT + sl]; b !== NONE; b = this.nextFree[b]) {
        if (this.size[b] > best) best = this.size[b];
      }
    }
    return best;
  }

  // 0 when all free space is one run, toward 1 as it splinters.
  fragmentation(): number {
    const free = this.freeUnits;
    return free === 0 ? 0 : 1 - this.largestFree() / free;
  }

  // Class of `size` (rounded down): sets this.fl, this.sl.
  private mapping(size: number): void {
    if (size < SMALL) {
      this.fl = 0;
      this.sl = size;
    } else {
      const m = msb(size);
      this.fl = m - SL_BITS + 1;
      this.sl = (size >>> (m - SL_BITS)) ^ SL_COUNT;
    }
  }

  // A free block of at least `units`: first any block from a class whose every
  // member fits (the next class up), else a first-fit scan of the request's own
  // class, whose members may be smaller.
  private findFree(units: number): number {
    // Round the request up to the next class boundary.
    let rounded = units;
    if (units >= SMALL) rounded += (1 << (msb(units) - SL_BITS)) - 1;
    this.mapping(rounded);
    let fl = this.fl, sl = this.sl;
    if (fl < FL_COUNT) {
      let slMap = this.slBitmap[fl] & (~0 << sl);
      if (slMap === 0) {
        const flMap = fl + 1 < FL_COUNT ? this.flBitmap & (~0 << (fl + 1)) : 0;
        if (flMap !== 0) {
          fl = 31 - Math.clz32(flMap & -flMap);
          slMap = this.slBitmap[fl];
        }
      }
      if (slMap !== 0) {
        sl = 31 - Math.clz32(slMap & -slMap);
        const b = this.heads[fl * SL_COUNT + sl];
        if (this.size[b] >= units) return b;
      }
    }
    // The request's own class holds blocks between its lower bound and the
    // rounded size; scan it.
    this.mapping(units);
    for (let b = this.heads[this.fl * SL_COUNT + this.sl]; b !== NONE; b = this.nextFree[b]) {
      if (this.size[b] >= units) return b;
    }
    return NONE;
  }

  private insertFree(b: number): void {
    this.mapping(this.size[b]);
    const i = this.fl * SL_COUNT + this.sl;
    const head = this.heads[i];
    this.prevFree[b] = NONE;
    this.nextFree[b] = head;
    if (head !== NONE) this.prevFree[head] = b;
    this.heads[i] = b;
    this.slBitmap[this.fl] |= 1 << this.sl;
    this.flBitmap |= 1 << this.fl;
    this.isFree[b] = 1;
    this.freeBlocks++;
  }

  private removeFree(b: number): void {
    this.mapping(this.size[b]);
    const i = this.fl * SL_COUNT + this.sl;
    const prev = this.prevFree[b], next = this.nextFree[b];
    if (prev !== NONE) this.nextFree[prev] = next;
    else this.heads[i] = next;
    if (next !== NONE) this.prevFree[next] = prev;
    if (this.heads[i] === NONE) {
      this.slBitmap[this.fl] &= ~(1 << this.sl);
      if (this.slBitmap[this.fl] === 0) this.flBitmap &= ~(1 << this.fl);
    }
    this.isFree[b] = 0;
    this.freeBlocks--;
  }

  private newBlock(offset: number, size: number): number {
    const b = this.spare[--this.spareCount];
    this.offset[b] = offset;
    this.size[b] = size;
    return b;
  }

  // Drops b from the address list and returns its entry (b is merged away).
  private unlinkAddr(b: number): void {
    const prev = this.prevAddr[b], next = this.nextAddr[b];
    if (prev !== NONE) this.nextAddr[prev] = next;
    if (next !== NONE) this.prevAddr[next] = prev;
    else this.lastBlock = prev;
    this.isFree[b] = 0;
    this.spare[this.spareCount++] = b;
  }
}
