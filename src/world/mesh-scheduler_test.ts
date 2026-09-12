import { BinaryMesher, hasTranslucent } from "../mesh/binary.ts";
import { CLUSTER_QUADS, ClusterBuilder, ORDER_EMISSION } from "../mesh/cluster.ts";
import { type MeshJobInput, type MeshJobOutput, REF_ALL, REF_BLOCK, runMeshJob } from "../mesh/job.ts";
import { ALL_NEIGHBORS, NEIGHBOR_OFFSETS } from "../mesh/neighbors.ts";
import { readMeshOutput } from "../mesh/output.ts";
import { newBorders, newPlanes, setBorder, setPlane } from "../mesh/planes.ts";
import { FACE_AXIS, FACE_COUNT, FACE_SIGN } from "../mesh/quad.ts";
import { testChunks, WATER } from "../mesh/testchunks.ts";
import { SETTLED_DELIVERED, SETTLED_DROPPED, WorkerPool } from "../workers/pool.ts";
import { ChunkData } from "./chunk.ts";
import { chunkKey } from "./keys.ts";
import { ARENA_SHARE_ID, type MeshJobPool, MeshScheduler, type MeshSchedulerOptions } from "./mesh-scheduler.ts";
import { ChunkStore } from "./store.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

interface FakeJob {
  key: number;
  version: number;
  priority: number;
  input: MeshJobInput;
  running: boolean;
}

// Records submissions; tests decide when jobs start and finish. Same per-key rules
// as WorkerPool for what the scheduler relies on.
class FakePool implements MeshJobPool {
  jobs: FakeJob[] = [];
  recycled = 0;
  readonly shared = new Map<number, SharedArrayBuffer>();
  share(id: number, buffer: SharedArrayBuffer): void {
    this.shared.set(id, buffer);
  }
  submit(_kind: string, key: number, version: number, priority: number, input: unknown): void {
    this.jobs.push({ key, version, priority, input: input as MeshJobInput, running: false });
  }
  cancel(_kind: string, key: number): boolean {
    const i = this.jobs.findIndex((j) => j.key === key && !j.running);
    if (i === -1) return false;
    this.jobs.splice(i, 1);
    return true;
  }
  recycle(): void {
    this.recycled++;
  }
  take(key: number): FakeJob {
    const i = this.jobs.findIndex((j) => j.key === key);
    if (i === -1) throw new Error(`no job for key ${key}`);
    return this.jobs.splice(i, 1)[0];
  }
}

const ctx = { alloc: (bytes: number) => new ArrayBuffer(bytes), transfer: () => {} };

// Runs a job to completion: result, then settled, as WorkerPool does.
function finish(s: MeshScheduler, job: FakeJob, pool: FakePool): MeshJobOutput {
  const out = runMeshJob(job.input, ctx, (id) => pool.shared.get(id)!);
  s.onResult(job.key, job.version, out);
  s.onSettled(job.key, job.version, SETTLED_DELIVERED);
  return out;
}

const OPTIONS: MeshSchedulerOptions = {
  scanPerFrame: 4096,
  submitPerFrame: 64,
  maxOutstanding: 8,
  clusterQuads: CLUSTER_QUADS,
  clusterOrder: ORDER_EMISSION,
  ao: false,
  blockLight: false,
};

function setup(shared = false, options = OPTIONS) {
  const store = new ChunkStore({ maxChunks: 256, arenaBytes: 4 << 20, shared });
  const pool = new FakePool();
  const sched = new MeshScheduler(store, pool, options);
  const put = (x: number, y: number, z: number, chunk: ChunkData) => {
    if (store.put(x, y, z, chunk) === -1) throw new Error("store full");
    sched.stored(chunkKey(x, y, z));
  };
  return { store, pool, sched, put };
}

const OFFSETS: readonly (readonly [number, number, number])[] = Array.from({ length: FACE_COUNT }, (_, f) => {
  const d = [0, 0, 0];
  d[FACE_AXIS[f]] = FACE_SIGN[f];
  return [d[0], d[1], d[2]] as const;
});

function dense(name: string): ChunkData {
  return ChunkData.fromDense(testChunks().find((c) => c.name === name)!.ids);
}

const AIR = ChunkData.uniform(0);
const STONE = ChunkData.uniform(1);
const CENTER = chunkKey(0, 0, 0);

Deno.test("a chunk is meshed only once all six neighbors are stored", () => {
  const { pool, sched, put } = setup();
  put(0, 0, 0, dense("hills"));
  sched.update(0, 0, 0);
  assert(pool.jobs.length === 0, "no neighbors");
  for (let f = 0; f < 5; f++) put(...OFFSETS[f], AIR);
  sched.update(0, 0, 0);
  assert(pool.jobs.length === 0, "five neighbors");
  put(...OFFSETS[5], AIR);
  sched.update(0, 0, 0);
  assert(pool.jobs.length === 1 && pool.jobs[0].key === CENTER, `jobs ${pool.jobs.map((j) => j.key)}`);
});

Deno.test("with baked AO a chunk waits for all 26 neighbors, and its job carries them", () => {
  const { pool, sched, put } = setup(false, { ...OPTIONS, ao: true });
  put(0, 0, 0, dense("hills"));
  for (let i = 0; i < ALL_NEIGHBORS - 1; i++) {
    put(NEIGHBOR_OFFSETS[i * 3], NEIGHBOR_OFFSETS[i * 3 + 1], NEIGHBOR_OFFSETS[i * 3 + 2], dense("hills"));
    sched.update(0, 0, 0);
    assert(pool.jobs.length === 0, `${i + 1} of ${ALL_NEIGHBORS} neighbors`);
  }
  const last = ALL_NEIGHBORS - 1;
  put(NEIGHBOR_OFFSETS[last * 3], NEIGHBOR_OFFSETS[last * 3 + 1], NEIGHBOR_OFFSETS[last * 3 + 2], dense("hills"));
  sched.update(0, 0, 0);
  assert(pool.jobs.length === 1 && pool.jobs[0].key === CENTER, `jobs ${pool.jobs.map((j) => j.key)}`);
  const input = pool.jobs[0].input as MeshJobInput;
  assert(input.ao, "job asks for AO");
  assert(input.refs.length === REF_ALL * 2, `refs ${input.refs.length / 2}, want ${REF_ALL}`);
  for (let i = 0; i < REF_ALL; i++) assert(input.refs[i * 2] === REF_BLOCK, `ref ${i} is a block`);
});

Deno.test("uniform chunks that can't have faces get an empty mesh without a job", () => {
  const cases: [ChunkData, ChunkData[], boolean][] = [
    [AIR, Array(6).fill(STONE), false],
    [STONE, Array(6).fill(STONE), false],
    [STONE, [...Array(5).fill(STONE), AIR], true],
    [ChunkData.uniform(WATER), Array(6).fill(ChunkData.uniform(WATER)), false],
    [ChunkData.uniform(WATER), [...Array(5).fill(STONE), ChunkData.uniform(WATER)], false],
    [ChunkData.uniform(WATER), [...Array(5).fill(STONE), AIR], true],
  ];
  for (const [center, around, job] of cases) {
    const { pool, sched, put } = setup();
    put(0, 0, 0, center);
    around.forEach((c, f) => put(...OFFSETS[f], c));
    sched.update(0, 0, 0);
    const submitted = pool.jobs.some((j) => j.key === CENTER);
    assert(submitted === job, `center ${center.uniformId}: job ${submitted}, expected ${job}`);
    if (!job) assert(sched.meshedVersionOf(CENTER) === sched.versionOf(CENTER), "empty mesh accepted");
  }
});

Deno.test("job output equals meshing the same chunk directly, shared and copy paths", () => {
  const center = dense("hills with water");
  const around = [dense("water and glass"), STONE, AIR, dense("hills"), ChunkData.uniform(WATER), AIR];
  // Direct: planes and borders from the neighbors, then mesh and cluster.
  const planes = newPlanes();
  const borders = newBorders();
  around.forEach((c, f) => {
    setPlane(planes, f, c);
    setBorder(borders, f, c);
  });
  assert(hasTranslucent(center), "test chunk has water");
  const mesher = new BinaryMesher();
  const opaque = mesher.mesh(center, planes, { borders });
  const direct = new ClusterBuilder().build(opaque, ORDER_EMISSION, mesher.translucent);
  const quads = direct.quads.slice(0, direct.quadCount * 2);
  const clusters = direct.clusters.slice(0, direct.clusterCount * 4);
  for (const shared of [true, false]) {
    const { pool, sched, put, store } = setup(shared);
    assert(store.arena.shared === shared, "arena kind");
    put(0, 0, 0, center);
    around.forEach((c, f) => put(...OFFSETS[f], c));
    sched.update(0, 0, 0);
    const job = pool.take(CENTER);
    assert(job.input.returnBuffer === !shared, `returnBuffer on ${shared ? "shared" : "copy"} path`);
    if (shared) {
      assert(job.input.sharedId === ARENA_SHARE_ID && job.input.buffer === null, "shared path names the arena");
      assert(pool.shared.get(ARENA_SHARE_ID) === store.arena.buffer, "arena shared once at construction");
    }
    const out = finish(sched, job, pool);
    assert(out.mesh !== null, "mesh");
    const view = readMeshOutput(out.mesh!);
    assert(view.quads.length === quads.length && view.quads.every((w, i) => w === quads[i]), "quads");
    assert(view.clusters.length === clusters.length && view.clusters.every((w, i) => w === clusters[i]), "clusters");
    assert(view.realQuads === opaque.count + mesher.translucent.count, "real quad count");
    assert(out.translucentQuads === mesher.translucent.count && out.translucentQuads > 0, "translucent quads");
    assert(sched.stats.meshes === 1 && sched.stats.quads === opaque.count, "totals");
  }
});

Deno.test("one job per chunk at a time; changes during a job resubmit, stale results are dropped", () => {
  const { pool, sched, put } = setup();
  put(0, 0, 0, dense("hills"));
  for (const o of OFFSETS) put(...o, AIR);
  const accepted: number[] = [];
  sched.onMesh = (key, _out) => {
    accepted.push(sched.meshedVersionOf(key));
    return false;
  };
  sched.update(0, 0, 0);
  const first = pool.take(CENTER);
  for (let i = 0; i < 3; i++) sched.markDirty(CENTER);
  sched.update(0, 0, 0);
  assert(pool.jobs.length === 0, "no second job while one is out");
  const v = sched.versionOf(CENTER);
  assert(first.version < v, "the job is older than the chunk");
  finish(sched, first, pool);
  assert(sched.stats.stale === 1 && pool.recycled === 1 && accepted.length === 0, "stale result dropped");
  sched.update(0, 0, 0);
  const second = pool.take(CENTER);
  assert(second.version === v, `resubmitted at ${second.version}, expected ${v}`);
  finish(sched, second, pool);
  assert(accepted.join(",") === String(v) && sched.meshedVersionOf(CENTER) === v, `accepted ${accepted}`);
});

Deno.test("rapid edits: accepted mesh versions only increase and end at the latest", () => {
  const { pool, sched, put } = setup();
  put(0, 0, 0, dense("terrain-like"));
  for (const o of OFFSETS) put(...o, STONE);
  const accepted: number[] = [];
  sched.onMesh = (key) => {
    accepted.push(sched.meshedVersionOf(key));
    return false;
  };
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let step = 0; step < 300; step++) {
    const r = rand();
    if (r < 0.4) sched.markDirty(CENTER);
    else if (r < 0.7 && pool.jobs.length > 0) finish(sched, pool.jobs.shift()!, pool);
    sched.update(0, 0, 0);
  }
  while (pool.jobs.length > 0 || sched.meshedVersionOf(CENTER) !== sched.versionOf(CENTER)) {
    if (pool.jobs.length > 0) finish(sched, pool.jobs.shift()!, pool);
    sched.update(0, 0, 0);
  }
  for (let i = 1; i < accepted.length; i++) assert(accepted[i] > accepted[i - 1], `order ${accepted}`);
  assert(accepted.at(-1) === sched.versionOf(CENTER), "ends at the latest version");
  assert(sched.stats.stale > 0, "some results were stale");
});

Deno.test("eviction: a queued job is cancelled, a running one keeps its record until it settles", () => {
  {
    const { pool, sched, put, store } = setup();
    put(0, 0, 0, dense("hills"));
    for (const o of OFFSETS) put(...o, AIR);
    sched.update(0, 0, 0);
    store.removeKey(CENTER);
    sched.evicted(CENTER);
    assert(pool.jobs.length === 0 && sched.versionOf(CENTER) === -1, "queued: cancelled, record gone");
  }
  {
    const { pool, sched, put, store } = setup();
    put(0, 0, 0, dense("hills"));
    for (const o of OFFSETS) put(...o, AIR);
    sched.update(0, 0, 0);
    pool.jobs[0].running = true;
    store.removeKey(CENTER);
    sched.evicted(CENTER);
    assert(sched.versionOf(CENTER) !== -1 && sched.stats.outstanding === 1, "running: record kept");
    const job = pool.take(CENTER);
    sched.onSettled(job.key, job.version, SETTLED_DROPPED);
    assert(sched.versionOf(CENTER) === -1 && sched.stats.outstanding === 0, "freed after settling");
  }
});

Deno.test("shared arena: a block retired while a job may read it is reused only after the job settles", () => {
  const { pool, sched, put, store } = setup(true);
  put(0, 0, 0, dense("hills"));
  for (const o of OFFSETS) put(...o, AIR);
  sched.update(0, 0, 0);
  const job = pool.jobs[0];
  job.running = true;
  const offset = job.input.refs[1];
  store.removeKey(CENTER);
  sched.evicted(CENTER);
  assert(store.retiredCount === 1, "retired, not freed");
  put(5, 0, 0, dense("hills"));
  sched.update(0, 0, 0);
  assert(store.blockOffset(store.handle(5, 0, 0)) !== offset, "not reused while the job runs");
  pool.take(CENTER);
  sched.onSettled(job.key, job.version, SETTLED_DROPPED);
  sched.update(0, 0, 0);
  assert(store.retiredCount === 0, "reclaimed after settling");
  put(6, 0, 0, dense("hills"));
  assert(store.blockOffset(store.handle(6, 0, 0)) === offset, "reused afterwards");
});

Deno.test("per-frame submit budget and outstanding cap", () => {
  const { pool, sched, put } = setup(false, { ...OPTIONS, submitPerFrame: 3, maxOutstanding: 5 });
  // A 4x1x4 slab of stone with air above and below: every chunk has faces.
  for (let x = -1; x <= 4; x++) {
    for (let z = -1; z <= 4; z++) {
      for (let y = -1; y <= 1; y++) put(x, y, z, y === 0 && x >= 0 && x < 4 && z >= 0 && z < 4 ? STONE : AIR);
    }
  }
  sched.update(0, 0, 0);
  assert(pool.jobs.length === 3, `first frame ${pool.jobs.length}`);
  sched.update(0, 0, 0);
  assert(pool.jobs.length === 5, `capped at ${pool.jobs.length}`);
  finish(sched, pool.jobs.shift()!, pool);
  finish(sched, pool.jobs.shift()!, pool);
  sched.update(0, 0, 0);
  assert(pool.jobs.length === 5, `refilled to ${pool.jobs.length}`);
});

Deno.test({
  name: "end to end: real workers mesh from the shared arena and match direct meshing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const url = new URL("../workers/voxel.worker.ts", import.meta.url);
    const pool = new WorkerPool(() => new Worker(url, { type: "module" }), 2);
    try {
      for (const shared of [true, false]) {
        const store = new ChunkStore({ maxChunks: 64, arenaBytes: 4 << 20, shared });
        const sched = new MeshScheduler(store, pool, OPTIONS);
        const done = Promise.withResolvers<MeshJobOutput>();
        sched.onMesh = (_key, out) => {
          done.resolve(out);
          return true;
        };
        pool.on("chunk.mesh", (key, version, out) => sched.onResult(key, version, out as MeshJobOutput));
        pool.onSettled("chunk.mesh", (key, version, outcome) => sched.onSettled(key, version, outcome));
        const center = dense("hills with water");
        store.put(0, 0, 0, center);
        sched.stored(CENTER);
        OFFSETS.forEach((o, f) => {
          store.put(...o, f === 2 ? AIR : STONE);
          sched.stored(chunkKey(...o));
        });
        sched.update(0, 0, 0);
        const out = await done.promise;
        const planes = newPlanes();
        const borders = newBorders();
        OFFSETS.forEach((_, f) => {
          setPlane(planes, f, f === 2 ? AIR : STONE);
          setBorder(borders, f, f === 2 ? AIR : STONE);
        });
        const mesher = new BinaryMesher();
        const direct = new ClusterBuilder().build(mesher.mesh(center, planes, { borders }), ORDER_EMISSION, mesher.translucent);
        const view = readMeshOutput(out.mesh!);
        assert(view.quadCount === direct.quadCount && view.clusterCount === direct.clusterCount, "counts");
        for (let i = 0; i < direct.quadCount * 2; i++) assert(view.quads[i] === direct.quads[i], `quad word ${i}`);
        assert(sched.meshedVersionOf(CENTER) === sched.versionOf(CENTER), `accepted on ${shared ? "shared" : "copy"} path`);
        pool.recycle(out.mesh!);
      }
    } finally {
      pool.terminate();
    }
  },
});

Deno.test("an urgent store submits the job at once, and falls back to the queue when it cannot", () => {
  const { pool, sched, put, store } = setup();
  const around = [dense("hills"), STONE, AIR, dense("hills"), ChunkData.uniform(WATER), AIR];
  put(0, 0, 0, dense("hills"));
  around.forEach((c, f) => put(...OFFSETS[f], c));
  sched.update(0, 0, 0);
  assert(pool.jobs.length === 1, `${pool.jobs.length} jobs after the first update`);
  finish(sched, pool.take(CENTER), pool);

  // Urgent: the job goes out without waiting for update().
  if (store.put(0, 0, 0, dense("hills with water")) === -1) throw new Error("store full");
  sched.stored(CENTER, true);
  assert(pool.jobs.length === 1 && pool.jobs[0].key === CENTER, "urgent store submitted at once");

  // A second urgent store while that job runs leaves it queued, not submitted twice.
  if (store.put(0, 0, 0, dense("hills")) === -1) throw new Error("store full");
  sched.stored(CENTER, true);
  assert(pool.jobs.length === 1, `${pool.jobs.length} jobs while one is running`);
  finish(sched, pool.take(CENTER), pool);
  sched.update(0, 0, 0);
  assert(pool.jobs.length === 1, "the queued version went out on the next update");
  assert(sched.stats.submitted === 3, `submitted ${sched.stats.submitted}`);
});
