// Messages between WorkerPool (main thread) and voxel.worker.ts.

// One or more jobs for a worker to run in order. Batched because each postMessage
// costs the main thread tens of microseconds (gotchas.md "postMessage is
// expensive"); the pool batches only when jobs are waiting, so a quiet pool still
// dispatches one at a time.
export interface JobMessage {
  type: "job";
  jobs: JobRequest[];
}

export interface JobRequest {
  id: number;
  kind: string;
  input: unknown;
}

// Consumed result buffers going back to a worker's BufferPool, batched (one
// message per frame instead of one per buffer; the trace showed each postMessage
// costing tens of microseconds on the main thread).
export interface RecycleMessage {
  type: "recycle";
  buffers: ArrayBuffer[];
}

// A SharedArrayBuffer every worker keeps under `id`, so jobs can name it instead of
// cloning a reference to it into every job message (WorkerPool.share()).
export interface ShareMessage {
  type: "share";
  id: number;
  buffer: SharedArrayBuffer;
}

export type ToWorker = JobMessage | RecycleMessage | ShareMessage;

// The results of one batch, in the order the jobs ran.
export interface DoneMessage {
  type: "done";
  results: JobResult[];
  buffers: ArrayBuffer[]; // every buffer from JobContext.alloc, all transferred
}

export interface JobResult {
  id: number;
  output: unknown; // undefined when `error` is set
  error?: string;
  ms: number; // handler run time inside the worker
  first: number; // index of this job's first buffer in DoneMessage.buffers
  count: number; // how many buffers are its own
}

export type FromWorker = DoneMessage;

// Given to a job handler. `alloc` is for output buffers only: every buffer it
// returns is transferred to the main thread with the result. `transfer` sends back
// a buffer the job received (for example an input the main thread wants to reuse).
// Scratch memory a handler keeps for itself belongs in module-level arrays.
export interface JobContext {
  alloc(bytes: number): ArrayBuffer;
  transfer(buffer: ArrayBuffer): void;
}

export type JobHandler = (input: unknown, ctx: JobContext) => unknown;
