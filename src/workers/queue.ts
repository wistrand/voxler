// Binary min-heap keyed by (priority, seq). Items carry their own heap index so a
// queued job can be removed or re-prioritized in O(log n). Lower priority values
// run first; equal priorities run in submission order.

export interface QueueItem {
  priority: number;
  seq: number;
  heapIndex: number; // -1 when not queued
}

export class PriorityQueue<T extends QueueItem> {
  private readonly items: T[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    item.heapIndex = this.items.length;
    this.items.push(item);
    this.siftUp(item.heapIndex);
  }

  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      last.heapIndex = 0;
      this.siftDown(0);
    }
    top.heapIndex = -1;
    return top;
  }

  // Removes a queued item. False if it wasn't queued.
  remove(item: T): boolean {
    const i = item.heapIndex;
    const items = this.items;
    if (i < 0 || i >= items.length || items[i] !== item) return false;
    const last = items.pop()!;
    if (i < items.length) {
      items[i] = last;
      last.heapIndex = i;
      this.siftUp(i);
      this.siftDown(last.heapIndex);
    }
    item.heapIndex = -1;
    return true;
  }

  // Restores heap order after item.priority changed.
  update(item: T): void {
    if (item.heapIndex < 0) return;
    this.siftUp(item.heapIndex);
    this.siftDown(item.heapIndex);
  }

  private less(a: T, b: T): boolean {
    return a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq);
  }

  private siftUp(i: number): void {
    const items = this.items;
    const item = items[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(item, items[parent])) break;
      items[i] = items[parent];
      items[i].heapIndex = i;
      i = parent;
    }
    items[i] = item;
    item.heapIndex = i;
  }

  private siftDown(i: number): void {
    const items = this.items;
    const n = items.length;
    const item = items[i];
    for (;;) {
      const left = 2 * i + 1;
      if (left >= n) break;
      const right = left + 1;
      const child = right < n && this.less(items[right], items[left]) ? right : left;
      if (!this.less(items[child], item)) break;
      items[i] = items[child];
      items[i].heapIndex = i;
      i = child;
    }
    items[i] = item;
    item.heapIndex = i;
  }
}
