// Sphere-traced preview of a world program. Renders at a reduced resolution
// (`scale`, default from ?previewScale) into offscreen color and depth targets in
// its own pass, then the main pass upscales it (drawBlit). Owned by Renderer and
// rebuilt with it after device loss. A world that fails to compile disables the
// preview only.

import "../gpu/globals.ts";
import cameraWgsl from "../render/camera.wgsl" with { type: "text" };
import brushWgsl from "../brush/brush.wgsl" with { type: "text" };
import shadingWgsl from "../render/shading.wgsl" with { type: "text" };
import skyColorWgsl from "../render/sky-color.wgsl" with { type: "text" };
import { skyConstantsWgsl } from "../render/sky.ts";
import { compileShader, createRenderPipeline, type Report } from "../gpu/shader.ts";
import { type BrushGrid, GRID_CELLS, MAX_GRID_OP_WORDS, MAX_GRID_RECORDS } from "../brush/grid.ts";
import { INSTANCE_WORDS } from "../brush/format.ts";
import { BLOCK_TABLE_FLOATS, blockColorTable } from "../world/blocks.ts";
import type { WorldProgram } from "../worlds/index.ts";
import blitWgsl from "./preview-blit.wgsl" with { type: "text" };
import previewWgsl from "./preview.wgsl" with { type: "text" };
import { worldSources } from "./sources.ts";

// struct World in preview.wgsl: seed + 3 pad words, then MAX_BLOCK_TYPES vec4f colors.
const WORLD_UNIFORM_SIZE = 16 + BLOCK_TABLE_FLOATS * 4;
const COLOR_FORMAT: GPUTextureFormat = "rgba8unorm"; // filterable, for the bilinear upscale
const DEPTH_FORMAT: GPUTextureFormat = "r32float"; // depth as a color target; read with textureLoad

type TimestampWrites = NonNullable<GPURenderPassDescriptor["timestampWrites"]>;

export class SdfPreview {
  readonly scale: number;
  private readonly device: GPUDevice;
  private readonly worldLayout: GPUBindGroupLayout;
  private readonly worldBindGroup: GPUBindGroup;
  private readonly blitLayout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private tracePipeline: GPURenderPipeline | null = null;
  private blitPipeline: GPURenderPipeline | null = null;
  private colorTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;
  private blitBindGroup: GPUBindGroup | null = null;

  private readonly colorAttachment: GPURenderPassColorAttachment;
  private readonly depthAttachment: GPURenderPassColorAttachment;
  private readonly passDescriptor: GPURenderPassDescriptor;
  // The brush grid this preview traces, or null when nothing places brushes.
  grid: BrushGrid | null = null;
  private readonly worldBuffer: GPUBuffer;
  private readonly header: Int32Array; // seed, then the grid origin
  private readonly brushRecords: GPUBuffer;
  private readonly brushOps: GPUBuffer;
  private readonly brushCells: GPUBuffer;

  constructor(device: GPUDevice, world: WorldProgram, scale: number) {
    this.device = device;
    this.scale = scale;
    const buffer = device.createBuffer({
      label: "world",
      size: WORLD_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const data = new ArrayBuffer(WORLD_UNIFORM_SIZE);
    new Uint32Array(data, 0, 4)[0] = world.seed >>> 0;
    blockColorTable(new Float32Array(data, 16), 0);
    device.queue.writeBuffer(buffer, 0, data);
    this.worldBuffer = buffer;
    this.header = new Int32Array(data, 0, 4);

    // Field brushes near the camera (plan-world-modelling phase 6). Allocated even
    // when nothing places brushes: the trace reads a cell per step whatever the
    // world holds, and an empty grid costs one load.
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.brushRecords = device.createBuffer({
      label: "preview brush records",
      size: MAX_GRID_RECORDS * INSTANCE_WORDS * 4,
      usage: storage,
    });
    this.brushOps = device.createBuffer({ label: "preview brush ops", size: MAX_GRID_OP_WORDS * 4, usage: storage });
    this.brushCells = device.createBuffer({ label: "preview brush cells", size: GRID_CELLS * 16, usage: storage });

    const fragment = GPUShaderStage.FRAGMENT;
    this.worldLayout = device.createBindGroupLayout({
      label: "world",
      entries: [
        { binding: 0, visibility: fragment, buffer: { type: "uniform" } },
        { binding: 1, visibility: fragment, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: fragment, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: fragment, buffer: { type: "read-only-storage" } },
      ],
    });
    this.worldBindGroup = device.createBindGroup({
      label: "world",
      layout: this.worldLayout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: { buffer: this.brushRecords } },
        { binding: 2, resource: { buffer: this.brushOps } },
        { binding: 3, resource: { buffer: this.brushCells } },
      ],
    });
    this.blitLayout = device.createBindGroupLayout({
      label: "preview blit",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.sampler = device.createSampler({ label: "preview", magFilter: "linear", minFilter: "linear" });

    this.colorAttachment = {
      view: undefined as unknown as GPUTextureView, // set in resize()
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    };
    this.depthAttachment = {
      view: undefined as unknown as GPUTextureView, // set in resize()
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    };
    this.passDescriptor = { label: "preview", colorAttachments: [this.colorAttachment, this.depthAttachment] };
  }

  // Pipelines built (the world compiled). Drawing also needs resize() to have run.
  get ready(): boolean {
    return this.tracePipeline !== null && this.blitPipeline !== null;
  }

  // Builds the pipelines. False (errors already reported) if the world fails.
  async init(
    world: WorldProgram,
    format: GPUTextureFormat,
    mainDepthFormat: GPUTextureFormat,
    frameLayout: GPUBindGroupLayout,
    report: Report,
  ): Promise<boolean> {
    const device = this.device;
    const [traceModule, blitModule] = await Promise.all([
      compileShader(device, `preview (${world.name})`, [
        { name: "camera.wgsl", code: cameraWgsl },
        { name: "sky.wgsl (generated)", code: skyConstantsWgsl(world.sky) },
        { name: "sky-color.wgsl", code: skyColorWgsl },
        { name: "shading.wgsl", code: shadingWgsl },
        { name: "brush/brush.wgsl", code: brushWgsl },
        ...worldSources(world),
        { name: "sdf/preview.wgsl", code: previewWgsl },
      ], report),
      compileShader(device, "preview blit", [{ name: "sdf/preview-blit.wgsl", code: blitWgsl }], report),
    ]);
    if (!traceModule || !blitModule) return false;
    [this.tracePipeline, this.blitPipeline] = await Promise.all([
      createRenderPipeline(device, {
        label: `preview (${world.name})`,
        layout: device.createPipelineLayout({ label: "preview", bindGroupLayouts: [frameLayout, this.worldLayout] }),
        vertex: { module: traceModule, entryPoint: "vs" },
        fragment: { module: traceModule, entryPoint: "fs", targets: [{ format: COLOR_FORMAT }, { format: DEPTH_FORMAT }] },
      }, report),
      createRenderPipeline(device, {
        label: "preview blit",
        layout: device.createPipelineLayout({ label: "preview blit", bindGroupLayouts: [frameLayout, this.blitLayout] }),
        vertex: { module: blitModule, entryPoint: "vs" },
        fragment: { module: blitModule, entryPoint: "fs", targets: [{ format }] },
        // "greater-equal": the near-field meshes drawn before it stay in front
        // where they are closer; preview misses (depth 0) fill only the background.
        depthStencil: { format: mainDepthFormat, depthWriteEnabled: true, depthCompare: "greater-equal" },
      }, report),
    ]);
    return this.tracePipeline !== null && this.blitPipeline !== null;
  }

  // Sizes the offscreen targets for a canvas of width x height. Not per frame.
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    if (this.colorTexture && this.colorTexture.width === w && this.colorTexture.height === h) return;
    this.colorTexture?.destroy();
    this.depthTexture?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.colorTexture = this.device.createTexture({ label: "preview color", size: [w, h], format: COLOR_FORMAT, usage });
    this.depthTexture = this.device.createTexture({ label: "preview depth", size: [w, h], format: DEPTH_FORMAT, usage });
    const colorView = this.colorTexture.createView();
    const depthView = this.depthTexture.createView();
    this.colorAttachment.view = colorView;
    this.depthAttachment.view = depthView;
    this.blitBindGroup = this.device.createBindGroup({
      label: "preview blit",
      layout: this.blitLayout,
      entries: [
        { binding: 0, resource: colorView },
        { binding: 1, resource: depthView },
        { binding: 2, resource: this.sampler },
      ],
    });
  }

  // Runs the trace pass. Call before the main pass; group 0 is the frame bind group.
  // Rebuilds the brush grid around the camera chunk and uploads it when it changed.
  // Cheap when nothing moved: the grid compares the store's version and the chunk.
  updateBrushes(cx: number, cy: number, cz: number): void {
    const grid = this.grid;
    if (grid === null || !grid.update(cx, cy, cz)) return;
    const q = this.device.queue;
    q.writeBuffer(this.brushCells, 0, grid.cells);
    if (grid.recordCount > 0) q.writeBuffer(this.brushRecords, 0, grid.records, 0, grid.recordCount * INSTANCE_WORDS);
    if (grid.opWords > 0) q.writeBuffer(this.brushOps, 0, grid.ops, 0, grid.opWords);
    this.header[1] = grid.origin[0];
    this.header[2] = grid.origin[1];
    this.header[3] = grid.origin[2];
    q.writeBuffer(this.worldBuffer, 0, this.header);
  }

  encode(encoder: GPUCommandEncoder, frameBindGroup: GPUBindGroup, timestamps: TimestampWrites | undefined): void {
    if (!this.tracePipeline || !this.colorTexture) return;
    this.passDescriptor.timestampWrites = timestamps;
    const pass = encoder.beginRenderPass(this.passDescriptor);
    pass.setBindGroup(0, frameBindGroup);
    pass.setBindGroup(1, this.worldBindGroup);
    pass.setPipeline(this.tracePipeline);
    pass.draw(3);
    pass.end();
  }

  // Upscales into the main pass (color and depth). Group 0 must already be set.
  drawBlit(pass: GPURenderPassEncoder): void {
    if (!this.blitPipeline || !this.blitBindGroup) return;
    pass.setBindGroup(1, this.blitBindGroup);
    pass.setPipeline(this.blitPipeline);
    pass.draw(3);
  }
}
