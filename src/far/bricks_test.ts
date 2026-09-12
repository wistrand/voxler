import { ChunkData } from "../world/chunk.ts";
import { CHUNK_VOLUME, voxelIndex } from "../world/coords.ts";
import { random01 } from "../util/random.ts";
import { BLOCK_FAR_SOLID } from "../world/blocks.ts";
import { ChunkStore } from "../world/store.ts";
import { BRICK_CELLS, BRICK_OCCUPANCY_WORDS, BRICK_WORDS, BrickGrid, cellIndex } from "./bricks.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function store(fill: (x: number, y: number, z: number) => number, chunks: [number, number, number][]): ChunkStore {
  const s = new ChunkStore({ maxChunks: 512, arenaBytes: 32 << 20, shared: false });
  for (const [cx, cy, cz] of chunks) {
    const dense = new Uint16Array(CHUNK_VOLUME);
    for (let y = 0; y < 32; y++) {
      for (let z = 0; z < 32; z++) {
        for (let x = 0; x < 32; x++) dense[voxelIndex(x, y, z)] = fill(cx * 32 + x, cy * 32 + y, cz * 32 + z);
      }
    }
    if (s.put(cx, cy, cz, ChunkData.fromDense(dense)) === -1) throw new Error("store full");
  }
  return s;
}

function readCell(grid: BrickGrid, brick: number, x: number, y: number, z: number): { solid: boolean; id: number } {
  const at = brick * BRICK_WORDS;
  const i = cellIndex(x, y, z);
  const solid = (grid.bricks[at + (i >>> 5)] & (1 << (i & 31))) !== 0;
  const word = grid.bricks[at + BRICK_OCCUPANCY_WORDS + (i >>> 2)];
  return { solid, id: (word >>> ((i & 3) * 8)) & 0xff };
}

Deno.test("a cell is solid when any voxel in it is, and takes that block id", () => {
  // One opaque voxel in an otherwise empty chunk: exactly one cell should be solid.
  const s = store((x, y, z) => (x === 17 && y === 5 && z === 30 ? 7 : 0), [[0, 0, 0]]);
  const grid = new BrickGrid({ level: 1, size: 8 });
  grid.build(s, 16, 16, 16);
  let solidCells = 0;
  let found: { brick: number; cell: number[] } | null = null;
  for (let slot = 0; slot < grid.indirection.length; slot++) {
    const entry = grid.indirection[slot];
    if (entry === 0) continue;
    const b = entry - 1;
    for (let z = 0; z < BRICK_CELLS; z++) {
      for (let y = 0; y < BRICK_CELLS; y++) {
        for (let x = 0; x < BRICK_CELLS; x++) {
          const c = readCell(grid, b, x, y, z);
          if (!c.solid) continue;
          solidCells++;
          found = { brick: b, cell: [x, y, z] };
          assert(c.id === 7, `the solid cell has id ${c.id}, expected the voxel's 7`);
        }
      }
    }
  }
  assert(solidCells === 1, `${solidCells} solid cells for one opaque voxel`);
  // Level 1 halves: voxel 17, 5, 30 lands in cell 8, 2, 15 of the world, and the
  // brick covering it is at brick 1, 0, 1 (16 voxels a side).
  assert(found !== null && found.cell.join() === "0,2,7", `the solid cell is at ${found?.cell}`);
});

Deno.test("empty bricks cost an indirection entry and no pool space", () => {
  const s = store((_x, y) => (y < 8 ? 1 : 0), [[0, 0, 0], [1, 0, 0]]);
  const grid = new BrickGrid({ level: 1, size: 8 });
  grid.build(s, 16, 16, 16);
  let empty = 0, filled = 0;
  for (const entry of grid.indirection) {
    if (entry === 0) empty++;
    else filled++;
  }
  assert(filled === grid.brickCount, `${filled} entries for ${grid.brickCount} bricks`);
  assert(empty > filled, `${empty} empty against ${filled} filled: a ground plane should leave most empty`);
});

Deno.test("every indirection entry points at a brick whose cells match the voxels", () => {
  const solid = (x: number, y: number, z: number) => {
    const v = random01(9, (x + 64) * 4096 + (y + 64) * 64 + (z + 64));
    return v < 0.08 ? 1 + Math.floor(v * 40) % 5 : 0;
  };
  const chunks: [number, number, number][] = [];
  for (let cx = 0; cx <= 1; cx++) for (let cy = 0; cy <= 1; cy++) for (let cz = 0; cz <= 1; cz++) chunks.push([cx, cy, cz]);
  const s = store(solid, chunks);
  const grid = new BrickGrid({ level: 1, size: 4 });
  grid.build(s, 32, 32, 32);
  const size = grid.options.size;
  let checked = 0;
  for (let bz = 0; bz < size; bz++) {
    for (let by = 0; by < size; by++) {
      for (let bx = 0; bx < size; bx++) {
        const entry = grid.indirection[bx + by * size + bz * size * size];
        const base = [
          (grid.origin[0] + bx) * grid.brickVoxels,
          (grid.origin[1] + by) * grid.brickVoxels,
          (grid.origin[2] + bz) * grid.brickVoxels,
        ];
        for (let z = 0; z < BRICK_CELLS; z++) {
          for (let y = 0; y < BRICK_CELLS; y++) {
            for (let x = 0; x < BRICK_CELLS; x++) {
              // The oracle: any opaque voxel in the cell, straight from the fill.
              let want = 0;
              for (let vz = 0; vz < 2 && want === 0; vz++) {
                for (let vy = 0; vy < 2 && want === 0; vy++) {
                  for (let vx = 0; vx < 2 && want === 0; vx++) {
                    const wx = base[0] + x * 2 + vx, wy = base[1] + y * 2 + vy, wz = base[2] + z * 2 + vz;
                    if (wx < 0 || wx >= 64 || wy < 0 || wy >= 64 || wz < 0 || wz >= 64) continue;
                    const id = solid(wx, wy, wz);
                    if (BLOCK_FAR_SOLID[id] === 1) want = id;
                  }
                }
              }
              checked++;
              if (entry === 0) {
                assert(want === 0, `brick (${bx}, ${by}, ${bz}) is empty but cell (${x}, ${y}, ${z}) should be ${want}`);
                continue;
              }
              const got = readCell(grid, entry - 1, x, y, z);
              assert(got.solid === (want !== 0), `cell (${x}, ${y}, ${z}) solid ${got.solid}, expected ${want !== 0}`);
              if (want !== 0) assert(got.id === want, `cell (${x}, ${y}, ${z}) id ${got.id}, expected ${want}`);
            }
          }
        }
      }
    }
  }
  assert(checked === size ** 3 * BRICK_CELLS ** 3, `${checked} cells checked`);
  assert(grid.brickCount > 0, "the region should produce bricks");
});

Deno.test("the grid centres on the position it is built around", () => {
  const s = store(() => 0, [[0, 0, 0]]);
  const grid = new BrickGrid({ level: 1, size: 8 });
  grid.build(s, 1000, -40, 3000);
  const b = grid.brickVoxels;
  for (const [i, v] of [1000, -40, 3000].entries()) {
    const centre = (grid.origin[i] + grid.options.size / 2) * b;
    assert(Math.abs(centre - v) <= b, `axis ${i}: grid centre ${centre} against ${v}`);
  }
  assert(grid.extentVoxels === 8 * 16, `extent ${grid.extentVoxels}`);
});
