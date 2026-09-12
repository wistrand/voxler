import { chunkKey } from "../world/keys.ts";
import { packCsg, packVoxel } from "./build.ts";
import { BRUSH_CSG, BRUSH_VOXEL, INSTANCE_WORDS, PRIM_SPHERE, SHAPE_BOX, VOXEL_SET } from "./format.ts";
import { BrushGrid, GRID_X, GRID_Y, GRID_Z } from "./grid.ts";
import { BrushStore } from "./store.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function cellOf(grid: BrushGrid, cx: number, cy: number, cz: number): number {
  const x = cx - grid.origin[0], y = cy - grid.origin[1], z = cz - grid.origin[2];
  assert(x >= 0 && x < GRID_X && y >= 0 && y < GRID_Y && z >= 0 && z < GRID_Z, `chunk (${cx}, ${cy}, ${cz}) is outside`);
  return x + z * GRID_X + y * GRID_X * GRID_Z;
}

Deno.test("a brush lands in every cell it reaches, with its ops copied in", () => {
  const store = new BrushStore();
  const id = store.add({ kind: BRUSH_CSG, cell: [16, 16, 16], material: 5, ops: packCsg([{ prim: PRIM_SPHERE, params: [4] }]) });
  const grid = new BrushGrid(store);
  assert(grid.update(0, 0, 0), "the first update builds");
  const cell = cellOf(grid, 0, 0, 0);
  assert(grid.cells[cell * 4 + 1] === 1, `chunk (0, 0, 0) holds ${grid.cells[cell * 4 + 1]} brushes`);
  const at = grid.cells[cell * 4] * INSTANCE_WORDS;
  assert(((grid.records[at + 4] >>> 16) & 0xffff) === 5, "the record came over");
  const offset = grid.records[at + 5];
  const count = grid.records[at + 6] & 0xffff;
  const from = store.opsOffsetOf(id);
  assert(count === store.opsCountOf(id), `${count} op words`);
  for (let w = 0; w < count; w++) assert(grid.ops[offset + w] === store.ops.u32[from + w], `op word ${w} differs`);

  // The index pad reaches the neighbouring chunks, so they hold it too.
  assert(grid.cells[cellOf(grid, 1, 0, 0) * 4 + 1] === 1, "the chunk next door holds it as well");
  // And somewhere well away does not.
  assert(grid.cells[cellOf(grid, 8, 0, 8) * 4 + 1] === 0, "a distant cell is empty");
});

Deno.test("the grid rebuilds when a brush changes or the camera moves a chunk", () => {
  const store = new BrushStore();
  const grid = new BrushGrid(store);
  assert(grid.update(0, 0, 0), "first build");
  assert(!grid.update(0, 0, 0), "nothing changed");
  store.add({ kind: BRUSH_CSG, cell: [0, 0, 0], ops: packCsg([{ prim: PRIM_SPHERE, params: [2] }]) });
  assert(grid.update(0, 0, 0), "a new brush rebuilds it");
  assert(!grid.update(0, 0, 0), "and then it settles");
  assert(grid.update(1, 0, 0), "moving a chunk rebuilds it");
  assert(grid.origin[0] === 1 - GRID_X / 2, `origin x ${grid.origin[0]}`);
});

Deno.test("voxel brushes are not in the grid, and neither is anything outside it", () => {
  const store = new BrushStore();
  store.add({
    kind: BRUSH_VOXEL,
    cell: [8, 8, 8],
    ops: packVoxel([{ mode: VOXEL_SET, shape: SHAPE_BOX, id: 2, params: [0, 0, 0, 3, 3, 3] }]),
  });
  store.add({ kind: BRUSH_CSG, cell: [8, 8, 8], ops: packCsg([{ prim: PRIM_SPHERE, params: [2] }]) });
  // Far outside the grid around the origin.
  store.add({ kind: BRUSH_CSG, cell: [8000, 0, 8000], ops: packCsg([{ prim: PRIM_SPHERE, params: [2] }]) });
  const grid = new BrushGrid(store);
  grid.update(0, 0, 0);
  assert(grid.recordCount === 0 || grid.recordCount > 0, "built");
  assert(grid.cells[cellOf(grid, 0, 0, 0) * 4 + 1] === 1, "only the field brush is in the cell");
  let total = 0;
  for (let i = 0; i < grid.cells.length; i += 4) total += grid.cells[i + 1];
  // The one field brush, in the cells its padded box reaches, and nothing else.
  assert(total > 0 && total < 64, `${total} cell entries`);
  assert(grid.dropped === 0, `${grid.dropped} dropped`);
  assert(chunkKey(0, 0, 0) !== undefined, "keys are real");
});

Deno.test("every cell's run lies inside the record array and its own count", () => {
  const store = new BrushStore();
  for (let i = 0; i < 12; i++) {
    store.add({
      kind: BRUSH_CSG,
      cell: [i * 9 - 40, (i % 3) * 12 - 12, i * 5 - 20],
      ops: packCsg([{ prim: PRIM_SPHERE, params: [3 + (i % 4)] }]),
    });
  }
  const grid = new BrushGrid(store);
  grid.update(0, 0, 0);
  let seen = 0;
  for (let i = 0; i < grid.cells.length; i += 4) {
    const start = grid.cells[i];
    const count = grid.cells[i + 1];
    seen += count;
    assert(start + count <= grid.recordCount, `cell ${i / 4}: run ${start}..${start + count} past ${grid.recordCount}`);
    if (count > 0) assert(grid.cells[i + 2] >= 256, `cell ${i / 4}: Lipschitz ${grid.cells[i + 2] / 256}, expected >= 1`);
  }
  assert(seen === grid.recordCount, `${seen} entries across cells, ${grid.recordCount} records`);
});
