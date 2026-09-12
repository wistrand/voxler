// Brick pool allocator (plan-far-field phase 3). Slots of BRICK_WORDS in one storage
// buffer, shared by every clipmap level: with L levels of B^3 bricks a slot per grid
// cell would be L * B^3 slots (132 MiB at L = 7, B = 32, past the default
// maxStorageBufferBindingSize), while only the bricks that hold a surface need one.
//
// Slots are fixed size, so there is no fragmentation and the free list is a stack:
// take() pops, give() pushes, both O(1). The GPU is what decides which bricks are
// occupied, so a build takes a list of slots up front and reports back how many it
// used; the rest come back to the stack (src/far/far-field.ts).

export class BrickPool {
  readonly capacity: number;
  // Free slots, stack[0..top). Order does not matter; slots are interchangeable.
  private readonly stack: Uint32Array;
  private top: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.stack = new Uint32Array(capacity);
    for (let i = 0; i < capacity; i++) this.stack[i] = capacity - 1 - i; // hand out 0 first
    this.top = capacity;
  }

  get free(): number {
    return this.top;
  }

  get used(): number {
    return this.capacity - this.top;
  }

  // Pops up to `n` slots into `out` at `at`. Returns how many, which is less than `n`
  // only when the pool is short: the caller drops the bricks it could not place.
  take(out: Uint32Array, at: number, n: number): number {
    const count = Math.min(n, this.top);
    for (let i = 0; i < count; i++) out[at + i] = this.stack[--this.top];
    return count;
  }

  give(slot: number): void {
    if (this.top >= this.capacity) throw new Error("brick pool free list overflow");
    this.stack[this.top++] = slot;
  }

  giveRange(slots: Uint32Array, from: number, to: number): void {
    for (let i = from; i < to; i++) this.give(slots[i]);
  }

  reset(): void {
    for (let i = 0; i < this.capacity; i++) this.stack[i] = this.capacity - 1 - i;
    this.top = this.capacity;
  }
}
