// The engine as one object.
//
// Everything here was `src/main.ts` a moment ago, and moving it was not a tidy-up: the
// demo page *was* the composition, so there was no way to run the engine anywhere else, no
// way to run two of them, and no way to take one down. What this class owns is what a host
// should never have to assemble by hand, in the order it has to be assembled in:
//
//   device -> renderer -> chunk store -> streaming -> meshing -> far-field edits
//
// and the two things that are easy to get wrong and invisible when you do: the frame
// order (render before streaming, so the frame draws what is already there rather than
// waiting), and device loss, which throws every GPU object away and has to build a second
// engine under a camera that keeps its place.
//
// What it deliberately does not own is anything a host would want to be different: input,
// the debug overlay, the on-screen panel, the benchmark harness, bird picking, the chase
// camera. Those are the demo's, and they live in `src/main.ts`. The seam between the two
// is four callbacks, documented below.
//
// See [plan-packaging.md](../agent_docs/plan-packaging.md).

import { FlyCamera } from "./camera/camera.ts";
import { FlyControls } from "./camera/controls.ts";
import { BrushBatch } from "./brush/batch.ts";
import { BrushGrid } from "./brush/grid.ts";
import { csgOne } from "./brush/build.ts";
import { BLEND_UNION, BRUSH_CSG, PRIM_SPHERE } from "./brush/format.ts";
import { BrushStore } from "./brush/store.ts";
import { EditTool } from "./brush/tool.ts";
import { fillBox, fillSphere, hasChunkOps, packChunkOps, setVoxel } from "./brush/voxel-ops.ts";
import { CPU_FRAME, CPU_RENDER, CPU_UPDATE, Stats } from "./debug/stats.ts";
import { DEFAULT_ADAPT_OPTIONS, FarAdapt } from "./far/adapt.ts";
import type { BrickJobOutput } from "./far/brick-job.ts";
import { BRICK_JOB, FarEdits } from "./far/edits.ts";
import { createGpu, type Gpu } from "./gpu/device.ts";
import { resolveOptions, type ResolvedOptions, type VoxlerOptions } from "./options.ts";
import { Renderer } from "./render/renderer.ts";
import type { Voxelizer } from "./sdf/voxelizer.ts";
import type { CompressInput, CompressOutput } from "./workers/jobs.ts";
import { WorkerPool } from "./workers/pool.ts";
import { canShareMemory } from "./workers/buffers.ts";
import { keyX, keyY, keyZ } from "./world/keys.ts";
import { MESH_JOB, MeshScheduler } from "./world/mesh-scheduler.ts";
import { ChunkStore } from "./world/store.ts";
import { ChunkStreamer } from "./world/streaming.ts";
import type { MeshJobOutput } from "./mesh/job.ts";
import type { WorldProgram } from "./worlds/index.ts";

// Longer gaps (a hidden tab, a debugger) are pauses and not frames: kept out of the stats
// window, and clamped before they reach the camera so it does not jump on the way back.
const MAX_FRAME_DT = 0.1;
const MAX_INTERVAL_SAMPLE_MS = 1000;
const VOXEL_BATCHES_PER_FRAME = 2;
const FAR_EDIT_JOBS_PER_FRAME = 2;
// A lost device is usually a driver reset and comes back; a device lost three times in
// thirty seconds is not coming back, and retrying forever hides that from the user.
const RESTART_DELAY_MS = 250;
const RESTART_WINDOW_MS = 30_000;
const MAX_RESTARTS_IN_WINDOW = 3;
// The init stages that stand between a sky and a world, in the order `Renderer.init`
// waits on them, so a host can say which are outstanding.
export const WORLD_STAGES = ["voxelize", "near", "far"] as const;

export interface VoxlerHooks {
  // Something went wrong and the engine kept going: a shader that would not compile, a
  // job that failed, a device that was lost and is being replaced.
  onError?: (message: string) => void;
  // Something went wrong and the engine did not keep going: no WebGPU, no adapter, a
  // device lost so often that retrying is pointless. There is nothing to render after
  // this; show the text.
  onUnsupported?: (message: string) => void;
  // Which of `WORLD_STAGES` are still compiling, on a slow tick, and `[]` once the world
  // is up. A heavy world takes seconds and the frame until then is a sky with nothing
  // under it, which reads as a hang rather than as work.
  onCompiling?: (outstanding: readonly string[]) => void;
  // A renderer exists and its world is up. Called again after a device loss, with the new
  // one, which is why a host must not cache the renderer anywhere else.
  onReady?: (renderer: Renderer, gpu: Gpu) => void;
  // Move the camera. Called once a frame inside the CPU_UPDATE timer, before anything is
  // drawn. Unset means the fly controls drive it, which is what a host that passed
  // `controls: true` wants.
  update?: (dt: number, now: number) => void;
  // The frame is over and the stats are closed. For a host that draws its own overlay.
  afterFrame?: (now: number, interval: number) => void;
}

export class Voxler {
  readonly canvas: HTMLCanvasElement;
  readonly options: ResolvedOptions;
  readonly world: WorldProgram;
  readonly camera = new FlyCamera();
  readonly stats = new Stats();
  readonly pool: WorkerPool;
  readonly store: ChunkStore;
  readonly streamer: ChunkStreamer;
  readonly brushes = new BrushStore();
  readonly tool: EditTool;
  readonly controls: FlyControls | null;
  mesher: MeshScheduler | null = null;
  gpu: Gpu | null = null;
  renderer: Renderer | null = null;
  hooks: VoxlerHooks = {};
  // Chunks regenerated per frame for their own sake: a soak test for the regeneration
  // path, and not the streamer's budget for the chunks an edit has actually changed.
  regenSoakPerFrame = 0;

  private readonly fieldBrushes: BrushBatch;
  private readonly brushGrid: BrushGrid;
  private farEdits: FarEdits | null = null;
  private brushDirty = new Float64Array(256);
  private compressVersion = 0;
  // A device loss replaces every GPU object, and the handlers of the old one are still
  // pending. Each attempt takes a number and anything from an older one drops.
  private generation = 0;
  private readonly restartTimes: number[] = [];
  private restartTimer = 0;
  private frameHandle = 0;
  private running = false;
  private disposed = false;
  private lastTime = -1;
  private compiling = 0;
  private pixelWidth = 1;
  private pixelHeight = 1;
  private sizeDirty = true;
  private sizedRenderer: Renderer | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Use `Voxler.create()`, which builds the device too. This only assembles the CPU side,
  // which is the part that survives device loss.
  constructor(canvas: HTMLCanvasElement, options: VoxlerOptions) {
    this.canvas = canvas;
    const o = this.options = resolveOptions(options);

    this.world = {
      name: "world",
      code: o.world.code,
      seed: o.world.seed,
      spawn: o.world.spawn,
      start: o.world.start,
      look: o.world.look,
      sky: o.world.sky,
      birds: o.world.birds,
    };

    this.camera.setPosition(o.camera.at[0], o.camera.at[1], o.camera.at[2]);
    this.camera.setOrientation(o.camera.yaw, o.camera.pitch);
    this.controls = o.controls ? new FlyControls(canvas, this.camera) : null;

    this.pool = new WorkerPool(o.workers.factory ?? defaultWorkerFactory, o.workers.count, o.workers.jobsPerMessage);
    this.pool.onError = (kind, key, message) => this.error(`job ${kind} ${key} failed: ${message}`);

    // The chunk store and streaming are CPU state: they survive a device loss and attach
    // to whatever voxelizer comes back.
    this.store = new ChunkStore({
      maxChunks: Math.ceil(ChunkStreamer.keepCapacity(o.stream) * 1.25),
      arenaBytes: o.arenaBytes,
      shared: canShareMemory(),
    });
    this.streamer = new ChunkStreamer(this.store, o.stream);

    this.fieldBrushes = new BrushBatch(this.brushes);
    this.brushGrid = new BrushGrid(this.brushes);
    this.tool = new EditTool(this.brushes);

    if (o.meshing) this.mesher = new MeshScheduler(this.store, this.pool, o.mesh);

    // The chain from a voxelized chunk to something on screen, and every link of it is a
    // callback rather than a call: the store does not know about meshing, the mesher does
    // not know about the renderer, and the renderer is replaced wholesale on device loss.
    // Leave one out and the failure is silence. Omitting the compress handler below leaves
    // the chunk store permanently empty, and the frame still draws, because the far field
    // samples the world directly and needs no chunks at all.
    this.pool.on("chunk.compress", (key, _version, output) => {
      const out = output as CompressOutput;
      this.streamer.onCompressed(key, out.uniform, out.block, out.bytes);
      if (out.block) this.pool.recycle(out.block);
      if (out.ids) this.renderer?.voxelizer.recycle(new Uint16Array(out.ids));
    });

    // Meshes go to whichever renderer is current; a new one asks for all of them again
    // (`remeshAll` after init).
    if (this.mesher) {
      this.mesher.onMesh = (key, output) => this.renderer?.near.add(key, output) ?? false;
      this.mesher.onUnmesh = (key) => this.renderer?.near.remove(key);
      this.pool.on(MESH_JOB, (key, version, output) => this.mesher?.onResult(key, version, output as MeshJobOutput));
      this.pool.onSettled(MESH_JOB, (key, version, outcome) => this.mesher?.onSettled(key, version, outcome));
    }

    // What a stored chunk sets off: meshing, and far-field bricks for the chunks an edit
    // has changed. An unedited chunk follows the world function, and the far field samples
    // that on the GPU instead.
    this.streamer.listener = {
      stored: (key: number, urgent: boolean) => {
        this.mesher?.stored(key, urgent);
        if (this.farEdits !== null && hasChunkOps(this.brushes, key)) this.farEdits.markDirty(key);
      },
      evicted: (key: number) => this.mesher?.evicted(key),
    };

    // The second half of a chunk: the field stage comes off the GPU, and this replays the
    // voxel edits over it. Without it a voxel brush is recorded and never applied.
    this.streamer.voxelStage = {
      opsFor: (key) => packChunkOps(this.brushes, key),
      has: (key) => hasChunkOps(this.brushes, key),
    };

    if (o.autoResize) {
      this.resizeObserver = new ResizeObserver((entries) => this.onResize(entries));
      try {
        this.resizeObserver.observe(canvas, { box: "device-pixel-content-box" });
      } catch {
        this.resizeObserver.observe(canvas); // browsers without device-pixel-content-box
      }
    }
  }

  // Throws if the engine could not be built: no WebGPU, no adapter, or a world that would
  // not compile. The detail has already gone to `onError`, and the throw is so a caller
  // handing in a world someone just typed does not get back an object that will never draw
  // anything. `dispose()` has already run on the way out, so nothing is left holding a
  // device or a worker.
  static async create(canvas: HTMLCanvasElement, options: VoxlerOptions, hooks: VoxlerHooks = {}): Promise<Voxler> {
    const voxler = new Voxler(canvas, options);
    voxler.hooks = hooks;
    let failure: string | null = null;
    const onError = hooks.onError;
    voxler.hooks = {
      ...hooks,
      onError: (message) => {
        failure ??= message; // the first one is the cause; the rest are usually its wake
        onError?.(message);
      },
    };
    // The constructor has already spawned the worker pool, and `init()` may have built a
    // device before whatever went wrong went wrong. Both paths out of here have to give
    // those back: a `false` return and a throw leak exactly the same things.
    let ok = false;
    try {
      ok = await voxler.init();
    } catch (err) {
      voxler.hooks = hooks;
      voxler.dispose();
      throw err;
    }
    voxler.hooks = hooks;
    if (!ok) {
      voxler.dispose();
      throw new Error(failure ?? "voxler could not start");
    }
    return voxler;
  }

  // Voxel edits, and the one field brush worth reaching for. The ids come back so they can
  // be undone with `brushes.remove(id)`.
  get edit() {
    return {
      setVoxel: (x: number, y: number, z: number, id: number) => setVoxel(this.brushes, x, y, z, id),
      fillBox: (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number) =>
        fillBox(this.brushes, x0, y0, z0, x1, y1, z1, id),
      fillSphere: (x: number, y: number, z: number, r: number, id: number) =>
        fillSphere(this.brushes, x, y, z, r, id),
      csgSphere: (x: number, y: number, z: number, r: number, id = 1, blend = BLEND_UNION, k = 0) =>
        this.brushes.add({
          kind: BRUSH_CSG,
          cell: [x, y, z],
          blend,
          blendK: k,
          material: id,
          ops: csgOne(PRIM_SPHERE, [r]),
        }),
    };
  }

  // Owns the loop. A host with a loop of its own calls `frame(now)` instead and never
  // touches this.
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTime = -1;
    const tick = (now: number) => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(tick);
      this.frame(now);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle !== 0) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
  }

  // One frame. The order is deliberate: the camera moves, then the frame is drawn from
  // what is already resident, and only then does streaming go looking for more. Drawing
  // last would spend the frame waiting for work that is not on screen yet.
  frame(now: number): void {
    if (this.disposed) return;
    this.stats.begin(CPU_FRAME);
    const interval = this.lastTime < 0 ? 0 : now - this.lastTime;
    if (this.lastTime >= 0 && interval < MAX_INTERVAL_SAMPLE_MS) this.stats.frameInterval.push(interval);
    const dt = Math.min(interval / 1000, MAX_FRAME_DT);
    this.lastTime = now;

    this.stats.begin(CPU_UPDATE);
    if (this.hooks.update) this.hooks.update(dt, now);
    else this.controls?.update(dt);
    this.stats.end(CPU_UPDATE);

    const { gpu, renderer } = this;
    if (gpu && renderer) {
      this.stats.begin(CPU_RENDER);
      if (this.sizeDirty || this.sizedRenderer !== renderer) this.applySize(renderer, gpu);
      renderer.time = now / 1000;
      renderer.render(this.camera);
      if (this.options.streaming) {
        this.applyBrushEdits();
        this.farEdits?.pump(FAR_EDIT_JOBS_PER_FRAME);
        if (this.regenSoakPerFrame > 0) this.soakRegeneration();
        this.streamer.update(this.camera.chunk[0], this.camera.chunk[1], this.camera.chunk[2]);
      }
      this.mesher?.update(this.camera.chunk[0], this.camera.chunk[1], this.camera.chunk[2]);
      renderer.voxelizer.pump(VOXEL_BATCHES_PER_FRAME);
      this.stats.end(CPU_RENDER);
    }
    // Buffers consumed this frame go back to the workers in one message.
    this.pool.flushRecycled();
    this.stats.end(CPU_FRAME);
    this.hooks.afterFrame?.(now, interval);
  }

  // Render at this size whatever the element is doing. `autoResize` does it from the
  // element instead, which is the default.
  resize(width: number, height: number): void {
    this.pixelWidth = Math.max(1, Math.round(width));
    this.pixelHeight = Math.max(1, Math.round(height));
    this.sizeDirty = true;
  }

  // Gives it all back: the loop, the workers, the device, the observer. Everything after
  // this is a no-op, so a host can call it from a teardown path that may run twice.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    // Bump the generation first: a device loss or an `init()` still in flight belongs to
    // an older engine now and has to drop rather than build a renderer into a dead one.
    this.generation++;
    if (this.restartTimer !== 0) clearTimeout(this.restartTimer);
    if (this.compiling !== 0) clearInterval(this.compiling);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controls?.dispose?.();
    this.pool.terminate();
    this.gpu?.device.destroy();
    this.gpu = null;
    this.renderer = null;
    this.farEdits = null;
  }

  // Builds the device and the renderer, and is called again by the restart after a device
  // loss. Everything it touches is rebuilt; everything on the CPU side is kept.
  async init(): Promise<boolean> {
    const gen = ++this.generation;
    const result = await createGpu(this.canvas, (m) => this.error(m));
    if ("error" in result) {
      this.hooks.onUnsupported?.(result.error);
      return false;
    }
    const { gpu } = result;
    if (gen !== this.generation) {
      gpu.device.destroy();
      return false;
    }

    gpu.device.lost.then((info) => {
      if (gen !== this.generation) return; // a newer device already replaced this one
      this.gpu = null;
      this.renderer = null;
      this.error(`device lost (${info.reason})${info.message ? `: ${info.message}` : ""}`);
      this.scheduleRestart();
    });

    const o = this.options;
    const renderer = new Renderer(gpu, (m) => this.error(m), this.world, {
      previewScale: o.render.previewScale,
      voxelSlots: o.voxelSlots,
      recycle: (buffer) => this.pool.recycle(buffer),
      near: {
        quadMiB: o.render.nearMiB,
        slots: this.store.capacity, // a mesh per stored chunk at most
        clusterQuads: o.mesh.clusterQuads,
        ao: o.mesh.ao,
        textured: o.render.textures,
        emissive: o.render.glow,
        animated: o.render.wind,
        blockLight: o.mesh.blockLight,
        shadows: o.shadows,
      },
      far: { clipmap: o.far.clipmap, slabsPerFrame: o.far.slabsPerFrame, scale: o.far.scale },
    });
    renderer.showPreview = o.render.preview;
    renderer.showGrid = o.render.grid;
    renderer.showGizmo = o.render.gizmo;
    renderer.near.cullFlags = o.render.cull;
    renderer.preview.grid = this.brushGrid;
    renderer.far.brushes = this.brushGrid;
    renderer.far.beam = o.far.beam;
    this.farEdits = new FarEdits(this.store, this.pool, renderer.far);
    // Which chunks the near field draws, so the far field can leave those to it.
    if (this.mesher) this.mesher.onCoverage = (key, covered) => renderer.far.coverage.set(key, covered);
    // Sampling a slab writes what the field says, so an edited chunk it covers is reduced
    // again over the top.
    renderer.far.onSlabBuilt = (level, axis, plane) => this.farEdits?.slabBuilt(level, axis, plane);
    this.pool.on(BRICK_JOB, (key, version, output) => this.farEdits?.onResult(key, version, output as BrickJobOutput));
    if (o.far.adapt) {
      // The ceiling is what the clipmap allocated, not the controller's own default:
      // asking for more levels than there are buffers would leave the two disagreeing
      // about how far the world reaches.
      renderer.farAdapt = new FarAdapt(renderer.far.levels, o.far.slabsPerFrame, renderer.far.resolutionScale, {
        ...DEFAULT_ADAPT_OPTIONS,
        maxLevels: renderer.far.map.levelCapacity,
        minLevels: Math.min(DEFAULT_ADAPT_OPTIONS.minLevels, renderer.far.map.levelCapacity),
      });
    }
    if (o.farOn) {
      renderer.showFar = true;
      const debug = o.far.debug;
      renderer.far.debug = debug === "steps"
        ? 1
        : debug === "bricks"
        ? 2
        : debug === "levels"
        ? 3
        : debug === "blocks"
        ? 4
        : debug === "height"
        ? 5
        : 0;
    }

    if (!(await renderer.init())) return false; // errors have gone to onError
    if (gen !== this.generation) return false;
    // The sky is up, so start drawing now. The pipelines that evaluate the world program
    // take seconds to compile for a heavy world, and waiting for them here is a black
    // screen for that whole time. Each pass checks its own readiness, so the frame draws
    // the sky, then the far field, then meshes, as they arrive.
    this.gpu = gpu;
    this.renderer = renderer;

    if (this.hooks.onCompiling) {
      this.compiling = setInterval(() => {
        if (gen !== this.generation) return;
        this.hooks.onCompiling?.(WORLD_STAGES.filter((name) => renderer.startup[name] === undefined));
      }, 200);
    }
    const worldOk = await renderer.worldReady;
    if (this.compiling !== 0) clearInterval(this.compiling);
    this.compiling = 0;
    if (gen !== this.generation) return false;
    // A world that would not compile leaves a renderer that draws a sky over nothing.
    // Better to fail here, where `create()` turns it into a throw carrying the message.
    if (!worldOk) return false;
    this.hooks.onCompiling?.([]);

    this.mesher?.remeshAll(); // a rebuilt renderer starts with no meshes
    if (this.options.streaming) this.attachStreaming(renderer.voxelizer);
    this.hooks.onReady?.(renderer, gpu);
    return true;
  }

  private error(message: string): void {
    this.hooks.onError?.(message);
    this.options.onError?.(message);
  }

  private scheduleRestart(): void {
    if (this.disposed) return;
    const now = performance.now();
    while (this.restartTimes.length > 0 && now - this.restartTimes[0] > RESTART_WINDOW_MS) this.restartTimes.shift();
    if (this.restartTimes.length >= MAX_RESTARTS_IN_WINDOW) {
      this.hooks.onUnsupported?.("The GPU device was lost repeatedly. Reload the page to try again.");
      return;
    }
    this.restartTimes.push(now);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = 0;
      if (!this.disposed) this.init();
    }, RESTART_DELAY_MS);
  }

  private attachStreaming(voxelizer: Voxelizer): void {
    voxelizer.onResult = (r) => this.streamer.onVoxelResult(r.cx, r.cy, r.cz, r.kind, r.blockId, r.ids);
    voxelizer.fieldBrushes = this.fieldBrushes;
    this.streamer.attach({
      queueChunk: (x, y, z, priority) => voxelizer.queueChunk(x, y, z, priority),
      get queuedCount() {
        return voxelizer.stats.queued;
      },
      recycle: (ids) => voxelizer.recycle(ids),
    }, {
      // A fresh input and transfer list per job: a job the pool queues keeps the caller's
      // objects until it is dispatched, so reusing them detaches the buffers of the one
      // still waiting.
      compress: (key, ids, uniformId, ops) => {
        const input: CompressInput = { ids, uniformId, ops, cx: keyX(key), cy: keyY(key), cz: keyZ(key) };
        const transfer: Transferable[] = [];
        if (ids) transfer.push(ids.buffer as ArrayBuffer);
        if (ops) transfer.push(ops);
        this.pool.submit("chunk.compress", key, ++this.compressVersion, 0, input, transfer);
      },
    });
  }

  private applyBrushEdits(): void {
    const n = this.brushes.dirty;
    if (n === 0) return;
    if (this.brushDirty.length < n) this.brushDirty = new Float64Array(n * 2);
    this.streamer.regenerateKeys(this.brushDirty, this.brushes.takeDirty(this.brushDirty));
  }

  private soakRegeneration(): void {
    const n = this.streamer.residentCount;
    if (n === 0) return;
    for (let i = 0; i < this.regenSoakPerFrame; i++) {
      this.streamer.regenerate(this.streamer.residentKeyAt(Math.floor(Math.random() * n)));
    }
  }

  private onResize(entries: ResizeObserverEntry[]): void {
    const entry = entries[0];
    const device = entry.devicePixelContentBoxSize?.[0];
    if (device) {
      this.pixelWidth = device.inlineSize;
      this.pixelHeight = device.blockSize;
    } else {
      const css = entry.contentBoxSize[0];
      this.pixelWidth = Math.round(css.inlineSize * devicePixelRatio);
      this.pixelHeight = Math.round(css.blockSize * devicePixelRatio);
    }
    this.sizeDirty = true;
  }

  private applySize(renderer: Renderer, gpu: Gpu): void {
    const fixed = this.options.render.size;
    const max = gpu.caps.limits.maxTextureDimension2D;
    const width = Math.max(1, Math.min(fixed ? fixed[0] : this.pixelWidth, max));
    const height = Math.max(1, Math.min(fixed ? fixed[1] : this.pixelHeight, max));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    // A fixed render size is laid out at the window's shape unless it is told otherwise,
    // and the two rarely agree: the frame is then scaled by a different factor across
    // than down, which is a pixel that is not square. Give the element the render target's
    // own aspect and let it letterbox; without a fixed size the render target already is
    // the element and there is nothing to fit.
    if (fixed) {
      this.canvas.style.aspectRatio = `${width} / ${height}`;
      this.canvas.style.setProperty("--fit-aspect", String(width / height));
      this.canvas.classList.add("fit");
    }
    renderer.resize(width, height);
    this.sizeDirty = false;
    this.sizedRenderer = renderer;
  }
}

// Where the worker comes from when the host has not said.
//
// `new Worker(new URL("...", import.meta.url), { type: "module" })` is written out as one
// expression on purpose: bundlers recognise that exact shape and emit the worker as an
// asset, and every spelling that hides part of it behind a variable or a function call
// defeats the detection and leaves a path that resolves to nothing. Keep it literal.
//
// It is still only a default. Served as built, the worker sits next to `voxler.js` and
// this finds it; through a bundler that does not follow the pattern, pass
// `workers.factory` (see `WorkerOptions`).
function defaultWorkerFactory(index: number): Worker {
  return new Worker(new URL("./workers/voxel.worker.js", import.meta.url), {
    type: "module",
    name: `voxel-${index}`,
  });
}

export { VERSION } from "./version.ts";
export { resolveOptions } from "./options.ts";
export type {
  CameraOptions,
  FarOptions,
  MeshingOptions,
  RenderOptions,
  ResolvedOptions,
  StreamingOptions,
  VoxlerOptions,
  WorkerOptions,
  WorldSource,
} from "./options.ts";
export { FlyCamera } from "./camera/camera.ts";
export { FlyControls } from "./camera/controls.ts";
export { Follow } from "./camera/follow.ts";
export { Renderer } from "./render/renderer.ts";
export { ChunkStore } from "./world/store.ts";
export { ChunkStreamer } from "./world/streaming.ts";
export { MeshScheduler } from "./world/mesh-scheduler.ts";
export { WorkerPool } from "./workers/pool.ts";
export { CHUNK_SIZE, CHUNK_VOLUME } from "./world/coords.ts";
export { BLOCKS, type BlockType } from "./world/blocks.ts";
// Editing. The blend and primitive constants are part of the surface: a field brush is
// useless without a way to say "subtract this sphere".
export { BrushStore, type BrushDesc, type BrushUpdate } from "./brush/store.ts";
export { EditTool } from "./brush/tool.ts";
export {
  BLEND_INTERSECT,
  BLEND_SMAX,
  BLEND_SMIN,
  BLEND_SUBTRACT,
  BLEND_UNION,
  BRUSH_CSG,
  BRUSH_SDF,
  BRUSH_VOXEL,
  PRIM_BOX,
  PRIM_CAPSULE,
  PRIM_CYLINDER,
  PRIM_ELLIPSOID,
  PRIM_ROUND_BOX,
  PRIM_SPHERE,
  PRIM_TORUS,
} from "./brush/format.ts";
export { type CsgOpSpec, csgOne, packCsg, packVoxel, type VoxelOpSpec } from "./brush/build.ts";
export {
  SHAPE_BOX,
  SHAPE_ELLIPSOID,
  SHAPE_SPHERE,
  SHAPE_VOXEL,
  VOXEL_CARVE,
  VOXEL_PAINT,
  VOXEL_REPLACE,
  VOXEL_SET,
} from "./brush/format.ts";
export { fillBox, fillSphere, setVoxel } from "./brush/voxel-ops.ts";
export { DEFAULT_SKY, SKIES, type Sky } from "./render/sky.ts";
export { WORLDS } from "./worlds/index.ts";
