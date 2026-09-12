import { random01 } from "../util/random.ts";
import { packCsg, packVoxel } from "./build.ts";
import { csgField } from "./field.ts";
import {
  BLEND_SMIN,
  BLEND_SUBTRACT,
  BLEND_UNION,
  BRUSH_CSG,
  csgBounds,
  INSTANCE_WORDS,
  type InstanceFields,
  LIPSCHITZ_SCALE,
  newInstanceFields,
  PRIM_BOX,
  PRIM_CAPSULE,
  PRIM_COUNT,
  PRIM_CYLINDER,
  PRIM_ELLIPSOID,
  PRIM_PARAMS,
  PRIM_ROUND_BOX,
  PRIM_SPHERE,
  PRIM_TORUS,
  readInstance,
  SHAPE_BOX,
  SHAPE_ELLIPSOID,
  SHAPE_SPHERE,
  SHAPE_VOXEL,
  voxelBounds,
  VOXEL_SET,
  WordBuffer,
  writeInstance,
} from "./format.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// Parameters that give each primitive a sensible shape, from a seeded value in
// [0, 1). Radii stay well away from zero so the ellipsoid bound stays usable.
function paramsFor(prim: number, r: (i: number) => number): number[] {
  switch (prim) {
    case PRIM_SPHERE:
      return [1 + r(0) * 4];
    case PRIM_BOX:
      return [1 + r(0) * 4, 1 + r(1) * 4, 1 + r(2) * 4];
    case PRIM_ROUND_BOX: {
      const h = [2 + r(0) * 4, 2 + r(1) * 4, 2 + r(2) * 4];
      return [...h, 0.5 + r(3) * Math.min(h[0], Math.min(h[1], h[2])) * 0.5];
    }
    case PRIM_TORUS:
      return [2 + r(0) * 4, 0.5 + r(1) * 1.5];
    case PRIM_CAPSULE:
      return [-2 - r(0) * 3, 0, 0, 2 + r(1) * 3, r(2) * 2, 0, 0.5 + r(3) * 2];
    case PRIM_CYLINDER:
      return [1 + r(0) * 4, 1 + r(1) * 3];
    default: // PRIM_ELLIPSOID
      return [2 + r(0) * 3, 2 + r(1) * 3, 2 + r(2) * 3];
  }
}

Deno.test("an instance record round-trips through every field", () => {
  const words = new WordBuffer(INSTANCE_WORDS * 4);
  const read: InstanceFields = newInstanceFields();
  for (let seed = 1; seed <= 40; seed++) {
    const r = (i: number) => random01(seed, i);
    const written: InstanceFields = {
      kind: Math.floor(r(0) * 3),
      blend: Math.floor(r(1) * 5),
      orientation: Math.floor(r(2) * 24),
      type: Math.floor(r(3) * 65536),
      material: Math.floor(r(4) * 65536),
      cellX: Math.floor(r(5) * 2e6) - 1e6,
      cellY: Math.floor(r(6) * 2000) - 1000,
      cellZ: Math.floor(r(7) * 2e6) - 1e6,
      scale: Math.fround(0.25 + r(8) * 4),
      blendK: Math.fround(r(9) * 8),
      // Quantized to the record's 8.8 fixed point, so the read matches exactly.
      lipschitz: Math.round((1 + r(10) * 8) * LIPSCHITZ_SCALE) / LIPSCHITZ_SCALE,
      opsOffset: Math.floor(r(11) * 1e6),
      opsCount: Math.floor(r(12) * 65536),
      seq: Math.floor(r(19) * 1e6),
      localMin: [Math.fround(-r(13) * 30), Math.fround(-r(14) * 30), Math.fround(-r(15) * 30)],
      localMax: [Math.fround(r(16) * 30), Math.fround(r(17) * 30), Math.fround(r(18) * 30)],
    };
    const at = (seed % 3) * INSTANCE_WORDS;
    writeInstance(words, at, written);
    readInstance(words, at, read);
    for (const key of Object.keys(written) as (keyof InstanceFields)[]) {
      const a = written[key];
      const b = read[key];
      if (typeof a === "number") {
        assert(a === b, `seed ${seed}: ${key} wrote ${a}, read ${b}`);
      } else {
        for (let i = 0; i < 3; i++) {
          assert(a[i] === (b as ArrayLike<number>)[i], `seed ${seed}: ${key}[${i}] wrote ${a[i]}, read ${b}`);
        }
      }
    }
  }
});

Deno.test("csgBounds contains every point the op list calls solid", () => {
  const pool = new WordBuffer(256);
  const bounds = new Float64Array(6);
  const out = new Float64Array(2);
  for (let seed = 1; seed <= 30; seed++) {
    const r = (i: number) => random01(seed, i);
    const ops = [];
    const count = 1 + Math.floor(r(0) * 3);
    for (let i = 0; i < count; i++) {
      const prim = Math.floor(r(1 + i * 8) * PRIM_COUNT);
      const blend = i === 0 ? BLEND_UNION : [BLEND_UNION, BLEND_SUBTRACT, BLEND_SMIN][Math.floor(r(2 + i * 8) * 3)];
      ops.push({
        prim,
        blend,
        material: 1 + i,
        k: 1 + r(3 + i * 8) * 2,
        center: [r(4 + i * 8) * 8 - 4, r(5 + i * 8) * 8 - 4, r(6 + i * 8) * 8 - 4] as [number, number, number],
        params: paramsFor(prim, (j) => r(20 + i * 8 + j)),
      });
    }
    const packed = packCsg(ops);
    pool.ensure(packed.length);
    pool.u32.set(packed, 0);
    const lipschitz = csgBounds(pool, 0, packed.length, bounds);
    assert(lipschitz >= 1, `seed ${seed}: Lipschitz bound ${lipschitz}`);
    // Sample a grid wider than the bounds and check nothing solid falls outside.
    for (let i = 0; i < 24; i++) {
      for (let j = 0; j < 24; j++) {
        for (let k = 0; k < 24; k++) {
          const x = -18 + i * 1.5, y = -18 + j * 1.5, z = -18 + k * 1.5;
          csgField(pool, 0, packed.length, x, y, z, out);
          if (out[0] > 0) continue;
          const inside = x >= bounds[0] && x <= bounds[3] && y >= bounds[1] && y <= bounds[4] &&
            z >= bounds[2] && z <= bounds[5];
          assert(inside, `seed ${seed}: solid at (${x}, ${y}, ${z}) is outside the bounds ${[...bounds]}`);
        }
      }
    }
  }
});

Deno.test("voxelBounds contains every voxel an op writes", () => {
  const pool = new WordBuffer(64);
  const bounds = new Float64Array(6);
  const cases: [number, number[]][] = [
    [SHAPE_VOXEL, [3, -4, 5]],
    [SHAPE_BOX, [-2, 0, 1, 6, 3, 9]],
    [SHAPE_BOX, [6, 3, 9, -2, 0, 1]], // reversed corners
    [SHAPE_SPHERE, [0, 10, -5, 4]],
    [SHAPE_ELLIPSOID, [1, 2, 3, 4, 5, 6]],
  ];
  for (const [shape, params] of cases) {
    const packed = packVoxel([{ mode: VOXEL_SET, shape, id: 7, params }]);
    pool.ensure(packed.length);
    pool.u32.set(packed, 0);
    voxelBounds(pool, 0, packed.length, bounds);
    // The written voxels, by the same rules an apply pass will use.
    let lo = [0, 0, 0];
    let hi = [0, 0, 0];
    if (shape === SHAPE_VOXEL) {
      lo = params.slice(0, 3);
      hi = params.slice(0, 3);
    } else if (shape === SHAPE_BOX) {
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(params[i], params[3 + i]);
        hi[i] = Math.max(params[i], params[3 + i]);
      }
    } else if (shape === SHAPE_SPHERE) {
      for (let i = 0; i < 3; i++) {
        lo[i] = params[i] - params[3];
        hi[i] = params[i] + params[3];
      }
    } else {
      for (let i = 0; i < 3; i++) {
        lo[i] = params[i] - params[3 + i];
        hi[i] = params[i] + params[3 + i];
      }
    }
    for (let i = 0; i < 3; i++) {
      assert(bounds[i] <= lo[i], `shape ${shape} axis ${i}: min ${bounds[i]} misses voxel ${lo[i]}`);
      assert(bounds[3 + i] >= hi[i] + 1, `shape ${shape} axis ${i}: max ${bounds[3 + i]} misses voxel ${hi[i]}`);
    }
  }
});

Deno.test("an op list whose words do not add up is rejected", () => {
  const pool = new WordBuffer(64);
  const bounds = new Float64Array(6);
  const packed = packCsg([{ prim: PRIM_SPHERE, params: [2] }]);
  pool.ensure(packed.length + 1);
  pool.u32.set(packed, 0);
  let threw = false;
  try {
    csgBounds(pool, 0, packed.length + 1, bounds);
  } catch {
    threw = true;
  }
  assert(threw, "a truncated op list should be rejected");
  assert(PRIM_PARAMS.length === PRIM_COUNT, "every primitive needs a parameter count");
  assert(BRUSH_CSG === 1, "brush kinds are part of the record layout");
});
