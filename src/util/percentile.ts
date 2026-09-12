// Percentile summaries of a RingBuffer. Runs at overlay rate (a few times per
// second), not per frame; the sort happens in a caller-owned scratch array.

import type { RingBuffer } from "./ring.ts";

export interface Summary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function newSummary(): Summary {
  return { count: 0, mean: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN };
}

// Nearest-rank percentile of the first `count` values of an ascending array.
export function percentileOfSorted(sorted: Float64Array, count: number, q: number): number {
  if (count === 0) return NaN;
  const rank = Math.ceil(q * count) - 1;
  return sorted[Math.min(count - 1, Math.max(0, rank))];
}

// Fills `out` from the ring's samples. `scratch` must hold ring.capacity values.
export function summarize(ring: RingBuffer, scratch: Float64Array, out: Summary): Summary {
  const n = ring.copyTo(scratch);
  out.count = n;
  if (n === 0) {
    out.mean = out.p50 = out.p95 = out.p99 = out.max = NaN;
    return out;
  }
  const sorted = scratch.subarray(0, n).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  out.mean = sum / n;
  out.p50 = percentileOfSorted(sorted, n, 0.5);
  out.p95 = percentileOfSorted(sorted, n, 0.95);
  out.p99 = percentileOfSorted(sorted, n, 0.99);
  out.max = sorted[n - 1];
  return out;
}
