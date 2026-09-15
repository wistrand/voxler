// NearField upload and free bookkeeping on Deno's WebGPU (skipped without an
// adapter): random adds, replacements, and removals, then the quad arena and
// cluster table are read back and checked against the meshes that should be live.

import cameraWgsl from "./camera.wgsl" with { type: "text" };
import { DEFAULT_SKY, SKIES } from "./sky.ts";
import { FlyCamera } from "../camera/camera.ts";
import type { Caps } from "../gpu/caps.ts";
import { BinaryMesher } from "../mesh/binary.ts";
import { ClusterBuilder } from "../mesh/cluster.ts";
import type { MeshJobOutput } from "../mesh/job.ts";
import { meshOutputBytes, readMeshOutput, writeMeshOutput } from "../mesh/output.ts";
import { neighborSetups, testChunks } from "../mesh/testchunks.ts";
import { ChunkData } from "../world/chunk.ts";
import { chunkKey } from "../world/keys.ts";
import { CameraUniform } from "./camera-uniform.ts";
import { NearField } from "./near-field.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

async function readBack(device: GPUDevice, buffer: GPUBuffer, bytes: number): Promise<Uint32Array> {
  const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(staging.getMappedRange().slice(0));
  staging.destroy();
  return out;
}

Deno.test("near field: random adds, replacements, removals leave exactly the live meshes", async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    console.log("no WebGPU adapter in this Deno; skipping");
    return;
  }
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));

  // A few distinct meshes to draw from, as mesh job outputs.
  const mesher = new BinaryMesher();
  const clusters = new ClusterBuilder(32);
  const planes = neighborSetups()[0].planes;
  const meshes = testChunks()
    .filter((c) => ["hills", "terrain-like", "single voxel, center", "slab x < 8", "random 10%"].includes(c.name))
    .map((c) => {
      const opaque = mesher.mesh(ChunkData.fromDense(c.ids), planes);
      clusters.build(opaque);
      const buffer = new ArrayBuffer(meshOutputBytes(clusters));
      writeMeshOutput(buffer, clusters, opaque.count);
      return buffer;
    });
  let recycled = 0;
  const near = new NearField(device, { limits: device.limits } as unknown as Caps, () => recycled++, {
    quadMiB: 8,
    slots: 64,
    clusterQuads: 32, ao: true, textured: true, emissive: true, animated: true,
    blockLight: true,
    shadows: false,
    bloom: false,
  });
  const output = (m: number): MeshJobOutput => ({
    mesh: meshes[m].slice(0),
    bytes: meshes[m].byteLength,
    quads: 0,
    translucentQuads: 0,
    clusters: 0,
    input: null,
  });

  let seed = 7;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const expected = new Map<number, number>(); // key -> mesh index
  let added = 0;
  for (let step = 0; step < 400; step++) {
    const key = chunkKey(Math.floor(rand() * 40), 0, 0);
    if (rand() < 0.3) {
      near.remove(key);
      expected.delete(key);
    } else {
      const m = Math.floor(rand() * meshes.length);
      near.add(key, output(m));
      expected.set(key, m);
      added++;
    }
    if (rand() < 0.5) near.upload(64 << 20);
  }
  near.upload(64 << 20);
  assert(recycled === added, `every added buffer recycled once: ${recycled} of ${added}`);
  assert(near.stats.dropped === 0 && near.stats.pending === 0, `dropped ${near.stats.dropped}`);
  assert(near.stats.chunks === expected.size, `chunks ${near.stats.chunks}, expected ${expected.size}`);

  const high = near.clusterHighWater;
  const desc = await readBack(device, near.clusterBuffer, Math.max(16, high * 16));
  const quads = await readBack(device, near.quadBuffer, near.stats.capacityQuads * 8);
  const owned = new Uint8Array(high);
  const r = new Int32Array(5);
  for (const [key, m] of expected) {
    assert(near.rangesOf(key, r), `key ${key} live`);
    const [slot, quadBase, quadCount, clusterBase, clusterCount] = r;
    const src = readMeshOutput(meshes[m]);
    assert(quadCount === src.quadCount && clusterCount === src.clusterCount, `key ${key}: range sizes`);
    for (let i = 0; i < clusterCount; i++) {
      const c = clusterBase + i;
      owned[c] = 1;
      assert(desc[c * 4] === src.clusters[i * 4] + quadBase, `key ${key} cluster ${i}: offset`);
      assert(desc[c * 4 + 1] === ((src.clusters[i * 4 + 1] | slot) >>> 0), `key ${key} cluster ${i}: slot`);
      assert(desc[c * 4 + 2] === src.clusters[i * 4 + 2], `key ${key} cluster ${i}: AABB`);
    }
    for (let i = 0; i < quadCount * 2; i++) {
      assert(quads[quadBase * 2 + i] === src.quads[i], `key ${key}: quad word ${i}`);
    }
  }
  for (let c = 0; c < high; c++) {
    if (!owned[c]) assert(desc[c * 4 + 1] >>> 24 === 0, `free cluster slot ${c} not empty`);
  }
  assert(errors.length === 0, errors.join("\n"));
  device.destroy();
});

Deno.test("near field: two-phase culled draw matches an unculled one, pixel for pixel, from many poses", async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    console.log("no WebGPU adapter in this Deno; skipping");
    return;
  }
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const reports: string[] = [];
  const report = (m: string) => reports.push(m);

  const frameLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
  });
  const cameraUniform = new CameraUniform(device);
  const frameBindGroup = device.createBindGroup({
    layout: frameLayout,
    entries: [{ binding: 0, resource: { buffer: cameraUniform.buffer } }],
  });
  const near = new NearField(device, { limits: device.limits } as unknown as Caps, () => {}, {
    quadMiB: 16,
    slots: 256,
    clusterQuads: 32, ao: true, textured: true, emissive: true, animated: true,
    blockLight: true,
    shadows: false,
    bloom: false,
  });
  const ok = await near.init({ name: "camera.wgsl", code: cameraWgsl }, SKIES[DEFAULT_SKY], "rgba8unorm", "depth32float", frameLayout, report);
  assert(ok, `init: ${reports.join("\n")}`);

  // A 5 x 2 x 5 block of chunk meshes around the camera chunk.
  const mesher = new BinaryMesher();
  const clusters = new ClusterBuilder(32);
  const planes = neighborSetups()[0].planes;
  const sources = ["hills", "terrain-like", "random 10%"].map((name) => {
    const opaque = mesher.mesh(ChunkData.fromDense(testChunks().find((c) => c.name === name)!.ids), planes);
    clusters.build(opaque);
    const buffer = new ArrayBuffer(meshOutputBytes(clusters));
    writeMeshOutput(buffer, clusters, opaque.count);
    return buffer;
  });
  let n = 0;
  for (let x = -2; x <= 2; x++) {
    for (let y = -1; y <= 0; y++) {
      for (let z = -2; z <= 2; z++) {
        const mesh = sources[n++ % sources.length].slice(0);
        near.add(chunkKey(x, y, z), { mesh, bytes: 0, quads: 0, translucentQuads: 0, clusters: 0, input: null });
      }
    }
  }
  near.upload(1 << 30);

  const camera = new FlyCamera();
  const width = 320, height = 180;
  // Stand-ins for the canvas and depth targets the renderer would draw into.
  const attachment = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
  const color = device.createTexture({ size: [width, height], format: "rgba8unorm", usage: attachment });
  const depth = device.createTexture({ size: [width, height], format: "depth32float", usage: attachment });
  const colorView = color.createView(), depthView = depth.createView();
  near.resize(width, height, depth);
  const nearPass = (load: boolean): GPURenderPassDescriptor => ({
    colorAttachments: [{
      view: colorView,
      loadOp: load ? "load" : "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
    depthStencilAttachment: {
      view: depthView,
      depthClearValue: 0,
      depthLoadOp: load ? "load" : "clear",
      depthStoreOp: "store",
    },
  });
  let seed = 5;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const poses = 24;
  let faceCulled = 0, frustumCulled = 0, occluded = 0, drawn = 0;
  for (let i = 0; i < poses; i++) {
    camera.setPosition((rand() - 0.5) * 80, 4 + rand() * 30, (rand() - 0.5) * 80);
    camera.setOrientation(rand() * 6.28, (rand() - 0.7) * 1.5);
    cameraUniform.write(device.queue, camera, width, height);
    near.prepare(cameraUniform.viewProj, camera.offset, camera.chunk, true);
    const encoder = device.createCommandEncoder();
    // The frame as the renderer draws it: cull A, draw A, Hi-Z, cull B, draw B.
    near.cullA(encoder);
    let pass = encoder.beginRenderPass(nearPass(false));
    pass.setBindGroup(0, frameBindGroup);
    near.draw(pass, 0);
    pass.end();
    near.buildHiZ(encoder);
    near.cullB(encoder);
    near.cullTranslucent(encoder); // also where the counters are copied back
    pass = encoder.beginRenderPass(nearPass(true));
    pass.setBindGroup(0, frameBindGroup);
    near.draw(pass, 1);
    pass.end();
    near.encodeCullCheck(encoder, frameBindGroup, width, height, colorView, depthView);
    device.queue.submit([encoder.finish()]);
    near.afterSubmit();
    // Wait for this pose's readbacks before the next one (the ring has 4 slots).
    const deadline = performance.now() + 10_000;
    while (near.refreshStats().cullChecks < i + 1 && performance.now() < deadline) {
      await device.queue.onSubmittedWorkDone();
      await new Promise((r) => setTimeout(r, 1));
    }
    const s = near.stats;
    assert(s.cullChecks === i + 1, `pose ${i}: check result never arrived`);
    // Phase B tests every cluster: drawn by B, culled, skipped, and already drawn
    // by A must account for the whole table.
    const accounted = s.drawnPhaseB + s.alreadyDrawn + s.faceCulled + s.frustumCulled + s.occludedClusters +
      s.skippedClusters;
    assert(accounted === s.clusters, `pose ${i}: ${accounted} clusters accounted for of ${s.clusters}`);
    faceCulled += s.faceCulled;
    frustumCulled += s.frustumCulled;
    occluded += s.occludedClusters;
    drawn += s.visibleClusters;
  }
  const s = near.stats;
  assert(s.cullCheckFailures === 0, `${s.cullCheckFailures} of ${poses} poses differ, up to ${s.cullCheckMaxDiff} px`);
  assert(
    faceCulled > 0 && frustumCulled > 0 && occluded > 0 && drawn > 0,
    `face ${faceCulled}, frustum ${frustumCulled}, occluded ${occluded}, drawn ${drawn}`,
  );
  assert(errors.length === 0, errors.join("\n"));
  device.destroy();
});

Deno.test("near field: no holes while the camera moves and turns, frame after frame", async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    console.log("no WebGPU adapter in this Deno; skipping");
    return;
  }
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const reports: string[] = [];
  const frameLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
  });
  const cameraUniform = new CameraUniform(device);
  const frameBindGroup = device.createBindGroup({
    layout: frameLayout,
    entries: [{ binding: 0, resource: { buffer: cameraUniform.buffer } }],
  });
  const near = new NearField(device, { limits: device.limits } as unknown as Caps, () => {}, {
    quadMiB: 16,
    slots: 256,
    clusterQuads: 32, ao: true, textured: true, emissive: true, animated: true,
    blockLight: true,
    shadows: false,
    bloom: false,
  });
  assert(
    await near.init({ name: "camera.wgsl", code: cameraWgsl }, SKIES[DEFAULT_SKY], "rgba8unorm", "depth32float", frameLayout, (m) => reports.push(m)),
    reports.join("\n"),
  );
  // Terrain-like chunks in a block, so plenty is hidden behind what is in front.
  const mesher = new BinaryMesher();
  const clusters = new ClusterBuilder(32);
  const planes = neighborSetups()[0].planes;
  const source = (name: string) => {
    const opaque = mesher.mesh(ChunkData.fromDense(testChunks().find((c) => c.name === name)!.ids), planes);
    clusters.build(opaque);
    const buffer = new ArrayBuffer(meshOutputBytes(clusters));
    writeMeshOutput(buffer, clusters, opaque.count);
    return buffer;
  };
  const sources = [source("terrain-like"), source("hills"), source("random 50%")];
  let n = 0;
  for (let x = -2; x <= 2; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -2; z <= 2; z++) {
        near.add(chunkKey(x, y, z), {
          mesh: sources[n++ % sources.length].slice(0),
          bytes: 0,
          quads: 0,
          translucentQuads: 0,
          clusters: 0,
          input: null,
        });
      }
    }
  }
  near.upload(1 << 30);

  const width = 320, height = 180;
  const attachment = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
  const color = device.createTexture({ size: [width, height], format: "rgba8unorm", usage: attachment });
  const depth = device.createTexture({ size: [width, height], format: "depth32float", usage: attachment });
  const colorView = color.createView(), depthView = depth.createView();
  near.resize(width, height, depth);
  const camera = new FlyCamera();
  const frames = 40;
  let occluded = 0;
  for (let f = 0; f < frames; f++) {
    // A slow arc through the block: small steps, so phase A's set stays useful.
    const t = f / frames;
    camera.setPosition(-20 + 50 * t, 14 + 6 * Math.sin(t * 6), -18 + 30 * t);
    camera.setOrientation(t * 3, -0.3 + 0.5 * Math.sin(t * 4));
    cameraUniform.write(device.queue, camera, width, height);
    near.prepare(cameraUniform.viewProj, camera.offset, camera.chunk, true);
    const encoder = device.createCommandEncoder();
    near.cullA(encoder);
    let pass = encoder.beginRenderPass({
      colorAttachments: [{ view: colorView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      depthStencilAttachment: { view: depthView, depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    pass.setBindGroup(0, frameBindGroup);
    near.draw(pass, 0);
    pass.end();
    near.buildHiZ(encoder);
    near.cullB(encoder);
    near.cullTranslucent(encoder); // also where the counters are copied back
    pass = encoder.beginRenderPass({
      colorAttachments: [{ view: colorView, loadOp: "load", storeOp: "store" }],
      depthStencilAttachment: { view: depthView, depthLoadOp: "load", depthStoreOp: "store" },
    });
    pass.setBindGroup(0, frameBindGroup);
    near.draw(pass, 1);
    pass.end();
    near.encodeCullCheck(encoder, frameBindGroup, width, height, colorView, depthView);
    device.queue.submit([encoder.finish()]);
    near.afterSubmit();
    const deadline = performance.now() + 10_000;
    while (near.refreshStats().cullChecks < f + 1 && performance.now() < deadline) {
      await device.queue.onSubmittedWorkDone();
      await new Promise((r) => setTimeout(r, 1));
    }
    assert(near.stats.cullChecks === f + 1, `frame ${f}: check result never arrived`);
    occluded += near.stats.occludedClusters;
  }
  const s = near.stats;
  assert(
    s.cullCheckFailures === 0,
    `${s.cullCheckFailures} of ${frames} frames differ, up to ${s.cullCheckMaxDiff} px, ${s.cullCheckMissing} missing`,
  );
  assert(occluded > 0, "the Hi-Z test culled something");
  assert(errors.length === 0, errors.join("\n"));
  device.destroy();
});

Deno.test({
  name: "near field: the translucent list comes out ordered far to near",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) {
      console.log("no WebGPU adapter in this Deno; skipping");
      return;
    }
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));

    // A chunk with water in it, so the mesh has translucent clusters to sort.
    const mesher = new BinaryMesher();
    const clusters = new ClusterBuilder(32);
    const setup = neighborSetups()[0];
    const chunk = ChunkData.fromDense(testChunks().find((c) => c.name === "hills with water")!.ids);
    const opaque = mesher.mesh(chunk, setup.planes, { borders: setup.borders });
    clusters.build(opaque, undefined, mesher.translucent);
    assert(mesher.translucent.count > 0, "the test chunk should have translucent faces");
    const buffer = new ArrayBuffer(meshOutputBytes(clusters));
    writeMeshOutput(buffer, clusters, opaque.count + mesher.translucent.count);
    const parsed = readMeshOutput(buffer);
    let translucentClusters = 0;
    for (let i = 0; i < parsed.clusterCount; i++) {
      if ((parsed.clusters[i * 4 + 1] >>> 23 & 1) !== 0) translucentClusters++;
    }
    assert(translucentClusters > 0, `the mesh has ${parsed.clusterCount} clusters, none translucent`);

    const near = new NearField(device, { limits: device.limits } as unknown as Caps, () => {}, {
      quadMiB: 16,
      slots: 64,
      clusterQuads: 32,
      ao: true,
      textured: true, emissive: true, animated: true,
    blockLight: true,
    shadows: false,
    bloom: false,
    });
    const camera = new FlyCamera();
    const cameraUniform = new CameraUniform(device);
    const frameLayout = device.createBindGroupLayout({
      label: "frame",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }],
    });
    const frameBindGroup = device.createBindGroup({
      label: "frame",
      layout: frameLayout,
      entries: [{ binding: 0, resource: { buffer: cameraUniform.buffer } }],
    });
    assert(await near.init({ name: "camera.wgsl", code: cameraWgsl }, SKIES[DEFAULT_SKY], "rgba8unorm", "depth32float", frameLayout, (m) => errors.push(m)), errors.join("\n"));

    // The same mesh in a line of chunks running away from the camera.
    const keys: number[] = [];
    for (let i = 0; i < 8; i++) {
      const key = chunkKey(0, 0, -i);
      keys.push(key);
      near.add(key, { mesh: buffer.slice(0), bytes: buffer.byteLength, quads: 0, translucentQuads: 0, clusters: 0, input: null });
    }
    near.upload(1 << 24);
    const width = 256, height = 256;
    const depth = device.createTexture({
      size: [width, height],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    near.resize(width, height, depth);
    camera.setPosition(16, 16, 40);
    camera.setOrientation(0, 0);
    cameraUniform.write(device.queue, camera, width, height);
    near.prepare(cameraUniform.viewProj, camera.offset, camera.chunk, false);
    const encoder = device.createCommandEncoder();
    near.cullA(encoder);
    near.cullB(encoder);
    near.cullTranslucent(encoder);
    device.queue.submit([encoder.finish()]);
    near.afterSubmit();
    for (let i = 0; i < 200 && near.refreshStats().clusters === 0; i++) {
      await device.queue.onSubmittedWorkDone();
      await new Promise((r) => setTimeout(r, 1));
    }
    // Give the counter readback a few turns to land whatever it is going to land.
    for (let i = 0; i < 50; i++) {
      near.refreshStats();
      await new Promise((r) => setTimeout(r, 1));
    }

    const b = near.translucentBuffers;
    const args = await readBack(device, b.args, 16);
    const count = args[1];
    assert(count > 0, `the translucent pass drew nothing to sort (${near.refreshStats().clusters} clusters)`);
    const visible = (await readBack(device, b.visible, count * 4)).subarray(0, count);
    const sorted = (await readBack(device, b.sorted, count * 4)).subarray(0, count);
    // A permutation: every appended cluster appears once in the sorted list.
    const a = Array.from(visible).sort((x, y) => x - y);
    const c = Array.from(sorted).sort((x, y) => x - y);
    assert(a.join() === c.join(), `the sorted list is not a permutation of the visible one (${count} entries)`);
    assert(errors.length === 0, errors.join("\n"));
    depth.destroy();
  },
});
