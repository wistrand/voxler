// Far-field brick builder (plan-far-field phases 2-3, plan-sdf-generation phase 4).
// Requires the generated block constants, sdf/lib.wgsl, brush/brush.wgsl, and a world
// program. One dispatch per clipmap slab: B x B workgroups, one per brick, 64 threads
// each, 8 cells per thread, straight from the world SDF. No chunks, no readback of
// voxels, so the far field reaches past what streaming holds.
//
// Chunks an edit has changed have no field left to sample and are reduced from their
// voxels instead (src/far/brick-job.ts). Field brushes are part of the field here,
// through the same camera-centred grid the preview uses (src/brush/grid.ts), or
// placed brushes would vanish at the near/far boundary.
//
// A cell is solid when the SDF is negative at its centre, sampled with
// sample_footprint set to the cell size, so worlds drop octaves finer than a cell and
// the field is already the low-frequency version at this scale. The CPU reduction
// calls a cell solid when any voxel in it is, which keeps sub-cell features this rule
// drops; the difference is bounded by one cell at the surface and `?farCheck`
// measures it.
//
// Slots: the CPU cannot know which bricks are occupied until the field is sampled, so
// it hands the dispatch a list of free slots and each occupied brick takes the next
// one with an atomic. The entries this writes are copied back (`slab` report region)
// so the CPU can mirror them and return the slots it did not need
// (src/far/clipmap.ts).

struct SlabParams {
  origin: vec4i, // level origin in bricks; w: level index
  plane: vec4i, // x: slab axis, y: plane brick coord, z: ring slot, w: slots offered
  grid: vec4u, // bricks per side (B), voxels per cell, voxels per brick, world seed
  brush_origin: vec4i, // brush grid origin in chunks; w unused
  reduce_range: vec4u, // x: first request, y: request count; zw unused
}

struct FarColors {
  color: array<vec4f, 768>, // MAX_BLOCK_TYPES x 3; solidity is in the first one's alpha
}

@group(0) @binding(0) var<uniform> build: SlabParams;
@group(0) @binding(1) var<uniform> far_colors: FarColors; // alpha 1: solid
@group(0) @binding(2) var<storage, read_write> out_indirection: array<u32>;
@group(0) @binding(3) var<storage, read_write> out_bricks: array<u32>;
@group(0) @binding(4) var<storage, read> brush_records: array<u32>;
@group(0) @binding(5) var<storage, read> brush_ops: array<u32>;
@group(0) @binding(6) var<storage, read> brush_cells: array<vec4u>;
// Per ring slot: [0] the slot cursor, [1 .. 1+B^2] free slots the CPU offered,
// [1+B^2 .. 1+2*B^2] what this build did with them, copied back.
@group(0) @binding(7) var<storage, read_write> slab: array<atomic<u32>>;
// Coarse-brick rebuilds (reduce_bricks): REDUCE_WORDS per request, then one report
// word per request. Layout in src/far/far-field.ts.
@group(0) @binding(8) var<storage, read_write> reduce: array<u32>;

const BRICK_CELLS: u32 = 8u;
const BRICK_WORDS: u32 = 144u;
const OCCUPANCY_WORDS: u32 = 16u;
const COLOR_WORDS: u32 = 128u;
const CELLS_PER_THREAD: u32 = 8u;
// Reported for a brick that is occupied but found no free slot.
const REPORT_DROPPED: u32 = 0xFFFFFFFFu;
// Indirection entry for a brick that is solid throughout with one block id, which
// costs no pool slot (design-formats.md "Brick and clipmap"). Underground that is
// almost every brick, and without it the pool holds the volume rather than the
// surface.
const ENTRY_SOLID: u32 = 0x80000000u;
const BRICK_CELL_COUNT: u32 = 512u;

// Brush grid dimensions, in step with src/brush/grid.ts.
const BRUSH_GRID_X: i32 = 32;
const BRUSH_GRID_Y: i32 = 16;
const BRUSH_GRID_Z: i32 = 32;

var<workgroup> wg_occupancy: array<atomic<u32>, 16>;
var<workgroup> wg_colors: array<atomic<u32>, 128>;
var<workgroup> wg_any: atomic<u32>;
var<workgroup> wg_solid: atomic<u32>; // cells found solid
var<workgroup> wg_min: atomic<u32>; // block id range over them
var<workgroup> wg_max: atomic<u32>;
var<workgroup> wg_slot: u32;

// The brush run covering a point, or an empty one outside the grid.
fn far_brush_cell(p: WorldPoint) -> vec4u {
  let c = (p.cell >> vec3u(5u)) - build.brush_origin.xyz;
  if (any(c < vec3i(0)) || c.x >= BRUSH_GRID_X || c.y >= BRUSH_GRID_Y || c.z >= BRUSH_GRID_Z) {
    return vec4u(0u);
  }
  return brush_cells[u32(c.x + c.z * BRUSH_GRID_X + c.y * BRUSH_GRID_X * BRUSH_GRID_Z)];
}

// Brick coordinate of one workgroup of the slab. The two axes the slab spans are the
// other two, in ascending order, which is the order src/far/clipmap.ts walks them.
fn slab_brick(u: u32, v: u32) -> vec3i {
  let axis = build.plane.x;
  var b = build.origin.xyz;
  if (axis == 0) {
    b = vec3i(build.plane.y, b.y + i32(u), b.z + i32(v));
  } else if (axis == 1) {
    b = vec3i(b.x + i32(u), build.plane.y, b.z + i32(v));
  } else {
    b = vec3i(b.x + i32(u), b.y + i32(v), build.plane.y);
  }
  return b;
}

// Toroidal grid cell of a brick, inside the level's slice of the indirection buffer.
fn grid_cell(brick: vec3i) -> u32 {
  let size = i32(build.grid.x);
  let m = size - 1;
  let c = brick & vec3i(m);
  return u32(build.origin.w) * u32(size * size * size) + u32(c.x + c.y * size + c.z * size * size);
}

fn slab_base() -> u32 {
  let per = 1u + 2u * build.grid.x * build.grid.x;
  return u32(build.plane.z) * per;
}

// Clears a slab's indirection entries. Run when the slab is queued, so the ring that
// scrolls in reads as empty until it is built instead of as terrain from a window
// away (plan-far-field phase 3).
@compute @workgroup_size(64)
fn clear_slab(@builtin(global_invocation_id) gid: vec3u) {
  let size = build.grid.x;
  let i = gid.x;
  if (i >= size * size) {
    return;
  }
  out_indirection[grid_cell(slab_brick(i % size, i / size))] = 0u;
}

@compute @workgroup_size(64)
fn build_slab(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let size = build.grid.x;
  let brick = slab_brick(wg.x, wg.y);
  if (li < OCCUPANCY_WORDS) {
    atomicStore(&wg_occupancy[li], 0u);
  }
  for (var i = li; i < COLOR_WORDS; i += 64u) {
    atomicStore(&wg_colors[i], 0u);
  }
  if (li == 0u) {
    atomicStore(&wg_any, 0u);
    atomicStore(&wg_solid, 0u);
    atomicStore(&wg_min, 0xFFFFu);
    atomicStore(&wg_max, 0u);
  }
  workgroupBarrier();

  world_seed = build.grid.w;
  let cell_voxels = i32(build.grid.y);
  sample_footprint = f32(cell_voxels);
  let base = brick * i32(build.grid.z);
  var solid = 0u;
  var lo = 0xFFFFu;
  var hi = 0u;
  for (var k = 0u; k < CELLS_PER_THREAD; k++) {
    let c = li * CELLS_PER_THREAD + k;
    let cell = vec3i(
      i32(c % BRICK_CELLS),
      i32((c / BRICK_CELLS) % BRICK_CELLS),
      i32(c / (BRICK_CELLS * BRICK_CELLS)),
    );
    // The cell's centre, as an integer voxel plus a fraction: no f32 world position
    // is ever formed (CLAUDE.md "Invariants").
    let p = WorldPoint(base + cell * cell_voxels + vec3i(cell_voxels / 2), vec3f(0.5));
    let run = far_brush_cell(p);
    let s = brush_fold(p, run.x, run.y, vec2f(world_sdf(p), 0.0));
    if (s.x >= 0.0) {
      continue;
    }
    var id = u32(s.y);
    if (id == 0u) {
      id = world_material(p) & 0xFFFFu;
    }
    id = min(id, 255u);
    if (far_colors.color[id * 3u].a < 1.0) {
      continue; // not solid: translucent cells are phase 4's
    }
    atomicOr(&wg_occupancy[c >> 5u], 1u << (c & 31u));
    atomicOr(&wg_colors[c >> 2u], id << ((c & 3u) * 8u));
    atomicStore(&wg_any, 1u);
    solid++;
    lo = min(lo, id);
    hi = max(hi, id);
  }
  atomicAdd(&wg_solid, solid);
  atomicMin(&wg_min, lo);
  atomicMax(&wg_max, hi);
  workgroupBarrier();

  let sb = slab_base();
  let report = sb + 1u + size * size + wg.x + wg.y * size;
  if (li == 0u) {
    var entry = 0u;
    var reported = 0u;
    let filled = atomicLoad(&wg_solid) == BRICK_CELL_COUNT && atomicLoad(&wg_min) == atomicLoad(&wg_max);
    if (filled) {
      // Solid throughout with one id: the entry is the brick, and no slot is spent.
      entry = ENTRY_SOLID | (atomicLoad(&wg_min) & 0xFFu);
      reported = entry;
      wg_slot = 0xFFFFFFFFu;
    } else if (atomicLoad(&wg_any) != 0u) {
      let i = atomicAdd(&slab[sb], 1u);
      if (i < u32(build.plane.w)) {
        let slot = atomicLoad(&slab[sb + 1u + i]);
        entry = slot + 1u;
        reported = entry;
        wg_slot = slot;
      } else {
        reported = REPORT_DROPPED; // occupied, but the pool had nothing left
        wg_slot = 0xFFFFFFFFu;
      }
    } else {
      wg_slot = 0xFFFFFFFFu;
    }
    out_indirection[grid_cell(brick)] = entry;
    atomicStore(&slab[report], reported);
  }
  workgroupBarrier();

  let slot = wg_slot;
  if (slot == 0xFFFFFFFFu) {
    return; // empty or dropped: the pool is untouched
  }
  let at = slot * BRICK_WORDS;
  if (li < OCCUPANCY_WORDS) {
    out_bricks[at + li] = atomicLoad(&wg_occupancy[li]);
  }
  for (var i = li; i < COLOR_WORDS; i += 64u) {
    out_bricks[at + OCCUPANCY_WORDS + i] = atomicLoad(&wg_colors[i]);
  }
}

// Rebuilds one brick from the eight under it at the finer level, so an edit reaches the
// levels a chunk reduction cannot (plan-far-field phase 5). A coarse brick spans more
// than a chunk, and the chunks around an edit are on the GPU only, so the rebuild runs
// where the data is.
//
// One workgroup per request. A request is REDUCE_WORDS words: level (of the parent),
// brick xyz, the slot to write (the one it already holds, or one the CPU offered), and
// the count, which the dispatch reads from `reduce[0]`.

const REDUCE_WORDS: u32 = 8u;
const REDUCE_MAX: u32 = 256u; // requests the buffer holds, in step with far-field.ts
const REDUCE_NONE: u32 = 0xFFFFFFFFu;

// Whether the cell of a child brick is solid, and its block id.
fn child_cell(entry: u32, cell: vec3i) -> vec2u {
  if (entry == 0u) {
    return vec2u(0u, 0u);
  }
  if ((entry & ENTRY_SOLID) != 0u) {
    return vec2u(1u, entry & 0xFFu);
  }
  let slot = entry - 1u;
  let i = u32(cell.x + cell.y * i32(BRICK_CELLS) + cell.z * i32(BRICK_CELLS) * i32(BRICK_CELLS));
  if ((out_bricks[slot * BRICK_WORDS + (i >> 5u)] & (1u << (i & 31u))) == 0u) {
    return vec2u(0u, 0u);
  }
  let word = out_bricks[slot * BRICK_WORDS + OCCUPANCY_WORDS + (i >> 2u)];
  return vec2u(1u, (word >> ((i & 3u) * 8u)) & 0xFFu);
}

@compute @workgroup_size(64)
fn reduce_bricks(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  if (wg.x >= build.reduce_range.y) {
    return;
  }
  let request = build.reduce_range.x + wg.x;
  let at = request * REDUCE_WORDS;
  let level = reduce[at];
  let parent = vec3i(i32(reduce[at + 1u]), i32(reduce[at + 2u]), i32(reduce[at + 3u]));
  let slot = reduce[at + 4u];
  let size = build.grid.x;
  let cells = size * size * size;

  if (li < OCCUPANCY_WORDS) {
    atomicStore(&wg_occupancy[li], 0u);
  }
  for (var i = li; i < COLOR_WORDS; i += 64u) {
    atomicStore(&wg_colors[i], 0u);
  }
  if (li == 0u) {
    atomicStore(&wg_any, 0u);
    atomicStore(&wg_solid, 0u);
    atomicStore(&wg_min, 0xFFFFu);
    atomicStore(&wg_max, 0u);
  }
  workgroupBarrier();

  // The child level's slice of the indirection, and the eight bricks under this one.
  let child_base = (level - 1u) * cells;
  let m = i32(size) - 1;
  var solid = 0u;
  var lo = 0xFFFFu;
  var hi = 0u;
  for (var k = 0u; k < CELLS_PER_THREAD; k++) {
    let c = li * CELLS_PER_THREAD + k;
    let cell = vec3i(
      i32(c % BRICK_CELLS),
      i32((c / BRICK_CELLS) % BRICK_CELLS),
      i32(c / (BRICK_CELLS * BRICK_CELLS)),
    );
    // The parent cell covers 2x2x2 child cells; which child brick they are in is the
    // octant of the parent cell.
    let octant = cell / 4;
    let child = parent * 2 + octant;
    let cw = (child + vec3i(m + 1)) & vec3i(m); // toroidal, and never negative
    let entry = out_indirection[child_base + u32(cw.x + cw.y * i32(size) + cw.z * i32(size) * i32(size))];
    let base = (cell - octant * 4) * 2;
    var id = 0u;
    for (var j = 0u; j < 8u; j++) {
      let sub = base + vec3i(i32(j & 1u), i32((j >> 1u) & 1u), i32(j >> 2u));
      let got = child_cell(entry, sub);
      if (got.x != 0u) {
        id = got.y;
        break;
      }
    }
    if (id == 0u) {
      continue;
    }
    atomicOr(&wg_occupancy[c >> 5u], 1u << (c & 31u));
    atomicOr(&wg_colors[c >> 2u], id << ((c & 3u) * 8u));
    atomicStore(&wg_any, 1u);
    solid++;
    lo = min(lo, id);
    hi = max(hi, id);
  }
  atomicAdd(&wg_solid, solid);
  atomicMin(&wg_min, lo);
  atomicMax(&wg_max, hi);
  workgroupBarrier();

  let pw = (parent + vec3i(m + 1)) & vec3i(m);
  let cell_index = level * cells + u32(pw.x + pw.y * i32(size) + pw.z * i32(size) * i32(size));
  let report = REDUCE_MAX * REDUCE_WORDS + request;
  if (li == 0u) {
    var entry = 0u;
    if (atomicLoad(&wg_solid) == BRICK_CELL_COUNT && atomicLoad(&wg_min) == atomicLoad(&wg_max)) {
      entry = ENTRY_SOLID | (atomicLoad(&wg_min) & 0xFFu);
    } else if (atomicLoad(&wg_any) != 0u && slot != REDUCE_NONE) {
      entry = slot + 1u;
    }
    out_indirection[cell_index] = entry;
    reduce[report] = entry;
  }
  workgroupBarrier();

  if (slot == REDUCE_NONE || atomicLoad(&wg_any) == 0u) {
    return;
  }
  let dst = slot * BRICK_WORDS;
  if (li < OCCUPANCY_WORDS) {
    out_bricks[dst + li] = atomicLoad(&wg_occupancy[li]);
  }
  for (var i = li; i < COLOR_WORDS; i += 64u) {
    out_bricks[dst + OCCUPANCY_WORDS + i] = atomicLoad(&wg_colors[i]);
  }
}
