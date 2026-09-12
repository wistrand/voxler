import { RingBuffer } from "./ring.ts";
import { newSummary, percentileOfSorted, summarize } from "./percentile.ts";

function assertEquals(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: ${actual} !== ${expected}`);
}

Deno.test("ring copies oldest-first before and after wrapping", () => {
  const r = new RingBuffer(3);
  const out = new Float64Array(3);
  assertEquals(r.copyTo(out), 0, "empty count");
  r.push(1);
  r.push(2);
  assertEquals(r.copyTo(out), 2, "partial count");
  assertEquals(out[0], 1, "partial [0]");
  assertEquals(out[1], 2, "partial [1]");
  r.push(3);
  r.push(4); // overwrites 1
  assertEquals(r.copyTo(out), 3, "full count");
  assertEquals(out.join(","), "2,3,4", "wrapped order");
  assertEquals(r.latest(), 4, "latest");
});

Deno.test("ring clear empties it", () => {
  const r = new RingBuffer(2);
  r.push(5);
  r.clear();
  assertEquals(r.count, 0, "count");
  assertEquals(Number.isNaN(r.latest()), true, "latest is NaN");
});

Deno.test("nearest-rank percentiles", () => {
  const sorted = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assertEquals(percentileOfSorted(sorted, 10, 0.5), 5, "p50");
  assertEquals(percentileOfSorted(sorted, 10, 0.95), 10, "p95");
  assertEquals(percentileOfSorted(sorted, 10, 0.1), 1, "p10");
  assertEquals(Number.isNaN(percentileOfSorted(sorted, 0, 0.5)), true, "empty");
});

Deno.test("summarize sorts a copy and leaves the ring intact", () => {
  const r = new RingBuffer(5);
  for (const v of [5, 1, 4, 2, 3]) r.push(v);
  const s = summarize(r, new Float64Array(5), newSummary());
  assertEquals(s.count, 5, "count");
  assertEquals(s.p50, 3, "p50");
  assertEquals(s.max, 5, "max");
  assertEquals(s.mean, 3, "mean");
  assertEquals(r.latest(), 3, "ring untouched");
});
