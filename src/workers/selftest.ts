// Pool self-test covering the plan-foundation phase 5 verify step: saturation on
// both the SharedArrayBuffer and copy paths, cancellation, and stale-version drops.
// Runs in the browser (`?workerTest`) and under `deno test` (pool_test.ts).
// Takes over the "selftest.sum" kind while it runs.

import { allocShared, canShareMemory } from "./buffers.ts";
import type { SumInput, SumOutput } from "./jobs.ts";
import type { WorkerPool } from "./pool.ts";

export interface SelfTestResult {
  name: string;
  ok: boolean;
  detail: string;
}

const KIND = "selftest.sum";
// 256 KiB of float32 ones, about a chunk's worth, so the copy path measures
// dispatch the way real jobs will use it. REPEAT sets the per-job run time.
const DATA_LENGTH = 1 << 16;
const REPEAT = 128;
const JOBS_PER_WORKER = 10;
const MIN_UTILIZATION = 0.75;
const SETTLE_MS = 300; // wait for late (wrongly delivered) results
const TIMEOUT_MS = 30_000;

interface Delivery {
  key: number;
  version: number;
  sum: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Collects deliveries for KIND until `done` returns true or the timeout passes.
async function collect(
  pool: WorkerPool,
  start: (deliveries: Delivery[]) => void,
  done: (deliveries: Delivery[]) => boolean,
): Promise<Delivery[]> {
  const deliveries: Delivery[] = [];
  pool.on(KIND, (key, version, output) => {
    const { sum } = output as SumOutput;
    deliveries.push({ key, version, sum: sum[0] });
    pool.recycle(sum.buffer as ArrayBuffer);
  });
  start(deliveries);
  const deadline = performance.now() + TIMEOUT_MS;
  while (!done(deliveries) && performance.now() < deadline) await sleep(5);
  await sleep(SETTLE_MS);
  return deliveries;
}

function onesArray(shared: boolean): Float32Array {
  const buffer = shared ? allocShared(DATA_LENGTH * 4) : new ArrayBuffer(DATA_LENGTH * 4);
  return new Float32Array(buffer).fill(1);
}

async function saturation(pool: WorkerPool, shared: boolean): Promise<SelfTestResult> {
  const name = `saturation, ${shared ? "SharedArrayBuffer" : "copy"} path`;
  if (shared && !canShareMemory()) {
    return { name, ok: true, detail: "skipped: SharedArrayBuffer unavailable (not cross-origin isolated)" };
  }
  const data = onesArray(shared);
  const jobs = pool.size * JOBS_PER_WORKER;
  const before = Array.from({ length: pool.size }, (_, i) => pool.workerCompleted(i));
  const busyBefore = pool.busyMs;
  const t0 = performance.now();
  let wall = 0;
  const deliveries = await collect(pool, () => {
    const input: SumInput = { data, repeat: REPEAT };
    for (let key = 0; key < jobs; key++) pool.submit(KIND, key, 1, 0, input);
  }, (d) => {
    if (d.length === jobs && wall === 0) wall = performance.now() - t0;
    return d.length === jobs;
  });
  const busy = pool.busyMs - busyBefore;
  const utilization = wall > 0 ? busy / (wall * pool.size) : 0;
  const idleWorkers = before.filter((n, i) => pool.workerCompleted(i) === n).length;
  const wrongSums = deliveries.filter((d) => d.sum !== DATA_LENGTH).length;
  const ok = deliveries.length === jobs && idleWorkers === 0 && wrongSums === 0 &&
    utilization >= MIN_UTILIZATION;
  const detail = `${deliveries.length}/${jobs} results, ${idleWorkers} idle workers, ` +
    `${wrongSums} wrong sums, utilization ${(utilization * 100).toFixed(0)}% ` +
    `(${busy.toFixed(0)} ms busy over ${wall.toFixed(0)} ms x ${pool.size} workers)`;
  return { name, ok, detail };
}

async function cancellation(pool: WorkerPool): Promise<SelfTestResult> {
  const data = onesArray(canShareMemory());
  const jobs = pool.size * 4;
  const cancelled = new Set<number>();
  const deliveries = await collect(pool, () => {
    const input: SumInput = { data, repeat: REPEAT };
    for (let key = 0; key < jobs; key++) pool.submit(KIND, key, 1, 0, input);
    // The first pool.size jobs are already running; the rest are queued. Cancel
    // every other key, so both running and queued jobs get cancelled.
    for (let key = 0; key < jobs; key += 2) {
      pool.cancel(KIND, key);
      cancelled.add(key);
    }
  }, (d) => d.length >= jobs - cancelled.size);
  const leaked = deliveries.filter((d) => cancelled.has(d.key)).length;
  const expected = jobs - cancelled.size;
  const ok = leaked === 0 && deliveries.length === expected;
  return {
    name: "cancellation",
    ok,
    detail: `${leaked} cancelled results delivered, ${deliveries.length}/${expected} others delivered`,
  };
}

async function staleVersions(pool: WorkerPool): Promise<SelfTestResult> {
  const data = onesArray(canShareMemory());
  const input: SumInput = { data, repeat: REPEAT };
  const deliveries = await collect(pool, () => {
    // With idle workers, all three versions start running at once on different
    // workers. Only the latest version's result may be delivered.
    pool.submit(KIND, 7, 1, 0, input);
    pool.submit(KIND, 7, 2, 0, input);
    pool.submit(KIND, 7, 3, 0, input);
  }, (d) => d.some((x) => x.version === 3));
  const versions = deliveries.map((d) => d.version);
  const ok = versions.length === 1 && versions[0] === 3;
  return { name: "stale versions", ok, detail: `delivered versions [${versions.join(", ")}], expected [3]` };
}

// Loads every worker's script and runs the kernel until V8 has fully optimized it,
// so the timed runs measure steady state. A light warm-up is not enough: measured
// in Deno, the first timed case ran about twice as slow as later ones until the
// warm-up used the full per-job cost. Both buffer kinds are warmed.
async function warmUp(pool: WorkerPool): Promise<void> {
  const plain: SumInput = { data: onesArray(false), repeat: REPEAT };
  const shared: SumInput = { data: onesArray(canShareMemory()), repeat: REPEAT };
  const jobs = pool.size * 4;
  await collect(pool, () => {
    for (let key = 0; key < jobs; key++) pool.submit(KIND, key, 1, 0, key % 2 === 0 ? plain : shared);
  }, (d) => d.length === jobs);
}

export async function runWorkerSelfTest(pool: WorkerPool): Promise<SelfTestResult[]> {
  await warmUp(pool);
  return [
    await saturation(pool, true),
    await saturation(pool, false),
    await cancellation(pool),
    await staleVersions(pool),
  ];
}
