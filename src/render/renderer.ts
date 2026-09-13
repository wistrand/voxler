// Owns every GPU resource derived from one device. After device loss the whole
// Renderer is discarded and rebuilt from CPU-side state.

import cameraWgsl from "./camera.wgsl" with { type: "text" };
import birdsWgsl from "./birds.wgsl" with { type: "text" };
import birdsCommonWgsl from "./birds-common.wgsl" with { type: "text" };
import birdsStepWgsl from "./birds-step.wgsl" with { type: "text" };
import shadingWgsl from "./shading.wgsl" with { type: "text" };
import shadowWgsl from "../far/shadow.wgsl" with { type: "text" };
import { CounterReadback } from "../gpu/counters.ts";
import { BIRD_FLOCKS, BIRD_STATE_BYTES, BIRD_STATE_FLOATS, BIRDS } from "./birds.ts";
import gizmoWgsl from "./gizmo.wgsl" with { type: "text" };
import gridWgsl from "./grid.wgsl" with { type: "text" };
import skyColorWgsl from "./sky-color.wgsl" with { type: "text" };
import { skyConstantsWgsl } from "./sky.ts";
import skyWgsl from "./sky.wgsl" with { type: "text" };
import "../gpu/globals.ts";
import type { FlyCamera } from "../camera/camera.ts";
import { type FrameCounters, STATS_WINDOW } from "../debug/stats.ts";
import type { Gpu } from "../gpu/device.ts";
import { compileShader, createRenderPipeline, type Report, type ShaderSource } from "../gpu/shader.ts";
import { GpuTimer } from "../gpu/timer.ts";
import { FarField, type FarFieldOptions } from "../far/far-field.ts";
import { farBudgetMs, type FarAdapt, refreshFromIntervals } from "../far/adapt.ts";
import { newSummary, percentileOfSorted, summarize } from "../util/percentile.ts";
import { RingBuffer } from "../util/ring.ts";
import { buildTextures } from "./textures.ts";
import { SdfPreview } from "../sdf/preview.ts";
import { Voxelizer } from "../sdf/voxelizer.ts";
import type { WorldProgram } from "../worlds/index.ts";
import { CAMERA_UNIFORM_SIZE, CameraUniform } from "./camera-uniform.ts";
import { runDrawTest } from "./draw-test.ts";
import { NearField, type NearFieldOptions } from "./near-field.ts";

const DEPTH_FORMAT: GPUTextureFormat = "depth32float";
const GRID_RADIUS = 8; // chunks each side of the camera chunk
const GRID_INSTANCES = (2 * GRID_RADIUS + 1) ** 2;
const GIZMO_CSS_PX = 96;
const GIZMO_MARGIN_CSS_PX = 12;
// Bytes of buffer uploads a frame, shared by the near field's arenas and the far
// field's clipmap: whatever the far field spent last frame comes off the near field's
// budget this frame, so a clipmap catching up cannot push the frame's upload cost past
// what one field alone would (plan-far-field phase 3).
const UPLOAD_BYTES_PER_FRAME = 4 << 20;
const CULL_CHECK_INTERVAL = 30; // frames between cull checks (?cullCheck)
// Frames of interval history before the display's period is worth reading, and where in
// that history to read it (see refreshFromIntervals: the short end, not the middle).
const MIN_INTERVAL_SAMPLES = 30;
const INTERVAL_Q = 0.1;

const CAMERA_SOURCE: ShaderSource = { name: "camera.wgsl", code: cameraWgsl };

// Timed passes, in GpuTimer index order. The near field runs in two phases
// (plan-rendering phase 4): cull A, draw A, Hi-Z build, cull B, draw B. "main"
// draws the background (preview blit or sky) behind them, then the grid and gizmo.
// These are indices into TIMED_PASSES below and have to stay in step with it: adding a
// pass in the middle renumbers every one after it.
const PASS_PREVIEW = 0;
const PASS_CULL_A = 1;
const PASS_NEAR_A = 2;
const PASS_BIRDS_STEP = 3;
const PASS_BIRDS = 4;
const PASS_HIZ = 5;
const PASS_CULL_B = 6;
const PASS_NEAR_B = 7;
const PASS_MAIN = 8;
const PASS_CULL_T = 9;
const PASS_NEAR_T = 10;
const PASS_FAR = 11;
const PASS_FAR_BUILD = 12;
const PASS_FAR_BEAM = 13;
// Three boxes to a bird (a body and two wings), 36 vertices to a box. The flock's shape
// is in `src/render/birds.ts`, beside the picker that needs the same numbers.
const BIRD_INSTANCES = BIRDS * 3;
const CUBE_VERTICES = 36;
const NO_PICK = 0xffff; // a bird index no bird has

const TIMED_PASSES = [
  "preview",
  "cull.a",
  "near.a",
  "birds.step",
  "birds",
  "hiz",
  "cull.b",
  "near.b",
  "main",
  "cull.t",
  "near.t",
  "far",
  "far.build",
  "far.beam",
] as const;

export interface RendererOptions {
  previewScale: number;
  voxelSlots: number;
  recycle: (buffer: ArrayBuffer) => void; // returns mesh buffers to the worker pool
  near: NearFieldOptions;
  far: FarFieldOptions;
}

interface Pipelines {
  sky: GPURenderPipeline;
  grid: GPURenderPipeline;
  gizmo: GPURenderPipeline;
}

export class Renderer {
  readonly timer: GpuTimer;
  // GPU chunk voxelizer for the world; pumped by the caller (main.ts), not by render().
  readonly voxelizer: Voxelizer;
  readonly counters: FrameCounters = { draws: 0, uploadBytes: 0 };
  // View toggles, owned by the caller (main.ts keys). The preview replaces the sky
  // when it compiled; the grid draws on top, hidden behind preview depth.
  // The SDF preview compiles the world program into a sphere-tracing loop, which is
  // the most expensive shader in the engine to build: for the forest it took two
  // minutes. It is off by default, so it is built the first time it is switched on
  // rather than on every load.
  private previewStarted = false;
  private previewWanted = false;
  get showPreview(): boolean {
    return this.previewWanted;
  }
  set showPreview(on: boolean) {
    this.previewWanted = on;
    if (on) this.ensurePreview();
  }
  showGrid = true;
  showMeshes = true;
  // Near-field meshes; fed by the mesh scheduler through main.ts.
  readonly near: NearField;
  // Result of the draw builtins self-test: null before it ran, "ok", or failures.
  drawTest: string | null = null;
  // Milliseconds each init stage took, for the overlay's startup line and the on-screen
  // panel's compiling note. Shader compilation for a heavy world dominates it, and what
  // it costs is the size of the world program rather than anything the engine does:
  // measured cold on the dev machine, the forest's two world modules take about 140 ms
  // and the monument valley's about 1.4 s, and the two compile at the same time rather
  // than one after the other, so the wait is the slower of them and not their sum. The
  // 3x3 neighbourhood loops in a world are not what costs it: forcing the compiler not to
  // unroll one moved the monument by nothing (gotchas.md "What a heavy world costs to
  // compile").
  readonly startup: Record<string, number> = {};
  // Null when adaptation is off (`?farAdapt=0`, and during a bench run, where a reach
  // that moves under the measurement makes the numbers incomparable).
  farAdapt: FarAdapt | null = null;
  private readonly farScratch = new Float64Array(STATS_WINDOW);
  private readonly farSummary = newSummary();
  // Intervals between the frames this renderer drew, for the display's period. Its own
  // ring rather than the overlay's: the overlay is optional and this is not.
  private readonly frameIntervals = new RingBuffer(STATS_WINDOW);
  private lastFrameAt = 0;
  // Compare culled and unculled near-field draws every CULL_CHECK_INTERVAL frames.
  cullCheck = false;
  // Seconds on the animation clock, set by the caller each frame. Held here rather than
  // read from a clock inside, so a check can freeze it (plan-living-world phase 2).
  time = 0;
  private frameCount = 0;
  private readonly gpu: Gpu;
  private readonly report: Report;
  private previewArgs: { format: GPUTextureFormat; report: Report } | null = null;
  private readonly world: WorldProgram;
  // Public so the page can hand it the brush grid it traces (main.ts).
  readonly preview: SdfPreview;
  // Far field (plan-far-field phases 1-2). Off until the page builds its bricks.
  readonly far: FarField;
  showFar = false;
  private readonly cameraUniform: CameraUniform;
  private readonly frameLayout: GPUBindGroupLayout;
  private readonly frameBindGroup: GPUBindGroup;
  private pipelines: Pipelines | null = null;
  private depthTexture: GPUTexture | null = null;
  private width = 0;
  private height = 0;
  // Birds, when the world asks for them (`birds` in src/worlds/index.ts). Null in a
  // world without them, so nothing is compiled and nothing is encoded.
  private birdPipeline: GPURenderPipeline | null = null;
  private birdStep: GPUComputePipeline | null = null;
  private birdState: GPUBuffer | null = null;
  private birdDraw: GPUBindGroup | null = null;
  private birdWrite: GPUBindGroup | null = null;
  private birdGround: GPUBindGroup | null = null;
  private birdPick: GPUBuffer | null = null;
  private birdStaging: GPUBuffer | null = null;
  private birdReading = false;
  private pickedBird = -1;
  private readonly pickScratch = new Uint32Array(4);
  private birdTrack: CounterReadback | null = null;
  private trackFloats: Float32Array | null = null;
  private tracked = -1;
  private trackSamples = -1;
  showBirds = true;
  private lastTime = -1; // seconds, for the frame's dt

  // The flock's state, for reading back (`BIRDS` records of two vec4f: position with a
  // placed flag, then velocity with the wing phase). Null in a world without birds.
  get birds(): GPUBuffer | null {
    return this.birdState;
  }

  // Keeps a fresh copy of one bird's state coming back from the GPU, for a camera that
  // wants to follow it. Set to -1 to stop. The copy lands a few frames late, which at a
  // bird's speed is half a voxel and is the price of not awaiting a readback in the frame
  // path (CLAUDE.md).
  trackBird(index: number): void {
    this.tracked = index >= 0 && index < BIRDS ? index : -1;
    if (this.tracked < 0) this.trackSamples = -1;
  }

  // The tracked bird's last arrived state: position in 0..2 and velocity in 4..6, as the
  // buffer holds it. Null until one has arrived, and null again when tracking stops.
  get trackedBird(): Float32Array | null {
    if (this.tracked < 0 || this.birdTrack === null) return null;
    return this.birdTrack.samples > this.trackSamples ? this.trackFloats : null;
  }

  // The bird drawn picked out, or -1. Set by whatever did the picking (main.ts, from a
  // click); the draw reads it out of a uniform.
  get picked(): number {
    return this.pickedBird;
  }

  // `index` out of range clears the selection.
  selectBird(index: number): void {
    const bird = index >= 0 && index < BIRDS ? index : -1;
    this.pickedBird = bird;
    if (this.birdPick === null) return;
    this.pickScratch[0] = bird < 0 ? NO_PICK : bird;
    this.gpu.device.queue.writeBuffer(this.birdPick, 0, this.pickScratch);
  }

  // A copy of the flock's state, or null in a world without birds or while a read is
  // already in flight. Not for the frame path: it maps a buffer, which resolves frames
  // later (CLAUDE.md "Never await a GPU readback in the frame path"). A click is a
  // gesture, and by the time this lands the birds have moved about half a voxel.
  async readBirds(): Promise<Float32Array | null> {
    const state = this.birdState;
    if (state === null || this.birdReading) return null;
    this.birdReading = true;
    try {
      const device = this.gpu.device;
      this.birdStaging ??= device.createBuffer({
        label: "birds readback",
        size: BIRD_STATE_BYTES,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder({ label: "birds readback" });
      encoder.copyBufferToBuffer(state, 0, this.birdStaging, 0, BIRD_STATE_BYTES);
      device.queue.submit([encoder.finish()]);
      await this.birdStaging.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(this.birdStaging.getMappedRange().slice(0));
      this.birdStaging.unmap();
      return out;
    } catch {
      return null; // a device loss mid-read; the caller simply picks nothing
    } finally {
      this.birdReading = false;
    }
  }
  private gizmoX = 0;
  private gizmoY = 0;
  private gizmoSize = 0;

  // Descriptors are built once and reused; only attachment views change. The near
  // pass clears color and depth; the main pass loads them.
  private readonly nearColor: GPURenderPassColorAttachment;
  private readonly nearDepth: GPURenderPassDepthStencilAttachment;
  private readonly nearDescriptor: GPURenderPassDescriptor; // phase A: clears
  private readonly nearBColor: GPURenderPassColorAttachment;
  private readonly nearBDepth: GPURenderPassDepthStencilAttachment;
  private readonly nearTDescriptor: GPURenderPassDescriptor;
  private readonly nearBDescriptor: GPURenderPassDescriptor; // phase B: loads
  private readonly birdDescriptor: GPURenderPassDescriptor;
  private readonly colorAttachment: GPURenderPassColorAttachment;
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment;
  private readonly passDescriptor: GPURenderPassDescriptor;
  private readonly encoderDescriptor: GPUCommandEncoderDescriptor = { label: "frame" };
  private readonly commandBuffers: GPUCommandBuffer[] = [];

  constructor(gpu: Gpu, report: Report, world: WorldProgram, options: RendererOptions) {
    this.gpu = gpu;
    this.report = report;
    this.world = world;
    const { device } = gpu;
    this.preview = new SdfPreview(device, world, options.previewScale);
    // Far-field colors come from the block registry's far table, averaged from the
    // same textures the near field draws when textures are on (`?tex=0` falls back
    // to the flat display colors).
    this.far = new FarField(device, world, {
      ...options.far,
      textures: options.near.textured ? buildTextures() : null,
    });
    this.voxelizer = new Voxelizer(device, world, report, { slots: options.voxelSlots });
    this.near = new NearField(device, gpu.caps, options.recycle, options.near);
    this.timer = new GpuTimer(device, gpu.caps.timestampQuery, TIMED_PASSES, STATS_WINDOW);
    this.cameraUniform = new CameraUniform(device);
    this.frameLayout = device.createBindGroupLayout({
      label: "frame",
      entries: [{
        binding: 0,
        // Compute as well: the boid step reads the camera and the frame's dt out of the
        // same uniform every other pass reads, and a stage left out here makes the
        // pipeline invalid with no error of its own, only "a previous error".
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      }],
    });
    this.frameBindGroup = device.createBindGroup({
      label: "frame",
      layout: this.frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.cameraUniform.buffer } }],
    });
    this.nearColor = {
      view: undefined as unknown as GPUTextureView, // set in render()
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    };
    this.nearDepth = {
      view: undefined as unknown as GPUTextureView, // set in resize()
      depthClearValue: 0, // reversed-Z: 0 is infinitely far
      depthLoadOp: "clear",
      depthStoreOp: "store",
    };
    this.nearDescriptor = {
      label: "near a",
      colorAttachments: [this.nearColor],
      depthStencilAttachment: this.nearDepth,
    };
    this.nearBColor = { view: undefined as unknown as GPUTextureView, loadOp: "load", storeOp: "store" };
    this.nearBDepth = { view: undefined as unknown as GPUTextureView, depthLoadOp: "load", depthStoreOp: "store" };
    this.nearTDescriptor = {
      label: "near translucent",
      colorAttachments: [this.nearBColor],
      // Depth is read, never written: the pipeline has depthWriteEnabled false.
      depthStencilAttachment: this.nearBDepth,
    };
    this.nearBDescriptor = {
      label: "near b",
      colorAttachments: [this.nearBColor],
      depthStencilAttachment: this.nearBDepth,
    };
    // Birds share the near field's colour and depth, loaded and stored, and draw whether
    // or not there are meshes: `?mesh=0` leaves the sky, and birds are still in it.
    this.birdDescriptor = {
      label: "birds",
      colorAttachments: [this.nearBColor],
      depthStencilAttachment: this.nearBDepth,
    };
    this.colorAttachment = {
      view: undefined as unknown as GPUTextureView, // set in render()
      loadOp: "load",
      storeOp: "store",
    };
    this.depthAttachment = {
      view: undefined as unknown as GPUTextureView, // set in resize()
      depthLoadOp: "load",
      depthStoreOp: "store",
    };
    this.passDescriptor = {
      label: "main",
      colorAttachments: [this.colorAttachment],
      depthStencilAttachment: this.depthAttachment,
    };
  }

  // Resolves once every pipeline that evaluates the world program is up: the
  // preview, the voxelizer, the near field and the far field. init() does not wait
  // for it, so the frame loop starts on the sky alone while a heavy world compiles.
  worldReady: Promise<boolean> = Promise.resolve(false);

  // Compiles shaders and builds pipelines. False if any failed (already reported).
  // Returns as soon as the frame can draw; see `worldReady` for the rest.
  async init(): Promise<boolean> {
    const { device, format } = this.gpu;
    const report = this.report;
    const layout = device.createPipelineLayout({ label: "frame", bindGroupLayouts: [this.frameLayout] });
    // The preview builds in parallel; if the world fails to compile, the rest of
    // the renderer still works and the error is in the overlay.
    const stage = (name: string, done: Promise<unknown>) => {
      const at = performance.now();
      return done.then((v) => {
        this.startup[name] = performance.now() - at;
        return v;
      });
    };
    this.previewArgs = { format, report };
    const voxelizerReady = stage("voxelize", this.voxelizer.init()); // failure is reported; rendering continues
    this.near.setShadowSource(this.far.shadowResources());
    const nearReady = stage("near", this.near.init(CAMERA_SOURCE, this.world.sky, format, DEPTH_FORMAT, this.frameLayout, report));
    const farReady = stage("far", this.far.init(format, DEPTH_FORMAT, report));
    const drawTestDone = stage("drawTest", runDrawTest(device, report).then((failure) => {
      this.drawTest = failure ?? "ok";
      if (failure) report(`draw builtins self-test failed: ${failure}`);
    }));
    const overlayAt = performance.now();
    const [skyModule, gridModule, gizmoModule, birdsModule, birdStepModule] = await Promise.all([
      compileShader(device, "sky", [
        CAMERA_SOURCE,
        { name: "sky.wgsl (generated)", code: skyConstantsWgsl(this.world.sky) },
        { name: "sky-color.wgsl", code: skyColorWgsl },
        { name: "sky.wgsl", code: skyWgsl },
      ], report),
      compileShader(device, "grid", [CAMERA_SOURCE, { name: "grid.wgsl", code: gridWgsl }], report),
      compileShader(device, "gizmo", [CAMERA_SOURCE, { name: "gizmo.wgsl", code: gizmoWgsl }], report),
      // Birds are lit and fogged by the one lighting model like every other surface, so
      // they carry the same sky constants the near field does.
      this.world.birds
        ? compileShader(device, "birds", [
          CAMERA_SOURCE,
          { name: "sky.wgsl (generated)", code: skyConstantsWgsl(this.world.sky) },
          { name: "sky-color.wgsl", code: skyColorWgsl },
          { name: "shading.wgsl", code: shadingWgsl },
          { name: "render/birds-common.wgsl", code: birdsCommonWgsl },
          { name: "render/birds.wgsl", code: birdsWgsl },
        ], report)
        : Promise.resolve(null),
      this.world.birds
        ? compileShader(device, "birds step", [
          CAMERA_SOURCE,
          // The clipmap, for the one thing the flock cannot work out for itself: where
          // the ground is. Same bindings the near field's shadow rays read.
          { name: "far/shadow.wgsl", code: shadowWgsl },
          { name: "render/birds-common.wgsl", code: birdsCommonWgsl },
          { name: "render/birds-step.wgsl", code: birdsStepWgsl },
        ], report)
        : Promise.resolve(null),
    ]);
    if (!skyModule || !gridModule || !gizmoModule) return false;
    if (this.world.birds && (!birdsModule || !birdStepModule)) return false;

    const overlayDepth: GPUDepthStencilState = {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: "always",
    };
    // The sky sits at depth 0 (infinity): "greater-equal" draws it only where the
    // near pass left the cleared depth.
    const behindDepth: GPUDepthStencilState = {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: "greater-equal",
    };
    const gridConstants = { grid_radius: GRID_RADIUS };
    const [sky, grid, gizmo] = await Promise.all([
      createRenderPipeline(device, {
        label: "sky",
        layout,
        vertex: { module: skyModule, entryPoint: "vs" },
        fragment: { module: skyModule, entryPoint: "fs", targets: [{ format }] },
        depthStencil: behindDepth,
      }, report),
      createRenderPipeline(device, {
        label: "grid",
        layout,
        vertex: { module: gridModule, entryPoint: "vs", constants: gridConstants },
        fragment: {
          module: gridModule,
          entryPoint: "fs",
          constants: gridConstants,
          targets: [{
            format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          }],
        },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: "greater" },
      }, report),
      createRenderPipeline(device, {
        label: "gizmo",
        layout,
        vertex: { module: gizmoModule, entryPoint: "vs" },
        fragment: { module: gizmoModule, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "line-list" },
        depthStencil: overlayDepth,
      }, report),
    ]);
    if (!sky || !grid || !gizmo) return false;
    if (birdsModule !== null && birdStepModule !== null) {
      // The flock's state, which is the one thing in the frame that survives from the
      // last one: a boid is defined by what its neighbours are doing, and no function of
      // position and time can answer that. A fresh buffer is zeroed, and a zeroed `pos.w`
      // is what tells the step to place the birds, so there is nothing to seed from here.
      this.birdState = device.createBuffer({
        label: "birds",
        size: BIRD_STATE_BYTES,
        // COPY_SRC so the flock can be read back and checked: it is the one thing in the
        // frame with state, and a rule that is wrong in it is wrong for as long as the
        // page is open rather than for one frame.
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      // Two layouts over the one buffer: the step writes it, and a vertex stage may only
      // read one.
      const write = device.createBindGroupLayout({
        label: "birds write",
        entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }],
      });
      const read = device.createBindGroupLayout({
        label: "birds read",
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        ],
      });
      // Which bird a click picked. The CPU chooses and the draw reads, which is the other
      // way round from the state buffer, so it is a uniform of its own rather than a
      // field in one the step owns.
      this.birdPick = device.createBuffer({
        label: "birds picked",
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.selectBird(NO_PICK);
      this.birdWrite = device.createBindGroup({
        label: "birds write",
        layout: write,
        entries: [{ binding: 0, resource: { buffer: this.birdState } }],
      });
      this.birdDraw = device.createBindGroup({
        label: "birds read",
        layout: read,
        entries: [
          { binding: 0, resource: { buffer: this.birdState } },
          { binding: 1, resource: { buffer: this.birdPick } },
        ],
      });
      // Opaque, depth-tested and depth-writing against the near field's own buffer, so
      // terrain hides a bird and two birds sort against each other. No back-face culling:
      // the boxes are built in the vertex stage and their winding is not worth the
      // bookkeeping for three hundred triangles.
      const birds = await createRenderPipeline(device, {
        label: "birds",
        layout: device.createPipelineLayout({ label: "birds", bindGroupLayouts: [this.frameLayout, read] }),
        vertex: { module: birdsModule, entryPoint: "vs" },
        fragment: { module: birdsModule, entryPoint: "fs", targets: [{ format }] },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "greater" },
      }, report);
      if (!birds) return false;
      this.birdPipeline = birds;
      device.pushErrorScope("validation");
      // Group 2 is the clipmap, at the same bindings shadow.wgsl declares for the near
      // field's rays, with its own layout because that one is visible to the fragment
      // stage and this is compute. The buffers exist whatever `?far=0` says; what changes
      // is whether anything has been written into them, and the step asks.
      const ground = device.createBindGroupLayout({
        label: "birds ground",
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        ],
      });
      this.birdGround = device.createBindGroup({
        label: "birds ground",
        layout: ground,
        entries: this.far.shadowResources().map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      // One bird's worth of state, coming back on the same kind of ring the frame
      // counters use: a copy a frame, read frames later, never awaited.
      this.birdTrack = new CounterReadback(device, "bird", BIRD_STATE_FLOATS);
      this.trackFloats = new Float32Array(this.birdTrack.latest.buffer);
      this.birdStep = device.createComputePipeline({
        label: "birds step",
        layout: device.createPipelineLayout({
          label: "birds step",
          bindGroupLayouts: [this.frameLayout, write, ground],
        }),
        compute: { module: birdStepModule, entryPoint: "step" },
      });
      // Or an invalid pipeline reaches the encoder and every frame after it fails with
      // "a previous error", which says nothing about what the previous error was.
      const stepError = await device.popErrorScope();
      if (stepError) {
        report(`birds step pipeline: ${stepError.message}`);
        this.birdStep = null;
        this.birdPipeline = null;
        return false;
      }
    }
    this.startup.sky = performance.now() - overlayAt;
    this.pipelines = { sky, grid, gizmo };
    // Not the preview: it is optional, it is the slowest thing here to compile, and
    // streaming waits on this.
    this.worldReady = Promise.all([voxelizerReady, nearReady, farReady, drawTestDone]).then(() => true);
    if (this.previewWanted) this.ensurePreview();
    return true;
  }

  // Compiles the preview's pipelines, once. Safe to call before init() has set up its
  // arguments: showPreview calls it again as soon as they exist.
  private ensurePreview(): void {
    const args = this.previewArgs;
    if (this.previewStarted || args === null) return;
    this.previewStarted = true;
    const at = performance.now();
    this.preview.init(this.world, args.format, DEPTH_FORMAT, this.frameLayout, args.report).then(() => {
      this.startup.preview = performance.now() - at;
      this.preview.resize(this.width, this.height);
    });
  }

  get previewAvailable(): boolean {
    return this.preview.ready;
  }

  // Feeds the adaptive controller the far field's own GPU time and applies what it
  // decides. Reads the timer's rings rather than its `onSample` hook, which the bench
  // session owns; the summaries only run when a window closes, not per frame.
  private adaptFar(): void {
    const adapt = this.farAdapt;
    if (adapt === null || !this.timer.enabled) return;
    const now = performance.now();
    if (this.lastFrameAt > 0) this.frameIntervals.push(now - this.lastFrameAt);
    this.lastFrameAt = now;
    const march = summarize(this.timer.rings[PASS_FAR], this.farScratch, this.farSummary).mean;
    const beam = summarize(this.timer.rings[PASS_FAR_BEAM], this.farScratch, this.farSummary).mean;
    summarize(this.timer.rings[PASS_FAR_BUILD], this.farScratch, this.farSummary);
    const build = this.farSummary.mean, buildMax = this.farSummary.max;
    // The beam is part of what marching costs, so it goes on the march's side.
    const marchTotal = march + (Number.isFinite(beam) ? beam : 0);
    const budget = this.farBudget();
    if (!adapt.frame(budget, marchTotal, build, buildMax, this.far.stats.queued, this.far.builtLastFrame)) {
      return;
    }
    this.far.levels = adapt.settings.levels;
    this.far.slabs = adapt.settings.slabsPerFrame;
    this.far.resolutionScale = adapt.settings.scale;
  }

  // What is left of a frame for the far field: the display's period, from the short end
  // of the observed intervals, less what every other timed pass costs. NaN until there
  // is enough of both to mean anything, which leaves the controller on its fallback.
  private farBudget(): number {
    const intervals = summarize(this.frameIntervals, this.farScratch, this.farSummary);
    if (intervals.count < MIN_INTERVAL_SAMPLES) return NaN;
    const refresh = refreshFromIntervals(percentileOfSorted(this.farScratch, intervals.count, INTERVAL_Q));
    let other = 0;
    for (let p = 0; p < TIMED_PASSES.length; p++) {
      if (p === PASS_FAR || p === PASS_FAR_BUILD || p === PASS_FAR_BEAM) continue;
      const mean = summarize(this.timer.rings[p], this.farScratch, this.farSummary).mean;
      if (Number.isFinite(mean)) other += mean;
    }
    return farBudgetMs(refresh, other, this.farAdapt!.options);
  }

  // Called when the canvas size changes. Not per frame: allocates the depth target.
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height && this.depthTexture) return;
    this.width = width;
    this.height = height;
    this.depthTexture?.destroy();
    this.depthTexture = this.gpu.device.createTexture({
      label: "depth",
      size: [width, height],
      format: DEPTH_FORMAT,
      // Sampled by the Hi-Z build; COPY_DST for the cull check's copy back.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.depthAttachment.view = this.depthTexture.createView();
    this.nearDepth.view = this.depthAttachment.view;
    this.nearBDepth.view = this.depthAttachment.view;
    this.near.resize(width, height, this.depthTexture);
    this.preview.resize(width, height);
    const margin = Math.round(GIZMO_MARGIN_CSS_PX * devicePixelRatio);
    this.gizmoSize = Math.max(1, Math.min(Math.round(GIZMO_CSS_PX * devicePixelRatio), width, height));
    this.gizmoX = Math.min(margin, width - this.gizmoSize);
    this.gizmoY = Math.max(0, height - this.gizmoSize - margin);
  }

  render(camera: FlyCamera): void {
    const p = this.pipelines;
    if (!p || !this.depthTexture) return;
    const { device, context } = this.gpu;
    const counters = this.counters;
    counters.draws = 0;
    counters.uploadBytes = 0;

    // The frame's own length, for anything that integrates state rather than being a
    // function of the clock (the boids). Taken here rather than passed in, because
    // `time` is the only clock the renderer is given.
    const dt = this.lastTime < 0 ? 0 : this.time - this.lastTime;
    this.lastTime = this.time;
    this.cameraUniform.write(device.queue, camera, this.width, this.height, this.time, dt);
    counters.uploadBytes += CAMERA_UNIFORM_SIZE;
    const farUpload = this.showFar ? this.far.stats.uploadBytes : 0;
    counters.uploadBytes += farUpload;
    counters.uploadBytes += this.near.upload(Math.max(0, UPLOAD_BYTES_PER_FRAME - farUpload));
    const target = context.getCurrentTexture().createView();
    this.far.resize(this.width, this.height, this.depthTexture);
    this.colorAttachment.view = target;
    this.nearColor.view = target;
    this.nearBColor.view = target;
    this.timer.beginFrame();

    const encoder = device.createCommandEncoder(this.encoderDescriptor);
    const preview = this.showPreview && this.preview.ready;
    if (preview) {
      this.preview.updateBrushes(camera.chunk[0], camera.chunk[1], camera.chunk[2]);
      this.preview.encode(encoder, this.frameBindGroup, this.timer.passWrites(PASS_PREVIEW));
      counters.draws++;
    }
    const timedCompute = (pass: number) => this.timer.passWrites(pass) as GPUComputePassTimestampWrites | undefined;
    // Near field first, so its depth hides the background drawn after it. While a
    // cull check runs, both phases render into the check's target and are copied
    // onto the real ones after, so the check compares this frame's own draw.
    const meshes = this.showMeshes && this.near.ready;
    const check = meshes && this.cullCheck && this.frameCount++ % CULL_CHECK_INTERVAL === 0;
    if (meshes) {
      this.near.prepare(this.cameraUniform.viewProj, camera.offset, camera.chunk, check);
      this.near.cullA(encoder, timedCompute(PASS_CULL_A));
    }
    this.nearDescriptor.timestampWrites = meshes ? this.timer.passWrites(PASS_NEAR_A) : undefined;
    const nearPass = encoder.beginRenderPass(this.nearDescriptor);
    if (meshes) {
      nearPass.setBindGroup(0, this.frameBindGroup);
      this.near.draw(nearPass, 0);
      counters.draws++;
    }
    nearPass.end();
    if (meshes) {
      // Only the occlusion test reads the pyramid.
      if (this.near.occlusionEnabled) this.near.buildHiZ(encoder, timedCompute(PASS_HIZ));
      this.near.cullB(encoder, timedCompute(PASS_CULL_B));
      this.nearBDescriptor.timestampWrites = this.timer.passWrites(PASS_NEAR_B);
      const passB = encoder.beginRenderPass(this.nearBDescriptor);
      passB.setBindGroup(0, this.frameBindGroup);
      this.near.draw(passB, 1);
      passB.end();
      counters.draws++;
    }
    // Birds after the near field's depth is complete and before the far field marches,
    // which reads that depth to skip pixels the raster pass already covered: a bird that
    // has written depth hides the far field behind it, which is why the flock is kept
    // inside the meshed radius where the depth buffer holds real terrain.
    if (this.birdPipeline !== null && this.birdStep !== null && this.showBirds) {
      // One workgroup a flock, and one more for the hunters.
      const stepPass = encoder.beginComputePass({
        label: "birds step",
        timestampWrites: timedCompute(PASS_BIRDS_STEP),
      });
      stepPass.setPipeline(this.birdStep);
      stepPass.setBindGroup(0, this.frameBindGroup);
      stepPass.setBindGroup(1, this.birdWrite!);
      stepPass.setBindGroup(2, this.birdGround!);
      stepPass.dispatchWorkgroups(BIRD_FLOCKS + 1);
      stepPass.end();
      this.birdDescriptor.timestampWrites = this.timer.passWrites(PASS_BIRDS);
      const birdPass = encoder.beginRenderPass(this.birdDescriptor);
      birdPass.setBindGroup(0, this.frameBindGroup);
      birdPass.setBindGroup(1, this.birdDraw!);
      birdPass.setPipeline(this.birdPipeline);
      birdPass.draw(CUBE_VERTICES, BIRD_INSTANCES);
      birdPass.end();
      counters.draws++;
      // One bird back to the CPU, for a camera following it. Encoded here and mapped
      // after the submit, like every other readback in the frame.
      if (this.tracked >= 0 && this.birdTrack !== null) {
        this.birdTrack.copy(encoder, this.birdState!, this.tracked * BIRD_STATE_FLOATS * 4);
      }
    }
    // Before the background paints over the near field: compare it against an
    // unculled draw of the same frame.
    if (check) {
      this.near.encodeCullCheck(encoder, this.frameBindGroup, this.width, this.height, target, this.nearDepth.view);
    }
    this.passDescriptor.timestampWrites = this.timer.passWrites(PASS_MAIN);
    // The far field marches after the near passes, so it can read their depth and skip
    // the pixels the raster pass already covered, and before the main pass, which
    // blits it behind them.
    if (this.showFar) {
      // Reach and build budget follow what the far field is costing on this machine.
      this.adaptFar();
      // Follow the camera and sample the slabs that scrolled in, budgeted per frame by
      // FarField so a clipmap that has to catch up never lands on one frame.
      this.far.updateBrushes(camera.chunk[0], camera.chunk[1], camera.chunk[2]);
      this.far.update(camera.worldPosition(0), camera.worldPosition(1), camera.worldPosition(2));
      this.far.encodeBuilds(encoder, timedCompute(PASS_FAR_BUILD));
      if (this.far.ready) {
        this.far.encode(
          encoder,
          this.cameraUniform.invViewProj,
          camera.offset,
          camera.chunk,
          timedCompute(PASS_FAR),
          timedCompute(PASS_FAR_BEAM),
        );
      }
    }
    const pass = encoder.beginRenderPass(this.passDescriptor);
    pass.setBindGroup(0, this.frameBindGroup);
    if (preview) {
      this.preview.drawBlit(pass);
    } else {
      pass.setPipeline(p.sky);
      pass.draw(3);
    }
    // After the sky and the preview, which fill the same pixels and would cover it,
    // and before the grid. The blit binds its own group 0, so the frame's goes back
    // for what follows.
    if (this.showFar && this.far.ready) {
      this.far.blit(pass);
      pass.setBindGroup(0, this.frameBindGroup);
      counters.draws++;
    }
    if (this.showGrid) {
      pass.setPipeline(p.grid);
      pass.draw(6, GRID_INSTANCES);
      counters.draws++;
    }
    pass.setViewport(this.gizmoX, this.gizmoY, this.gizmoSize, this.gizmoSize, 0, 1);
    pass.setPipeline(p.gizmo);
    pass.draw(6);
    counters.draws += 2;
    pass.end();
    // Translucent last: it blends over the background as well as the near field, and
    // it tests against the opaque depth without writing to it.
    if (meshes) {
      this.near.cullTranslucent(encoder, timedCompute(PASS_CULL_T));
      this.nearTDescriptor.timestampWrites = this.timer.passWrites(PASS_NEAR_T);
      const passT = encoder.beginRenderPass(this.nearTDescriptor);
      passT.setBindGroup(0, this.frameBindGroup);
      this.near.drawTranslucent(passT);
      passT.end();
      counters.draws++;
    }
    this.timer.resolve(encoder);
    this.commandBuffers[0] = encoder.finish();
    device.queue.submit(this.commandBuffers);
    this.timer.afterSubmit();
    this.near.afterSubmit();
    if (this.tracked >= 0) this.birdTrack?.afterSubmit();
  }
}
