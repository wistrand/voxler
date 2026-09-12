// Draw builtins self-test (plan-rendering phase 1): checks, on the running
// browser and backend, the draw semantics the near field relies on:
// - vertex_index includes firstVertex (direct draws select a face group with it);
// - instance_index includes firstInstance (direct draws pass the chunk slot);
// - drawIndirect with firstInstance 0 sees instance_index from 0;
// - with cullMode "back" and frontFace "ccw", a triangle counter-clockwise in NDC
//   is drawn and a clockwise one is culled (the mesh winding tables assume it).
// Runs once at renderer start; one small render pass and a readback, off the
// frame path.

import testWgsl from "./draw-test.wgsl" with { type: "text" };
import "../gpu/globals.ts";
import { compileShader, createRenderPipeline, type Report } from "../gpu/shader.ts";

const EMPTY = 0xffffffff;

interface Case {
  name: string;
  expected: number; // (vertex_index << 16) | instance_index, or EMPTY
}

const CASES: Case[] = [
  { name: "draw(3, 1, firstVertex 30, firstInstance 5)", expected: (30 << 16) | 5 },
  { name: "draw(3, 3, firstVertex 0, firstInstance 20): last instance", expected: 22 },
  { name: "drawIndirect(3, 2, firstVertex 12, firstInstance 0): last instance", expected: (12 << 16) | 1 },
  { name: "counter-clockwise triangle, cull back", expected: 7 },
  { name: "clockwise triangle, cull back", expected: EMPTY },
];

// Resolves to null when every case passes, else a description of the failures.
export async function runDrawTest(device: GPUDevice, report: Report): Promise<string | null> {
  const module = await compileShader(device, "draw test", [{ name: "render/draw-test.wgsl", code: testWgsl }], report);
  if (!module) return "shader failed to compile";
  const layout = device.createPipelineLayout({ label: "draw test", bindGroupLayouts: [] });
  const pipeline = (entryPoint: string) =>
    createRenderPipeline(device, {
      label: `draw test ${entryPoint}`,
      layout,
      vertex: { module, entryPoint },
      fragment: { module, entryPoint: "fs", targets: [{ format: "r32uint" }] },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
    }, report);
  const [ccw, cw] = await Promise.all([pipeline("vs_ccw"), pipeline("vs_cw")]);
  if (!ccw || !cw) return "pipelines failed";

  const width = CASES.length;
  const target = device.createTexture({
    label: "draw test",
    size: [width, 1],
    format: "r32uint",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const indirect = device.createBuffer({
    label: "draw test indirect",
    size: 16,
    usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indirect, 0, new Uint32Array([3, 2, 12, 0]));
  const readback = device.createBuffer({
    label: "draw test readback",
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder({ label: "draw test" });
  const pass = encoder.beginRenderPass({
    label: "draw test",
    colorAttachments: [{
      view: target.createView(),
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: EMPTY, g: 0, b: 0, a: 0 },
    }],
  });
  const at = (i: number) => pass.setViewport(i, 0, 1, 1, 0, 1);
  pass.setPipeline(ccw);
  at(0);
  pass.draw(3, 1, 30, 5);
  at(1);
  pass.draw(3, 3, 0, 20);
  at(2);
  pass.drawIndirect(indirect, 0);
  at(3);
  pass.draw(3, 1, 0, 7);
  pass.setPipeline(cw);
  at(4);
  pass.draw(3, 1, 0, 9);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256 }, [width, 1]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const got = new Uint32Array(readback.getMappedRange().slice(0, width * 4));
  readback.unmap();
  target.destroy();
  indirect.destroy();
  readback.destroy();

  const failures: string[] = [];
  CASES.forEach((c, i) => {
    if (got[i] !== c.expected) {
      const show = (v: number) => (v === EMPTY ? "nothing" : `vertex ${v >>> 16} instance ${v & 0xffff}`);
      failures.push(`${c.name}: got ${show(got[i])}, expected ${show(c.expected)}`);
    }
  });
  return failures.length === 0 ? null : failures.join("; ");
}
