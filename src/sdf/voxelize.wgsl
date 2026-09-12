// GPU chunk voxelizer. Requires the generated block constants, sdf/lib.wgsl,
// brush/brush.wgsl, and a world program. Two entry points over one bind group (Voxelizer in voxelizer.ts):
//
// voxelize: dispatch (64, count). One workgroup per 8^3 sub-block of one chunk.
//   Samples the field at the sub-block center; if |d| > lipschitz * reach, the whole
//   sub-block has one sign, so it is written as air, or as solid with only the
//   material evaluated. Otherwise every voxel center is tested. Writes u16 block ids
//   (two per u32, voxel order x + z*32 + y*1024) and per-chunk counters.
//
//   The field is the world program folded with the chunk's brushes
//   (brush/brush.wgsl). The bound that decides a skip is the larger of the world's
//   WORLD_LIPSCHITZ and the chunk's brushes' (brush_ranges[c].z, 8.8 fixed): a brush
//   with a steeper field must not be skipped over.
//
// compact_dense: dispatch (count). Copies each dense chunk's ids to the front of the
//   compact buffer in chunk order, so the CPU maps only the dense payloads.
//
// Layouts: agent_docs/design-formats.md "Voxelizer output".

struct VoxParams {
  seed: u32,
  count: u32, // chunks in this batch
  skip: u32, // 1: skip sub-blocks by the Lipschitz bound; 0: evaluate every voxel (tests)
  pad: u32,
}

// Per chunk. The CPU writes solid 0, min_id 0xFFFFFFFF, max_id 0 before each batch.
struct ChunkHeader {
  solid: atomic<u32>, // voxels with a nonzero block id
  min_id: atomic<u32>, // over solid voxels
  max_id: atomic<u32>,
  pad: u32,
}

@group(0) @binding(0) var<uniform> params: VoxParams;
@group(0) @binding(1) var<storage, read> chunks: array<vec4i>; // xyz chunk coordinate
@group(0) @binding(2) var<storage, read_write> headers: array<ChunkHeader>;
@group(0) @binding(3) var<storage, read_write> ids: array<u32>; // 16384 words per chunk slot
@group(0) @binding(4) var<storage, read_write> compact: array<u32>; // dense chunks, packed
@group(0) @binding(5) var<storage, read> brush_records: array<u32>; // 16 u32 each, per chunk contiguous
@group(0) @binding(6) var<storage, read> brush_ops: array<u32>;
// Per chunk: first record, record count, Lipschitz bound (8.8 fixed), unused.
@group(0) @binding(7) var<storage, read> brush_ranges: array<vec4u>;

const WORDS_PER_CHUNK: u32 = 16384u; // 32768 u16 ids
const VOXELS_PER_CHUNK: u32 = 32768u;
// Center of an 8^3 sub-block to its farthest voxel center: 3.5 * sqrt(3).
const SUB_REACH: f32 = 6.0622;

var<workgroup> sub_d: f32;
var<workgroup> wg_solid: atomic<u32>;
var<workgroup> wg_min: atomic<u32>;
var<workgroup> wg_max: atomic<u32>;

@compute @workgroup_size(64)
fn voxelize(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let c = wg.y;
  if (c >= params.count) {
    return; // workgroup-uniform: the whole workgroup leaves together
  }
  world_seed = params.seed;
  sample_footprint = 1.0;

  // Sub-block index in the same y-major order as voxels: sx + sz*4 + sy*16.
  let s = wg.x;
  let sub_origin = vec3u(s % 4u, s / 16u, (s / 4u) % 4u) * 8u;
  let base = chunks[c].xyz * 32 + vec3i(sub_origin);

  let range = brush_ranges[c];
  let brushes = range.y;
  if (li == 0u) {
    let center = WorldPoint(base + vec3i(4), vec3f(0.0));
    sub_d = brush_fold(center, range.x, brushes, vec2f(world_sdf(center), 0.0)).x;
    atomicStore(&wg_solid, 0u);
    atomicStore(&wg_min, 0xFFFFFFFFu);
    atomicStore(&wg_max, 0u);
  }
  workgroupBarrier();
  let reach = max(WORLD_LIPSCHITZ, f32(range.z) * (1.0 / 256.0)) * SUB_REACH;
  let all_air = params.skip != 0u && sub_d > reach;
  let all_solid = params.skip != 0u && sub_d < -reach;

  // Each thread: an x pair (one u32 word), one z, four y. 64 threads cover 8^3.
  let x0 = (li % 4u) * 2u;
  let z = (li / 4u) % 8u;
  let y0 = (li / 32u) * 4u;
  var solid = 0u;
  var lo = 0xFFFFFFFFu;
  var hi = 0u;
  for (var dy = 0u; dy < 4u; dy++) {
    let y = y0 + dy;
    var word = 0u;
    for (var k = 0u; k < 2u; k++) {
      var id = 0u;
      if (!all_air) {
        let p = WorldPoint(base + vec3i(vec3u(x0 + k, y, z)), vec3f(0.5)); // voxel center
        // The all-solid shortcut skips the field but not the material, and with
        // brushes the material is part of the fold, so it stays a shortcut only for
        // a chunk with none.
        var solid = all_solid;
        var brush_id = 0.0;
        if (!all_solid || brushes != 0u) {
          let s = brush_fold(p, range.x, brushes, vec2f(world_sdf(p), 0.0));
          solid = s.x < 0.0;
          brush_id = s.y;
        }
        if (solid) {
          id = select(world_material(p), u32(brush_id), brush_id != 0.0) & 0xFFFFu;
        }
      }
      if (id != 0u) {
        solid++;
        lo = min(lo, id);
        hi = max(hi, id);
      }
      word |= id << (16u * k);
    }
    let v = sub_origin + vec3u(x0, y, z);
    ids[c * WORDS_PER_CHUNK + (v.x + v.z * 32u + v.y * 1024u) / 2u] = word;
  }
  atomicAdd(&wg_solid, solid);
  atomicMin(&wg_min, lo);
  atomicMax(&wg_max, hi);
  workgroupBarrier();
  if (li == 0u) {
    let n = atomicLoad(&wg_solid);
    if (n > 0u) {
      atomicAdd(&headers[c].solid, n);
      atomicMin(&headers[c].min_id, atomicLoad(&wg_min));
      atomicMax(&headers[c].max_id, atomicLoad(&wg_max));
    }
  }
}

// Dense: has solid voxels, and is not a single block id filling the whole chunk.
// Kept in step with chunkKind() in voxelizer.ts.
fn is_dense(i: u32) -> bool {
  let n = atomicLoad(&headers[i].solid);
  if (n == 0u) {
    return false;
  }
  return !(n == VOXELS_PER_CHUNK && atomicLoad(&headers[i].min_id) == atomicLoad(&headers[i].max_id));
}

@compute @workgroup_size(256)
fn compact_dense(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let c = wg.x;
  if (c >= params.count || !is_dense(c)) {
    return;
  }
  var rank = 0u;
  for (var i = 0u; i < c; i++) {
    if (is_dense(i)) {
      rank++;
    }
  }
  for (var w = li; w < WORDS_PER_CHUNK; w += 256u) {
    compact[rank * WORDS_PER_CHUNK + w] = ids[c * WORDS_PER_CHUNK + w];
  }
}
