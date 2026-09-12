// Buffer reuse. Workers allocate result buffers from a BufferPool in power-of-two
// size classes; the main thread sends consumed buffers back (WorkerPool.recycle)
// so steady-state jobs allocate nothing.

const MIN_CLASS = 64;
const MAX_PER_CLASS = 32;

// Smallest power of two >= bytes, at least MIN_CLASS.
export function sizeClass(bytes: number): number {
  if (bytes <= MIN_CLASS) return MIN_CLASS;
  return 2 ** (32 - Math.clz32(bytes - 1));
}

export class BufferPool {
  private readonly free = new Map<number, ArrayBuffer[]>();

  // A buffer of at least `bytes`; its byteLength is the size class.
  alloc(bytes: number): ArrayBuffer {
    const size = sizeClass(bytes);
    return this.free.get(size)?.pop() ?? new ArrayBuffer(size);
  }

  // Returns a buffer for reuse. Ignores detached buffers and non-class sizes.
  release(buffer: ArrayBuffer): void {
    const size = buffer.byteLength;
    if (size === 0 || size !== sizeClass(size)) return;
    let list = this.free.get(size);
    if (!list) {
      list = [];
      this.free.set(size, list);
    }
    if (list.length < MAX_PER_CLASS) list.push(buffer);
  }

  get pooledBytes(): number {
    let total = 0;
    for (const [size, list] of this.free) total += size * list.length;
    return total;
  }
}

// True when SharedArrayBuffer can be shared with workers: in a cross-origin
// isolated page, or in Deno (which has no crossOriginIsolated global and always
// allows it).
export function canShareMemory(): boolean {
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  return typeof SharedArrayBuffer === "function" && isolated !== false;
}

// Memory readable by every worker without copying when canShareMemory(); a plain
// ArrayBuffer (copied per job) otherwise.
export function allocShared(bytes: number): ArrayBuffer | SharedArrayBuffer {
  return canShareMemory() ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
}
