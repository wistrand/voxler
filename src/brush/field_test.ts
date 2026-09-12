import { random01 } from "../util/random.ts";
import { packCsg } from "./build.ts";
import { boxDistance, foldInstances, instanceBox, instanceField } from "./field.ts";
import { BLEND_SMIN, BLEND_SUBTRACT, BLEND_UNION, BRUSH_CSG, PRIM_BOX, PRIM_SPHERE } from "./format.ts";

import { BrushStore } from "./store.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const BLENDS = [BLEND_UNION, BLEND_SUBTRACT, BLEND_SMIN];

// A scene of random brushes around the origin, over a plane at y = 0.
function scene(seed: number, count: number): { store: BrushStore; ids: Int32Array; lipschitz: number } {
  const store = new BrushStore();
  const ids = new Int32Array(count);
  let lipschitz = 1; // the terrain plane
  for (let i = 0; i < count; i++) {
    const r = (j: number) => random01(seed, i * 16 + j);
    const sphere = r(0) < 0.5;
    const ops = packCsg([{
      prim: sphere ? PRIM_SPHERE : PRIM_BOX,
      material: 1 + i,
      params: sphere ? [2 + r(1) * 5] : [2 + r(1) * 4, 2 + r(2) * 4, 2 + r(3) * 4],
    }]);
    ids[i] = store.add({
      kind: BRUSH_CSG,
      cell: [Math.floor(r(4) * 40 - 20), Math.floor(r(5) * 16 - 4), Math.floor(r(6) * 40 - 20)],
      orientation: Math.floor(r(7) * 24),
      blend: BLENDS[Math.floor(r(8) * BLENDS.length)],
      blendK: 1 + r(9) * 2,
      material: 1 + i,
      scale: 0.5 + r(10) * 2,
      ops,
    });
    const at = store.offsetOf(ids[i]);
    lipschitz = Math.max(lipschitz, (store.records.u32[at + 6] >>> 16) / 256);
  }
  return { store, ids, lipschitz };
}

Deno.test("a brush reports the distance to its box from far away, never a large constant", () => {
  const store = new BrushStore();
  const id = store.add({
    kind: BRUSH_CSG,
    cell: [0, 0, 0],
    material: 3,
    ops: packCsg([{ prim: PRIM_SPHERE, params: [4] }]),
  });
  const at = store.offsetOf(id);
  const box = new Float64Array(6);
  instanceBox(store.records, at, box);
  const out = new Float64Array(2);
  for (const d of [10, 50, 200, 5000]) {
    instanceField(store.records, at, store.ops, d, 0, 0, out);
    const toBox = boxDistance(d, 0, 0, box);
    assert(out[0] <= toBox + 1e-6, `at x = ${d}: reported ${out[0]}, above the box distance ${toBox}`);
    // The true distance to the sphere is d - 4; the report must not exceed it.
    assert(out[0] <= d - 4 + 1e-6, `at x = ${d}: reported ${out[0]}, above the true distance ${d - 4}`);
    assert(Number.isFinite(out[0]), `at x = ${d}: reported ${out[0]}`);
  }
});

Deno.test("the folded field never claims more empty space than there is", () => {
  // The skip rule the voxelizer runs on: |d| > L * r at a point means no sign change
  // within r of it. Checking it directly is what catches a brush that lies about its
  // distance, which is how a brush gets silently deleted.
  const out = new Float64Array(2);
  const probe = new Float64Array(2);
  for (let seed = 1; seed <= 12; seed++) {
    const { store, ids, lipschitz } = scene(seed, 6);
    for (let s = 0; s < 400; s++) {
      const r = (j: number) => random01(seed * 1000 + s, j);
      const x = r(0) * 80 - 40, y = r(1) * 50 - 20, z = r(2) * 80 - 40;
      foldInstances(store.records, store.ops, ids, ids.length, x, y, z, y, 1, out);
      const d = out[0];
      const reach = Math.abs(d) / lipschitz;
      if (reach < 1e-3) continue;
      for (let k = 0; k < 8; k++) {
        // A random point strictly inside the claimed radius.
        const t = Math.cbrt(r(3 + k * 4)) * reach * 0.999;
        const u = r(4 + k * 4) * 2 - 1;
        const phi = r(5 + k * 4) * Math.PI * 2;
        const rho = Math.sqrt(1 - u * u);
        const px = x + t * rho * Math.cos(phi);
        const py = y + t * u;
        const pz = z + t * rho * Math.sin(phi);
        foldInstances(store.records, store.ops, ids, ids.length, px, py, pz, py, 1, probe);
        assert(
          (probe[0] > 0) === (d > 0),
          `seed ${seed} sample ${s}: d = ${d} at (${x}, ${y}, ${z}) claims ${reach} clear, ` +
            `but the field is ${probe[0]} at ${t} away`,
        );
      }
    }
  }
});

Deno.test("a carve is visible from outside its box, so the field cannot skip over it", () => {
  // Deep inside solid terrain, a subtract brush 5 voxels away must pull the reported
  // distance toward the cavity wall. Omitting it would let a skip claim solid rock
  // across the cavity.
  const store = new BrushStore();
  const id = store.add({
    kind: BRUSH_CSG,
    cell: [20, -40, 0],
    blend: BLEND_SUBTRACT,
    ops: packCsg([{ prim: PRIM_SPHERE, params: [6] }]),
  });
  const ids = Int32Array.of(id);
  const out = new Float64Array(2);
  // Terrain: everything below y = 0 is solid, so the plane's distance is y.
  foldInstances(store.records, store.ops, ids, 1, 0, -40, 0, -40, 1, out);
  assert(out[0] < 0, `the point should still be solid, got ${out[0]}`);
  const box = new Float64Array(6);
  instanceBox(store.records, store.offsetOf(id), box);
  const toBox = boxDistance(0, -40, 0, box);
  assert(
    Math.abs(out[0]) <= toBox + 1e-6,
    `reported ${out[0]} with the cavity ${toBox} away: a skip would jump over the cavity wall`,
  );
});

Deno.test("folding is independent of the order instances are listed, for unions", () => {
  const store = new BrushStore();
  const ids = new Int32Array(4);
  for (let i = 0; i < ids.length; i++) {
    ids[i] = store.add({
      kind: BRUSH_CSG,
      cell: [i * 7 - 10, 0, 0],
      blend: BLEND_UNION,
      material: 2 + i,
      ops: packCsg([{ prim: PRIM_SPHERE, params: [3 + i] }]),
    });
  }
  const forward = new Float64Array(2);
  const backward = new Float64Array(2);
  const reversed = Int32Array.from(ids).reverse();
  for (let s = 0; s < 200; s++) {
    const r = (j: number) => random01(s + 1, j);
    const x = r(0) * 60 - 30, y = r(1) * 20 - 10, z = r(2) * 20 - 10;
    foldInstances(store.records, store.ops, ids, ids.length, x, y, z, y, 1, forward);
    foldInstances(store.records, store.ops, reversed, reversed.length, x, y, z, y, 1, backward);
    assert(
      Math.abs(forward[0] - backward[0]) < 1e-9,
      `sample ${s}: ${forward[0]} forward, ${backward[0]} reversed`,
    );
  }
});

Deno.test("the box shortcut never puts a surface at a bounding box corner", () => {
  // What the sphere-traced preview found: outside its box a brush reports the
  // distance to that box, which is zero at the box itself. A consumer that treats a
  // small distance as a surface would draw the box. Above the sample footprint the
  // reported value cannot be mistaken for one.
  const store = new BrushStore();
  const id = store.add({
    kind: BRUSH_CSG,
    cell: [0, 0, 0],
    material: 3,
    ops: packCsg([{ prim: PRIM_SPHERE, params: [10] }]),
  });
  const ids = Int32Array.of(id);
  const out = new Float64Array(2);
  const box = new Float64Array(6);
  instanceBox(store.records, store.offsetOf(id), box);
  // The corner of the box is sqrt(3) * 10 from the centre, so the sphere's surface is
  // about 7.3 away from it: a tracer must not stop there.
  const corner = [box[3], box[4], box[5]];
  for (const footprint of [0.01, 0.1, 1]) {
    foldInstances(store.records, store.ops, ids, 1, corner[0], corner[1], corner[2], 1e9, 0, out, footprint);
    assert(
      out[0] > footprint * 0.5,
      `footprint ${footprint}: the box corner reports ${out[0]}, which reads as a surface`,
    );
  }
  // Just outside a face, where the sphere does touch the box, it is a surface, and
  // should be: the shape really is there.
  foldInstances(store.records, store.ops, ids, 1, 10.05, 0, 0, 1e9, 0, out, 0.01);
  assert(out[0] < 0.1, `the sphere's own surface reports ${out[0]}`);
  // Far away the shortcut is back, and still never overestimates.
  foldInstances(store.records, store.ops, ids, 1, 200, 0, 0, 1e9, 0, out, 1);
  assert(out[0] > 0 && out[0] <= 190 + 1e-6, `at 200 voxels the field reports ${out[0]}`);
});
