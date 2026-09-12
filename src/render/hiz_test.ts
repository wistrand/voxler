// Hi-Z pyramid reduction on Deno's WebGPU (skipped without an adapter): renders a
// depth pattern, builds the pyramid, and checks the two properties the cull pass
// depends on, at a deliberately odd size (levels 35 -> 17 -> 8 ... round down):
//   - a texel is at most the minimum of the depth pixels its level nominally
//     covers (never claims more coverage than it has);
//   - the top level is the minimum of the whole depth buffer (no pixel is lost on
//     the way up, which is what halving an odd size used to do).

import { compileShader, createRenderPipeline } from "../gpu/shader.ts";
import { HiZPyramid } from "./hiz.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const PATTERN = `
// One full-screen triangle whose depth is a different value at every pixel, from
// near at the top left to far at the bottom right, so losing any row or column on
// the way up the pyramid changes a minimum.
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((v << 1u) & 2u), f32(v & 2u));
  return vec4f(p * 2.0 - 1.0, 0.5, 1.0);
}

struct FsOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fs(@builtin(position) position: vec4f) -> FsOut {
  let size = vec2f(61.0, 35.0);
  let t = (floor(position.y) * size.x + floor(position.x)) / (size.x * size.y);
  var out: FsOut;
  out.color = vec4f(1.0);
  out.depth = 0.9 - 0.8 * t; // near at the first pixel, far at the last
  return out;
}
`;

async function readTexture(device: GPUDevice, texture: GPUTexture, level: number, w: number, h: number) {
  const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture, mipLevel: level }, { buffer, bytesPerRow }, [w, h]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.destroy();
  const out: number[][] = [];
  for (let y = 0; y < h; y++) out.push(Array.from(new Float32Array(raw.buffer, y * bytesPerRow, w)));
  return out;
}

Deno.test("hi-z: levels never claim more coverage than they have, at an odd size", async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    console.log("no WebGPU adapter in this Deno; skipping");
    return;
  }
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  const width = 61, height = 35;
  const depth = device.createTexture({
    size: [width, height],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const color = device.createTexture({
    size: [width, height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const module = await compileShader(device, "pattern", [{ name: "pattern", code: PATTERN }], (m) => errors.push(m));
  assert(module !== null, errors.join("\n"));
  const pipeline = await createRenderPipeline(device, {
    layout: "auto",
    vertex: { module: module!, entryPoint: "vs" },
    fragment: { module: module!, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "greater" },
  }, (m) => errors.push(m));
  assert(pipeline !== null, errors.join("\n"));

  const hiz = new HiZPyramid(device);
  assert(await hiz.init((m) => errors.push(m)), errors.join("\n"));
  hiz.resize(width, height, depth);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: color.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "store" },
  });
  pass.setPipeline(pipeline!);
  pass.draw(3);
  pass.end();
  hiz.build(encoder);
  device.queue.submit([encoder.finish()]);

  const depthValues = await readTexture(device, depth, 0, width, height);
  let globalMin = 1;
  for (const row of depthValues) for (const v of row) globalMin = Math.min(globalMin, v);
  for (let level = 0; level < hiz.levels; level++) {
    const w = Math.max(1, hiz.width >> level), h = Math.max(1, hiz.height >> level);
    const got = await readTexture(device, hiz.texture!, level, w, h);
    const span = 2 << level; // depth pixels per texel along each axis
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let nominal = 1;
        for (let sy = y * span; sy < Math.min((y + 1) * span, height); sy++) {
          for (let sx = x * span; sx < Math.min((x + 1) * span, width); sx++) {
            nominal = Math.min(nominal, depthValues[sy][sx]);
          }
        }
        assert(got[y][x] <= nominal, `level ${level} at (${x}, ${y}): ${got[y][x]} above its footprint ${nominal}`);
      }
    }
    if (w === 1 && h === 1) assert(got[0][0] === globalMin, `top level ${got[0][0]}, depth minimum ${globalMin}`);
  }
  assert(hiz.levels > 3, `levels ${hiz.levels}`);
  assert(errors.length === 0, errors.join("\n"));
  device.destroy();
});
