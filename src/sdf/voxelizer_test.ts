// Voxelizer property tests on Deno's built-in WebGPU (wgpu/naga, headless). They
// check properties, never cross-machine hashes (CLAUDE.md "Invariants"). Skipped
// with a message when Deno has no GPU adapter.

import { BrushBatch } from "../brush/batch.ts";
import { packCsg } from "../brush/build.ts";
import { BLEND_SUBTRACT, BLEND_UNION, BRUSH_CSG, PRIM_BOX, PRIM_ELLIPSOID, PRIM_SPHERE, PRIM_TORUS } from "../brush/format.ts";
import { foldInstances } from "../brush/field.ts";
import { BrushStore } from "../brush/store.ts";
import { random01 } from "../util/random.ts";
import { BLOCKS } from "../world/blocks.ts";
import { voxelIndex } from "../world/coords.ts";
import { WORLDS, type WorldProgram } from "../worlds/index.ts";

const BRICK = BLOCKS.find((b) => b.name === "brick")!.id;
const DIRT = BLOCKS.find((b) => b.name === "dirt")!.id;
import { CHUNK_AIR, CHUNK_DENSE, CHUNK_UNIFORM, type VoxelResult, Voxelizer, VOXELS_PER_CHUNK } from "./voxelizer.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

async function gpuDevice(): Promise<GPUDevice | null> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    console.log("no WebGPU adapter in this Deno; skipping");
    return null;
  }
  return await adapter.requestDevice();
}

function world(name: string, code: string, seed = 1): WorldProgram {
  return { name, code, seed, spawn: [0, 0, 0] };
}

// Voxelizes the given chunk coordinates and returns results keyed "cx,cy,cz".
async function voxelize(
  device: GPUDevice,
  w: WorldProgram,
  chunks: readonly [number, number, number][],
  skip = true,
  brushes: BrushBatch | null = null,
): Promise<Map<string, VoxelResult>> {
  const errors: string[] = [];
  const v = new Voxelizer(device, w, (m) => errors.push(m), { skip });
  v.fieldBrushes = brushes;
  assert(await v.init(), `voxelizer init failed: ${errors.join("\n")}`);
  const out = new Map<string, VoxelResult>();
  v.onResult = (r) => out.set(`${r.cx},${r.cy},${r.cz}`, { ...r, ids: r.ids ? r.ids.slice() : null });
  for (const [x, y, z] of chunks) v.queueChunk(x, y, z);
  const deadline = performance.now() + 60_000;
  while (!v.idle && performance.now() < deadline) {
    v.pump(4);
    await new Promise((r) => setTimeout(r, 1));
  }
  assert(v.idle, "voxelizer did not finish");
  assert(errors.length === 0, errors.join("\n"));
  return out;
}

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) out.push([x, y, z]);
  return out;
}

function solidCount(r: VoxelResult): number {
  if (r.kind === CHUNK_AIR) return 0;
  if (r.kind === CHUNK_UNIFORM) return VOXELS_PER_CHUNK;
  let n = 0;
  for (const id of r.ids!) if (id !== 0) n++;
  return n;
}

const SPHERE = (radius: number) => `
const WORLD_LIPSCHITZ: f32 = 1.0;
fn world_sdf(p: WorldPoint) -> f32 { return length(wp_local(p, vec3i(0))) - ${radius.toFixed(1)}; }
fn world_material(p: WorldPoint) -> u32 { return BLOCK_STONE; }
`;

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "a sphere's voxel count matches its volume",
  ...opts,
  fn: async () => {
    const device = await gpuDevice();
    if (!device) return;
    const r = 20;
    const results = await voxelize(device, world("sphere", SPHERE(r)), box(-1, 0, -1, 0, -1, 0));
    let solid = 0;
    for (const res of results.values()) {
      solid += solidCount(res);
      assert(res.kind === CHUNK_DENSE, `chunk ${res.cx},${res.cy},${res.cz} should be dense`);
    }
    const volume = (4 / 3) * Math.PI * r ** 3;
    assert(Math.abs(solid - volume) / volume < 0.015, `solid ${solid} vs volume ${volume.toFixed(0)}`);
  },
});

Deno.test({
  name: "chunks fully inside or outside are uniform or air",
  ...opts,
  fn: async () => {
    const device = await gpuDevice();
    if (!device) return;
    const results = await voxelize(device, world("big", SPHERE(200)), [[0, 0, 0], [20, 0, 0]]);
    const inside = results.get("0,0,0")!;
    const outside = results.get("20,0,0")!;
    assert(inside.kind === CHUNK_UNIFORM && inside.blockId === 1, `inside kind ${inside.kind} id ${inside.blockId}`);
    assert(outside.kind === CHUNK_AIR, `outside kind ${outside.kind}`);
  },
});

Deno.test({
  name: "voxel ids follow the x + z*32 + y*1024 layout",
  ...opts,
  fn: async () => {
    const device = await gpuDevice();
    if (!device) return;
    // Solid where local x < 5; the id encodes local y and z.
    const code = `
const WORLD_LIPSCHITZ: f32 = 1.0;
fn world_sdf(p: WorldPoint) -> f32 { return select(1.0, -1.0, (p.cell.x & 31) < 5); }
fn world_material(p: WorldPoint) -> u32 { return 1u + u32(p.cell.y & 31) * 32u + u32(p.cell.z & 31); }
`;
    const res = (await voxelize(device, world("layout", code), [[2, -1, 3]], false)).get("2,-1,3")!;
    assert(res.kind === CHUNK_DENSE, "dense");
    for (const [x, y, z] of [[0, 0, 0], [4, 31, 17], [5, 3, 3], [31, 31, 31], [1, 12, 30]]) {
      const expected = x < 5 ? 1 + y * 32 + z : 0;
      const got = res.ids![x + z * 32 + y * 1024];
      assert(got === expected, `voxel ${x},${y},${z}: ${got} !== ${expected}`);
    }
  },
});

Deno.test({
  name: "skipping by the Lipschitz bound never changes the result (real worlds)",
  ...opts,
  fn: async () => {
    const device = await gpuDevice();
    if (!device) return;
    const cases: [string, [number, number, number][]][] = [
      ["showcase", box(-2, 1, -1, 1, -2, 1)],
      ["terrain", box(-1, 0, 0, 4, -1, 0)], // surface near the origin is about y = 75
    ];
    for (const [name, chunks] of cases) {
      const w = world(name, WORLDS[name].code);
      const fast = await voxelize(device, w, chunks, true);
      const full = await voxelize(device, w, chunks, false);
      for (const [key, a] of full) {
        const b = fast.get(key)!;
        assert(a.kind === b.kind && a.blockId === b.blockId, `${name} ${key}: kind ${b.kind} vs ${a.kind}`);
        if (a.ids) {
          for (let i = 0; i < VOXELS_PER_CHUNK; i++) {
            assert(a.ids[i] === b.ids![i], `${name} ${key}: voxel ${i} differs (${b.ids![i]} vs ${a.ids[i]})`);
          }
        }
      }
    }
  },
});

Deno.test({
  name: "voxelizing the same chunks twice gives identical ids",
  ...opts,
  fn: async () => {
    const device = await gpuDevice();
    if (!device) return;
    const w = world("terrain", WORLDS.terrain.code, 7);
    const chunks = box(0, 1, 1, 3, 0, 1);
    const a = await voxelize(device, w, chunks);
    const b = await voxelize(device, w, chunks);
    for (const [key, ra] of a) {
      const rb = b.get(key)!;
      assert(ra.kind === rb.kind && ra.blockId === rb.blockId, `${key} kind`);
      if (ra.ids) assert(ra.ids.every((v, i) => v === rb.ids![i]), `${key} ids differ`);
    }
  },
});

// A world of empty space, so what the voxelizer produces is entirely the brushes.
const EMPTY = `
const WORLD_LIPSCHITZ: f32 = 1.0;
fn world_sdf(p: WorldPoint) -> f32 { return 1e9; }
fn world_material(p: WorldPoint) -> u32 { return BLOCK_STONE; }
`;

// A flat world, solid below y = 0, for carving into.
const GROUND = `
const WORLD_LIPSCHITZ: f32 = 1.0;
fn world_sdf(p: WorldPoint) -> f32 { return f32(p.cell.y) + p.frac.y; }
fn world_material(p: WorldPoint) -> u32 { return BLOCK_DIRT; }
`;

function brushStore(): BrushStore {
  return new BrushStore();
}

// The voxel ids of a chunk, whatever kind it came back as.
function idsOf(r: VoxelResult): Uint16Array {
  if (r.kind === CHUNK_DENSE) return r.ids!;
  const out = new Uint16Array(VOXELS_PER_CHUNK);
  if (r.kind === CHUNK_UNIFORM) out.fill(r.blockId);
  return out;
}

Deno.test({
  name: "a CSG brush appears in the voxels, with its own material",
  ...opts,
  fn: async () => {
    const device = await gpuDevice();
    if (!device) return;
    const store = brushStore();
    const radius = 10;
    store.add({
      kind: BRUSH_CSG,
      cell: [16, 16, 16],
      material: BRICK,
      ops: packCsg([{ prim: PRIM_SPHERE, params: [radius] }]),
    });
    const results = await voxelize(device, world("empty", EMPTY), box(0, 0, 0, 0, 0, 0), true, new BrushBatch(store));
    const ids = idsOf(results.get("0,0,0")!);
    let solid = 0;
    for (const id of ids) {
      if (id === 0) continue;
      solid++;
      assert(id === BRICK, `a voxel came out as ${id}, not the brush's material`);
    }
    const volume = (4 / 3) * Math.PI * radius ** 3;
    assert(Math.abs(solid - volume) / volume < 0.02, `solid ${solid} vs sphere volume ${volume.toFixed(0)}`);
    // And the voxels are where the brush is.
    assert(ids[voxelIndex(16, 16, 16)] === BRICK, "the centre is solid");
    assert(ids[voxelIndex(1, 1, 1)] === 0, "a far corner is not");
  },
});

Deno.test({
  name: "a subtract brush carves the world, and the world keeps its own material",
  ...opts,
  fn: async () => {
    const device = await gpuDevice();
    if (!device) return;
    const store = brushStore();
    store.add({
      kind: BRUSH_CSG,
      cell: [16, -16, 16],
      blend: BLEND_SUBTRACT,
      ops: packCsg([{ prim: PRIM_SPHERE, params: [8] }]),
    });
    const results = await voxelize(device, world("ground", GROUND), [[0, -1, 0]], true, new BrushBatch(store));
    const ids = idsOf(results.get("0,-1,0")!);
    assert(ids[voxelIndex(16, 16, 16)] === 0, "the middle of the carve is air");
    assert(ids[voxelIndex(16, 0, 16)] === DIRT, "well below it is still the world's dirt");
    assert(ids[voxelIndex(0, 31, 0)] === DIRT, "and so is a corner away from the carve");
  },
});

Deno.test({
  name: "skipping by the Lipschitz bound never changes the result, with brushes",
  ...opts,
  fn: async () => {
    // The test the whole phase rests on: a brush must not be skipped over. Its bound
    // goes into the chunk's, so a sub-block holding a brush cannot be written off as
    // empty even when the world alone says the space is far from anything.
    const device = await gpuDevice();
    if (!device) return;
    for (let seed = 1; seed <= 4; seed++) {
      const store = brushStore();
      const r = (i: number) => random01(seed, i);
      for (let b = 0; b < 4; b++) {
        const base = b * 12;
        const prim = [PRIM_SPHERE, PRIM_BOX, PRIM_ELLIPSOID, PRIM_TORUS][b % 4];
        const params = prim === PRIM_SPHERE
          ? [2 + r(base) * 6]
          : prim === PRIM_TORUS
          ? [4 + r(base) * 4, 1 + r(base + 1) * 2]
          : [2 + r(base) * 5, 2 + r(base + 1) * 5, 2 + r(base + 2) * 5];
        store.add({
          kind: BRUSH_CSG,
          cell: [
            Math.floor(r(base + 3) * 48) - 8,
            Math.floor(r(base + 4) * 48) - 8,
            Math.floor(r(base + 5) * 48) - 8,
          ],
          orientation: Math.floor(r(base + 6) * 24),
          blend: r(base + 7) < 0.3 ? BLEND_SUBTRACT : BLEND_UNION,
          material: BRICK,
          scale: 0.5 + r(base + 8) * 1.5,
          ops: packCsg([{ prim, params }]),
        });
      }
      const chunks = box(0, 1, 0, 1, 0, 1);
      const skipped = await voxelize(device, world("ground", GROUND), chunks, true, new BrushBatch(store));
      const full = await voxelize(device, world("ground", GROUND), chunks, false, new BrushBatch(store));
      for (const [key, a] of skipped) {
        const b = full.get(key)!;
        const x = idsOf(a);
        const y = idsOf(b);
        for (let i = 0; i < VOXELS_PER_CHUNK; i++) {
          if (x[i] !== y[i]) {
            throw new Error(`seed ${seed} chunk ${key} voxel ${i}: skipping gave ${x[i]}, full gave ${y[i]}`);
          }
        }
      }
    }
  },
});

Deno.test({
  name: "the shader's fold agrees with the CPU mirror, voxel for voxel",
  ...opts,
  fn: async () => {
    // The two folds have to stay in step: the CPU one is what the far field and the
    // tests use, the shader one is what the world is made of.
    const device = await gpuDevice();
    if (!device) return;
    const store = brushStore();
    const ids: number[] = [];
    ids.push(store.add({
      kind: BRUSH_CSG,
      cell: [14, 18, 16],
      material: BRICK,
      ops: packCsg([
        { prim: PRIM_SPHERE, params: [9] },
        { prim: PRIM_BOX, blend: BLEND_UNION, material: DIRT, center: [6, 0, 0], params: [5, 3, 3] },
      ]),
    }));
    ids.push(store.add({
      kind: BRUSH_CSG,
      cell: [20, 12, 18],
      orientation: 7,
      blend: BLEND_SUBTRACT,
      scale: 1.5,
      ops: packCsg([{ prim: PRIM_ELLIPSOID, params: [4, 2, 3] }]),
    }));
    const results = await voxelize(device, world("empty", EMPTY), [[0, 0, 0]], true, new BrushBatch(store));
    const got = idsOf(results.get("0,0,0")!);

    const order = Int32Array.from(ids);
    const out = new Float64Array(2);
    let compared = 0;
    for (let y = 0; y < 32; y++) {
      for (let z = 0; z < 32; z++) {
        for (let x = 0; x < 32; x++) {
          foldInstances(store.records, store.ops, order, order.length, x + 0.5, y + 0.5, z + 0.5, 1e9, 0, out);
          const want = out[0] < 0 ? (out[1] === 0 ? 1 : out[1]) : 0;
          const at = voxelIndex(x, y, z);
          // f32 on the GPU against f64 here: only voxels within a hair of a surface
          // can differ, so compare away from the surface and count what is compared.
          if (Math.abs(out[0]) < 0.02) continue;
          compared++;
          if (got[at] !== want) {
            throw new Error(`voxel (${x}, ${y}, ${z}): shader ${got[at]}, mirror ${want} (d ${out[0].toFixed(3)})`);
          }
        }
      }
    }
    assert(compared > 30000, `only ${compared} voxels compared`);
  },
});
