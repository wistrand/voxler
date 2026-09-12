import { RangeAllocator } from "./range-allocator.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

// Longest run of free units in the reference.
function longestFree(owner: Int32Array): number {
  let best = 0, run = 0;
  for (let i = 0; i < owner.length; i++) {
    run = owner[i] === -1 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

Deno.test("random alloc/free against a reference: no overlaps, fails only without a fitting run", () => {
  for (const [seed, capacity, maxSize] of [[1, 1000, 40], [2, 5000, 300], [3, 64, 64], [4, 20000, 7]] as const) {
    const rand = lcg(seed);
    const a = new RangeAllocator(capacity, 4096);
    const owner = new Int32Array(capacity).fill(-1); // unit -> block handle
    const live: number[] = [];
    let used = 0;
    for (let step = 0; step < 20000; step++) {
      if (live.length > 0 && rand() < 0.45) {
        const i = Math.floor(rand() * live.length);
        const b = live[i];
        live[i] = live[live.length - 1];
        live.pop();
        const o = a.offsetOf(b), n = a.sizeOf(b);
        for (let u = o; u < o + n; u++) {
          assert(owner[u] === b, `seed ${seed}: freeing unit ${u} not owned by ${b}`);
          owner[u] = -1;
        }
        used -= n;
        a.free(b);
      } else {
        const n = 1 + Math.floor(rand() * maxSize);
        const b = a.alloc(n);
        if (b === -1) {
          assert(longestFree(owner) < n, `seed ${seed}: alloc(${n}) failed with a run of ${longestFree(owner)} free`);
          continue;
        }
        const o = a.offsetOf(b);
        assert(a.sizeOf(b) === n && o >= 0 && o + n <= capacity, `seed ${seed}: block ${o}+${a.sizeOf(b)} for ${n}`);
        for (let u = o; u < o + n; u++) {
          assert(owner[u] === -1, `seed ${seed}: unit ${u} handed out twice`);
          owner[u] = b;
        }
        used += n;
        live.push(b);
      }
      assert(a.usedUnits === used && a.usedBlocks === live.length, `seed ${seed}: counts at step ${step}`);
      if (step % 997 === 0) {
        assert(a.largestFree() === longestFree(owner), `seed ${seed}: largest free ${a.largestFree()}`);
        let high = 0;
        for (let u = capacity - 1; u >= 0; u--) if (owner[u] !== -1) {
          high = u + 1;
          break;
        }
        assert(a.highWater === high, `seed ${seed}: high water ${a.highWater}, expected ${high}`);
      }
    }
    for (const b of live) a.free(b);
    assert(a.usedUnits === 0 && a.freeBlocks === 1 && a.largestFree() === capacity, `seed ${seed}: coalesced back`);
    assert(a.highWater === 0 && a.fragmentation() === 0, `seed ${seed}: empty`);
  }
});

Deno.test("free coalesces with both neighbors; exact fits reuse the hole", () => {
  const a = new RangeAllocator(100, 16);
  const x = a.alloc(10), y = a.alloc(20), z = a.alloc(30);
  assert(a.offsetOf(x) === 0 && a.offsetOf(y) === 10 && a.offsetOf(z) === 30, "bump from the start");
  a.free(y);
  const y2 = a.alloc(20);
  assert(a.offsetOf(y2) === 10, `exact hole reused at ${a.offsetOf(y2)}`);
  a.free(x);
  a.free(y2);
  assert(a.freeBlocks === 2 && a.largestFree() === 40, "x and y merged, tail separate");
  a.free(z);
  assert(a.freeBlocks === 1 && a.largestFree() === 100 && a.highWater === 0, "all merged");
});

Deno.test("allocations just above a size-class boundary still find exact-size holes", () => {
  // 17 rounds up to the class starting at 18; a 17-unit hole sits in the class
  // below and is only found by the first-fit scan.
  const a = new RangeAllocator(64, 16);
  const blocks = [a.alloc(17), a.alloc(1), a.alloc(46)];
  assert(blocks.every((b) => b !== -1), "setup");
  a.free(blocks[0]);
  const b = a.alloc(17);
  assert(b !== -1 && a.offsetOf(b) === 0, "17-unit hole reused");
});

Deno.test("block table exhaustion fails the allocation and is counted", () => {
  const a = new RangeAllocator(1000, 3);
  let got = 0;
  while (a.alloc(1) !== -1) got++;
  assert(got >= 2 && a.blockFailures === 1, `allocated ${got}, failures ${a.blockFailures}`);
});

Deno.test("churn with mesh-like sizes: fragmentation stays bounded at 60% occupancy", () => {
  // Sizes like chunk meshes in clusters of 32 quads: mostly small, a long tail.
  const rand = lcg(99);
  const capacity = 1 << 20;
  const a = new RangeAllocator(capacity, 1 << 16);
  const live: number[] = [];
  let failures = 0;
  let worst = 0;
  const size = () => 32 * Math.ceil(Math.exp(rand() * 7)); // 32 .. ~35k units
  for (let step = 0; step < 200000; step++) {
    if (a.usedUnits > 0.6 * capacity && live.length > 0) {
      const i = Math.floor(rand() * live.length);
      a.free(live[i]);
      live[i] = live[live.length - 1];
      live.pop();
    } else {
      const b = a.alloc(size());
      if (b === -1) failures++;
      else live.push(b);
    }
    if (step % 5000 === 4999) worst = Math.max(worst, a.fragmentation());
  }
  assert(failures === 0, `${failures} failed allocations at 60% occupancy`);
  assert(worst < 0.9, `fragmentation reached ${worst.toFixed(3)}`);
});
