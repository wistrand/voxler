import { chunkKey } from "../world/keys.ts";
import { BrushBatch, MAX_BRUSHES_PER_CHUNK } from "./batch.ts";
import { packCsg, packVoxel } from "./build.ts";
import { BRUSH_CSG, BRUSH_VOXEL, INSTANCE_WORDS, PRIM_BOX, PRIM_SPHERE, SHAPE_BOX, VOXEL_SET } from "./format.ts";
import { BrushStore } from "./store.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function setup() {
  return {
    store: new BrushStore(),
    records: new Uint32Array(4 * MAX_BRUSHES_PER_CHUNK * INSTANCE_WORDS),
    ops: new Uint32Array(8192),
    ranges: new Uint32Array(4 * 4),
  };
}

Deno.test("each chunk gets a contiguous run, with op offsets rewritten into the batch", () => {
  const { store, records, ops, ranges } = setup();
  const store2 = store;
  // One brush in chunk (0,0,0) only, and one big enough to reach both chunks.
  const small = store2.add({ kind: BRUSH_CSG, cell: [8, 8, 8], ops: packCsg([{ prim: PRIM_SPHERE, params: [2] }]) });
  const wide = store2.add({ kind: BRUSH_CSG, cell: [32, 8, 8], ops: packCsg([{ prim: PRIM_BOX, params: [40, 4, 4] }]) });
  const batch = new BrushBatch(store2);
  const coords = Int32Array.of(0, 0, 0, 1, 0, 0);
  const n = batch.pack(coords, 2, records, ops, ranges);
  assert(n >= 3, `${n} records for two chunks that share a brush`);
  assert(ranges[1] >= 2 && ranges[5] >= 1, `chunk runs ${ranges[1]}, ${ranges[5]}`);
  assert(ranges[4] === ranges[1], `the second run starts at ${ranges[4]}, after ${ranges[1]}`);

  // Every record's op offset points inside this batch's ops, at a copy of the words
  // the store holds for the instance with that sequence number.
  const bySeq = new Map<number, number>();
  for (const id of [small, wide]) bySeq.set(store2.seqOf(id), id);
  for (let i = 0; i < n; i++) {
    const at = i * INSTANCE_WORDS;
    const offset = records[at + 5];
    const count = records[at + 6] & 0xffff;
    assert(offset + count <= batch.opWords, `record ${i}: ops ${offset}..${offset + count} past ${batch.opWords}`);
    assert(count > 0, `record ${i} lost its op count`);
    const id = bySeq.get(records[at + 15]);
    assert(id !== undefined, `record ${i} has sequence ${records[at + 15]}, which is no instance`);
    const from = store2.opsOffsetOf(id!);
    assert(count === store2.opsCountOf(id!), `record ${i}: ${count} op words, store has ${store2.opsCountOf(id!)}`);
    for (let w = 0; w < count; w++) {
      assert(ops[offset + w] === store2.ops.u32[from + w], `record ${i} word ${w} differs from the store`);
    }
  }
  assert(batch.dropped === 0, `${batch.dropped} dropped`);
  assert(store2.kindOf(wide) === BRUSH_CSG && store2.kindOf(small) === BRUSH_CSG, "both are field brushes");
});

Deno.test("voxel brushes are left out, and the Lipschitz bound is the largest in the chunk", () => {
  const { store, records, ops, ranges } = setup();
  store.add({
    kind: BRUSH_VOXEL,
    cell: [4, 4, 4],
    ops: packVoxel([{ mode: VOXEL_SET, shape: SHAPE_BOX, id: 3, params: [0, 0, 0, 4, 4, 4] }]),
  });
  const field = store.add({ kind: BRUSH_CSG, cell: [8, 8, 8], ops: packCsg([{ prim: PRIM_SPHERE, params: [3] }]) });
  const batch = new BrushBatch(store);
  const n = batch.pack(Int32Array.of(0, 0, 0), 1, records, ops, ranges);
  assert(n === 1, `${n} records: only the field brush belongs in the fold`);
  assert(ranges[1] === 1, `run of ${ranges[1]}`);
  assert(records[5] === 0 && (records[6] & 0xffff) === store.opsCountOf(field), "the field brush's ops came over");

  // An ellipsoid with a wide radius ratio raises the chunk's bound above 1.
  const steep = store.add({
    kind: BRUSH_CSG,
    cell: [8, 8, 8],
    ops: packCsg([{ prim: 6, params: [8, 1, 8] }]),
  });
  batch.pack(Int32Array.of(0, 0, 0), 1, records, ops, ranges);
  const bound = ranges[2] / 256;
  assert(bound >= 8, `chunk bound ${bound}, expected at least the ellipsoid's ratio`);
  assert(store.kindOf(steep) === BRUSH_CSG, "kind");
});

Deno.test("a chunk with no brushes gets an empty run, and one far away is untouched", () => {
  const { store, records, ops, ranges } = setup();
  store.add({ kind: BRUSH_CSG, cell: [8, 8, 8], ops: packCsg([{ prim: PRIM_SPHERE, params: [2] }]) });
  const batch = new BrushBatch(store);
  const n = batch.pack(Int32Array.of(50, 50, 50, 0, 0, 0), 2, records, ops, ranges);
  assert(ranges[1] === 0 && ranges[2] === 0, `the far chunk got a run of ${ranges[1]}`);
  assert(ranges[5] === 1, `the near chunk got a run of ${ranges[5]}`);
  assert(n === 1, `${n} records`);
});

Deno.test("more brushes than a chunk holds are dropped and counted, never silently packed", () => {
  const { store, ops, ranges } = setup();
  const records = new Uint32Array(MAX_BRUSHES_PER_CHUNK * INSTANCE_WORDS);
  for (let i = 0; i < MAX_BRUSHES_PER_CHUNK + 8; i++) {
    store.add({ kind: BRUSH_CSG, cell: [8, 8, 8], ops: packCsg([{ prim: PRIM_SPHERE, params: [1] }]) });
  }
  const batch = new BrushBatch(store);
  const n = batch.pack(Int32Array.of(0, 0, 0), 1, records, ops, ranges);
  assert(n === MAX_BRUSHES_PER_CHUNK, `${n} records, expected the cap`);
  assert(batch.dropped === 8, `${batch.dropped} dropped, expected 8`);
  assert(ranges[1] === MAX_BRUSHES_PER_CHUNK, `run of ${ranges[1]}`);
  assert(chunkKey(0, 0, 0) !== 0, "keys are real");
});
