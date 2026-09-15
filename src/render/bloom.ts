// Bloom over the glowing blocks (`?bloom=1`, off by default). Owns the emission source
// the near field draws into as its second colour attachment, the chain of half-size
// targets the blur runs down and back up, and the composite onto the frame. Shaders in
// bloom.wgsl; the design and what it costs are in plan-living-world.md "Bloom".
//
// Everything here is allocated on resize and reused: a frame encodes a fixed set of
// passes over fixed bind groups (CLAUDE.md "Never allocate in the per-frame path").

import "../gpu/globals.ts";
import { compileShader, createRenderPipeline, type Report } from "../gpu/shader.ts";
import bloomWgsl from "./bloom.wgsl" with { type: "text" };

// The emission source is 8-bit: every emission is under 1 by construction
// (blocks_test.ts), and it is about to be blurred.
export const BLOOM_FORMAT: GPUTextureFormat = "rgba8unorm";
// Half-size levels below the source. Four takes a 1080p frame to 120x68 at the bottom,
// which is a glow about a sixteenth of the frame wide: a soft pool around a cap, not a
// wash over the glade.
const LEVELS = 4;
// How much of the blurred glow lands on the frame. Screen blended, so it cannot clip.
export const DEFAULT_BLOOM_STRENGTH = 0.6;

export class Bloom {
  strength = DEFAULT_BLOOM_STRENGTH;
  // The near field's second colour attachment, in the two states the two phases need.
  readonly sourceClear: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: "clear",
    storeOp: "store",
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
  };
  readonly sourceLoad: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: "load",
    storeOp: "store",
  };

  private readonly device: GPUDevice;
  private readonly layout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly params: GPUBuffer;
  private readonly paramsData = new Float32Array(4);
  private down: GPURenderPipeline | null = null;
  private up: GPURenderPipeline | null = null;
  private composite: GPURenderPipeline | null = null;
  private source: GPUTexture | null = null;
  private readonly levels: GPUTexture[] = [];
  // Bind groups reading each texture: index 0 reads the source, i reads level i - 1.
  private readonly reads: GPUBindGroup[] = [];
  private readonly downPasses: GPURenderPassDescriptor[] = [];
  private readonly upPasses: GPURenderPassDescriptor[] = [];
  private readonly compositeColor: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: "load",
    storeOp: "store",
  };
  private readonly compositePass: GPURenderPassDescriptor;
  // The frame's `bloom` stamp spans the whole chain: its beginning goes on the first
  // downsample and its end on the composite. Two fixed objects filled from the timer's
  // per frame, allocated once.
  private readonly firstWrites: { querySet: GPUQuerySet; beginningOfPassWriteIndex: number } = {
    querySet: undefined as unknown as GPUQuerySet,
    beginningOfPassWriteIndex: 0,
  };
  private readonly lastWrites: { querySet: GPUQuerySet; endOfPassWriteIndex: number } = {
    querySet: undefined as unknown as GPUQuerySet,
    endOfPassWriteIndex: 0,
  };
  private width = 0;
  private height = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.layout = device.createBindGroupLayout({
      label: "bloom",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    // Clamped, so the tent at an edge does not pull in the far side of the frame.
    this.sampler = device.createSampler({
      label: "bloom",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.params = device.createBuffer({
      label: "bloom params",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.compositePass = { label: "bloom composite", colorAttachments: [this.compositeColor] };
  }

  async init(format: GPUTextureFormat, report: Report): Promise<boolean> {
    const device = this.device;
    const module = await compileShader(device, "bloom", [{ name: "render/bloom.wgsl", code: bloomWgsl }], report);
    if (!module) return false;
    const layout = device.createPipelineLayout({ label: "bloom", bindGroupLayouts: [this.layout] });
    const vertex = { module, entryPoint: "vs" };
    const primitive: GPUPrimitiveState = { topology: "triangle-list" };
    const [down, up, composite] = await Promise.all([
      createRenderPipeline(device, {
        label: "bloom down",
        layout,
        vertex,
        fragment: { module, entryPoint: "fs_down", targets: [{ format: BLOOM_FORMAT }] },
        primitive,
      }, report),
      createRenderPipeline(device, {
        label: "bloom up",
        layout,
        vertex,
        fragment: {
          module,
          entryPoint: "fs_up",
          // Added onto the level above: the blur of every level lands on the way up.
          targets: [{
            format: BLOOM_FORMAT,
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" },
            },
          }],
        },
        primitive,
      }, report),
      createRenderPipeline(device, {
        label: "bloom composite",
        layout,
        vertex,
        fragment: {
          module,
          entryPoint: "fs_composite",
          // Screen: src + dst - src * dst, as src * (1 - dst) + dst. Never past white.
          targets: [{
            format,
            blend: {
              color: { srcFactor: "one-minus-dst", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
            },
          }],
        },
        primitive,
      }, report),
    ]);
    if (!down || !up || !composite) return false;
    this.down = down;
    this.up = up;
    this.composite = composite;
    return true;
  }

  get ready(): boolean {
    return this.composite !== null && this.source !== null;
  }

  // The source at the frame's size, and the chain under it. Called with the renderer's
  // resize; a frame smaller than the chain is fine, the bottom levels just get small.
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height && this.source !== null) return;
    this.width = width;
    this.height = height;
    const device = this.device;
    this.source?.destroy();
    for (const t of this.levels) t.destroy();
    this.levels.length = 0;
    this.reads.length = 0;
    this.downPasses.length = 0;
    this.upPasses.length = 0;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.source = device.createTexture({ label: "bloom source", size: [width, height], format: BLOOM_FORMAT, usage });
    const sourceView = this.source.createView();
    this.sourceClear.view = sourceView;
    this.sourceLoad.view = sourceView;
    let w = width, h = height;
    const views: GPUTextureView[] = [sourceView];
    for (let i = 0; i < LEVELS; i++) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      const t = device.createTexture({ label: `bloom level ${i}`, size: [w, h], format: BLOOM_FORMAT, usage });
      this.levels.push(t);
      views.push(t.createView());
    }
    for (let i = 0; i < views.length; i++) {
      this.reads.push(device.createBindGroup({
        label: `bloom read ${i}`,
        layout: this.layout,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: views[i] },
          { binding: 2, resource: { buffer: this.params } },
        ],
      }));
    }
    // Down: level i is written from views[i] (the source or the level above).
    for (let i = 0; i < LEVELS; i++) {
      this.downPasses.push({
        label: `bloom down ${i}`,
        colorAttachments: [{ view: views[i + 1], loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
    }
    // Up: level i - 1 has level i added to it, down to level 0.
    for (let i = LEVELS - 1; i >= 1; i--) {
      this.upPasses.push({
        label: `bloom up ${i}`,
        colorAttachments: [{ view: views[i], loadOp: "load", storeOp: "store" }],
      });
    }
  }

  // Blurs the source down the chain and back, then screens level 0 onto `target`. The
  // frame's `bloom` stamp is split so it spans the chain: a pass descriptor's timestamps
  // bracket that pass alone, so the beginning is written by the first downsample and the
  // end by the composite.
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, timestampWrites?: GPURenderPassTimestampWrites): void {
    if (!this.ready) return;
    if (this.paramsData[0] !== this.strength) {
      this.paramsData[0] = this.strength;
      this.device.queue.writeBuffer(this.params, 0, this.paramsData);
    }
    if (timestampWrites !== undefined) {
      this.firstWrites.querySet = timestampWrites.querySet;
      this.firstWrites.beginningOfPassWriteIndex = timestampWrites.beginningOfPassWriteIndex!;
      this.lastWrites.querySet = timestampWrites.querySet;
      this.lastWrites.endOfPassWriteIndex = timestampWrites.endOfPassWriteIndex!;
    }
    this.downPasses[0].timestampWrites = timestampWrites === undefined ? undefined : this.firstWrites;
    for (let i = 0; i < LEVELS; i++) {
      const pass = encoder.beginRenderPass(this.downPasses[i]);
      pass.setPipeline(this.down!);
      pass.setBindGroup(0, this.reads[i]);
      pass.draw(3);
      pass.end();
    }
    for (let k = 0; k < this.upPasses.length; k++) {
      // upPasses[k] writes level (LEVELS - 1 - k), reading the level below it.
      const from = LEVELS - k; // views index of the level being read
      const pass = encoder.beginRenderPass(this.upPasses[k]);
      pass.setPipeline(this.up!);
      pass.setBindGroup(0, this.reads[from]);
      pass.draw(3);
      pass.end();
    }
    this.compositeColor.view = target;
    this.compositePass.timestampWrites = timestampWrites === undefined ? undefined : this.lastWrites;
    const pass = encoder.beginRenderPass(this.compositePass);
    pass.setPipeline(this.composite!);
    pass.setBindGroup(0, this.reads[1]); // level 0, the finest blurred level
    pass.draw(3);
    pass.end();
  }
}
