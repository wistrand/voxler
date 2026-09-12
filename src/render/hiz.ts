// Hi-Z depth pyramid (plan-rendering phase 4): half-resolution mip chain of minimum
// depth, rebuilt each frame from the near field's depth buffer between the two cull
// phases. The cull pass reads it to drop clusters hidden behind what is already
// drawn (hiz.wgsl explains the reduction and why it stays conservative).

import hizWgsl from "./hiz.wgsl" with { type: "text" };
import "../gpu/globals.ts";
import { compileShader, type Report } from "../gpu/shader.ts";

const WORKGROUP = 8;

export class HiZPyramid {
  levels = 0;
  width = 0;
  height = 0;
  private readonly device: GPUDevice;
  private readonly depthLayout: GPUBindGroupLayout;
  private readonly levelLayout: GPUBindGroupLayout;
  private depthPipeline: GPUComputePipeline | null = null;
  private levelPipeline: GPUComputePipeline | null = null;
  texture: GPUTexture | null = null;
  private sampledView: GPUTextureView | null = null;
  private groups: GPUBindGroup[] = []; // one per level: level 0 from depth, then each from the last
  private readonly sizes: [number, number][] = [];
  private readonly descriptor: GPUComputePassDescriptor = { label: "hiz" };

  constructor(device: GPUDevice) {
    this.device = device;
    this.depthLayout = device.createBindGroupLayout({
      label: "hiz from depth",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "r32float" },
        },
      ],
    });
    this.levelLayout = device.createBindGroupLayout({
      label: "hiz level",
      entries: [
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "r32float" },
        },
      ],
    });
  }

  async init(report: Report): Promise<boolean> {
    const device = this.device;
    const module = await compileShader(device, "hiz", [{ name: "render/hiz.wgsl", code: hizWgsl }], report);
    if (!module) return false;
    try {
      [this.depthPipeline, this.levelPipeline] = await Promise.all([
        device.createComputePipelineAsync({
          label: "hiz from depth",
          layout: device.createPipelineLayout({ label: "hiz from depth", bindGroupLayouts: [this.depthLayout] }),
          compute: { module, entryPoint: "reduce_depth" },
        }),
        device.createComputePipelineAsync({
          label: "hiz level",
          layout: device.createPipelineLayout({ label: "hiz level", bindGroupLayouts: [this.levelLayout] }),
          compute: { module, entryPoint: "reduce_level" },
        }),
      ]);
    } catch (err) {
      report(`hiz pipelines: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    return true;
  }

  get ready(): boolean {
    return this.sampledView !== null;
  }

  // The whole pyramid, for the cull pass (textureLoad per level).
  get view(): GPUTextureView {
    return this.sampledView!;
  }

  // Rebuilds the pyramid for a new depth target. Not per frame.
  resize(width: number, height: number, depth: GPUTexture): void {
    this.texture?.destroy();
    this.width = Math.max(1, width >> 1);
    this.height = Math.max(1, height >> 1);
    this.levels = Math.floor(Math.log2(Math.max(this.width, this.height))) + 1;
    const device = this.device;
    this.texture = device.createTexture({
      label: "hiz",
      size: [this.width, this.height],
      mipLevelCount: this.levels,
      format: "r32float",
      // COPY_SRC so tests can read levels back.
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.sampledView = this.texture.createView({ label: "hiz sampled" });
    const level = (i: number) =>
      this.texture!.createView({ label: `hiz level ${i}`, baseMipLevel: i, mipLevelCount: 1 });
    this.groups = [
      device.createBindGroup({
        label: "hiz from depth",
        layout: this.depthLayout,
        entries: [
          { binding: 0, resource: depth.createView({ label: "depth for hiz" }) },
          { binding: 1, resource: level(0) },
        ],
      }),
    ];
    this.sizes.length = 0;
    this.sizes.push([this.width, this.height]);
    for (let i = 1; i < this.levels; i++) {
      this.sizes.push([Math.max(1, this.width >> i), Math.max(1, this.height >> i)]);
      this.groups.push(device.createBindGroup({
        label: `hiz level ${i}`,
        layout: this.levelLayout,
        entries: [{ binding: 2, resource: level(i - 1) }, { binding: 3, resource: level(i) }],
      }));
    }
  }

  // Encodes the reduction chain; the depth target must be written and the pass
  // ended before this.
  build(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void {
    if (!this.sampledView || !this.depthPipeline || !this.levelPipeline) return;
    this.descriptor.timestampWrites = timestampWrites;
    const pass = encoder.beginComputePass(this.descriptor);
    for (let i = 0; i < this.groups.length; i++) {
      pass.setPipeline(i === 0 ? this.depthPipeline : this.levelPipeline);
      pass.setBindGroup(0, this.groups[i]);
      const [w, h] = this.sizes[i];
      pass.dispatchWorkgroups(Math.ceil(w / WORKGROUP), Math.ceil(h / WORKGROUP));
    }
    pass.end();
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.sampledView = null;
  }
}
