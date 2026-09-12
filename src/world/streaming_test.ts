import { chunkKey, keyX, keyY, keyZ } from "./keys.ts";
import { ChunkStore } from "./store.ts";
import { ChunkStreamer, type Compressor, KIND_AIR, KIND_DENSE, KIND_UNIFORM, type StreamOptions, type VoxelSource } from "./streaming.ts";
import { blockBytes, writeBlock } from "./arena.ts";
import { ChunkData } from "./chunk.ts";
import { CHUNK_VOLUME } from "./coords.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const OPTIONS: StreamOptions = {
  radius: 3,
  height: 1,
  hysteresis: 1,
  innerRadius: 1,
  queueTarget: 8,
  scanPerFrame: 1000,
  sweepPerFrame: 1000,
  regenPerFrame: 4,
};

// Fake voxelizer: records requests; the test answers them.
class FakeSource implements VoxelSource {
  readonly requests: [number, number, number, boolean][] = [];
  recycled = 0;
  get queuedCount(): number {
    return this.requests.length;
  }
  queueChunk(cx: number, cy: number, cz: number, priority = false): void {
    this.requests.push([cx, cy, cz, priority]);
  }
  recycle(): void {
    this.recycled++;
  }
}

class FakeCompressor implements Compressor {
  readonly jobs: number[] = [];
  compress(key: number): void {
    this.jobs.push(key);
  }
}

function setup(maxChunks = 1024) {
  const store = new ChunkStore({ maxChunks, arenaBytes: 8 << 20, shared: false });
  const streamer = new ChunkStreamer(store, OPTIONS);
  const source = new FakeSource();
  const compressor = new FakeCompressor();
  streamer.attach(source, compressor);
  return { store, streamer, source, compressor };
}

// Answers every outstanding request as uniform stone.
function answerAll(streamer: ChunkStreamer, source: FakeSource): number {
  let n = 0;
  while (source.requests.length > 0) {
    const [x, y, z] = source.requests.shift()!;
    streamer.onVoxelResult(x, y, z, KIND_UNIFORM, 1, null);
    n++;
  }
  return n;
}

Deno.test("requests nearest chunks first, never twice, up to the queue target", () => {
  const { streamer, source } = setup();
  streamer.update(0, 0, 0);
  assert(source.requests.length === OPTIONS.queueTarget, `queued ${source.requests.length}`);
  const [first] = source.requests;
  assert(first[0] === 0 && first[1] === 0 && first[2] === 0, "camera chunk first");
  const keys = new Set(source.requests.map(([x, y, z]) => chunkKey(x, y, z)));
  assert(keys.size === source.requests.length, "no duplicate requests");
  streamer.update(0, 0, 0); // queue is full: nothing new
  assert(source.requests.length === OPTIONS.queueTarget, "respects the queue target");
});

Deno.test("fills the whole load range and then has no holes", () => {
  const { streamer, source, store } = setup();
  for (let frame = 0; frame < 100; frame++) {
    streamer.update(0, 0, 0);
    answerAll(streamer, source);
  }
  // radius 3 circle: 29 columns; height 1: 3 layers.
  assert(store.count === 29 * 3, `resident ${store.count}`);
  assert(streamer.stats.holes === 0, `holes ${streamer.stats.holes}`);
  streamer.update(0, 0, 0);
  assert(source.requests.length === 0, "nothing left to request");
});

Deno.test("evicts chunks beyond radius plus hysteresis after the camera moves", () => {
  const { streamer, source, store } = setup();
  for (let frame = 0; frame < 50; frame++) {
    streamer.update(0, 0, 0);
    answerAll(streamer, source);
  }
  for (let frame = 0; frame < 50; frame++) {
    streamer.update(20, 0, 0);
    answerAll(streamer, source);
  }
  assert(!store.hasKey(chunkKey(0, 0, 0)), "old camera chunk evicted");
  assert(store.hasKey(chunkKey(20, 0, 0)), "new camera chunk resident");
  assert(streamer.stats.resident === store.count, `resident ${streamer.stats.resident} vs store ${store.count}`);
  let far = 0;
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) if (store.hasKey(chunkKey(x, 0, z))) far++;
  assert(far === 0, `${far} chunks near the old position still resident`);
});

Deno.test("dense results go through the compressor; stale results are dropped", () => {
  const { streamer, source, store, compressor } = setup();
  streamer.update(0, 0, 0);
  const [x, y, z] = source.requests.shift()!;
  const ids = new Uint16Array(CHUNK_VOLUME);
  ids[5] = 3;
  streamer.onVoxelResult(x, y, z, KIND_DENSE, 0, ids);
  const key = chunkKey(x, y, z);
  assert(compressor.jobs[0] === key && streamer.stats.compressing === 1, "sent to the compressor");
  const parts = ChunkData.fromDense(ids).toParts();
  const block = new ArrayBuffer(blockBytes(parts));
  writeBlock(block, 0, parts);
  streamer.onCompressed(key, -1, block, blockBytes(parts));
  assert(store.hasKey(key) && streamer.stats.compressing === 0, "stored after compression");
  assert(store.read(store.handle(x, y, z))!.get(5) === 3, "contents intact");

  // A result for a chunk the camera left behind is dropped, not stored.
  const [fx, fy, fz] = source.requests.shift()!;
  streamer.update(100, 0, 0);
  streamer.onVoxelResult(fx, fy, fz, KIND_AIR, 0, null);
  assert(!store.hasKey(chunkKey(fx, fy, fz)) && streamer.stats.dropped === 1, "out-of-range result dropped");
  // An unsolicited result (never requested) is ignored and its ids recycled.
  streamer.onVoxelResult(500, 0, 500, KIND_DENSE, 0, new Uint16Array(CHUNK_VOLUME));
  assert(source.recycled === 1, "unsolicited ids recycled");
});

Deno.test("attach forgets requests in flight at the old source", () => {
  const { streamer, source } = setup();
  streamer.update(0, 0, 0);
  const lost = source.requests.map(([x, y, z]) => chunkKey(x, y, z));
  const fresh = new FakeSource();
  streamer.attach(fresh, new FakeCompressor());
  streamer.update(0, 0, 0);
  const again = new Set(fresh.requests.map(([x, y, z]) => chunkKey(x, y, z)));
  assert(lost.every((k) => again.has(k)), "lost requests are asked for again");
  assert(keyX(lost[0]) === 0 && keyY(lost[0]) === 0 && keyZ(lost[0]) === 0, "nearest first again");
});

// Fills the whole load range with uniform stone.
function fill(streamer: ChunkStreamer, source: FakeSource): void {
  for (let frame = 0; frame < 100; frame++) {
    streamer.update(0, 0, 0);
    answerAll(streamer, source);
  }
}

// Answers one request as a dense chunk with `id` at voxel 0, through the compressor.
function answerDense(streamer: ChunkStreamer, source: FakeSource, id: number): number {
  const [x, y, z] = source.requests.shift()!;
  const key = chunkKey(x, y, z);
  const ids = new Uint16Array(CHUNK_VOLUME);
  ids[0] = id;
  streamer.onVoxelResult(x, y, z, KIND_DENSE, 0, ids);
  const parts = ChunkData.fromDense(ids).toParts();
  const block = new ArrayBuffer(blockBytes(parts));
  writeBlock(block, 0, parts);
  streamer.onCompressed(key, -1, block, blockBytes(parts));
  return key;
}

Deno.test("regeneration re-requests a resident chunk and replaces its payload", () => {
  const { streamer, source, store } = setup();
  const listener = { stored: [] as number[], evicted: [] as number[] };
  streamer.listener = {
    stored: (key) => listener.stored.push(key),
    evicted: (key) => listener.evicted.push(key),
  };

  fill(streamer, source);
  const key = chunkKey(0, 0, 0);
  assert(store.read(store.handle(0, 0, 0))!.get(0) === 1, "stone before");
  listener.stored.length = 0;

  streamer.regenerate(key);
  assert(streamer.stats.regenQueued === 1, `queued ${streamer.stats.regenQueued}`);
  streamer.update(0, 0, 0);
  assert(source.requests.length === 1, `${source.requests.length} requests`);
  const [x, y, z] = source.requests[0];
  assert(chunkKey(x, y, z) === key, "the regenerated chunk was asked for");
  // It stays resident with the old data while the new one is in flight.
  assert(store.hasKey(key) && store.read(store.handle(0, 0, 0))!.get(0) === 1, "old data kept meanwhile");

  const same = answerDense(streamer, source, 7);
  assert(same === key, "answered the right chunk");
  assert(store.read(store.handle(0, 0, 0))!.get(0) === 7, "payload replaced");
  assert(streamer.stats.regenReplaced === 1, `replaced ${streamer.stats.regenReplaced}`);
  assert(listener.stored.length === 1 && listener.stored[0] === key, "the mesher was told once");
  assert(streamer.stats.resident === store.count, "resident count unchanged by a replacement");
});

Deno.test("repeat regeneration requests coalesce, and one asked for in flight runs after", () => {
  const { streamer, source } = setup();
  fill(streamer, source);
  const key = chunkKey(0, 0, 0);
  for (let i = 0; i < 5; i++) streamer.regenerate(key);
  assert(streamer.stats.regenQueued === 1, `queued ${streamer.stats.regenQueued}`);
  streamer.update(0, 0, 0);
  assert(streamer.stats.regenerated === 1, `submitted ${streamer.stats.regenerated}`);

  // Asked for again while the first is in flight: it waits, then runs once.
  streamer.regenerate(key);
  streamer.update(0, 0, 0);
  assert(streamer.stats.regenerated === 1, "no second request while one is in flight");
  answerDense(streamer, source, 3);
  streamer.update(0, 0, 0);
  assert(streamer.stats.regenerated === 2, `submitted ${streamer.stats.regenerated} after settling`);
  assert(source.requests.length === 1, "asked for exactly once more");
  answerDense(streamer, source, 4);
  streamer.update(0, 0, 0);
  assert(streamer.stats.regenerated === 2, "and then stops");
});

Deno.test("regeneration is nearest first and bounded per frame", () => {
  const { streamer, source } = setup();
  fill(streamer, source);
  const keys: number[] = [];
  for (let x = -3; x <= 3; x++) {
    const key = chunkKey(x, 0, 0);
    if (streamer.residentCount > 0) keys.push(key);
  }
  // Queue the far ones first, so insertion order is not distance order.
  for (const key of [...keys].sort((a, b) => Math.abs(keyX(b)) - Math.abs(keyX(a)))) streamer.regenerate(key);
  streamer.update(0, 0, 0);
  assert(source.requests.length === OPTIONS.regenPerFrame, `submitted ${source.requests.length} in one frame`);
  const first = source.requests.map(([x]) => Math.abs(x));
  const sorted = [...first].sort((a, b) => a - b);
  assert(first.join() === sorted.join(), `submitted at distances ${first}, not nearest first`);
});

Deno.test("a chunk that is neither resident nor in flight is not regenerated", () => {
  const { streamer, source } = setup();
  fill(streamer, source);
  streamer.regenerate(chunkKey(100, 0, 100));
  assert(streamer.stats.regenQueued === 0, "an absent chunk is ignored");
  streamer.update(0, 0, 0);
  assert(source.requests.length === 0, "nothing requested");

  // One evicted while queued is dropped when its turn comes.
  const key = chunkKey(0, 0, 0);
  streamer.regenerate(key);
  streamer.update(20, 0, 0); // moves the camera; the chunk leaves the keep range
  for (let frame = 0; frame < 50; frame++) {
    streamer.update(20, 0, 0);
    answerAll(streamer, source);
  }
  assert(streamer.stats.regenQueued === 0, `queue left with ${streamer.stats.regenQueued}`);
});

Deno.test("checkRegen counts replacements whose voxels changed", () => {
  const { streamer, source } = setup();
  streamer.checkRegen = true;
  fill(streamer, source);
  const key = chunkKey(0, 0, 0);
  streamer.regenerate(key);
  streamer.update(0, 0, 0);
  answerDense(streamer, source, 7);
  assert(streamer.stats.regenDiffer === 1, "a changed payload is counted");

  streamer.regenerate(key);
  streamer.update(0, 0, 0);
  answerDense(streamer, source, 7);
  assert(streamer.stats.regenReplaced === 2, `replaced ${streamer.stats.regenReplaced}`);
  assert(streamer.stats.regenDiffer === 1, "an identical payload is not counted");
});

Deno.test("attach re-queues regenerations the old source never finished", () => {
  const { streamer, source, store } = setup();
  fill(streamer, source);
  const key = chunkKey(0, 0, 0);
  streamer.regenerate(key);
  streamer.update(0, 0, 0);
  assert(source.requests.length === 1, "the regeneration was submitted");
  // A second request arrives while the first is in flight, so one waits.
  streamer.regenerate(key);
  streamer.update(0, 0, 0);

  const fresh = new FakeSource();
  streamer.attach(fresh, new FakeCompressor());
  streamer.update(0, 0, 0);
  const asked = fresh.requests.filter(([x, y, z]) => chunkKey(x, y, z) === key);
  assert(asked.length === 1, `asked for the chunk ${asked.length} times after attach`);
  assert(store.hasKey(key), "it stayed resident throughout");
});

Deno.test("a regeneration jumps the streaming backlog and meshes without waiting a frame", () => {
  const store = new ChunkStore({ maxChunks: 1024, arenaBytes: 8 << 20, shared: false });
  const streamer = new ChunkStreamer(store, OPTIONS);
  const source = new FakeSource();
  streamer.attach(source, new FakeCompressor());
  const urgent: boolean[] = [];
  streamer.listener = { stored: (_key, u) => urgent.push(u), evicted: () => {} };

  // A first load is not urgent; nothing was on screen to be wrong.
  streamer.update(0, 0, 0);
  const [fx, fy, fz] = source.requests[0];
  streamer.onVoxelResult(fx, fy, fz, KIND_UNIFORM, 1, null);
  assert(urgent.length === 1 && urgent[0] === false, `first load urgent ${urgent}`);
  fill(streamer, source);

  // A backlog of streaming requests, then a regeneration behind them.
  source.requests.length = 0;
  for (let i = 0; i < 20; i++) source.queueChunk(100 + i, 0, 100);
  const key = chunkKey(0, 0, 0);
  streamer.regenerate(key);
  streamer.update(0, 0, 0);
  const priority = source.requests.filter((r) => r[3]);
  assert(priority.length === 1, `${priority.length} requests marked priority`);
  assert(chunkKey(priority[0][0], priority[0][1], priority[0][2]) === key, "the regeneration is the priority one");

  // A replacement is urgent, so the mesher submits it without waiting a frame.
  urgent.length = 0;
  streamer.onVoxelResult(0, 0, 0, KIND_UNIFORM, 5, null);
  assert(urgent.length === 1 && urgent[0] === true, `replacement urgent ${urgent}`);
});

Deno.test("a chunk with voxel ops goes through the compressor even when the voxelizer calls it uniform", () => {
  const { streamer, source, store, compressor } = setup();
  const edited = chunkKey(0, 0, 0);
  const seen: { key: number; dense: boolean; uniformId: number; ops: boolean }[] = [];
  streamer.voxelStage = { opsFor: (key) => key === edited ? new ArrayBuffer(4) : null, has: (key) => key === edited };
  (compressor as unknown as { compress: Compressor["compress"] }).compress = (key, ids, uniformId, ops) => {
    seen.push({ key, dense: ids !== null, uniformId, ops: ops !== null });
  };
  streamer.update(0, 0, 0);

  // The edited chunk: uniform from the voxelizer, still compressed so the ops land.
  streamer.onVoxelResult(0, 0, 0, KIND_UNIFORM, 7, null);
  assert(seen.length === 1, `${seen.length} compress jobs`);
  assert(seen[0].key === edited && !seen[0].dense && seen[0].uniformId === 7 && seen[0].ops, `routed as ${JSON.stringify(seen[0])}`);
  assert(!store.hasKey(edited), "not stored until the worker answers");

  // An untouched chunk: uniform goes straight to the store, no compress job.
  const [x, y, z] = source.requests.find(([a, b, c]) => chunkKey(a, b, c) !== edited)!;
  streamer.onVoxelResult(x, y, z, KIND_UNIFORM, 1, null);
  assert(seen.length === 1, "an unedited uniform chunk skips the compressor");
  assert(store.hasKey(chunkKey(x, y, z)), "and is stored at once");
});
