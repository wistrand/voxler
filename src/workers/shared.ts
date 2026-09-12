// Shared buffers a worker received through WorkerPool.share(), by id. Worker side;
// job handlers look up buffers their inputs name.

const buffers = new Map<number, SharedArrayBuffer>();

export function setShared(id: number, buffer: SharedArrayBuffer): void {
  buffers.set(id, buffer);
}

export function sharedBuffer(id: number): SharedArrayBuffer {
  const buffer = buffers.get(id);
  if (!buffer) throw new Error(`no shared buffer ${id} in this worker`);
  return buffer;
}
