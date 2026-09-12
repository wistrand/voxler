// Fixed-capacity ring of float64 samples. push() never allocates; once full, the
// oldest sample is overwritten.

export class RingBuffer {
  readonly capacity: number;
  private readonly data: Float64Array;
  private head = 0; // next write index
  private size = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.data = new Float64Array(capacity);
  }

  get count(): number {
    return this.size;
  }

  push(value: number): void {
    this.data[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  // Most recent sample, or NaN when empty.
  latest(): number {
    return this.size === 0 ? NaN : this.data[(this.head - 1 + this.capacity) % this.capacity];
  }

  // Copies samples oldest-first into `out` (length >= count). Returns the count.
  copyTo(out: Float64Array): number {
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) out[i] = this.data[(start + i) % this.capacity];
    return this.size;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }
}
