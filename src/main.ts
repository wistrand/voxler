// Browser entry point: GPU startup, device-loss recovery, canvas sizing, and the
// frame loop (update, then render).

import { SCENES } from "./bench/scenes.ts";
import { type BenchContext, BenchSession } from "./bench/session.ts";
import { VoxelBench } from "./bench/voxel-bench.ts";
import { FlyCamera } from "./camera/camera.ts";
import { FlyControls } from "./camera/controls.ts";
import { Follow, type FollowState, raiseHeight } from "./camera/follow.ts";
import { Hud, type HudButton } from "./debug/hud.ts";
import { Overlay } from "./debug/overlay.ts";
import { CPU_FRAME, CPU_RENDER, CPU_UPDATE, Stats } from "./debug/stats.ts";
import { formatCaps } from "./gpu/caps.ts";
import { createGpu, type Gpu } from "./gpu/device.ts";
import { Renderer } from "./render/renderer.ts";
import { DEFAULT_JOBS_PER_MESSAGE, WorkerPool } from "./workers/pool.ts";
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
import { DEFAULT_CLIPMAP_OPTIONS, levelsForReach, MAX_LEVELS } from "./far/clipmap.ts";
import { DEFAULT_FAR_SCALE } from "./far/far-field.ts";
import { BRICK_JOB, FarEdits } from "./far/edits.ts";
import { DEFAULT_ADAPT_OPTIONS, FarAdapt } from "./far/adapt.ts";
import type { BrickJobOutput } from "./far/brick-job.ts";
import { canShareMemory } from "./workers/buffers.ts";
import { BLOCKS } from "./world/blocks.ts";
import { voxelIndex } from "./world/coords.ts";
import { ChunkStore } from "./world/store.ts";
import { chunkKey, keyX, keyY, keyZ } from "./world/keys.ts";
import { DEFAULT_MESH_OPTIONS, MESH_JOB, MeshScheduler } from "./world/mesh-scheduler.ts";
import { CLUSTER_QUADS, ORDER_EMISSION, ORDER_MORTON } from "./mesh/cluster.ts";
import { CULL_ALL, DEFAULT_NEAR_OPTIONS, type NearFieldOptions } from "./render/near-field.ts";
import type { MeshJobOutput } from "./mesh/job.ts";
import { ChunkStreamer, DEFAULT_STREAM_OPTIONS, type StreamOptions } from "./world/streaming.ts";
import type { Voxelizer } from "./sdf/voxelizer.ts";
import { runWorkerSelfTest } from "./workers/selftest.ts";
import { DEFAULT_WORLD, type WorldProgram, WORLDS } from "./worlds/index.ts";
import { DEFAULT_SKY, fogHorizonVoxels, SKIES } from "./render/sky.ts";

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
  "F2 overlay  P preview  G grid  M meshes  (overlay text is selectable)\n" +
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
  "?farLevels=n ?farSize=n ?farFirst=k ?farBricks=n ?farSlabs=n ?farBeam=0  ?farAdapt=0  ?farCheck\n" +
  `?bench=${Object.keys(SCENES).join("|")}&runs=n benchmark`;

const params = new URLSearchParams(location.search);

// View toggles, kept here so they survive a Renderer rebuild after device loss.
// `?preview=0` starts with the SDF preview off (P toggles it), e.g. to benchmark
// streaming without the preview's GPU cost.
// The preview starts off when streamed meshes are drawn (they show the same world);
// `?preview=1` forces it on. `?cull=n` is a cull mask (0 none, 3 no occlusion, 7
// all); `?cullCheck` compares the frame against an unculled draw every 30 frames.
const meshesByDefault = params.get("stream") !== "0" && params.get("mesh") !== "0" && !params.has("voxelBench");
// The init stages that stand between a sky and a world, in the order they are waited on
// (`Renderer.init`). Named here so the panel can say which are outstanding.
const WORLD_STAGES = ["voxelize", "near", "far"] as const;

const view = {
  preview: params.get("preview") === "1" || (params.get("preview") !== "0" && !meshesByDefault),
  grid: false,
  meshes: true,
};
// `?cull=n` is a mask: 1 frustum, 2 face direction, 4 occlusion (so 0 none, 3 no
// occlusion, 7 all). Anything unparsable keeps the default.
const cullFlags = params.has("cull") ? intParam("cull", CULL_ALL, 0, CULL_ALL) : CULL_ALL;
const cullCheck = params.has("cullCheck");

// `?previewScale=0.25..1` sets the SDF preview's resolution relative to the canvas.
// Sphere tracing is per pixel, so half resolution costs about a quarter.
const DEFAULT_PREVIEW_SCALE = 0.5;
function previewScale(): number {
  const s = Number(params.get("previewScale"));
  return Number.isFinite(s) && s > 0 ? Math.min(1, Math.max(0.1, s)) : DEFAULT_PREVIEW_SCALE;
}

// `?stream=0` disables chunk streaming; `?streamRadius=n` and `?streamHeight=n` set
// the load range in chunks; `?arenaMB=n` sizes the chunk payload arena.
const DEFAULT_ARENA_MB = 128;
function intParam(name: string, fallback: number, min: number, max: number): number {
  const n = Number(params.get(name));
  return params.has(name) && Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function numberParam(name: string, fallback: number, min: number, max: number): number {
  const n = Number(params.get(name));
  return params.has(name) && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function streamOptions(): StreamOptions {
  return {
    ...DEFAULT_STREAM_OPTIONS,
    radius: intParam("streamRadius", DEFAULT_STREAM_OPTIONS.radius, 1, 64),
    height: intParam("streamHeight", DEFAULT_STREAM_OPTIONS.height, 1, 32),
  };
}

// `?voxelSlots=n` sets the voxelizer's readback slots (batches in flight).
function voxelSlots(): number {
  const n = Number(params.get("voxelSlots"));
  return Number.isInteger(n) && n > 0 ? Math.min(16, n) : DEFAULT_VOXEL_SLOTS;
}

// `?world=<name>&seed=<n>` picks the world program; unknown names fall back to the
// default with an overlay error.
function selectWorld(): WorldProgram {
  let name = params.get("world") ?? DEFAULT_WORLD;
  if (!(name in WORLDS)) {
    overlay.error(`unknown world "${name}"; known: ${Object.keys(WORLDS).join(", ")}`);
    name = DEFAULT_WORLD;
  }
  const seed = Number(params.get("seed") ?? 1);
  const entry = WORLDS[name];
  // `?sky=<name>` overrides the world's own preset, so a world can be seen at another
  // time of day without editing it.
  const skyName = params.get("sky") ?? entry.sky ?? DEFAULT_SKY;
  const sky = SKIES[skyName] ?? SKIES[DEFAULT_SKY];
  if (!(skyName in SKIES)) overlay.error(`unknown sky "${skyName}"; known: ${Object.keys(SKIES).join(", ")}`);
  return {
    name,
    code: entry.code,
    seed: Number.isInteger(seed) ? seed >>> 0 : 1,
    spawn: entry.spawn,
    sky,
    far: entry.far,
  };
}

// `?size=1920x1080` renders at a fixed pixel size (stretched to the window).
// Benchmarks default to 1080p so results compare across window sizes.
function fixedSize(): [number, number] | null {
  const m = params.get("size")?.match(/^(\d+)x(\d+)$/);
  if (m) return [Number(m[1]), Number(m[2])];
  return params.has("bench") ? BENCH_DEFAULT_SIZE : null;
}

// `?bench=<scene>&runs=<n>` starts a benchmark session instead of the fly controls.
function benchSession(): BenchSession | null {
  const name = params.get("bench");
  if (name === null) return null;
  const scene = SCENES[name];
  if (!scene) {
    overlay.error(`unknown bench scene "${name}"; known: ${Object.keys(SCENES).join(", ")}`);
    return null;
  }
  const runs = Math.min(MAX_BENCH_RUNS, Math.max(1, Math.floor(Number(params.get("runs")) || 1)));
  // The overlay starts hidden, and a bench run's progress is the one thing worth showing.
  overlay.show();
  return new BenchSession(scene, runs, world.spawn, () => overlay.setSection("bench", bench?.status() ?? ""));
}

// `?workers=n` overrides the default of one worker per core, minus one for the
// main thread.
function workerCount(): number {
  const requested = Number(params.get("workers"));
  if (Number.isInteger(requested) && requested > 0) return requested;
  return Math.max(1, (navigator.hardwareConcurrency || 2) - 1);
}

const canvas = document.getElementById("view") as HTMLCanvasElement;
const overlay = new Overlay(document.body);
const camera = new FlyCamera();
const controls = new FlyControls(canvas, camera);
const stats = new Stats();
// Worker URL is the built output path next to main.js (build.ts workerEntries()).
const pool = new WorkerPool(
  (i) => new Worker(new URL("./workers/voxel.worker.js", import.meta.url), { type: "module", name: `voxel-${i}` }),
  workerCount(),
  intParam("jobBatch", DEFAULT_JOBS_PER_MESSAGE, 1, 64),
);
pool.onError = (kind, key, message) => overlay.error(`job ${kind} ${key} failed: ${message}`);
globalThis.voxler = { gpu: null, renderer: null, camera, pool };
// Order matters: benchSession() reads world.spawn. Module-level consts are bundled
// as vars, so a use before this line sees undefined rather than a TDZ error.
const world = selectWorld();
const renderSize = fixedSize();
const bench = benchSession();
let voxelBench: VoxelBench | null = null;

// Chunk store and streaming are CPU state: they survive device loss, and attach to
// each new voxelizer. Off for ?voxelBench (it owns the voxelizer) and ?stream=0.
const streaming = params.get("stream") !== "0" && !params.has("voxelBench");
const streamOpts = streamOptions();
const store = new ChunkStore({
  maxChunks: Math.ceil(ChunkStreamer.keepCapacity(streamOpts) * 1.25),
  arenaBytes: intParam("arenaMB", DEFAULT_ARENA_MB, 16, 2048) * 1048576,
  shared: canShareMemory(),
});
const streamer = new ChunkStreamer(store, streamOpts);
// `?regen=n` regenerates n random resident chunks a frame, the soak test for the
// regeneration path (plan-world-modelling phase 2); `?regenCheck` compares every
// replaced chunk against the one it replaced and counts differences.
const regenPerFrame = intParam("regen", 0, 0, 1024);
streamer.checkRegen = params.has("regenCheck");
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
const meshing = streaming && params.get("mesh") !== "0";
// Constructed only when used: it turns on deferred frees in the store.
// `?clusterQuads=n` sets the cluster size for this session (plan-rendering phase 1);
// `?nearMB=n` the near-field quad arena budget (plan-rendering phase 2).
const clusterQuads = intParam("clusterQuads", CLUSTER_QUADS, 1, 255);
// `?clusterOrder=morton` sorts a cluster's quads by Morton code instead of mesher
// order; the two are compared by cull rate (plan-rendering phase 4).
const clusterOrder = params.get("clusterOrder") === "morton" ? ORDER_MORTON : ORDER_EMISSION;
// `?ao=0` meshes without baked AO (flat lighting), the A/B for plan-rendering
// phase 5. Off, a mesh job reads 6 neighbors instead of 26.
const bakedAo = params.get("ao") !== "0";
// `?tex=0` draws flat block colors instead of sampling the block textures.
const textured = params.get("tex") !== "0";
// `?glow=0` drops each block's emission, the A/B for plan-living-world phase 1.
const emissive = params.get("glow") !== "0";
// `?wind=0` holds the foliage still, the A/B for phase 2.
const animated = params.get("wind") !== "0";
// Block light is baked in the mesh job as well as read in the shader, so ?light=0 turns
// off both: the A/B is what the fill costs, not only what it looks like.
const blockLight = params.get("light") !== "0";
// Shadow rays march the far field's clipmap, so they need it built: `?far=0` leaves the
// scene unshadowed whatever this says.
const shadows = params.get("shadow") !== "0";
// `?farCheck` compares the SDF-sampled bricks against the same region reduced from
// resident chunk data (plan-far-field phase 2). `?farLevels=n` sets the clipmap's
// level count, `?farBricks=n` the pool capacity in bricks, and `?farSlabs=n` how many
// brick slabs are sampled per frame (phase 3).
const farCheck = params.has("farCheck");
// A world may widen or shorten the clipmap for itself (`far` in src/worlds/index.ts);
// the switches below still win over what it asked for.
const farDefaults = { ...DEFAULT_CLIPMAP_OPTIONS, ...world.far };
// `?farSize=n` sets the bricks per side of every level, which is the reach of each
// level at its own cell size: doubling it halves the cell size at a given distance.
// Powers of two only; the clipmap rejects anything else.
const farSize = intParam("farSize", farDefaults.size, 8, 128);
const farFirst = intParam("farFirst", farDefaults.firstLevel, 1, 6);
// Levels past the world's fog horizon march for nothing: what they find is mixed to the
// sky colour the sky pass already drew. So the default level count is trimmed to the
// horizon rather than taken as written. `?farLevels=n` overrides it outright, because a
// measurement wants the setting it asked for.
const farLevels = params.has("farLevels")
  ? intParam("farLevels", farDefaults.levels, 1, MAX_LEVELS)
  : Math.min(
    farDefaults.levels,
    levelsForReach(farSize, farFirst, fogHorizonVoxels(world.sky), MAX_LEVELS),
  );
const farOptions = {
  clipmap: {
    ...farDefaults,
    size: farSize,
    levels: farLevels,
    firstLevel: farFirst,
    bricks: intParam("farBricks", farDefaults.bricks, 4096, 1 << 20),
  },
  slabsPerFrame: intParam("farSlabs", 2, 1, 16),
  scale: numberParam("farScale", DEFAULT_FAR_SCALE, 0.1, 1),
};
// `?farBeam=0` turns the beam pre-pass off (plan-far-field phase 5).
const farBeam = params.get("farBeam") !== "0";
// The far field's reach and build budget can follow what they cost on this machine
// (src/far/adapt.ts), but only when asked: `?farAdapt=1`.
//
// Off by default because what it moves is visible. Dropping a clipmap level shortens the
// world and rebuilds the level, and changing the march resolution rebuilds the target;
// both land as a pop in the middle of the frame, with nothing the viewer did to cause
// them. A controller that changes the picture while the camera is still has to be
// imperceptible before it can be the default, and this one is not yet: over a minute
// standing in one place it walked terrain from eight levels to five.
const farAdapt = params.get("farAdapt") === "1";
// The far field is on unless `?far=0` says otherwise; `?far=steps|bricks|levels` picks
// a debug view (plan-far-field)
// and picks its debug view. F rebuilds its bricks around the camera.
const farMode = params.get("far") ?? "on";
const farOn = farMode !== "0" && farMode !== "off";
const nearOptions: NearFieldOptions = {
  quadMiB: intParam("nearMB", DEFAULT_NEAR_OPTIONS.quadMiB, 8, 2048),
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
// otherwise it starts at the world's spawn point.
function placeCamera(): void {
  const at = params.get("at")?.split(",").map(Number);
  if (at && at.length === 3 && at.every(Number.isFinite)) {
    camera.setPosition(at[0], at[1], at[2]);
  } else {
    camera.setPosition(world.spawn[0], world.spawn[1], world.spawn[2]);
  }
  camera.setOrientation(0, START_PITCH);
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
  renderer.resize(width, height);
  sizeDirty = false;
  sizedRenderer = renderer;
}

function prefixed(prefix: string, stats: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) out[prefix + k] = v as number;
  return out;
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
    if (renderer) bench.drive(now, camera, renderer.timer);
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
    renderer.voxelizer.pump(voxelBench ? voxelSlots() : VOXEL_BATCHES_PER_FRAME);
    stats.end(CPU_RENDER);
    voxelBench?.update(gpu.caps, voxelSlots());
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
    previewScale: previewScale(),
    voxelSlots: voxelSlots(),
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
    `world  ${world.name}  seed ${world.seed}  preview at ${previewScale()}x resolution, built on demand (P)\n` +
      `      pipelines ${Object.entries(renderer.startup).map(([k, ms]) => `${k} ${ms.toFixed(0)}`).join("  ")} ms`,
  );
  mesher?.remeshAll(); // a rebuilt renderer starts with no meshes
  if (streaming) attachStreaming(renderer.voxelizer);
  if (params.has("voxelBench") && !voxelBench) {
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

// The follow-the-ground flyover (src/camera/follow.ts). It reads the chunk store, so it
// follows whatever the near field has streamed; outside that it holds its heading.
const followState: FollowState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
const follow = new Follow((x, y, z) => {
  const handle = store.handle(x >> 5, y >> 5, z >> 5);
  if (handle < 0) return -1;
  const chunk = store.read(handle);
  if (chunk === null) return -1;
  return chunk.get(voxelIndex(x & 31, y & 31, z & 31));
});
let following = false;

function toggleFollow(): void {
  following = !following;
  if (!following) return;
  followState.x = camera.worldPosition(0);
  followState.y = camera.worldPosition(1);
  followState.z = camera.worldPosition(2);
  followState.yaw = camera.yaw;
  followState.pitch = camera.pitch;
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

function currentSky(): string {
  const name = params.get("sky") ?? world.sky.name;
  return name in SKIES ? name : DEFAULT_SKY;
}

function cycleSky(): void {
  const names = Object.keys(SKIES);
  reloadWith("sky", names[(names.indexOf(currentSky()) + 1) % names.length]);
}

globalThis.voxler.controls = controls;
globalThis.voxler.follow = follow;

const hud = new Hud(document.body, [
  { label: "sky", title: "Day, night or desert. Reloads: the sky is compiled into the shaders", on: () => true, press: cycleSky },
  { label: "far", title: "Far field (the ray-marched distance)", on: () => globalThis.voxler.renderer?.showFar ?? false, press: toggleFar },
  { label: "shadow", title: "Shadows. Reloads: it is a shader constant", on: () => shadows, press: () => reloadWith("shadow", shadows ? "0" : null) },
  { label: "mesh", title: "Near-field meshes (M)", on: () => view.meshes, press: toggleMeshes },
  { label: "sdf", title: "SDF preview (P)", on: () => view.preview, press: togglePreview },
  { label: "grid", title: "Chunk grid (G)", on: () => view.grid, press: toggleGrid },
  { label: "follow", title: "Fly along whatever is under the camera, a stream for instance (K)", on: () => following, press: toggleFollow },
  { label: "stats", title: "Debug overlay (F2)", on: () => overlay.visible, press: () => overlay.toggle() },
] satisfies HudButton[]);

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
if (params.has("workerTest")) workerTest();
