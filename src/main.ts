// Browser entry point: GPU startup, device-loss recovery, canvas sizing, and the
// frame loop (update, then render).

import { appSwitches, optionsFromSearch, type SearchProblem, worldFromSearch } from "./app/search-options.ts";
import { resolveOptions } from "./options.ts";
import { SCENES } from "./bench/scenes.ts";
import { type BenchContext, BenchSession } from "./bench/session.ts";
import { VoxelBench } from "./bench/voxel-bench.ts";
import { FlyCamera } from "./camera/camera.ts";
import { FlyControls } from "./camera/controls.ts";
import { ease, Follow, type FollowState, raiseHeight } from "./camera/follow.ts";
import { Hud, type HudButton } from "./debug/hud.ts";
import { Overlay } from "./debug/overlay.ts";
import { CPU_FRAME, CPU_RENDER, CPU_UPDATE, Stats } from "./debug/stats.ts";
import { formatCaps } from "./gpu/caps.ts";
import { createGpu, type Gpu } from "./gpu/device.ts";
import { describeBird, NO_BIRD, pickBird } from "./render/birds.ts";
import { Renderer } from "./render/renderer.ts";
import { WorkerPool } from "./workers/pool.ts";
import type { CompressInput, CompressOutput } from "./workers/jobs.ts";
import { BrushBatch } from "./brush/batch.ts";
import { BrushGrid } from "./brush/grid.ts";
import { csgOne } from "./brush/build.ts";
import { BLEND_UNION, BRUSH_CSG, PRIM_SPHERE } from "./brush/format.ts";
import { BrushStore } from "./brush/store.ts";
import { EditTool } from "./brush/tool.ts";
import { fillBox, fillSphere, hasChunkOps, packChunkOps, setVoxel } from "./brush/voxel-ops.ts";
import { newRayHit, raycastVoxels } from "./world/raycast.ts";
import { BRICK_WORDS, bricksPerChunkSide, tilesChunk } from "./far/reduce.ts";
import { BRICK_CELLS, BrickGrid } from "./far/bricks.ts";
import { BRICK_JOB, FarEdits } from "./far/edits.ts";
import { DEFAULT_ADAPT_OPTIONS, FarAdapt } from "./far/adapt.ts";
import type { BrickJobOutput } from "./far/brick-job.ts";
import { canShareMemory } from "./workers/buffers.ts";
import { BLOCKS } from "./world/blocks.ts";
import { CHUNK_VOLUME, voxelIndex } from "./world/coords.ts";
import { ChunkStore } from "./world/store.ts";
import { chunkInRange, chunkKey, keyX, keyY, keyZ } from "./world/keys.ts";
import { DEFAULT_MESH_OPTIONS, MESH_JOB, MeshScheduler } from "./world/mesh-scheduler.ts";
import { ORDER_MORTON } from "./mesh/cluster.ts";
import type { NearFieldOptions } from "./render/near-field.ts";
import type { MeshJobOutput } from "./mesh/job.ts";
import { ChunkStreamer } from "./world/streaming.ts";
import type { Voxelizer } from "./sdf/voxelizer.ts";
import { runWorkerSelfTest } from "./workers/selftest.ts";
import { type WorldProgram, WORLDS } from "./worlds/index.ts";
import { DEFAULT_SKY, SKIES } from "./render/sky.ts";

declare global {
  // Console handle for debugging, e.g. `voxler.gpu.device.destroy()` to test
  // recovery, or `voxler.camera.setPosition(1e6, 10, 1e6)` to teleport.
  var voxler: {
    gpu: Gpu | null;
    renderer: Renderer | null;
    camera: FlyCamera;
    pool: WorkerPool;
    // The fly controls and the follow flyover, so a flight can be set up from the
    // console: `voxler.follow.speed = 60`, `voxler.follow.height = 40`.
    controls?: FlyControls;
    follow?: Follow;
    store?: ChunkStore;
    streamer?: ChunkStreamer;
    mesher?: MeshScheduler;
    // Brush instances and the voxel journal, plus the edit helpers, so edits can be
    // made from the console: `voxler.edit.fillBox(voxler.brushes, x0, y0, z0, x1, y1, z1, id)`.
    brushes?: BrushStore;
    tool?: EditTool;
    edit?: {
      setVoxel: typeof setVoxel;
      fillBox: typeof fillBox;
      fillSphere: typeof fillSphere;
      // Field brushes: `voxler.edit.csgSphere(x, y, z, r, id)` adds one, and
      // `voxler.edit.csgSphere(x, y, z, r, 0, BLEND_SUBTRACT)` carves with it.
      csgSphere: (x: number, y: number, z: number, r: number, id?: number, blend?: number, k?: number) => number;
    };
  };
}

const RESTART_DELAY_MS = 250;
const RESTART_WINDOW_MS = 30_000;
const MAX_RESTARTS_IN_WINDOW = 3;
const MAX_FRAME_DT = 0.1; // seconds; longer gaps (tab hidden, debugger) don't jump the camera
const MAX_INTERVAL_SAMPLE_MS = 1000; // longer gaps are pauses, not frames; keep them out of stats
const OVERLAY_INTERVAL_MS = 250;
const START_PITCH = -0.25;
const BENCH_DEFAULT_SIZE: [number, number] = [1920, 1080]; // CLAUDE.md targets are at 1080p
const MAX_BENCH_RUNS = 10;
const VOXEL_BATCHES_PER_FRAME = 2; // normal budget; ?voxelBench uses every free slot
const DEFAULT_VOXEL_SLOTS = 8;

const CONTROLS_HELP = "drag: look (mouse or touch)  WASD move  Space/C up/down  Shift sprint\n" +
  "wheel: fly to and from the cursor  +/- speed\n" +
  "F2 overlay (its text is selectable)  P preview  G grid  M meshes\n" +
  "K follow the ground below the camera; +/- set its speed and Space/C its height while it flies\n" +
  "E place  Q remove  R rotate (Shift+R back)  B block  X shape  Z undo  Y redo\n" +
  `?world=${Object.keys(WORLDS).join("|")}&seed=n  ?at=x,y,z teleports on load\n` +
  "?previewScale=0.1..1  ?workers=n pool size  ?jobBatch=n jobs per worker message  ?workerTest\n" +
  "?voxelBench voxelizer throughput  ?voxelSlots=n readback slots\n" +
  "?stream=0 no streaming  ?streamRadius=n ?streamHeight=n chunks  ?arenaMB=n chunk memory  ?preview=0\n" +
  "?regen=n chunks regenerated per frame  ?regenCheck compares each replacement\n" +
  "?mesh=0 no meshing  ?cull=n mask (0 none, 3 no occlusion, 7 all)  ?cullCheck  ?clusterQuads=n\n" +
  "?clusterOrder=morton  ?nearMB=n quad arena  ?ao=0 no baked AO  ?tex=0 no textures\n" +
  "?glow=0 no emission  ?wind=0 no sway  ?light=0 no block light  ?shadow=0 no shadows\n" +
  `?sky=${Object.keys(SKIES).join("|")} overrides the world's own sky\n` +
  "?far=0 no far field  ?far=steps|bricks|levels debug view (F rebuilds it)  ?farScale=0.1..1\n" +
  "?birds=0 no birds (the forest has them)  ?gizmo=0 no axis cross\n" +
  "?farLevels=n ?farSize=n ?farFirst=k ?farBricks=n ?farSlabs=n ?farBeam=0  ?farAdapt=0  ?farCheck\n" +
  `?bench=${Object.keys(SCENES).join("|")}&runs=n benchmark`;

const params = new URLSearchParams(location.search);
// Everything the engine needs, resolved once (`src/options.ts`). The switches still exist
// and still mean what they meant; what changed is that they are one source of options and
// no longer the only one, so the same engine can be set up by a host that has no URL
// (plan-packaging.md phase 1). Anything unknown in the query string lands in
// `searchProblems` and goes to the overlay as soon as there is one.
const searchProblems: SearchProblem[] = [];
const opts = resolveOptions(optionsFromSearch(params, searchProblems));
// The switches that drive this shell rather than the engine: the benchmark harness, the
// self-tests and the comparisons.
const app = appSwitches(params);

// The init stages that stand between a sky and a world, in the order they are waited on
// (`Renderer.init`). Named here so the panel can say which are outstanding.
const WORLD_STAGES = ["voxelize", "near", "far"] as const;

// View toggles, kept here so they survive a Renderer rebuild after device loss.
const view = {
  preview: opts.render.preview,
  grid: opts.render.grid,
  gizmo: opts.render.gizmo,
  meshes: true,
};

// The cull mask (1 frustum, 2 face direction, 4 occlusion), and the comparison against an
// unculled draw of the same frame that `?cullCheck` turns on.
const cullFlags = opts.render.cull;
const cullCheck = app.cullCheck;

// `?bench=<scene>&runs=<n>` starts a benchmark session instead of the fly controls.
function benchSession(): BenchSession | null {
  if (app.bench === null) return null;
  const scene = SCENES[app.bench];
  if (!scene) {
    overlay.error(`unknown bench scene "${app.bench}"; known: ${Object.keys(SCENES).join(", ")}`);
    return null;
  }
  const runs = Math.min(MAX_BENCH_RUNS, Math.max(1, app.runs ?? 1));
  // The overlay starts hidden, and a bench run's progress is the one thing worth showing.
  overlay.show();
  return new BenchSession(scene, runs, world.spawn, () => overlay.setSection("bench", bench?.status() ?? ""));
}

const canvas = document.getElementById("view") as HTMLCanvasElement;
const overlay = new Overlay(document.body);
// Anything the query string asked for that does not exist. Reported, not thrown: the
// options layer has already fallen back to something that runs.
for (const problem of searchProblems) overlay.error(problem.message);
const camera = new FlyCamera();
const controls = new FlyControls(canvas, camera);
const stats = new Stats();
// Worker URL is the built output path next to main.js (build.ts workerEntries()).
const pool = new WorkerPool(
  opts.workers.factory ??
    ((i) => new Worker(new URL("./workers/voxel.worker.js", import.meta.url), { type: "module", name: `voxel-${i}` })),
  opts.workers.count,
  opts.workers.jobsPerMessage,
);
pool.onError = (kind, key, message) => overlay.error(`job ${kind} ${key} failed: ${message}`);
globalThis.voxler = { gpu: null, renderer: null, camera, pool };
// Order matters: benchSession() reads world.spawn. Module-level consts are bundled
// as vars, so a use before this line sees undefined rather than a TDZ error.
// The world the renderer, the voxelizer and the preview all read. Everything in it but
// the name comes from the resolved options; the name is a label for shader errors and the
// overlay, so it lives with the shell that knows a `?world=` was typed.
const world: WorldProgram = {
  name: worldFromSearch(params).name,
  code: opts.world.code,
  seed: opts.world.seed,
  spawn: opts.world.spawn,
  start: opts.world.start,
  sky: opts.world.sky,
  birds: opts.world.birds,
};
const renderSize = opts.render.size;
const bench = benchSession();
let voxelBench: VoxelBench | null = null;

// Chunk store and streaming are CPU state: they survive device loss, and attach to
// each new voxelizer. Off for ?voxelBench (it owns the voxelizer) and ?stream=0.
const streaming = opts.streaming;
const streamOpts = opts.stream;
const store = new ChunkStore({
  maxChunks: Math.ceil(ChunkStreamer.keepCapacity(streamOpts) * 1.25),
  arenaBytes: opts.arenaBytes,
  shared: canShareMemory(),
});
const streamer = new ChunkStreamer(store, streamOpts);
// `?regen=n` regenerates n random resident chunks a frame, the soak test for the
// regeneration path (plan-world-modelling phase 2); `?regenCheck` compares every
// replaced chunk against the one it replaced and counts differences. A soak, and not the
// streamer's own `regenPerFrame`, which is how many chunks an *edit* has changed it puts
// back through the voxelizer.
const regenPerFrame = app.regen;
streamer.checkRegen = app.regenCheck;
globalThis.voxler.store = store;
globalThis.voxler.streamer = streamer;
let compressVersion = 0;

// Brush instances and the voxel journal (plan-world-modelling). Edits and voxel
// brushes are one thing, so this store holds both; its dirty chunks are drained into
// the streamer's regeneration queue every frame.
const brushes = new BrushStore();
// Field brushes (SDF and CSG) go to the voxelizer with each batch; voxel brushes go
// to the compress worker as the voxel stage (plan-world-modelling phases 3 and 5).
const fieldBrushes = new BrushBatch(brushes);
// The preview traces brushes through a camera-centred grid, since a ray crosses many
// chunks and cannot use the voxelizer's per-chunk runs.
const brushGrid = new BrushGrid(brushes);
globalThis.voxler.brushes = brushes;
globalThis.voxler.edit = {
  setVoxel,
  fillBox,
  fillSphere,
  csgSphere: (x, y, z, r, id = 1, blend = BLEND_UNION, k = 0) =>
    brushes.add({
      kind: BRUSH_CSG,
      cell: [x, y, z],
      blend,
      blendK: k,
      material: id,
      ops: csgOne(PRIM_SPHERE, [r]),
    }),
};
const tool = new EditTool(brushes);
globalThis.voxler.tool = tool;
const toolHit = newRayHit();
// How far a placement ray reaches, in voxels.
const TOOL_REACH = 96;

// Casts from the eye along the view direction and hands the hit to the tool. One
// path for every edit, whether it comes from a key or from a script.
function toolRay(): boolean {
  const b = camera.basis;
  return raycastVoxels(
    store,
    camera.worldPosition(0),
    camera.worldPosition(1),
    camera.worldPosition(2),
    b[6],
    b[7],
    b[8],
    toolHit,
    { maxDistance: TOOL_REACH, opaqueOnly: false },
  );
}

function describeTool(): string {
  const aim = toolHit.hit
    ? `aim (${toolHit.x}, ${toolHit.y}, ${toolHit.z}) id ${toolHit.id} at ${toolHit.distance.toFixed(1)}`
    : "aim -";
  return `edit  ${tool.describeState()}\n      ${aim}  E place  Q remove  R rotate  B block  X shape  Z undo  Y redo`;
}
streamer.voxelStage = {
  opsFor: (key) => packChunkOps(brushes, key),
  has: (key) => hasChunkOps(brushes, key),
};
let brushDirty = new Float64Array(256);
// Far-field bricks for edited chunks, built once a renderer exists.
let farEdits: FarEdits | null = null;
const FAR_EDIT_JOBS_PER_FRAME = 2;

function applyBrushEdits(): void {
  const n = brushes.dirty;
  if (n === 0) return;
  if (brushDirty.length < n) brushDirty = new Float64Array(n * 2);
  streamer.regenerateKeys(brushDirty, brushes.takeDirty(brushDirty));
}

// Meshing follows streaming: stored chunks are meshed in workers once their
// neighbors are in. Nothing draws the meshes yet (plan-rendering); results are
// counted and recycled. `?mesh=0` turns it off.
const meshing = opts.meshing;
// Constructed only when used: it turns on deferred frees in the store.
// `?clusterQuads=n` sets the cluster size for this session (plan-rendering phase 1);
// `?nearMB=n` the near-field quad arena budget (plan-rendering phase 2).
const clusterQuads = opts.mesh.clusterQuads;
const clusterOrder = opts.mesh.clusterOrder;
const bakedAo = opts.mesh.ao;
const textured = opts.render.textures;
const emissive = opts.render.glow;
const animated = opts.render.wind;
const blockLight = opts.mesh.blockLight;
// Shadow rays march the far field's clipmap, so they need it built: `?far=0` has already
// taken them with it by the time this is read (`resolveOptions`).
const shadows = opts.shadows;
// `?farCheck` compares the SDF-sampled bricks against the same region reduced from
// resident chunk data (plan-far-field phase 2). `?farLevels=n` sets the clipmap's
// level count, `?farBricks=n` the pool capacity in bricks, and `?farSlabs=n` how many
// brick slabs are sampled per frame (phase 3).
const farCheck = app.farCheck;
// The clipmap a world asked for, trimmed to the distance its fog closes the view at, with
// any `?far*` switch winning over both. All of it decided in `resolveOptions`; what is
// left here is handing it to the renderer.
const farOptions = { clipmap: opts.far.clipmap, slabsPerFrame: opts.far.slabsPerFrame, scale: opts.far.scale };
const farBeam = opts.far.beam;
// The far field's reach and build budget can follow what they cost on this machine
// (src/far/adapt.ts), but only when asked: `?farAdapt=1`.
//
// Off by default because what it moves is visible. Dropping a clipmap level shortens the
// world and rebuilds the level, and changing the march resolution rebuilds the target;
// both land as a pop in the middle of the frame, with nothing the viewer did to cause
// them. A controller that changes the picture while the camera is still has to be
// imperceptible before it can be the default, and this one is not yet: over a minute
// standing in one place it walked terrain from eight levels to five.
const farAdapt = opts.far.adapt;
// `?far=steps|bricks|levels` picks a debug view; F rebuilds its bricks around the camera.
const farMode = opts.far.debug;
const farOn = opts.farOn;
const nearOptions: NearFieldOptions = {
  quadMiB: opts.render.nearMiB,
  slots: store.capacity, // a mesh per stored chunk at most
  clusterQuads,
  ao: bakedAo,
  textured,
  emissive,
  animated,
  blockLight,
  shadows: shadows && farOn,
};
const mesher = meshing ? new MeshScheduler(store, pool, { ...DEFAULT_MESH_OPTIONS, clusterQuads, clusterOrder, ao: bakedAo, blockLight }) : null;
if (mesher) {
  // Meshes go to whichever renderer is current; a new renderer asks for all of
  // them again (remeshAll after init).
  mesher.onMesh = (key, output) => globalThis.voxler.renderer?.near.add(key, output) ?? false;
  mesher.onUnmesh = (key) => globalThis.voxler.renderer?.near.remove(key);
  // Meshing and, for chunks an edit changed, far-field bricks. Unedited chunks
  // follow the world SDF and the far field samples them on the GPU instead
  // (plan-far-field phase 2).
  streamer.listener = {
    stored(key: number, urgent: boolean) {
      mesher.stored(key, urgent);
      if (farEdits !== null && hasChunkOps(brushes, key)) farEdits.markDirty(key);
    },
    evicted(key: number) {
      mesher.evicted(key);
    },
  };
  pool.on(MESH_JOB, (key, version, output) => mesher.onResult(key, version, output as MeshJobOutput));
  pool.onSettled(MESH_JOB, (key, version, outcome) => mesher.onSettled(key, version, outcome));
}
globalThis.voxler.mesher = mesher ?? undefined;

pool.on("chunk.compress", (key, _version, output) => {
  const out = output as CompressOutput;
  streamer.onCompressed(key, out.uniform, out.block, out.bytes);
  if (out.block) pool.recycle(out.block);
  if (out.ids) globalThis.voxler.renderer?.voxelizer.recycle(new Uint16Array(out.ids));
});

function attachStreaming(voxelizer: Voxelizer): void {
  voxelizer.onResult = (r) => streamer.onVoxelResult(r.cx, r.cy, r.cz, r.kind, r.blockId, r.ids);
  voxelizer.fieldBrushes = fieldBrushes;
  streamer.attach({
    queueChunk: (x, y, z, priority) => voxelizer.queueChunk(x, y, z, priority),
    get queuedCount() {
      return voxelizer.stats.queued;
    },
    recycle: (ids) => voxelizer.recycle(ids),
  }, {
    // A fresh input and transfer list per job: a job the pool queues keeps the
    // caller's objects until it is dispatched, so reusing them detaches the buffers
    // of the one still waiting.
    compress: (key, ids, uniformId, ops) => {
      const input: CompressInput = { ids, uniformId, ops, cx: keyX(key), cy: keyY(key), cz: keyZ(key) };
      const transfer: Transferable[] = [];
      if (ids) transfer.push(ids.buffer as ArrayBuffer);
      if (ops) transfer.push(ops);
      pool.submit("chunk.compress", key, ++compressVersion, 0, input, transfer);
    },
  });
}
let lastVoxelChunks = 0;
let lastVoxelTime = 0;

let running = true; // cleared when a benchmark session finishes
let pixelWidth = 1;
let pixelHeight = 1;
let sizeDirty = true;
let sizedRenderer: Renderer | null = null;
let generation = 0;
let lastTime = -1;
let nextOverlayUpdate = 0;
const restartTimes: number[] = [];

function showMessage(text: string): void {
  const el = document.getElementById("message");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
}

// `?at=x,y,z` starts the camera at a world position, e.g. `?at=1000000,10,1000000`;
// otherwise it starts where the world opens: its own `start`, or its spawn point when it
// does not name one. The aim is the same everywhere, looking along -Z and a little down.
function placeCamera(): void {
  const from = app.at ?? opts.camera.at;
  camera.setPosition(from[0], from[1], from[2]);
  camera.setOrientation(opts.camera.yaw, opts.camera.pitch);
}

function describeCamera(): string {
  const deg = 180 / Math.PI;
  return [
    `pos    ${camera.worldPosition(0).toFixed(2)}  ${camera.worldPosition(1).toFixed(2)}  ${
      camera.worldPosition(2).toFixed(2)
    }`,
    `chunk  ${camera.chunk[0]}  ${camera.chunk[1]}  ${camera.chunk[2]}`,
    `look   yaw ${(camera.yaw * deg).toFixed(1)}  pitch ${(camera.pitch * deg).toFixed(1)}`,
    `speed  ${controls.speed.toFixed(1)} voxels/s`,
  ].join("\n");
}

// Asks for a few random resident chunks to be generated again (`?regen=n`).
function soakRegeneration(): void {
  const n = streamer.residentCount;
  if (n === 0) return;
  for (let i = 0; i < regenPerFrame; i++) {
    streamer.regenerate(streamer.residentKeyAt(Math.floor(Math.random() * n)));
  }
}

function describeStreaming(): string {
  const s = streamer.stats;
  const a = store.arena;
  const regen = s.regenerated > 0 || regenPerFrame > 0
    ? `\n        regen queued ${s.regenQueued}  done ${s.regenerated}  replaced ${s.regenReplaced}` +
      `  differ ${streamer.checkRegen ? s.regenDiffer : "-"}`
    : "";
  return `stream  resident ${s.resident} (uniform ${store.uniformCount})  requested ${s.requested}  ` +
    `compressing ${s.compressing}  holes ${s.holes}  evicted ${s.evicted}  dropped ${s.dropped}  ` +
    `full ${s.storeFull}\n        arena ${(a.usedBytes / 1048576).toFixed(1)} / ${(a.capacityBytes / 1048576).toFixed(0)} MiB` +
    ` (${a.shared ? "shared" : "copy path"})  radius ${streamOpts.radius}  height ${streamOpts.height}${regen}`;
}

let lastMeshAccepted = 0;
let lastMeshTime = 0;
function describeMeshing(mesher: MeshScheduler, now: number): string {
  const s = mesher.stats;
  const rate = lastMeshTime > 0 ? ((s.accepted - lastMeshAccepted) * 1000) / (now - lastMeshTime) : 0;
  lastMeshAccepted = s.accepted;
  lastMeshTime = now;
  const perChunk = s.meshes > 0 ? Math.round(s.quads / s.meshes) : 0;
  return `mesh  meshes ${s.meshes}  empty ${s.empty}  dirty ${s.dirty}  in flight ${s.outstanding}  ` +
    `${rate.toFixed(0)}/s  stale ${s.stale}  failed ${s.failed}  latency ${s.latencyMs.toFixed(1)} ms\n` +
    `      quads ${s.quads} (${perChunk}/mesh)  translucent ${s.translucentQuads}  clusters ${s.clusters}  ` +
    `${(s.bytes / 1048576).toFixed(1)} MiB  retired ${store.retiredCount}`;
}

function describeNear(renderer: Renderer): string {
  const s = renderer.near.refreshStats();
  const waste = s.paddedQuads > 0 ? (100 * (s.paddedQuads - s.realQuads)) / s.paddedQuads : 0;
  const mib = (quads: number) => ((quads * 8) / 1048576).toFixed(1);
  const check = cullCheck
    ? `  cull check ${s.cullChecks} frames, ${s.cullCheckFailures} fail (depth max ${s.cullCheckMaxDiff} px, ` +
      `${s.cullCheckMissing} missing, ${s.cullCheckTies} edge ties)`
    : "";
  return `near${renderer.showMeshes ? "" : " (hidden, M)"}  chunks ${s.chunks}  clusters ${s.liveClusters} live  ` +
    `quads ${s.realQuads} (padding ${waste.toFixed(1)}%)  order ${clusterOrder === ORDER_MORTON ? "morton" : "emission"}\n` +
    `      cull${renderer.near.cullFlags === 0 ? " off" : ""}: ${s.clusters} tested, ${s.visibleClusters} drawn ` +
    `(${s.drawnPhaseA} again, ${s.drawnPhaseB} new), ${s.faceCulled} by face, ${s.frustumCulled} by frustum, ` +
    `${s.occludedClusters} hidden, ${s.skippedClusters} empty${check}\n` +
    `      translucent: ${s.translucentDrawn} drawn, ${s.translucentOccluded} hidden\n` +
    `      arena ${mib(s.paddedQuads)} / ${mib(s.capacityQuads)} MiB  free runs ${s.quadFreeBlocks}  ` +
    `largest ${mib(s.quadLargestFree)} MiB  frag ${s.quadFragmentation.toFixed(2)}  ` +
    `clusters frag ${s.clusterFragmentation.toFixed(2)}\n` +
    `      pending ${s.pending}  dropped ${s.dropped}  draw test ${renderer.drawTest ?? "running"}`;
}

function describeFar(renderer: Renderer): string {
  const s = renderer.far.stats;
  const map = renderer.far.map;
  const e = farEdits?.stats;
  const reach = map.extentVoxels(map.levels - 1) / 2;
  const a = renderer.farAdapt;
  const adapt = a === null
    ? "fixed"
    : `adapting: march ${a.report.marchMs.toFixed(2)} + build ${a.report.buildMs.toFixed(2)} ` +
      `(${(a.report.buildDuty * 100).toFixed(0)}% of frames, worst ${a.report.buildMaxMs.toFixed(1)}) ` +
      `of ${a.report.budgetMs.toFixed(2)} ms left in the frame, ${a.report.action}`;
  return `far  ${map.levels}/${map.levelCapacity} levels, k ${map.levelK(0)}..${map.levelK(map.levels - 1)}, ` +
    `${map.options.size}^3 bricks each, reach ${reach} voxels, ${renderer.far.slabs} slabs/frame\n` +
    `     ${adapt}\n` +
    `     pool ${s.bricks}/${map.pool.capacity} bricks (${(s.poolBytes / 1048576).toFixed(1)} MiB)  ` +
    `dropped ${s.dropped}  slabs ${s.slabs} built, ${s.queued} queued, ${s.inFlight} in flight  ` +
    `upload ${s.uploadBytes} B/frame\n` +
    `     edited chunks: ${e?.submitted ?? 0} reduced, ${s.patched} bricks patched, ${e?.queued ?? 0} queued, ` +
    `${e?.missing ?? 0} not resident, ${e?.retried ?? 0} retried, ${e?.stale ?? 0} stale\n` +
    `     coarse: ${s.coarse} bricks rebuilt from the level under them, ${s.coarseQueued} queued  ` +
    `march at ${(renderer.far.resolutionScale * 100).toFixed(0)}% resolution` +
    `${renderer.far.beam ? " with a beam pre-pass" : ""}`;
}

function describeVoxelizer(renderer: Renderer, now: number): string {
  const s = renderer.voxelizer.stats;
  const rate = lastVoxelTime > 0 ? ((s.chunks - lastVoxelChunks) * 1000) / (now - lastVoxelTime) : 0;
  lastVoxelChunks = s.chunks;
  lastVoxelTime = now;
  return `voxelize  queued ${s.queued}  in flight ${s.inFlight}  chunks ${s.chunks} (${rate.toFixed(0)}/s)  ` +
    `air ${s.air} uniform ${s.uniform} dense ${s.dense}  ${(s.mappedBytes / 1048576).toFixed(1)} MiB mapped  ` +
    `latency ${s.latencyMs.toFixed(1)} ms`;
}

function applySize(renderer: Renderer, gpu: Gpu): void {
  const max = gpu.caps.limits.maxTextureDimension2D;
  const width = Math.max(1, Math.min(renderSize ? renderSize[0] : pixelWidth, max));
  const height = Math.max(1, Math.min(renderSize ? renderSize[1] : pixelHeight, max));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  // A fixed render size is laid out at the window's shape unless it is told otherwise,
  // and the two rarely agree: the frame is then scaled by a different factor across than
  // down, which is a pixel that is not square. Give the element the render target's own
  // aspect and let it letterbox (canvas.fit in index.html), so the picture is the same
  // picture whatever the window is doing. Without `?size=` the render target already is
  // the window and there is nothing to fit.
  if (renderSize) {
    canvas.style.aspectRatio = `${width} / ${height}`;
    canvas.style.setProperty("--fit-aspect", String(width / height));
    canvas.classList.add("fit");
  }
  renderer.resize(width, height);
  sizeDirty = false;
  sizedRenderer = renderer;
}

function prefixed(prefix: string, stats: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) out[prefix + k] = v as number;
  return out;
}

// How long a bench waited for the world before it started, and the longest it will.
let benchWaitedMs = -1;
const BENCH_READY_TIMEOUT_MS = 90_000;

// A benchmark must not start before the world it is measuring exists. The renderer is
// handed over as soon as it can draw a sky; its pipelines, its clipmap and its chunks
// arrive over the seconds after that, and a run started then measures an empty frame.
// What that looks like is not an error but a good result: no meshes to draw, no bricks to
// march, `resident` 0 and a GPU time of nothing
// (gotchas.md "A bench that starts before the world is built").
//
// Three things have to be true, and the warm-up is not one of them: it is a settling
// time, not a wait for the world. The timeout is there so a world that never settles
// still produces a result, and `readyMs` in the result says how long it took.
function benchReady(renderer: Renderer, now: number): boolean {
  if (benchWaitedMs >= 0) return true;
  const s = streamer.stats;
  // "Nothing outstanding" is not the same as "everything arrived": on the first frames
  // there are no holes because nothing has been asked for yet, and no queued slabs because
  // the clipmap has not been told where the camera is. On a machine whose shader cache is
  // warm the pipelines land in a tenth of a second and a gate that only asks for quiet
  // walks straight through, which is what a 140 ms `readyMs` on the Mac turned out to be
  // ([gotchas.md](agent_docs/gotchas.md) "A bench that starts before the world is built").
  // So every check here is a *positive* one: something arrived, and nothing is still on
  // its way.
  const ready = WORLD_STAGES.every((name) => renderer.startup[name] !== undefined) &&
    renderer.far.stats.slabs > 0 && renderer.far.stats.queued === 0 &&
    (!streaming || (s.resident > 0 && s.requested === 0 && s.compressing === 0 && s.holes === 0));
  if (ready || now >= BENCH_READY_TIMEOUT_MS) {
    benchWaitedMs = Math.round(now);
    hud.status(""); // or the waiting line stays up for the whole run
    if (!ready) overlay.error(`bench started before the world settled, after ${(now / 1000).toFixed(0)}s`);
    return true;
  }
  hud.status("building the world before the benchmark");
  return false;
}

// Environment for a finished benchmark run; defined once so record() gets the same
// function every frame instead of a new closure.
function benchContext(): BenchContext {
  const renderer = globalThis.voxler.renderer!;
  const gpu = globalThis.voxler.gpu!;
  return {
    world: world.name,
    streaming: streaming
      ? {
        ...streamer.stats,
        arenaUsedMiB: store.arena.usedBytes / 1048576,
        ...(mesher ? prefixed("mesh.", mesher.stats) : {}),
        ...prefixed("near.", renderer.near.refreshStats()),
        "near.cullFlags": renderer.near.cullFlags,
        "near.clusterQuads": clusterQuads,
        "near.clusterOrder": clusterOrder,
        "near.quadMiB": nearOptions.quadMiB,
      }
      : null,
    caps: gpu.caps,
    readyMs: benchWaitedMs,
    counters: renderer.counters,
    pool,
    width: canvas.width,
    height: canvas.height,
  };
}

function frame(now: number): void {
  if (running) requestAnimationFrame(frame);
  stats.begin(CPU_FRAME);
  const interval = lastTime < 0 ? 0 : now - lastTime;
  if (lastTime >= 0 && interval < MAX_INTERVAL_SAMPLE_MS) stats.frameInterval.push(interval);
  const dt = Math.min(interval / 1000, MAX_FRAME_DT);
  lastTime = now;
  const { gpu, renderer } = globalThis.voxler;

  // A benchmark drives the camera only once there is something to render.
  stats.begin(CPU_UPDATE);
  if (bench) {
    if (renderer && benchReady(renderer, now)) bench.drive(now, camera, renderer.timer);
  } else if (chasing) {
    // The keys that raise and lower the ground flyover raise and lower this too, and a
    // selection that has been cleared or moved to another bird ends or moves the chase.
    controls.update(dt);
    const picked = renderer?.picked ?? -1;
    if (picked < 0) {
      stopChase();
    } else {
      if (picked !== chased) {
        chased = picked;
        renderer!.trackBird(picked);
      }
      const lift = controls.vertical;
      if (lift !== 0) {
        chaseHeight = Math.max(-20, Math.min(120, chaseHeight + lift * controls.speed * dt));
      }
      const bird = renderer?.trackedBird ?? null;
      if (bird !== null) chaseStep(bird, dt);
    }
  } else if (following) {
    // The controls run first and the flight picks up whatever they did, so dragging the
    // view re-aims it and WASD nudges it sideways rather than being fought.
    controls.update(dt);
    // The keys that set the fly speed set the flight's, and the ones that fly up and down
    // raise and lower it. Anything else and the camera would be pulled straight back to
    // the height it was holding, which reads as the keys not working.
    follow.speed = controls.speed;
    const lift = controls.vertical;
    if (lift !== 0) {
      follow.height = raiseHeight(follow.height, lift * controls.speed * (controls.sprinting ? 3 : 1) * dt);
    }
    followState.x = camera.worldPosition(0);
    followState.y = camera.worldPosition(1);
    followState.z = camera.worldPosition(2);
    followState.yaw = camera.yaw;
    probeKey = Number.NaN; // this frame's chunks, not last frame's
    follow.step(followState, dt);
    camera.setPosition(followState.x, followState.y, followState.z);
    camera.setOrientation(followState.yaw, followState.pitch);
  } else {
    controls.update(dt);
  }
  stats.end(CPU_UPDATE);

  if (gpu && renderer) {
    stats.begin(CPU_RENDER);
    if (sizeDirty || sizedRenderer !== renderer) applySize(renderer, gpu);
    renderer.time = now / 1000;
    renderer.render(camera);
    if (streaming) {
      applyBrushEdits();
      farEdits?.pump(FAR_EDIT_JOBS_PER_FRAME);
      if (regenPerFrame > 0) soakRegeneration();
      streamer.update(camera.chunk[0], camera.chunk[1], camera.chunk[2]);
    }
    mesher?.update(camera.chunk[0], camera.chunk[1], camera.chunk[2]);
    renderer.voxelizer.pump(voxelBench ? opts.voxelSlots : VOXEL_BATCHES_PER_FRAME);
    stats.end(CPU_RENDER);
    voxelBench?.update(gpu.caps, opts.voxelSlots);
  }
  // Buffers consumed this frame go back to the workers in one message.
  pool.flushRecycled();
  stats.end(CPU_FRAME);

  if (bench && renderer) {
    const cpu = stats.cpu;
    const done = bench.record(
      interval,
      cpu[CPU_FRAME].latest(),
      cpu[CPU_UPDATE].latest(),
      cpu[CPU_RENDER].latest(),
      streaming ? streamer.stats.holes : 0,
      benchContext,
    );
    if (done) running = false;
  }

  // The on-screen panel keeps its own slow tick, because it is up whether or not the
  // overlay is.
  hud.frame();
  hud.refresh(now);

  // Overlay text is built outside the timed frame, a few times per second, and not
  // at all while the overlay is hidden.
  if (overlay.visible && now >= nextOverlayUpdate) {
    nextOverlayUpdate = now + OVERLAY_INTERVAL_MS;
    overlay.setSection("stats", stats.format(renderer?.timer ?? null, renderer?.counters ?? null, pool));
    overlay.setSection("camera", describeCamera());
    if (renderer) overlay.setSection("voxelizer", describeVoxelizer(renderer, now));
    if (streaming) {
      toolRay(); // keeps the aim line current, and costs one ray a second
      overlay.setSection("edit", describeTool());
      overlay.setSection("streaming", describeStreaming());
    }
    if (mesher) overlay.setSection("meshing", describeMeshing(mesher, now));
    if (renderer) overlay.setSection("near", describeNear(renderer));
    if (renderer?.showFar) overlay.setSection("far", describeFar(renderer));
    if (voxelBench) overlay.setSection("voxel bench", voxelBench.text());
    if (bench) overlay.setSection("bench", bench.status());
  }
}

function scheduleRestart(): void {
  const now = performance.now();
  while (restartTimes.length > 0 && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift();
  if (restartTimes.length >= MAX_RESTARTS_IN_WINDOW) {
    showMessage("The GPU device was lost repeatedly. Reload the page to try again.");
    return;
  }
  restartTimes.push(now);
  setTimeout(start, RESTART_DELAY_MS);
}

async function start(): Promise<void> {
  const gen = ++generation;
  const result = await createGpu(canvas, (m) => overlay.error(m));
  if ("error" in result) {
    showMessage(result.error);
    return;
  }
  const { gpu } = result;

  gpu.device.lost.then((info) => {
    if (gen !== generation) return; // a newer device already replaced this one
    globalThis.voxler.gpu = null;
    globalThis.voxler.renderer = null;
    overlay.error(`device lost (${info.reason})${info.message ? `: ${info.message}` : ""}`);
    scheduleRestart();
  });

  overlay.setSection("caps", formatCaps(gpu.caps));
  if (!gpu.caps.crossOriginIsolated) {
    console.warn("Not cross-origin isolated: SharedArrayBuffer is unavailable; workers use the copy path.");
  }

  const renderer = new Renderer(gpu, (m) => overlay.error(m), world, {
    previewScale: opts.render.previewScale,
    voxelSlots: opts.voxelSlots,
    recycle: (buffer) => pool.recycle(buffer),
    near: nearOptions,
    far: farOptions,
  });
  renderer.showPreview = view.preview;
  renderer.preview.grid = brushGrid;
  renderer.far.brushes = brushGrid;
  farEdits = new FarEdits(store, pool, renderer.far);
  // Which chunks the near field draws, so the far field can leave those to it.
  if (mesher) mesher.onCoverage = (key, covered) => renderer.far.coverage.set(key, covered);
  // Sampling a slab writes what the field says, so an edited chunk it covers is
  // reduced again over the top.
  renderer.far.onSlabBuilt = (level, axis, plane) => farEdits?.slabBuilt(level, axis, plane);
  pool.on(BRICK_JOB, (key, version, output) => farEdits?.onResult(key, version, output as BrickJobOutput));
  renderer.far.beam = farBeam;
  if (farAdapt && !bench) {
    // The ceiling is what the clipmap allocated (`?farLevels=n`), not the controller's
    // own default: asking for more levels than there are buffers would leave the two
    // disagreeing about how far the world reaches.
    renderer.farAdapt = new FarAdapt(renderer.far.levels, farOptions.slabsPerFrame ?? 2, renderer.far.resolutionScale, {
      ...DEFAULT_ADAPT_OPTIONS,
      maxLevels: renderer.far.map.levelCapacity,
      minLevels: Math.min(DEFAULT_ADAPT_OPTIONS.minLevels, renderer.far.map.levelCapacity),
    });
  }
  if (farOn) {
    renderer.showFar = true;
    renderer.far.debug = farMode === "steps" ? 1 : farMode === "bricks" ? 2 : farMode === "levels" ? 3 : 0;
    // Bricks are sampled from the world SDF as the clipmap follows the camera, so
    // nothing has to be resident. F queues every level again.
    if (farCheck) setTimeout(() => runFarCheck(renderer), 20000);
  }
  renderer.showGrid = view.grid;
  renderer.showGizmo = view.gizmo;
  renderer.showMeshes = view.meshes;
  renderer.near.cullFlags = cullFlags;
  renderer.cullCheck = cullCheck;
  if (!(await renderer.init())) return; // errors are in the overlay
  if (gen !== generation) return;
  // The sky is up, so start drawing now. The pipelines that evaluate the world
  // program take seconds to compile for a heavy world, and waiting for them here
  // is a black screen for that whole time. Each pass checks its own readiness, so
  // the frame draws the sky, then the far field, then meshes, as they arrive.
  overlay.setSection("world", `world  ${world.name}  seed ${world.seed}  compiling`);
  globalThis.voxler.gpu = gpu;
  globalThis.voxler.renderer = renderer;
  // Say what is still compiling. A heavy world's pipelines take seconds, and until they
  // land the frame is a sky with nothing under it, which looks like a hang rather than
  // like work. Each stage records itself in `startup` as it finishes, so polling that on
  // the panel's own tick needs nothing from the renderer.
  const compiling = setInterval(() => {
    if (gen !== generation) return;
    const left = WORLD_STAGES.filter((name) => renderer.startup[name] === undefined);
    hud.status(left.length === 0 ? "starting" : `compiling ${left.join(" ")}`);
  }, 200);
  await renderer.worldReady;
  clearInterval(compiling);
  hud.status("");
  if (gen !== generation) return;
  overlay.setSection(
    "world",
    `world  ${world.name}  seed ${world.seed}  preview at ${opts.render.previewScale}x resolution, built on demand (P)\n` +
      `      pipelines ${Object.entries(renderer.startup).map(([k, ms]) => `${k} ${ms.toFixed(0)}`).join("  ")} ms`,
  );
  mesher?.remeshAll(); // a rebuilt renderer starts with no meshes
  if (streaming) attachStreaming(renderer.voxelizer);
  if (app.voxelBench && !voxelBench) {
    // The voxelizer gets the GPU to itself: no preview while measuring.
    view.preview = false;
    renderer.showPreview = false;
    voxelBench = new VoxelBench(renderer.voxelizer, world);
  }
}

function onResize(entries: ResizeObserverEntry[]): void {
  const entry = entries[0];
  const device = entry.devicePixelContentBoxSize?.[0];
  if (device) {
    pixelWidth = device.inlineSize;
    pixelHeight = device.blockSize;
  } else {
    const css = entry.contentBoxSize[0];
    pixelWidth = Math.round(css.inlineSize * devicePixelRatio);
    pixelHeight = Math.round(css.blockSize * devicePixelRatio);
  }
  sizeDirty = true;
}

const resizeObserver = new ResizeObserver(onResize);
try {
  resizeObserver.observe(canvas, { box: "device-pixel-content-box" });
} catch {
  resizeObserver.observe(canvas); // browsers without device-pixel-content-box
}

// A click on the canvas, alongside the camera's own drag handling: the controls capture
// the pointer for looking, which does not stop a second listener on the same element.
canvas.addEventListener("pointerdown", (e) => {
  clickId = e.pointerId;
  clickX = e.clientX;
  clickY = e.clientY;
});
canvas.addEventListener("pointerup", (e) => {
  if (e.pointerId !== clickId) return;
  clickId = -1;
  if (Math.hypot(e.clientX - clickX, e.clientY - clickY) > CLICK_SLOP_PX) return;
  void pickBirdAt(e.clientX, e.clientY);
});
canvas.addEventListener("pointercancel", () => {
  clickId = -1;
});

// The follow-the-ground flyover (src/camera/follow.ts). It reads the chunk store, so it
// follows whatever the near field has streamed; outside that it holds its heading.
const followState: FollowState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
// The flight probes columns of voxels, thousands of them a frame, and two things keep
// that off the frame budget. It reads through `store.blockAtSlot` and never `store.read`,
// which builds five objects a call and at this rate is the GC in the frame path
// (CLAUDE.md "Never allocate in the per-frame path"). And the chunk's slot is held across
// the 32 voxels of a column that share it, so the table is probed once a chunk instead of
// once a voxel, and a uniform chunk answers without touching the arena at all. The voxel
// raycast caches the same way (`src/world/raycast.ts`).
//
// `probeKey` is cleared before every step, so a chunk that has streamed in, been evicted
// or been regenerated since the last frame is never answered out of a stale slot.
let probeKey = Number.NaN;
let probeSlot = -1;
let probeUniform = -1;
const follow = new Follow((x, y, z) => {
  const cx = x >> 5, cy = y >> 5, cz = z >> 5;
  if (!chunkInRange(cx, cy, cz)) return -1;
  const key = chunkKey(cx, cy, cz);
  if (key !== probeKey) {
    probeKey = key;
    probeSlot = store.slotOf(key);
    probeUniform = probeSlot === -1 ? -1 : store.slotUniformId(probeSlot);
  }
  if (probeSlot === -1) return -1;
  return probeUniform >= 0 ? probeUniform : store.blockAtSlot(probeSlot, voxelIndex(x & 31, y & 31, z & 31));
});
let following = false;

// Chasing the bird a click picked out, which is what the follow switch does when there is
// one: trailing it and looking at it, over a position that arrives a few frames late from
// the GPU (`Renderer.trackedBird`). At a bird's speed that lag is half a voxel.
// Far enough back to be behind the *flock*, not inside it: a bird's neighbours sit within
// twenty voxels of it, and a camera closer than that ends up in the middle of them with
// the one it is following a speck beyond.
const CHASE_BACK = 52; // voxels behind it
const CHASE_UP = 14; // and over it, before Space/C move that
const CHASE_POSITION = 0.30; // seconds to close on where the camera should be
const CHASE_AIM = 0.20; // and on where it should look
let chasing = false;
let chased = -1; // the bird the renderer is keeping a copy of
let chaseHeight = CHASE_UP;

function startChase(bird: number): void {
  chasing = true;
  following = false;
  chaseHeight = CHASE_UP;
  chased = bird;
  globalThis.voxler.renderer?.trackBird(bird);
}

function stopChase(): void {
  chasing = false;
  chased = -1;
  globalThis.voxler.renderer?.trackBird(-1);
}

// Eases an angle the short way round, so a heading crossing the back of the compass does
// not take the long way.
function easeAngle(from: number, to: number, amount: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return from + d * amount;
}

// One frame of the chase. The bird's own heading sets where the camera sits, so it trails
// rather than orbiting, and the camera always looks at the bird itself.
function chaseStep(bird: Float32Array, dt: number): void {
  const speed = Math.hypot(bird[4], bird[5], bird[6]);
  const back = speed > 1e-4 ? CHASE_BACK / speed : 0;
  const wantX = bird[0] - bird[4] * back;
  const wantY = bird[1] - bird[5] * back + chaseHeight;
  const wantZ = bird[2] - bird[6] * back;
  const k = ease(dt, CHASE_POSITION);
  const x = camera.worldPosition(0) + (wantX - camera.worldPosition(0)) * k;
  const y = camera.worldPosition(1) + (wantY - camera.worldPosition(1)) * k;
  const z = camera.worldPosition(2) + (wantZ - camera.worldPosition(2)) * k;
  camera.setPosition(x, y, z);
  const dx = bird[0] - x, dy = bird[1] - y, dz = bird[2] - z;
  const flat = Math.hypot(dx, dz);
  const a = ease(dt, CHASE_AIM);
  camera.setOrientation(
    easeAngle(camera.yaw, Math.atan2(-dx, -dz), a),
    camera.pitch + (Math.atan2(dy, flat) - camera.pitch) * a,
  );
}

function toggleFollow(): void {
  if (chasing) {
    stopChase();
    return;
  }
  if (following) {
    following = false;
    return;
  }
  // A picked bird is what the switch follows; without one it follows the ground.
  const bird = globalThis.voxler.renderer?.picked ?? -1;
  if (bird >= 0) {
    startChase(bird);
    return;
  }
  following = true;
  followState.x = camera.worldPosition(0);
  followState.y = camera.worldPosition(1);
  followState.z = camera.worldPosition(2);
  followState.yaw = camera.yaw;
  followState.pitch = camera.pitch;
  probeKey = Number.NaN;
  follow.start(followState);
}

// The switches, shared by the keys and by the on-screen panel so the two can never
// disagree about what a toggle does.
function togglePreview(): void {
  view.preview = !view.preview;
  const renderer = globalThis.voxler.renderer;
  if (renderer) renderer.showPreview = view.preview;
}

function toggleGrid(): void {
  view.grid = !view.grid;
  const renderer = globalThis.voxler.renderer;
  if (renderer) renderer.showGrid = view.grid;
}

function toggleGizmo(): void {
  view.gizmo = !view.gizmo;
  const renderer = globalThis.voxler.renderer;
  if (renderer) renderer.showGizmo = view.gizmo;
}

function toggleMeshes(): void {
  view.meshes = !view.meshes;
  const renderer = globalThis.voxler.renderer;
  if (renderer) renderer.showMeshes = view.meshes;
}

// The far field draws only where it has been built, so this is safe whether or not
// `?far=0` kept it from initialising: `far.ready` still gates the pass.
function toggleFar(): void {
  const renderer = globalThis.voxler.renderer;
  if (renderer) renderer.showFar = !renderer.showFar;
}

// Some switches are compiled into the shaders (the sky's constants are generated into
// every pass that lights a surface, and shadows are a constant in the near field), so
// they cannot be flipped on a running renderer. Reloading is the honest way to offer
// them, and carrying the camera in `?at=` means the world comes back where it was.
function reloadWith(key: string, value: string | null): void {
  const next = new URLSearchParams(location.search);
  if (value === null) next.delete(key);
  else next.set(key, value);
  next.set(
    "at",
    `${camera.worldPosition(0).toFixed(0)},${camera.worldPosition(1).toFixed(0)},${camera.worldPosition(2).toFixed(0)}`,
  );
  location.search = next.toString();
}

// The sky in force, which is the world's own unless `?sky=` overrode it. Read off the
// resolved sky rather than off the query string: the fallbacks already happened there, so
// an unknown `?sky=` cycles from what is actually being drawn.
function currentSky(): string {
  return world.sky.name in SKIES ? world.sky.name : DEFAULT_SKY;
}

function cycleSky(): void {
  const names = Object.keys(SKIES);
  reloadWith("sky", names[(names.indexOf(currentSky()) + 1) % names.length]);
}

globalThis.voxler.controls = controls;
globalThis.voxler.follow = follow;

// Clicking a bird picks it out. A click is a pointer that went down and came up in about
// the same place; anything further is a drag of the view, which is what the canvas is
// mostly for. The flock lives on the GPU, so the pick reads it back and resolves a few
// frames later, by which time the birds have moved about half a voxel.
const CLICK_SLOP_PX = 5;
let clickId = -1;
let clickX = 0;
let clickY = 0;

async function pickBirdAt(clientX: number, clientY: number): Promise<void> {
  const renderer = globalThis.voxler.renderer;
  if (!renderer || renderer.birds === null) return;
  // The cursor as NDC over the canvas as it is displayed, and the aspect from the render
  // target, which is what the projection used. Under `?size=` the element is letterboxed
  // to that same aspect, so the rect would give the same answer; the render target is
  // still the one to ask, because it is the one the ray is being cast through.
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
  camera.rayThrough(ndcX, ndcY, aspect, pickDir);
  const state = await renderer.readBirds();
  if (state === null) return;
  const hit = pickBird(
    state,
    camera.worldPosition(0),
    camera.worldPosition(1),
    camera.worldPosition(2),
    pickDir[0],
    pickDir[1],
    pickDir[2],
    BIRD_PICK_REACH,
  );
  renderer.selectBird(hit);
  pickedText = hit === NO_BIRD ? "" : describeBird(state, hit);
}

// How far a click reaches for a bird, in voxels. Past the flock's own box there is
// nothing to hit (`HOME` in birds-common.wgsl).
const BIRD_PICK_REACH = 320;
const pickDir = new Float64Array(3);
let pickedText = "";

// What the world is holding, for the always-on panel: how much of it is resident, how
// much geometry that came to, and how much of that the GPU kept after culling. Built on
// the panel's own quarter-second tick, never in the frame path.
function amount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

function describeCounts(): string {
  const renderer = globalThis.voxler.renderer;
  if (!renderer) return "";
  const parts: string[] = [];
  if (streaming) {
    const chunks = streamer.stats.resident;
    // A chunk is 32^3, so this is the volume the near field is actually holding, which is
    // the number people mean when they ask how big the world on screen is.
    parts.push(`${amount(chunks)} chunks`, `${amount(chunks * CHUNK_VOLUME)} voxels`);
  }
  if (renderer.showMeshes && renderer.near.ready) {
    const near = renderer.near.refreshStats();
    parts.push(`${amount(near.realQuads)} quads`, `${amount(near.visibleClusters)}/${amount(near.liveClusters)} clusters`);
  }
  if (renderer.showFar && renderer.far.ready) {
    parts.push(`${amount(renderer.far.stats.bricks)} bricks`);
  }
  // The bird a click picked out, if one is. Its own line: it is about one thing and the
  // rest of the row is about all of them.
  const counts = parts.join("  ");
  return pickedText === "" ? counts : `${counts}\n${pickedText}`;
}

const hud = new Hud(document.body, [
  { label: "sky", title: "Day, night or desert. Reloads: the sky is compiled into the shaders", on: () => true, press: cycleSky },
  { label: "far", title: "Far field (the ray-marched distance)", on: () => globalThis.voxler.renderer?.showFar ?? false, press: toggleFar },
  { label: "shadow", title: "Shadows. Reloads: it is a shader constant", on: () => shadows, press: () => reloadWith("shadow", shadows ? "0" : null) },
  { label: "mesh", title: "Near-field meshes (M)", on: () => view.meshes, press: toggleMeshes },
  { label: "sdf", title: "SDF preview (P)", on: () => view.preview, press: togglePreview },
  { label: "grid", title: "Chunk grid (G)", on: () => view.grid, press: toggleGrid },
  { label: "axes", title: "The axis cross in the corner", on: () => view.gizmo, press: toggleGizmo },
  {
    label: "follow",
    title: "Follow the bird a click picked out, or if none, fly along whatever is under the camera (K)",
    on: () => following || chasing,
    press: toggleFollow,
  },
  { label: "stats", title: "Debug overlay (F2)", on: () => overlay.visible, press: () => overlay.toggle() },
] satisfies HudButton[], describeCounts);

addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const renderer = globalThis.voxler.renderer;
  switch (e.code) {
    case "F2": // same label on every keyboard layout, and unbound in Chrome and Firefox
      e.preventDefault();
      overlay.toggle();
      break;
    case "KeyP":
      togglePreview();
      break;
    case "KeyG":
      toggleGrid();
      break;
    case "KeyM":
      toggleMeshes();
      break;
    case "KeyK":
      toggleFollow();
      break;
    case "KeyE":
      if (toolRay()) tool.place(toolHit);
      break;
    case "KeyQ":
      if (toolRay()) tool.remove(toolHit);
      break;
    case "KeyR":
      tool.rotate(e.shiftKey ? -1 : 1);
      break;
    case "KeyB":
      tool.state.blockId = tool.state.blockId % (BLOCKS.length - 1) + 1;
      break;
    case "KeyX":
      tool.nextShape();
      break;
    case "KeyZ":
      tool.undo();
      break;
    case "KeyY":
      tool.redo();
      break;
    case "KeyF":
      renderer?.far.rebuild();
      break;
  }
});

// `?farCheck`: the phase 2 verification, on the clipmap's finest level. Reads the
// SDF-sampled bricks back and compares them with the same window reduced from the
// chunk data, over the bricks whose chunk is resident. The two rules differ by
// construction (the GPU takes the sign at the cell centre, the CPU calls a cell solid
// when any voxel in it is), so this measures the difference rather than asserting
// equality: cells present in one and not the other should be a thin shell at the
// surface, and colors should agree where both call a cell solid.
async function runFarCheck(renderer: Renderer): Promise<void> {
  const far = renderer.far;
  const map = far.map;
  const level = 0;
  const k = map.levelK(level);
  if (!tilesChunk(k)) {
    overlay.setSection("far check", `far check  level ${k} bricks span more than a chunk; nothing to compare`);
    return;
  }
  while (map.queued > 0) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 500)); // let the last reports land
  const { indirection, bricks } = await far.readBack();
  const size = map.options.size;
  const per = bricksPerChunkSide(k); // bricks per chunk side
  const cpu = new BrickGrid({ level: k, size });
  cpu.origin.set(map.origins.subarray(0, 3));
  let compared = 0, both = 0, gpuOnly = 0, cpuOnly = 0, colors = 0, skipped = 0;
  for (let bz = 0; bz < size; bz++) {
    for (let by = 0; by < size; by++) {
      for (let bx = 0; bx < size; bx++) {
        const b = [map.origins[0] + bx, map.origins[1] + by, map.origins[2] + bz];
        const chunk = b.map((v) => Math.floor(v / per));
        if (store.slotOf(chunkKey(chunk[0], chunk[1], chunk[2])) === -1) {
          skipped++;
          continue; // not resident: the GPU knows terrain the CPU cannot see
        }
        const gpuEntry = indirection[map.cellOf(level, b[0], b[1], b[2])];
        const cpuSlot = cpu.buildBrick(store, b[0], b[1], b[2]);
        const cpuEntry = cpu.indirection[cpuSlot];
        compared++;
        for (let i = 0; i < BRICK_CELLS ** 3; i++) {
          const g = gpuEntry === 0 ? false : (bricks[(gpuEntry - 1) * BRICK_WORDS + (i >>> 5)] & (1 << (i & 31))) !== 0;
          const c = cpuEntry === 0 ? false : (cpu.bricks[(cpuEntry - 1) * BRICK_WORDS + (i >>> 5)] & (1 << (i & 31))) !== 0;
          if (g && c) {
            both++;
            const gi = (bricks[(gpuEntry - 1) * BRICK_WORDS + 16 + (i >>> 2)] >>> ((i & 3) * 8)) & 0xFF;
            const ci = (cpu.bricks[(cpuEntry - 1) * BRICK_WORDS + 16 + (i >>> 2)] >>> ((i & 3) * 8)) & 0xFF;
            if (gi !== ci) colors++;
          } else if (g) gpuOnly++;
          else if (c) cpuOnly++;
        }
      }
    }
  }
  const cells = compared * BRICK_CELLS ** 3;
  const pct = (n: number) => `${((n / Math.max(1, both + gpuOnly + cpuOnly)) * 100).toFixed(2)}%`;
  const text = `far check  level ${k}: ${compared} bricks compared, ${skipped} not resident\n` +
    `           cells ${cells}: both ${both} (${pct(both)})  sdf only ${gpuOnly} (${pct(gpuOnly)})  ` +
    `chunks only ${cpuOnly} (${pct(cpuOnly)})\n` +
    `           color differs on ${colors} of ${both} shared cells`;
  overlay.setSection("far check", text);
  console.log(text);
}

// `?workerTest` runs the pool self-test and shows the results in the overlay.
async function workerTest(): Promise<void> {
  overlay.setSection("worker test", `worker self-test running on ${pool.size} workers...`);
  const results = await runWorkerSelfTest(pool);
  const lines = results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`);
  overlay.setSection("worker test", `worker self-test (${pool.size} workers)\n${lines.join("\n")}`);
  for (const line of lines) console.info(line);
  if (results.some((r) => !r.ok)) overlay.error("worker self-test failed; see the worker test section");
}

placeCamera();
overlay.setSection("controls", CONTROLS_HELP);
requestAnimationFrame(frame);
start();
if (app.workerTest) workerTest();
