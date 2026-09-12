import { BufferPool, sizeClass } from "./buffers.ts";
import { PriorityQueue, type QueueItem } from "./queue.ts";

function assertEquals(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: ${actual} !== ${expected}`);
}

interface Item extends QueueItem {
  name: string;
}

function item(name: string, priority: number, seq: number): Item {
  return { name, priority, seq, heapIndex: -1 };
}

function drain(q: PriorityQueue<Item>): string {
  const out: string[] = [];
  for (let it = q.pop(); it; it = q.pop()) out.push(it.name);
  return out.join(",");
}

Deno.test("queue pops by priority, then submission order", () => {
  const q = new PriorityQueue<Item>();
  q.push(item("c", 3, 0));
  q.push(item("a1", 1, 1));
  q.push(item("b", 2, 2));
  q.push(item("a2", 1, 3));
  assertEquals(drain(q), "a1,a2,b,c", "order");
});

Deno.test("queue remove and update keep heap order", () => {
  const q = new PriorityQueue<Item>();
  const items = [5, 3, 8, 1, 9, 2, 7].map((p, i) => item(`p${p}`, p, i));
  for (const it of items) q.push(it);
  assertEquals(q.remove(items[1]), true, "remove p3");
  assertEquals(q.remove(items[1]), false, "remove twice");
  items[2].priority = 0; // p8 jumps to the front
  q.update(items[2]);
  assertEquals(drain(q), "p8,p1,p2,p5,p7,p9", "order after remove and update");
});

Deno.test("queue survives random operations against a sorted reference", () => {
  const q = new PriorityQueue<Item>();
  const live: Item[] = [];
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let step = 0; step < 2000; step++) {
    const r = rand();
    if (r < 0.5 || live.length === 0) {
      const it = item(`i${step}`, Math.floor(rand() * 50), step);
      q.push(it);
      live.push(it);
    } else if (r < 0.7) {
      const it = live.splice(Math.floor(rand() * live.length), 1)[0];
      assertEquals(q.remove(it), true, `remove at step ${step}`);
    } else if (r < 0.85) {
      const it = live[Math.floor(rand() * live.length)];
      it.priority = Math.floor(rand() * 50);
      q.update(it);
    } else {
      live.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const expected = live.shift()!;
      assertEquals(q.pop(), expected, `pop at step ${step}`);
    }
    assertEquals(q.size, live.length, `size at step ${step}`);
  }
});

Deno.test("size classes are powers of two with a floor", () => {
  assertEquals(sizeClass(1), 64, "tiny");
  assertEquals(sizeClass(64), 64, "exact floor");
  assertEquals(sizeClass(65), 128, "just over");
  assertEquals(sizeClass(4096), 4096, "exact power");
  assertEquals(sizeClass(4097), 8192, "over power");
});

Deno.test("buffer pool reuses released buffers of the same class", () => {
  const pool = new BufferPool();
  const a = pool.alloc(100);
  assertEquals(a.byteLength, 128, "class size");
  pool.release(a);
  assertEquals(pool.alloc(120), a, "reused");
  pool.release(new ArrayBuffer(100)); // not a class size: ignored
  assertEquals(pool.pooledBytes, 0, "ignored odd size");
});
