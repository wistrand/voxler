// Worker entry point. Built to dist/workers/voxel.worker.js (build.ts
// workerEntries()). Runs one job at a time from WorkerPool and posts the result
// with its output buffers transferred.

import { BufferPool } from "./buffers.ts";
import { HANDLERS } from "./jobs.ts";
import { setShared } from "./shared.ts";
import type { FromWorker, JobContext, JobResult, ToWorker } from "./protocol.ts";

// The DOM lib types `self` as a Window; declare the worker surface we use.
interface WorkerScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
const pool = new BufferPool();
const outputs: ArrayBuffer[] = []; // buffers handed out during the current batch
const results: JobResult[] = [];

const ctx: JobContext = {
  alloc(bytes: number): ArrayBuffer {
    const buffer = pool.alloc(bytes);
    outputs.push(buffer);
    return buffer;
  },
  transfer(buffer: ArrayBuffer): void {
    outputs.push(buffer);
  },
};

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "recycle") {
    for (const buffer of msg.buffers) pool.release(buffer);
    return;
  }
  if (msg.type === "share") {
    setShared(msg.id, msg.buffer);
    return;
  }
  outputs.length = 0;
  results.length = 0;
  for (const job of msg.jobs) {
    const first = outputs.length;
    const start = performance.now();
    try {
      const handler = HANDLERS[job.kind];
      if (!handler) throw new Error(`unknown job kind "${job.kind}"`);
      const output = handler(job.input, ctx);
      results.push({ id: job.id, output, ms: performance.now() - start, first, count: outputs.length - first });
    } catch (err) {
      // Drop what the failed job allocated; earlier jobs keep their buffers.
      for (let i = outputs.length - 1; i >= first; i--) pool.release(outputs[i]);
      outputs.length = first;
      const error = err instanceof Error ? err.message : String(err);
      results.push({ id: job.id, output: undefined, error, ms: performance.now() - start, first, count: 0 });
    }
  }
  // postMessage serializes synchronously, so the arrays can be reset afterwards.
  scope.postMessage({ type: "done", results, buffers: outputs }, outputs);
  outputs.length = 0;
  results.length = 0;
};
