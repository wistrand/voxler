import { CHUNK_SIZE } from "../world/coords.ts";
import { chunkKey } from "../world/keys.ts";
import { random01 } from "../util/random.ts";
import { packCsg, packVoxel } from "./build.ts";
import {
  BLEND_INTERSECT,
  BLEND_SMAX,
  BLEND_SMIN,
  BLEND_UNION,
  BRUSH_CSG,
  BRUSH_SDF,
  BRUSH_VOXEL,
  PRIM_BOX,
  SHAPE_BOX,
  VOXEL_SET,
} from "./format.ts";
import { BRUSH_DIRTY_PAD, BRUSH_INDEX_PAD, BrushStore } from "./store.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function blendK(store: BrushStore, id: number): number {
  return store.records.f32[store.offsetOf(id) + 14];
}

// The chunks a brush reaches, from its box and a pad alone.
function chunksWithin(store: BrushStore, id: number, pad: number): Set<number> {
  const box = new Float64Array(6);
  store.boxOf(id, box);
  const keys = new Set<number>();
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    lo[i] = Math.floor((box[i] - pad) / CHUNK_SIZE);
    hi[i] = Math.floor((box[3 + i] + pad) / CHUNK_SIZE);
  }
  for (let y = lo[1]; y <= hi[1]; y++) {
    for (let z = lo[2]; z <= hi[2]; z++) {
      for (let x = lo[0]; x <= hi[0]; x++) keys.add(chunkKey(x, y, z));
    }
  }
  return keys;
}

// The chunks a brush must be indexed into, and the ones its voxels can change.
function expectedChunks(store: BrushStore, id: number): Set<number> {
  return chunksWithin(store, id, BRUSH_INDEX_PAD + blendK(store, id));
}

function expectedDirty(store: BrushStore, id: number): Set<number> {
  return chunksWithin(store, id, BRUSH_DIRTY_PAD + blendK(store, id));
}

// Every (chunk, instance) pair the index should hold, by brute force.
function bruteForce(store: BrushStore, live: number[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const id of live) {
    for (const key of expectedChunks(store, id)) {
      let list = map.get(key);
      if (list === undefined) {
        list = [];
        map.set(key, list);
      }
      list.push(id);
    }
  }
  for (const list of map.values()) list.sort((a, b) => store.seqOf(a) - store.seqOf(b));
  return map;
}

function checkIndex(store: BrushStore, live: number[], what: string): void {
  const want = bruteForce(store, live);
  const out = new Int32Array(256);
  for (const [key, ids] of want) {
    const n = store.instancesIn(key, out);
    assert(n === ids.length, `${what}: chunk ${key} holds ${n} brushes, expected ${ids.length}`);
    for (let i = 0; i < n; i++) assert(out[i] === ids[i], `${what}: chunk ${key} entry ${i} is ${out[i]}`);
  }
  // Nothing indexed where nothing belongs: probe around each brush's range.
  for (const id of live) {
    const box = new Float64Array(6);
    store.boxOf(id, box);
    const far = chunkKey(
      Math.floor(box[0] / CHUNK_SIZE) - 8,
      Math.floor(box[1] / CHUNK_SIZE) - 8,
      Math.floor(box[2] / CHUNK_SIZE) - 8,
    );
    if (want.has(far)) continue;
    assert(store.instancesIn(far, out) === 0, `${what}: chunk ${far} should be empty`);
  }
}

function boxOps(size: number): Uint32Array {
  return packCsg([{ prim: PRIM_BOX, material: 4, params: [size, size, size] }]);
}

Deno.test("the index matches brute force under random add, move, and remove", () => {
  const store = new BrushStore();
  const live: number[] = [];
  for (let step = 0; step < 300; step++) {
    const r = (j: number) => random01(step + 1, j);
    const action = r(0);
    if (live.length === 0 || action < 0.5) {
      const id = store.add({
        kind: BRUSH_CSG,
        cell: [Math.floor(r(1) * 200 - 100), Math.floor(r(2) * 60 - 30), Math.floor(r(3) * 200 - 100)],
        orientation: Math.floor(r(4) * 24),
        blend: r(5) < 0.3 ? BLEND_SMIN : BLEND_UNION,
        blendK: r(6) < 0.3 ? 1 + r(7) * 6 : 0,
        scale: 0.5 + r(8) * 2,
        material: 4,
        ops: boxOps(2 + r(9) * 8),
      });
      live.push(id);
    } else if (action < 0.8) {
      const id = live[Math.floor(r(1) * live.length)];
      store.move(
        id,
        Math.floor(r(2) * 200 - 100),
        Math.floor(r(3) * 60 - 30),
        Math.floor(r(4) * 200 - 100),
        Math.floor(r(5) * 24),
      );
    } else {
      const i = Math.floor(r(1) * live.length);
      store.remove(live[i]);
      live.splice(i, 1);
    }
    assert(store.count === live.length, `step ${step}: count ${store.count}, expected ${live.length}`);
    if (step % 10 === 0) checkIndex(store, live, `step ${step}`);
  }
  checkIndex(store, live, "final");
});

Deno.test("every touched chunk is dirtied once, and draining clears it", () => {
  const store = new BrushStore();
  const id = store.add({ kind: BRUSH_CSG, cell: [0, 0, 0], ops: boxOps(4) });
  const first = expectedDirty(store, id);
  // Only where voxels can change, which is far fewer chunks than the fold reaches.
  assert(first.size < expectedChunks(store, id).size, "the dirty range should be tighter than the index range");
  let out = new Float64Array(store.dirty);
  let n = store.takeDirty(out);
  assert(n === first.size, `add dirtied ${n} chunks, expected ${first.size}`);
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    assert(!seen.has(out[i]), `chunk ${out[i]} dirtied twice`);
    seen.add(out[i]);
    assert(first.has(out[i]), `chunk ${out[i]} is not in the brush's range`);
  }
  assert(store.dirty === 0, "draining should clear the dirty set");
  assert(store.takeDirty(new Float64Array(0)) === 0, "a second drain finds nothing");

  // A move dirties the union of where it was and where it went.
  const before = expectedDirty(store, id);
  store.move(id, 300, 0, 300);
  const after = expectedDirty(store, id);
  out = new Float64Array(store.dirty);
  n = store.takeDirty(out);
  const union = new Set([...before, ...after]);
  assert(n === union.size, `move dirtied ${n} chunks, expected ${union.size}`);
  for (let i = 0; i < n; i++) assert(union.has(out[i]), `chunk ${out[i]} is outside the moved range`);
});

Deno.test("an op list is measured, bounded, and freed for reuse", () => {
  const store = new BrushStore();
  const id = store.add({ kind: BRUSH_CSG, cell: [0, 0, 0], ops: boxOps(3) });
  const at = store.offsetOf(id);
  const box = new Float64Array(6);
  store.boxOf(id, box);
  for (let i = 0; i < 3; i++) {
    assert(box[i] === -3 && box[3 + i] === 3, `axis ${i}: box is ${box[i]}..${box[3 + i]}, expected -3..3`);
  }
  const offset = store.records.u32[at + 5];
  const count = store.records.u32[at + 6] & 0xffff;
  assert(count > 0, "the op list should be recorded");

  // A replacement of the same size reuses the freed run.
  store.setOps(id, boxOps(5));
  assert(store.records.u32[at + 5] === offset, "the same-size op list should reuse the run");
  store.boxOf(id, box);
  assert(box[0] === -5 && box[3] === 5, `the box should follow the new op list, got ${box[0]}..${box[3]}`);

  // A removed brush's run comes back too.
  store.remove(id);
  const other = store.add({ kind: BRUSH_CSG, cell: [10, 10, 10], ops: boxOps(1) });
  assert(store.records.u32[store.offsetOf(other) + 5] === offset, "a removed brush's run should be reused");
  assert(store.count === 1, `count ${store.count}`);
});

Deno.test("orientation and scale move the world box, exactly", () => {
  const store = new BrushStore();
  // A box twice as long in x as in z, so a rotation is visible in the bounds.
  const ops = packCsg([{ prim: PRIM_BOX, params: [8, 2, 4], center: [0, 0, 0] }]);
  const id = store.add({ kind: BRUSH_CSG, cell: [100, 0, -50], ops, scale: 2 });
  const box = new Float64Array(6);
  store.boxOf(id, box);
  assert(box[0] === 100 - 16 && box[3] === 100 + 16, `x: ${box[0]}..${box[3]}`);
  assert(box[1] === -4 && box[4] === 4, `y: ${box[1]}..${box[4]}`);
  assert(box[2] === -50 - 8 && box[5] === -50 + 8, `z: ${box[2]}..${box[5]}`);
  // A rotation permutes the extents and leaves the anchor at the center, exactly.
  const want = [16, 4, 8].sort((a, b) => a - b).join();
  const seen = new Set<string>();
  for (let o = 0; o < 24; o++) {
    store.move(id, 100, 0, -50, o);
    store.boxOf(id, box);
    const e = [0, 1, 2].map((i) => (box[3 + i] - box[i]) / 2);
    assert(e.slice().sort((a, b) => a - b).join() === want, `orientation ${o}: extents ${e}`);
    for (let i = 0; i < 3; i++) {
      const center = (box[i] + box[3 + i]) / 2;
      const anchor = [100, 0, -50][i];
      assert(center === anchor, `orientation ${o}, axis ${i}: center ${center}, anchor ${anchor}`);
    }
    seen.add(e.join());
  }
  // The 24 rotations induce all six axis permutations.
  assert(seen.size === 6, `the extents took ${seen.size} arrangements, expected 6`);
});

Deno.test("a voxel brush is measured from its ops and never evaluated as a field", () => {
  const store = new BrushStore();
  const ops = packVoxel([{ mode: VOXEL_SET, shape: SHAPE_BOX, id: 3, params: [0, 0, 0, 7, 3, 1] }]);
  const id = store.add({ kind: BRUSH_VOXEL, cell: [64, 16, 64], ops });
  const box = new Float64Array(6);
  store.boxOf(id, box);
  assert(box[0] === 64 && box[3] === 64 + 8, `x: ${box[0]}..${box[3]}`);
  assert(box[1] === 16 && box[4] === 16 + 4, `y: ${box[1]}..${box[4]}`);
  assert(box[2] === 64 && box[5] === 64 + 2, `z: ${box[2]}..${box[5]}`);
});

Deno.test("an SDF brush must declare its box, and every brush a bound of at least 1", () => {
  const store = new BrushStore();
  let threw = false;
  try {
    store.add({ kind: BRUSH_SDF, cell: [0, 0, 0], type: 1 });
  } catch {
    threw = true;
  }
  assert(threw, "an SDF brush without bounds should be rejected");
  threw = false;
  try {
    store.add({ kind: BRUSH_SDF, cell: [0, 0, 0], type: 1, localMin: [-1, -1, -1], localMax: [1, 1, 1], lipschitz: 0.5 });
  } catch {
    threw = true;
  }
  assert(threw, "a Lipschitz bound below 1 should be rejected");
});

Deno.test("update changes a record's fields and reindexes by the new blend radius", () => {
  const store = new BrushStore();
  const id = store.add({ kind: BRUSH_CSG, cell: [0, 0, 0], material: 4, ops: boxOps(4) });
  store.takeDirty(new Float64Array(store.dirty)); // the add's dirty set is not what this checks

  store.update(id, { material: 9, scale: 3, blendK: 5, blend: BLEND_SMIN });
  const at = store.offsetOf(id);
  assert(((store.records.u32[at + 4] >>> 16) & 0xffff) === 9, "material changed");
  assert(store.records.f32[at + 7] === 3, "scale changed");
  assert(store.records.f32[at + 14] === 5, "blend radius changed");
  assert(((store.records.u32[at + 3] >>> 20) & 7) === BLEND_SMIN, "blend changed");
  const box = new Float64Array(6);
  store.boxOf(id, box);
  assert(box[0] === -12 && box[3] === 12, `the box follows the scale, got ${box[0]}..${box[3]}`);

  // The index now covers the wider blend radius, and only the voxels that can change
  // were dirtied.
  const indexed = expectedChunks(store, id);
  const out = new Int32Array(64);
  for (const key of indexed) assert(store.instancesIn(key, out) === 1, `chunk ${key} should hold the brush`);
  const dirty = new Float64Array(store.dirty);
  const n = store.takeDirty(dirty);
  const want = expectedDirty(store, id);
  assert(n >= want.size, `update dirtied ${n} chunks, fewer than the ${want.size} it can change`);
  assert(n < indexed.size, `update dirtied ${n} chunks, as many as the fold reaches`);

  // Everything else survived the partial update.
  assert(((store.records.u32[at + 3] >>> 18) & 3) === BRUSH_CSG, "kind survived");
  assert((store.records.u32[at + 6] & 0xffff) > 0, "the op list survived");
});

Deno.test("a blend that reaches every chunk is rejected for an instance", () => {
  const store = new BrushStore();
  for (const blend of [BLEND_INTERSECT, BLEND_SMAX]) {
    let threw = false;
    try {
      store.add({ kind: BRUSH_CSG, cell: [0, 0, 0], blend, ops: boxOps(2) });
    } catch {
      threw = true;
    }
    assert(threw, `blend ${blend} should be rejected on add`);
  }
  const id = store.add({ kind: BRUSH_CSG, cell: [0, 0, 0], ops: boxOps(2) });
  let threw = false;
  try {
    store.update(id, { blend: BLEND_INTERSECT });
  } catch {
    threw = true;
  }
  assert(threw, "and on update");
  assert(((store.records.u32[store.offsetOf(id) + 3] >>> 20) & 7) === BLEND_UNION, "the record is unchanged");
});

Deno.test("instances come back in creation order even after an id is reused", () => {
  const store = new BrushStore();
  const first = store.add({ kind: BRUSH_CSG, cell: [0, 0, 0], ops: boxOps(2) });
  const second = store.add({ kind: BRUSH_CSG, cell: [1, 0, 0], ops: boxOps(2) });
  store.remove(first);
  // The freed id comes back, so this instance is newer but has the lower id.
  const third = store.add({ kind: BRUSH_CSG, cell: [2, 0, 0], ops: boxOps(2) });
  assert(third === first, `expected the freed id back, got ${third}`);
  assert(store.seqOf(third) > store.seqOf(second), "the reused id carries a newer sequence number");
  const out = new Int32Array(8);
  const n = store.instancesIn(chunkKey(0, 0, 0), out);
  assert(n === 2, `${n} instances`);
  assert(out[0] === second && out[1] === third, `order ${out[0]}, ${out[1]}: not creation order`);
});
