import { CHUNK_SIZE, CHUNK_VOLUME, voxelIndex } from "../world/coords.ts";
import { chunkKey } from "../world/keys.ts";
import { random01 } from "../util/random.ts";
import { packVoxel } from "./build.ts";
import {
  BRUSH_VOXEL,
  SHAPE_BOX,
  SHAPE_ELLIPSOID,
  SHAPE_SPHERE,
  SHAPE_VOXEL,
  VOXEL_CARVE,
  VOXEL_PAINT,
  VOXEL_REPLACE,
  VOXEL_SET,
} from "./format.ts";
import { codeSign, codeSource, invertCode, ORIENTATION_CODES } from "./orientation.ts";
import { BrushStore } from "./store.ts";
import { applyChunkOps, fillBox, fillSphere, hasChunkOps, packChunkOps, setVoxel } from "./voxel-ops.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const MODES = [VOXEL_SET, VOXEL_CARVE, VOXEL_REPLACE, VOXEL_PAINT];
const SHAPES = [SHAPE_VOXEL, SHAPE_BOX, SHAPE_SPHERE, SHAPE_ELLIPSOID];

function paramsFor(shape: number, r: (i: number) => number): number[] {
  const c = [Math.floor(r(0) * 24) - 12, Math.floor(r(1) * 24) - 12, Math.floor(r(2) * 24) - 12];
  switch (shape) {
    case SHAPE_VOXEL:
      return c;
    case SHAPE_BOX:
      return [...c, c[0] + Math.floor(r(3) * 9), c[1] + Math.floor(r(4) * 9), c[2] + Math.floor(r(5) * 9)];
    case SHAPE_SPHERE:
      return [...c, 1 + Math.floor(r(3) * 6)];
    default:
      return [...c, 1 + Math.floor(r(3) * 6), 1 + Math.floor(r(4) * 6), 1 + Math.floor(r(5) * 6)];
  }
}

// Whether a brush-local voxel is inside a shape, written out longhand as the oracle.
function inShape(shape: number, p: readonly number[], q: readonly number[]): boolean {
  if (shape === SHAPE_VOXEL) return q[0] === p[0] && q[1] === p[1] && q[2] === p[2];
  if (shape === SHAPE_BOX) {
    for (let i = 0; i < 3; i++) {
      if (q[i] < Math.min(p[i], p[3 + i]) || q[i] > Math.max(p[i], p[3 + i])) return false;
    }
    return true;
  }
  if (shape === SHAPE_SPHERE) {
    let d = 0;
    for (let i = 0; i < 3; i++) d += (q[i] - p[i]) ** 2;
    return d <= p[3] ** 2;
  }
  let d = 0;
  for (let i = 0; i < 3; i++) d += ((q[i] - p[i]) / p[3 + i]) ** 2;
  return d <= 1;
}

// The oracle: every voxel of the chunk, tested against every op in order, with the
// rotation undone by hand.
function reference(
  dense: Uint16Array,
  cx: number,
  cy: number,
  cz: number,
  brushes: { cell: number[]; code: number; ops: { mode: number; shape: number; id: number; match: number; params: number[] }[] }[],
): Uint16Array {
  const out = Uint16Array.from(dense);
  for (const b of brushes) {
    const inv = invertCode(b.code);
    for (const op of b.ops) {
      for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const w = [cx * CHUNK_SIZE + x - b.cell[0], cy * CHUNK_SIZE + y - b.cell[1], cz * CHUNK_SIZE + z - b.cell[2]];
            const q = [0, 0, 0];
            for (let r = 0; r < 3; r++) q[r] = codeSign(inv, r) * w[codeSource(inv, r)];
            if (!inShape(op.shape, op.params, q)) continue;
            const at = voxelIndex(x, y, z);
            if (op.mode === VOXEL_CARVE) out[at] = 0;
            else if (op.mode === VOXEL_REPLACE) {
              if (out[at] === op.match) out[at] = op.id;
            } else if (op.mode === VOXEL_PAINT) {
              if (out[at] !== 0) out[at] = op.id;
            } else out[at] = op.id;
          }
        }
      }
    }
  }
  return out;
}

Deno.test("applied ops match a per-voxel reference, on every shape, mode and orientation", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const r = (i: number) => random01(seed, i);
    const store = new BrushStore();
    // A chunk somewhere away from the origin, so anchors and chunk origins differ.
    const cx = Math.floor(r(0) * 20) - 10, cy = Math.floor(r(1) * 6) - 3, cz = Math.floor(r(2) * 20) - 10;
    const dense = new Uint16Array(CHUNK_VOLUME);
    for (let i = 0; i < CHUNK_VOLUME; i++) dense[i] = i % 7 === 0 ? 0 : 1 + (i % 3);
    const brushes = [];
    const count = 1 + Math.floor(r(3) * 3);
    for (let b = 0; b < count; b++) {
      const base = 10 + b * 20;
      const orientation = Math.floor(r(base) * 24);
      // An anchor near the chunk, so ops land inside it.
      const cell = [
        cx * CHUNK_SIZE + Math.floor(r(base + 1) * CHUNK_SIZE),
        cy * CHUNK_SIZE + Math.floor(r(base + 2) * CHUNK_SIZE),
        cz * CHUNK_SIZE + Math.floor(r(base + 3) * CHUNK_SIZE),
      ];
      const ops = [];
      const opCount = 1 + Math.floor(r(base + 4) * 3);
      for (let o = 0; o < opCount; o++) {
        const shape = SHAPES[Math.floor(r(base + 5 + o * 3) * SHAPES.length)];
        const mode = MODES[Math.floor(r(base + 6 + o * 3) * MODES.length)];
        ops.push({
          mode,
          shape,
          id: mode === VOXEL_CARVE ? 0 : 4 + o,
          match: 1 + (o % 3),
          params: paramsFor(shape, (i) => r(base + 40 + o * 8 + i)),
        });
      }
      store.add({
        kind: BRUSH_VOXEL,
        cell: [cell[0], cell[1], cell[2]],
        orientation,
        ops: packVoxel(ops),
      });
      brushes.push({ cell, code: ORIENTATION_CODES[orientation], ops });
    }
    const packed = packChunkOps(store, chunkKey(cx, cy, cz));
    const got = Uint16Array.from(dense);
    if (packed !== null) applyChunkOps(got, cx, cy, cz, packed);
    const want = reference(dense, cx, cy, cz, brushes);
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      if (got[i] !== want[i]) {
        const x = i & 31, z = (i >>> 5) & 31, y = i >>> 10;
        throw new Error(`seed ${seed}: voxel (${x}, ${y}, ${z}) is ${got[i]}, reference says ${want[i]}`);
      }
    }
  }
});

Deno.test("ops apply in sequence order, not id order, and undo removes exactly one", () => {
  const store = new BrushStore();
  const key = chunkKey(0, 0, 0);
  const dense = new Uint16Array(CHUNK_VOLUME);
  const run = () => {
    const out = new Uint16Array(CHUNK_VOLUME);
    const packed = packChunkOps(store, key);
    if (packed !== null) applyChunkOps(out, 0, 0, 0, packed);
    return out;
  };
  const first = fillBox(store, 0, 0, 0, 7, 7, 7, 3);
  const second = fillBox(store, 0, 0, 0, 7, 7, 7, 5);
  assert(run()[voxelIndex(1, 1, 1)] === 5, "the later op wins");

  // Free the first id and reuse it: the new brush is newer and must still win.
  store.remove(first);
  const third = fillBox(store, 0, 0, 0, 7, 7, 7, 9);
  assert(third === first, `expected the freed id back, got ${third}`);
  assert(run()[voxelIndex(1, 1, 1)] === 9, "a reused id does not reorder the replay");

  // Undo drops that one and leaves the rest.
  store.remove(third);
  assert(run()[voxelIndex(1, 1, 1)] === 5, "undo left the earlier op in place");
  store.remove(second);
  assert(packChunkOps(store, key) === null, "no ops left");
  assert(!hasChunkOps(store, key), "and the chunk reports none");
  assert(dense[0] === 0, "the input was not touched");
});

Deno.test("a replay is deterministic and clips to the chunk it is given", () => {
  const store = new BrushStore();
  // A box spanning four chunks in x, and a sphere straddling a chunk corner.
  fillBox(store, -40, 5, 5, 40, 9, 9, 2);
  fillSphere(store, 32, 32, 32, 6, 3);
  for (const [cx, cy, cz] of [[-2, 0, 0], [-1, 0, 0], [0, 0, 0], [1, 0, 0], [1, 1, 1], [5, 5, 5]]) {
    const key = chunkKey(cx, cy, cz);
    const a = new Uint16Array(CHUNK_VOLUME);
    const b = new Uint16Array(CHUNK_VOLUME);
    const packed = packChunkOps(store, key);
    if (packed === null) {
      assert(cx === 5, `chunk (${cx}, ${cy}, ${cz}) should have ops`);
      continue;
    }
    applyChunkOps(a, cx, cy, cz, packed);
    applyChunkOps(b, cx, cy, cz, packChunkOps(store, key)!);
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      assert(a[i] === b[i], `chunk (${cx}, ${cy}, ${cz}) voxel ${i}: replay differs`);
    }
    // Nothing outside the chunk was written, because there is nowhere else to write.
    let written = 0;
    for (let i = 0; i < CHUNK_VOLUME; i++) if (a[i] !== 0) written++;
    assert(written > 0, `chunk (${cx}, ${cy}, ${cz}) should hold some of the box`);
  }
});

Deno.test("setVoxel at a chunk corner dirties the neighbouring chunks", () => {
  const store = new BrushStore();
  store.takeDirty(new Float64Array(store.dirty));
  // The last voxel of chunk (0, 0, 0): its faces show in three neighbours.
  setVoxel(store, CHUNK_SIZE - 1, CHUNK_SIZE - 1, CHUNK_SIZE - 1, 4);
  const out = new Float64Array(store.dirty);
  const n = store.takeDirty(out);
  const keys = new Set(Array.from(out.subarray(0, n)));
  for (let dx = 0; dx <= 1; dx++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dz = 0; dz <= 1; dz++) {
        assert(keys.has(chunkKey(dx, dy, dz)), `chunk (${dx}, ${dy}, ${dz}) was not dirtied`);
      }
    }
  }
  assert(n === 8, `dirtied ${n} chunks, expected the 8 the voxel touches`);
});

Deno.test("carving writes air and a voxel brush never claims to be a field", () => {
  const store = new BrushStore();
  const id = fillSphere(store, 4, 4, 4, 3, 0);
  assert(store.kindOf(id) === BRUSH_VOXEL, "kind");
  const dense = new Uint16Array(CHUNK_VOLUME).fill(1);
  applyChunkOps(dense, 0, 0, 0, packChunkOps(store, chunkKey(0, 0, 0))!);
  assert(dense[voxelIndex(4, 4, 4)] === 0, "the centre was carved");
  assert(dense[voxelIndex(0, 0, 0)] === 1, "a voxel outside the sphere is untouched");
});
