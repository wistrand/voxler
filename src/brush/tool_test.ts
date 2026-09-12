import { CHUNK_VOLUME, voxelIndex } from "../world/coords.ts";
import { chunkKey } from "../world/keys.ts";
import { newRayHit } from "../world/raycast.ts";
import { SHAPE_BOX, SHAPE_SPHERE, SHAPE_VOXEL } from "./format.ts";
import { ORIENTATION_COUNT } from "./orientation.ts";
import { BrushStore } from "./store.ts";
import { EditTool } from "./tool.ts";
import { applyChunkOps, packChunkOps } from "./voxel-ops.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// The chunk (0, 0, 0) after the voxel stage.
function bake(store: BrushStore): Uint16Array {
  const dense = new Uint16Array(CHUNK_VOLUME);
  const packed = packChunkOps(store, chunkKey(0, 0, 0));
  if (packed !== null) applyChunkOps(dense, 0, 0, 0, packed);
  return dense;
}

// A hit on the voxel at (x, y, z), entered through its -Y face (looking down).
function hitAt(x: number, y: number, z: number) {
  const h = newRayHit();
  h.hit = true;
  h.x = x;
  h.y = y;
  h.z = z;
  h.fromX = x;
  h.fromY = y + 1;
  h.fromZ = z;
  h.face = 2;
  h.id = 1;
  return h;
}

Deno.test("place puts the shape against the face, remove takes it out of the voxel hit", () => {
  const store = new BrushStore();
  const tool = new EditTool(store);
  tool.state.blockId = 5;
  tool.place(hitAt(10, 10, 10));
  let dense = bake(store);
  assert(dense[voxelIndex(10, 11, 10)] === 5, "placed on the face the ray entered");
  assert(dense[voxelIndex(10, 10, 10)] === 0, "and not in the voxel hit");

  tool.state.blockId = 0;
  tool.remove(hitAt(20, 20, 20));
  dense = bake(store);
  assert(dense[voxelIndex(20, 20, 20)] === 0, "a carve writes air");
});

Deno.test("undo and redo walk the log, and a new edit drops what was undone", () => {
  const store = new BrushStore();
  const tool = new EditTool(store);
  tool.state.blockId = 3;
  tool.place(hitAt(4, 4, 4));
  tool.state.blockId = 6;
  tool.place(hitAt(8, 8, 8));
  assert(tool.undoDepth === 2 && tool.redoDepth === 0, `depths ${tool.undoDepth}, ${tool.redoDepth}`);
  assert(bake(store)[voxelIndex(8, 9, 8)] === 6, "the second edit is there");

  assert(tool.undo(), "undo");
  assert(bake(store)[voxelIndex(8, 9, 8)] === 0, "the second edit is gone");
  assert(bake(store)[voxelIndex(4, 5, 4)] === 3, "the first edit stays");
  assert(tool.undoDepth === 1 && tool.redoDepth === 1, `depths ${tool.undoDepth}, ${tool.redoDepth}`);

  assert(tool.redo(), "redo");
  assert(bake(store)[voxelIndex(8, 9, 8)] === 6, "redo brought it back");
  assert(store.count === 2, `${store.count} instances`);

  // Undo, then a different edit: the redo is gone and the store holds only the live
  // ones.
  assert(tool.undo(), "undo again");
  tool.state.blockId = 9;
  tool.place(hitAt(12, 12, 12));
  assert(tool.redoDepth === 0, "a new edit drops the redo");
  assert(!tool.redo(), "and there is nothing to redo");
  const dense = bake(store);
  assert(dense[voxelIndex(12, 13, 12)] === 9 && dense[voxelIndex(8, 9, 8)] === 0, "only the live edits are baked");
  assert(store.count === 2, `${store.count} instances after the replacement`);
});

Deno.test("undo restores the exact voxels, over a run of random edits", () => {
  const store = new BrushStore();
  const tool = new EditTool(store);
  const snapshots: Uint16Array[] = [bake(store)];
  for (let i = 0; i < 12; i++) {
    tool.state.blockId = 1 + (i % 5);
    tool.state.shape = [SHAPE_VOXEL, SHAPE_BOX, SHAPE_SPHERE][i % 3];
    tool.state.orientation = (i * 7) % ORIENTATION_COUNT;
    tool.place(hitAt(4 + i * 2, 6 + (i % 4) * 3, 5 + ((i * 3) % 20)));
    snapshots.push(bake(store));
  }
  for (let i = snapshots.length - 1; i > 0; i--) {
    assert(tool.undo(), `undo ${i}`);
    const now = bake(store);
    const want = snapshots[i - 1];
    for (let v = 0; v < CHUNK_VOLUME; v++) {
      if (now[v] !== want[v]) throw new Error(`after undo ${i}, voxel ${v} is ${now[v]}, was ${want[v]}`);
    }
  }
  assert(!tool.undo(), "nothing left to undo");
  assert(store.count === 0, `${store.count} instances left`);
});

Deno.test("rotating cycles the 24 orientations both ways and shows in the tool state", () => {
  const tool = new EditTool(new BrushStore());
  for (let i = 0; i < ORIENTATION_COUNT; i++) {
    assert(tool.state.orientation === i, `after ${i} steps the orientation is ${tool.state.orientation}`);
    tool.rotate(1);
  }
  assert(tool.state.orientation === 0, "a full cycle returns to the identity");
  tool.rotate(-1);
  assert(tool.state.orientation === ORIENTATION_COUNT - 1, `rotating back gave ${tool.state.orientation}`);
  assert(tool.describeState().includes("orientation 23"), tool.describeState());
});

Deno.test("an orientation turns an asymmetric brush, and the same brush placed twice differs", () => {
  const upright = new BrushStore();
  const laid = new BrushStore();
  const a = new EditTool(upright);
  const b = new EditTool(laid);
  for (const tool of [a, b]) {
    tool.state.shape = SHAPE_BOX;
    tool.state.blockId = 2;
    tool.state.sizeX = 1;
    tool.state.sizeY = 4;
    tool.state.sizeZ = 1;
  }
  // Find the orientation that maps the tall axis onto x.
  let turned = -1;
  for (let o = 1; o < ORIENTATION_COUNT && turned === -1; o++) {
    b.state.orientation = o;
    const id = b.apply(b.describe(16, 16, 16, 2));
    const box = new Float64Array(6);
    laid.boxOf(id, box);
    if (box[3] - box[0] === 9) turned = o;
    b.undo();
  }
  assert(turned !== -1, "some orientation should lay the box on its side");
  a.place(hitAt(16, 15, 16));
  b.state.orientation = turned;
  b.place(hitAt(16, 15, 16));
  const tall = bake(upright);
  const flat = bake(laid);
  assert(tall[voxelIndex(16, 20, 16)] === 2 && flat[voxelIndex(16, 20, 16)] === 0, "the upright one reaches higher");
  assert(flat[voxelIndex(20, 16, 16)] === 2 && tall[voxelIndex(20, 16, 16)] === 0, "the turned one reaches further along x");
});
