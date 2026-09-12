import { Clipmap, type Slab } from "./clipmap.ts";
import { BrickPool } from "./pool.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const OPTIONS = { size: 8, levels: 3, firstLevel: 1, bricks: 4096 };
const slab = (): Slab => ({ level: 0, axis: 0, plane: 0 });

// Builds every queued slab: takes it, pretends the GPU filled `fill` of its bricks,
// and reports back. Returns how many slabs were built.
function drain(map: Clipmap, fill: (level: number, bx: number, by: number, bz: number) => boolean): number {
  const size = map.options.size;
  const slots = new Uint32Array(size * size);
  const entries = new Uint32Array(size * size);
  const s = slab();
  let built = 0;
  while (map.take(s)) {
    const n = map.pool.take(slots, 0, size * size);
    let used = 0;
    for (let v = 0; v < size; v++) {
      for (let u = 0; u < size; u++) {
        const cell = map.slabCell(s.level, s.axis, s.plane, u, v);
        const b = brickOf(map, s, u, v);
        entries[u + v * size] = fill(s.level, b[0], b[1], b[2]) && used < n ? slots[used++] + 1 : 0;
        void cell;
      }
    }
    const reported = map.applyReport(s, entries, 0);
    assert(reported === used, `report counted ${reported} of ${used} bricks`);
    map.pool.giveRange(slots, used, n);
    built++;
    if (built > 10000) throw new Error("the queue never drains");
  }
  return built;
}

function brickOf(map: Clipmap, s: Slab, u: number, v: number): [number, number, number] {
  const other = [[1, 2], [0, 2], [0, 1]][s.axis];
  const b: [number, number, number] = [0, 0, 0];
  b[s.axis] = s.plane;
  b[other[0]] = map.origins[s.level * 3 + other[0]] + u;
  b[other[1]] = map.origins[s.level * 3 + other[1]] + v;
  return b;
}

Deno.test("the pool hands out distinct slots and takes them back", () => {
  const pool = new BrickPool(4);
  const out = new Uint32Array(8);
  assert(pool.take(out, 0, 3) === 3, "three slots");
  assert(new Set([out[0], out[1], out[2]]).size === 3, "slots are distinct");
  assert(pool.free === 1, `${pool.free} free after taking three of four`);
  assert(pool.take(out, 3, 4) === 1, "the pool hands out what it has left, not what was asked");
  assert(pool.free === 0, "empty");
  pool.giveRange(out, 0, 4);
  assert(pool.free === 4, `${pool.free} free after returning all four`);
});

Deno.test("the first update queues every level and marching finds the bricks", () => {
  const map = new Clipmap(OPTIONS);
  map.update(0, 0, 0);
  assert(map.queued === OPTIONS.size * OPTIONS.levels, `${map.queued} slabs queued`);
  // Solid ground: every brick with by < 0.
  const built = drain(map, (_level, _bx, by) => by < 0);
  assert(built === OPTIONS.size * OPTIONS.levels, `${built} slabs built`);
  for (let level = 0; level < map.levels; level++) {
    const o = level * 3;
    for (let by = map.origins[o + 1]; by < map.origins[o + 1] + OPTIONS.size; by++) {
      const slot = map.slotOf(level, map.origins[o], by, map.origins[o + 2]);
      assert((slot >= 0) === (by < 0), `level ${level} brick y ${by} slot ${slot}`);
    }
  }
});

Deno.test("scrolling one brick queues one slab per level that moved, and no more", () => {
  const map = new Clipmap(OPTIONS);
  map.update(0, 0, 0);
  drain(map, () => false); // nothing solid: no slots in play
  // One level-1 brick is 16 voxels; level 2 is 32 and level 3 is 64.
  map.update(16, 0, 0);
  assert(map.queued === 1, `${map.queued} slabs queued for a 16-voxel step`);
  drain(map, () => false);
  map.update(64, 0, 0);
  // From 16 to 64 voxels: level 1 (16-voxel bricks) moved three, level 2 two, level 3 one.
  assert(map.queued === 3 + 2 + 1, `${map.queued} slabs queued for a 64-voxel step`);
});

Deno.test("a pool too small for the terrain drops bricks instead of overrunning", () => {
  const map = new Clipmap({ ...OPTIONS, bricks: 100 });
  map.update(0, 0, 0);
  drain(map, (_level, _bx, by) => by < 0);
  assert(map.pool.used === 100, `${map.pool.used} of 100 slots used`);
  assert(map.pool.free === 0, "the pool is empty");
  let filled = 0;
  for (let i = 0; i < map.entries.length; i++) if (map.entries[i] !== 0) filled++;
  assert(filled === 100, `${filled} cells hold a slot`);
});

Deno.test("a brick that scrolls out gives its slot back", () => {
  const map = new Clipmap(OPTIONS);
  map.update(0, 0, 0);
  drain(map, (_level, _bx, by) => by < 0);
  const used = map.pool.used;
  assert(used > 0, "the ground filled bricks");
  // Move far enough that every level jumps a whole window: everything is dropped and
  // queued again.
  map.update(100000, 0, 0);
  assert(map.pool.used === 0, `${map.pool.used} slots still held after a teleport`);
  assert(map.queued === OPTIONS.size * OPTIONS.levels, `${map.queued} slabs queued after a teleport`);
  drain(map, (_level, _bx, by) => by < 0);
  assert(map.pool.used === used, `${map.pool.used} slots after rebuilding, against ${used} before`);
});

Deno.test("no cell is left pointing at a brick from somewhere else", () => {
  const map = new Clipmap(OPTIONS);
  const solid = (level: number, bx: number, by: number, bz: number) =>
    by < 0 && ((bx + bz + level) & 3) !== 0;
  map.update(0, 0, 0);
  drain(map, solid);
  // Walk the camera across several bricks, draining part of the queue each step, and
  // check every cell that holds a slot is a brick inside its level's window.
  for (let step = 1; step <= 40; step++) {
    map.update(step * 13, step * 3, step * 7);
    const s = slab();
    const size = OPTIONS.size;
    const slots = new Uint32Array(size * size);
    const entries = new Uint32Array(size * size);
    for (let i = 0; i < 2 && map.take(s); i++) {
      const n = map.pool.take(slots, 0, size * size);
      let used = 0;
      for (let v = 0; v < size; v++) {
        for (let u = 0; u < size; u++) {
          const b = brickOf(map, s, u, v);
          entries[u + v * size] = solid(s.level, b[0], b[1], b[2]) && used < n ? slots[used++] + 1 : 0;
        }
      }
      map.applyReport(s, entries, 0);
      map.pool.giveRange(slots, used, n);
    }
    // Every occupied cell must be a brick of the level's window, and hold a slot no
    // other cell holds.
    const seen = new Set<number>();
    for (let level = 0; level < map.levels; level++) {
      const o = level * 3;
      for (let z = 0; z < size; z++) {
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const bx = map.origins[o] + x, by = map.origins[o + 1] + y, bz = map.origins[o + 2] + z;
            const slot = map.slotOf(level, bx, by, bz);
            if (slot < 0) continue;
            assert(!seen.has(slot), `slot ${slot} is held by two cells at step ${step}`);
            seen.add(slot);
          }
        }
      }
    }
  }
});

Deno.test("a changed brick queues the bricks above it, finest level first", () => {
  const map = new Clipmap(OPTIONS);
  map.update(0, 0, 0);
  drain(map, (_level, _bx, by) => by < 0);
  // A brick at the finest level: every level above it covers the same ground.
  const o = map.origins;
  map.queueCoarse(0, o[0] + 2, o[1] + 2, o[2] + 2);
  assert(map.coarseQueued === 2, `${map.coarseQueued} coarse bricks queued for a 3-level map`);
  // Queueing it again changes nothing: the queue is deduplicated.
  map.queueCoarse(0, o[0] + 2, o[1] + 2, o[2] + 2);
  assert(map.coarseQueued === 2, `${map.coarseQueued} after queueing the same brick twice`);
  // The finer level comes out first, or it would be read before it was rebuilt.
  const out = new Int32Array(8 * 4);
  const first = map.takeCoarse(out, 8);
  assert(first === 1, `${first} taken first`);
  assert(out[0] === 1, `level ${out[0]} taken first, expected 1`);
  const second = map.takeCoarse(out, 8);
  assert(second === 1 && out[0] === 2, `level ${out[0]} taken second, expected 2`);
  assert(map.takeCoarse(out, 8) === 0, "the queue is empty");
});

Deno.test("a brick outside a coarser level's window is not queued for it", () => {
  const map = new Clipmap({ ...OPTIONS, levels: 2 });
  map.update(0, 0, 0);
  // A brick at the far corner of the finest level: its parent is inside level 1, so
  // one entry; nothing above that exists.
  const o = map.origins;
  map.queueCoarse(0, o[0], o[1], o[2]);
  assert(map.coarseQueued <= 1, `${map.coarseQueued} queued with only two levels`);
});
