// Bloom (src/render/bloom.ts): the shader compiles and its three pipelines build on
// Deno's WebGPU (skipped without an adapter), and the near shader's second entry point
// writes what bloom needs, checked as text because the rule it encodes is in the source:
// the glow it emits has to be the fogged glow, or a grove of caps past the fog puts a
// halo on the horizon.

import { compileShader } from "../gpu/shader.ts";
import bloomWgsl from "./bloom.wgsl" with { type: "text" };

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const NEAR = Deno.readTextFileSync("src/render/near.wgsl");
const BIRDS = Deno.readTextFileSync("src/render/birds.wgsl");

Deno.test("the near shader has both entry points, and the bloom one emits the fogged glow", () => {
  assert(/@fragment\s+fn fs\(/.test(NEAR), "fs is gone");
  assert(/@fragment\s+fn fs_bloom\(/.test(NEAR), "fs_bloom is gone; the bloom pipeline has no entry point");
  assert(/@location\(1\)\s+glow/.test(NEAR), "fs_bloom no longer writes location 1, which is bloom's source");
  assert(/exp\(-dist \* FOG_DENSITY\)/.test(NEAR), "the glow output is no longer fogged with the surface");
});

Deno.test("the bird shader has a bloom entry point that writes no glow, so a bird covers what is under it", () => {
  assert(/@fragment\s+fn fs\(/.test(BIRDS), "fs is gone");
  assert(/@fragment\s+fn fs_bloom\(/.test(BIRDS), "fs_bloom is gone; the bloom bird pipeline has no entry point");
  assert(/@location\(1\)\s+glow/.test(BIRDS), "fs_bloom no longer writes location 1, which is bloom's source");
  assert(/vec4f\(0\.0, 0\.0, 0\.0, 1\.0\)/.test(BIRDS), "a bird's glow output is no longer zero");
});

Deno.test("bloom's three pipelines build", async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    console.log("no WebGPU adapter in this Deno; skipping");
    return;
  }
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  const module = await compileShader(device, "bloom", [{ name: "bloom.wgsl", code: bloomWgsl }], (m) => errors.push(m));
  assert(module !== null, errors.join("\n"));
  for (const entryPoint of ["fs_down", "fs_up", "fs_composite"]) {
    device.pushErrorScope("validation");
    await device.createRenderPipelineAsync({
      label: entryPoint,
      layout: "auto",
      vertex: { module: module!, entryPoint: "vs" },
      fragment: { module: module!, entryPoint, targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });
    const err = await device.popErrorScope();
    assert(err === null, `${entryPoint}: ${err?.message}`);
  }
  device.destroy();
});
