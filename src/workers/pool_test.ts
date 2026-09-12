// Runs the pool self-test with real Deno workers loading the TypeScript worker
// source directly. Deno shares SharedArrayBuffer between workers without
// isolation headers, so both the shared and copy paths run here.

import { WorkerPool } from "./pool.ts";
import { runWorkerSelfTest } from "./selftest.ts";

Deno.test({
  name: "worker pool self-test",
  // Workers keep async ops alive until terminate(); checked in finally.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const url = new URL("./voxel.worker.ts", import.meta.url);
    const pool = new WorkerPool(() => new Worker(url, { type: "module" }), 4);
    try {
      const results = await runWorkerSelfTest(pool);
      const failed = results.filter((r) => !r.ok);
      for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`);
      if (failed.length > 0) throw new Error(`${failed.length} self-test case(s) failed`);
    } finally {
      pool.terminate();
    }
  },
});

Deno.test({
  name: "settled fires once per dispatched job; replaced and cancelled queued jobs never settle",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const url = new URL("./voxel.worker.ts", import.meta.url);
    const pool = new WorkerPool(() => new Worker(url, { type: "module" }), 1);
    try {
      const data = new Float32Array(1 << 16).fill(1);
      const input = { data, repeat: 20 };
      const settled: string[] = [];
      const delivered: string[] = [];
      let pending = 0;
      const done = Promise.withResolvers<void>();
      pool.on("selftest.sum", (key, version) => delivered.push(`${key}@${version}`));
      pool.onSettled("selftest.sum", (key, version, outcome) => {
        settled.push(`${key}@${version}:${outcome}`);
        if (--pending === 0) done.resolve();
      });
      // One worker: key 1 v1 runs; v2 queues, then v3 replaces it.
      pool.submit("selftest.sum", 1, 1, 0, input);
      pool.submit("selftest.sum", 1, 2, 0, input);
      pool.submit("selftest.sum", 1, 3, 0, input);
      // Key 2 queues behind them and is cancelled before it runs.
      pool.submit("selftest.sum", 2, 1, 0, input);
      if (!pool.cancel("selftest.sum", 2)) throw new Error("cancel of a queued job should return true");
      pending = 2;
      await done.promise;
      // v1 finished while v3 was the latest: dropped (1). v3 delivered (0).
      if (settled.join(",") !== "1@1:1,1@3:0") throw new Error(`settled ${settled.join(",")}`);
      if (delivered.join(",") !== "1@3") throw new Error(`delivered ${delivered.join(",")}`);
      // Cancel while running: returns false, the job still settles as dropped.
      const running = Promise.withResolvers<void>();
      pool.onSettled("selftest.sum", (key, version, outcome) => {
        settled.push(`${key}@${version}:${outcome}`);
        running.resolve();
      });
      pool.submit("selftest.sum", 3, 1, 0, input);
      if (pool.cancel("selftest.sum", 3)) throw new Error("cancel of a running job should return false");
      await running.promise;
      if (settled[settled.length - 1] !== "3@1:1") throw new Error(`running cancel settled ${settled.at(-1)}`);
    } finally {
      pool.terminate();
    }
  },
});
