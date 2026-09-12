// Main-thread worker pool and job queue.
//
// Jobs are identified by (kind, key), for example ("mesh", chunkKey), and carry a
// version, for example the chunk's edit version. Per (kind, key):
// - submitting while a job is queued replaces it (new version, input, priority);
// - submitting while a job is running queues the new one; the running result is
//   dropped when it arrives because its version is no longer the latest;
// - cancel() removes a queued job and makes any running result drop.
// So a result handler only ever sees the latest version of a key, and never sees a
// cancelled key. Dropped results have their buffers recycled automatically.
//
// Each worker runs one job at a time; queued jobs stay on the main thread where
// they can still be cancelled or re-prioritized.

import { type QueueItem, PriorityQueue } from "./queue.ts";
import type { FromWorker, JobMessage, JobRequest, RecycleMessage, ShareMessage } from "./protocol.ts";

export type ResultHandler = (key: number, version: number, output: unknown) => void;
export type ErrorHandler = (kind: string, key: number, message: string) => void;
// Called once for every dispatched job when it ends, after the result handler.
// Queued jobs that are replaced or cancelled never ran and are not reported.
export type SettledHandler = (key: number, version: number, outcome: number) => void;

export const SETTLED_DELIVERED = 0; // the result handler got it
export const SETTLED_DROPPED = 1; // stale or cancelled while running; buffers recycled
export const SETTLED_FAILED = 2; // the handler threw, or the worker errored

interface Job extends QueueItem {
  id: number;
  kind: string;
  key: number;
  version: number;
  input: unknown;
  transfer: Transferable[] | null;
}

interface KindState {
  handler: ResultHandler | null;
  settled: SettledHandler | null;
  latest: Map<number, number>; // key -> latest submitted version, while outstanding
  queued: Map<number, Job>; // key -> queued (not yet dispatched) job
}

interface Slot {
  readonly worker: Worker;
  jobs: Job[]; // the batch it is running, in order
  completed: number;
}

const RECYCLE_BATCH = 64; // flush early when this many buffers are waiting
// Jobs per worker message. 1 by default: batching 4 at a time cut the message
// count fourfold and saved no measurable main-thread time, while nearly doubling
// job latency (plan-rendering phase 3 A/B). A job message costs what its payload
// costs, not a fixed per-message overhead. `?jobBatch=n` re-runs that experiment.
export const DEFAULT_JOBS_PER_MESSAGE = 1;

export class WorkerPool {
  readonly size: number;
  completed = 0; // results delivered to a handler
  dropped = 0; // results discarded as stale or cancelled
  failed = 0; // jobs whose handler threw
  busyMs = 0; // summed handler time reported by workers
  onError: ErrorHandler = (kind, key, message) => console.error(`job ${kind} ${key} failed: ${message}`);

  private readonly slots: Slot[] = [];
  private readonly idle: number[] = [];
  private readonly queue = new PriorityQueue<Job>();
  private readonly kinds = new Map<string, KindState>();
  private readonly freeJobs: Job[] = [];
  private readonly jobsPerMessage: number;
  private seq = 0;
  private nextId = 1;
  private recycleTarget = 0;
  // Reused for every post; postMessage copies it synchronously.
  private readonly jobRequests: JobRequest[] = [];
  private readonly spareRequests: JobRequest[] = [];
  private readonly jobMessage: JobMessage = { type: "job", jobs: this.jobRequests };
  private readonly jobTransfer: Transferable[] = [];
  // Buffers waiting to go back to a worker; sent together by flushRecycled().
  private readonly recycleBuffers: ArrayBuffer[] = [];
  private readonly recycleMessage: RecycleMessage = { type: "recycle", buffers: this.recycleBuffers };

  // `jobsPerMessage` caps how many queued jobs share one message (1 disables
  // batching; `?jobBatch=n`).
  constructor(createWorker: (index: number) => Worker, size: number, jobsPerMessage = DEFAULT_JOBS_PER_MESSAGE) {
    this.size = size;
    this.jobsPerMessage = Math.max(1, jobsPerMessage);
    for (let i = 0; i < size; i++) {
      const worker = createWorker(i);
      worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(i, e.data);
      worker.onerror = (e: ErrorEvent) => this.onWorkerError(i, e);
      this.slots.push({ worker, jobs: [], completed: 0 });
      this.idle.push(i);
    }
  }

  get queued(): number {
    return this.queue.size;
  }

  // Jobs dispatched to workers and not yet finished.
  get running(): number {
    let n = 0;
    for (const slot of this.slots) n += slot.jobs.length;
    return n;
  }

  workerCompleted(index: number): number {
    return this.slots[index].completed;
  }

  // Sets the handler that receives results of one kind. One handler per kind.
  on(kind: string, handler: ResultHandler): void {
    this.kind(kind).handler = handler;
  }

  // Sets the handler told when each dispatched job of one kind ends, whatever the
  // outcome. For callers that must know when a worker stops reading shared memory.
  onSettled(kind: string, handler: SettledHandler): void {
    this.kind(kind).settled = handler;
  }

  // Queues a job. Lower priority values run first. `transfer` lists buffers in
  // `input` to move to the worker instead of copying (they detach here).
  submit(
    kind: string,
    key: number,
    version: number,
    priority: number,
    input: unknown,
    transfer: Transferable[] | null = null,
  ): void {
    const k = this.kind(kind);
    k.latest.set(key, version);
    const existing = k.queued.get(key);
    if (existing) {
      existing.version = version;
      existing.input = input;
      existing.transfer = transfer;
      existing.priority = priority;
      this.queue.update(existing);
      return;
    }
    const job = this.freeJobs.pop() ??
      { id: 0, kind: "", key: 0, version: 0, input: null, transfer: null, priority: 0, seq: 0, heapIndex: -1 };
    job.kind = kind;
    job.key = key;
    job.version = version;
    job.input = input;
    job.transfer = transfer;
    job.priority = priority;
    job.seq = this.seq++;
    k.queued.set(key, job);
    this.queue.push(job);
    this.dispatch();
  }

  // Drops a queued job and discards the result of a running one. True when a queued
  // job was removed; a running job still settles later.
  cancel(kind: string, key: number): boolean {
    const k = this.kinds.get(kind);
    if (!k) return false;
    k.latest.delete(key);
    const job = k.queued.get(key);
    if (!job) return false;
    k.queued.delete(key);
    this.queue.remove(job);
    this.release(job);
    return true;
  }

  // Changes the priority of a queued job. No effect once it is running.
  setPriority(kind: string, key: number, priority: number): void {
    const job = this.kinds.get(kind)?.queued.get(key);
    if (!job) return;
    job.priority = priority;
    this.queue.update(job);
  }

  // Gives a consumed result buffer back to a worker's BufferPool. Queued; the
  // frame loop calls flushRecycled() once per frame (and a full batch flushes
  // itself), so buffers travel back in a few messages instead of one each.
  recycle(buffer: ArrayBuffer): void {
    if (buffer.byteLength === 0) return;
    this.recycleBuffers.push(buffer);
    if (this.recycleBuffers.length >= RECYCLE_BATCH) this.flushRecycled();
  }

  // Sends the queued buffers to one worker, rotating between workers.
  flushRecycled(): void {
    if (this.recycleBuffers.length === 0) return;
    // postMessage clones synchronously: the array can be emptied right after.
    this.slots[this.recycleTarget].worker.postMessage(this.recycleMessage, this.recycleBuffers);
    this.recycleBuffers.length = 0;
    this.recycleTarget = (this.recycleTarget + 1) % this.size;
  }

  // Hands every worker a SharedArrayBuffer to keep under `id` (worker side:
  // sharedBuffer(id) in shared.ts), so jobs can name it rather than carry it.
  share(id: number, buffer: SharedArrayBuffer): void {
    const msg: ShareMessage = { type: "share", id, buffer };
    for (const slot of this.slots) slot.worker.postMessage(msg);
  }

  terminate(): void {
    for (const slot of this.slots) slot.worker.terminate();
  }

  private kind(kind: string): KindState {
    let k = this.kinds.get(kind);
    if (!k) {
      k = { handler: null, settled: null, latest: new Map(), queued: new Map() };
      this.kinds.set(kind, k);
    }
    return k;
  }

  private release(job: Job): void {
    job.input = null;
    job.transfer = null;
    job.heapIndex = -1;
    this.freeJobs.push(job);
  }

  private dispatch(): void {
    while (this.idle.length > 0 && this.queue.size > 0) {
      // Batch only what is waiting: with a shallow queue every worker still gets
      // one job, so nothing waits behind another job for no reason.
      const perWorker = Math.min(this.jobsPerMessage, Math.ceil(this.queue.size / this.idle.length));
      const slot = this.slots[this.idle.pop()!];
      const requests = this.jobRequests;
      const transfer = this.jobTransfer;
      requests.length = 0;
      transfer.length = 0;
      for (let i = 0; i < perWorker && this.queue.size > 0; i++) {
        const job = this.queue.pop()!;
        this.kinds.get(job.kind)!.queued.delete(job.key);
        job.id = this.nextId++;
        slot.jobs.push(job);
        // Request objects are reused: postMessage clones them synchronously.
        const request = this.spareRequests[i] ??= { id: 0, kind: "", input: null };
        request.id = job.id;
        request.kind = job.kind;
        request.input = job.input;
        requests.push(request);
        if (job.transfer) for (const t of job.transfer) transfer.push(t);
        job.input = null; // don't keep the input alive while the job runs
        job.transfer = null;
      }
      slot.worker.postMessage(this.jobMessage, transfer);
      for (const request of requests) request.input = null; // don't hold inputs
      requests.length = 0;
      transfer.length = 0;
    }
  }

  private onMessage(index: number, msg: FromWorker): void {
    const slot = this.slots[index];
    const jobs = slot.jobs;
    if (jobs.length === 0) return;
    // The worker becomes idle after its results are handled: a handler that
    // submits dispatches to the others, then to this one below.
    for (const result of msg.results) {
      const job = jobs.find((j) => j.id === result.id);
      if (!job) continue;
      slot.completed++;
      this.busyMs += result.ms;
      const k = this.kinds.get(job.kind)!;
      const current = k.latest.get(job.key) === job.version;
      if (current) k.latest.delete(job.key);

      let outcome: number;
      if (result.error !== undefined) {
        this.failed++;
        outcome = SETTLED_FAILED;
        if (current) this.onError(job.kind, job.key, result.error);
      } else if (current && k.handler) {
        this.completed++;
        outcome = SETTLED_DELIVERED;
        k.handler(job.key, job.version, result.output);
      } else {
        this.dropped++;
        outcome = SETTLED_DROPPED;
        for (let i = 0; i < result.count; i++) this.recycle(msg.buffers[result.first + i]);
      }
      k.settled?.(job.key, job.version, outcome);
      this.release(job);
    }
    jobs.length = 0;
    this.idle.push(index);
    this.dispatch();
  }

  // An error outside any handler (the worker script failed to load, for example).
  private onWorkerError(index: number, e: ErrorEvent): void {
    e.preventDefault();
    const slot = this.slots[index];
    const jobs = slot.jobs;
    this.onError(jobs[0]?.kind ?? "worker", jobs[0]?.key ?? -1, `worker ${index}: ${e.message || "script error"}`);
    if (jobs.length === 0) return;
    // Treat the batch as failed so its keys aren't stuck; the worker may be unusable.
    slot.jobs = [];
    for (const job of jobs) {
      this.failed++;
      const k = this.kinds.get(job.kind);
      if (k && k.latest.get(job.key) === job.version) k.latest.delete(job.key);
      k?.settled?.(job.key, job.version, SETTLED_FAILED);
      this.release(job);
    }
    this.idle.push(index);
    this.dispatch();
  }
}
