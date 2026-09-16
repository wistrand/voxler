// Cluster cull pass (plan-rendering phases 3-5): one invocation per cluster slot
// below the cluster table's high-water mark. Skips empty (freed) clusters and the
// ones of the other kind (`TRANSLUCENT`),
// culls by face direction and against the frustum (tests mirrored by
// cullBox() in cull.ts), and appends survivors to `visible`. The append count is
// the indirect draw's instance count, written here; the CPU never reads it back
// per frame. Standalone: needs no other source.
//
// Two phases per frame (`PHASE_B`), the standard two-phase occlusion scheme:
//   A  only clusters drawn last frame (`seen` bits), frustum and face tests. They
//      are drawn first, and their depth builds the Hi-Z pyramid.
//   B  every cluster, frustum and face tests, then the Hi-Z test. Survivors set
//      their bit for next frame; those without a bit from last frame are appended,
//      since the rest were already drawn in A.
// So a cluster that became visible this frame appears one frame late only if it
// also fails the Hi-Z test, and one that stopped being visible loses its bit.
//
// `sort_translucent` then orders that list back to front by the distance from the eye
// to a cluster's box, in 64 buckets of 16 voxels, so blending compounds in the right
// order between clusters. Within a cluster the quads keep mesher order, which is why
// the plan calls this per-chunk ordering and not sorted translucency. One workgroup
// counts, prefixes and scatters, which is enough for the few hundred clusters a
// water surface comes to and needs no indirect dispatch.
//
// `TRANSLUCENT` runs once, after both opaque phases, over the translucent clusters:
// every cluster tested, the Hi-Z pyramid from the opaque depth used to drop what is
// behind solid geometry, and no seen bits either read or written. Translucency is
// not part of the two-phase scheme: it draws over a depth buffer that is already
// complete, so there is nothing to predict.

struct Cull {
  planes: array<vec4f, 5>, // left, right, bottom, top, near (render space)
  eye: vec4f,              // camera offset in render space; w unused
  chunk: vec4i,            // camera chunk; w unused
  view_proj: mat4x4f,      // render space -> clip, for the Hi-Z rectangle
  viewport: vec4f,         // Hi-Z level 0 width, height, level count; w unused
  cluster_count: u32,      // slots to test
  // bit 0 frustum, 1 face direction, 2 occlusion (B), 3 write seen bits (B),
  // 4 ignore seen bits (A: test every cluster, for the cull check)
  flags: u32,
  pad0: u32,
  pad1: u32,
}

struct DrawArgs {
  vertex_count: u32,
  instance_count: atomic<u32>,
  first_vertex: u32,
  first_instance: u32,
}

@group(0) @binding(0) var<uniform> cull: Cull;
@group(0) @binding(1) var<storage, read> clusters: array<vec4u>;
@group(0) @binding(2) var<storage, read> chunks: array<vec4i>;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: DrawArgs;
// Phase A at words 0-5, phase B at 6-11, the translucent pass at 12-17: drawn,
// culled by face, culled by frustum, skipped (empty or the other kind), culled by
// occlusion, already drawn by phase A. Phase B tests every cluster, so its six words
// add up to the whole table.
@group(0) @binding(5) var<storage, read_write> counts: array<atomic<u32>, 18>;
@group(0) @binding(6) var<storage, read> seen: array<u32>; // drawn last frame, one bit per slot
@group(0) @binding(7) var<storage, read_write> seen_next: array<atomic<u32>>;
@group(0) @binding(8) var hiz: texture_2d<f32>;
// The translucent pass's visible list again, ordered far to near by `sort_translucent`.
@group(0) @binding(9) var<storage, read_write> sorted: array<u32>;

override PHASE_B: bool = false;
override TRANSLUCENT: bool = false;

const WORKGROUP = 64u;
const CULL_FRUSTUM = 1u;
const CULL_FACE = 2u;
const CULL_OCCLUSION = 4u;
const CULL_WRITE_SEEN = 8u;
const CULL_ALL_CLUSTERS = 16u;

var<workgroup> wg_visible: atomic<u32>;
var<workgroup> wg_face: atomic<u32>;
var<workgroup> wg_frustum: atomic<u32>;
var<workgroup> wg_skipped: atomic<u32>;
var<workgroup> wg_occluded: atomic<u32>;
var<workgroup> wg_already: atomic<u32>;
var<workgroup> wg_base: u32;

// 0 visible, 1 culled by face direction, 2 culled by the frustum.
fn cull_cluster(lo: vec3f, hi: vec3f, face: u32) -> u32 {
  if ((cull.flags & CULL_FACE) != 0u) {
    let axis = face >> 1u;
    let e = cull.eye[axis];
    let behind = select(e >= hi[axis] - 1.0, e <= lo[axis] + 1.0, (face & 1u) == 0u);
    if (behind) {
      return 1u;
    }
  }
  if ((cull.flags & CULL_FRUSTUM) != 0u) {
    for (var p = 0u; p < 5u; p++) {
      let plane = cull.planes[p];
      let corner = select(lo, hi, plane.xyz > vec3f(0.0));
      if (dot(plane.xyz, corner) + plane.w < 0.0) {
        return 2u;
      }
    }
  }
  return 0u;
}

// True when the box is entirely behind what the Hi-Z pyramid already holds. The
// box's screen rectangle picks a level where it spans about two texels; the
// smallest depth there is the farthest surface already drawn, so a box nearer than
// nothing in that rectangle is hidden.
fn hiz_occluded(lo: vec3f, hi: vec3f) -> bool {
  var rect_min = vec2f(1e30, 1e30);
  var rect_max = vec2f(-1e30, -1e30);
  var nearest = 0.0; // reversed-Z: larger is nearer
  for (var c = 0u; c < 8u; c++) {
    let corner = vec3f(
      select(lo.x, hi.x, (c & 1u) != 0u),
      select(lo.y, hi.y, (c & 2u) != 0u),
      select(lo.z, hi.z, (c & 4u) != 0u),
    );
    let clip = cull.view_proj * vec4f(corner, 1.0);
    if (clip.w <= 0.0) {
      return false; // crosses the near plane: the rectangle is meaningless
    }
    let ndc = clip.xyz / clip.w;
    rect_min = min(rect_min, ndc.xy);
    rect_max = max(rect_max, ndc.xy);
    nearest = max(nearest, ndc.z);
  }
  // Clip space to Hi-Z texels (y grows downward in the texture).
  let size = cull.viewport.xy;
  // A pixel's margin either way: the draw expands every quad EXPAND_PX outward in
  // screen space (near.wgsl), so a cluster's geometry can reach past its box's
  // rectangle by that much, and a cluster culled on the bare rectangle would lose the
  // fringe that pokes out beside its occluder.
  let a = (vec2f(rect_min.x, -rect_max.y) * 0.5 + 0.5) * size - vec2f(1.0);
  let b = (vec2f(rect_max.x, -rect_min.y) * 0.5 + 0.5) * size + vec2f(1.0);
  let extent = max(b.x - a.x, b.y - a.y);
  let level = clamp(i32(ceil(log2(max(extent, 1.0)))), 0, i32(cull.viewport.z) - 1);
  let scale = f32(1u << u32(level));
  let level_size = vec2i(max(vec2u(size) >> vec2u(u32(level)), vec2u(1u)));
  let first = clamp(vec2i(floor(a / scale)), vec2i(0), level_size - vec2i(1));
  let last = clamp(vec2i(floor(b / scale)), first, min(first + vec2i(3), level_size - vec2i(1)));
  var farthest = 1.0;
  for (var y = first.y; y <= last.y; y++) {
    for (var x = first.x; x <= last.x; x++) {
      farthest = min(farthest, textureLoad(hiz, vec2i(x, y), level).r);
    }
  }
  return nearest < farthest;
}

fn has_bit(bits: u32, i: u32) -> bool {
  return ((bits >> (i & 31u)) & 1u) != 0u;
}

const SORT_BUCKETS = 64u;
const SORT_WORKGROUP = 256u;
const BUCKET_VOXELS = 16.0;

var<workgroup> bucket_count: array<atomic<u32>, SORT_BUCKETS>;
var<workgroup> bucket_base: array<u32, SORT_BUCKETS>;
var<workgroup> bucket_cursor: array<atomic<u32>, SORT_BUCKETS>;

// Distance bucket of a cluster's box centre from the eye, clamped to the last bucket
// so anything past the near field's reach still sorts first.
fn cluster_bucket(i: u32) -> u32 {
  let cl = clusters[i];
  let origin = (chunks[cl.y & 0xfffffu].xyz - cull.chunk.xyz) * 32;
  let vmin = vec3i(i32(cl.z & 31u), i32((cl.z >> 5u) & 31u), i32((cl.z >> 10u) & 31u));
  let vmax = vec3i(i32((cl.z >> 15u) & 31u), i32((cl.z >> 20u) & 31u), i32((cl.z >> 25u) & 31u));
  let centre = vec3f(origin) + (vec3f(vmin) + vec3f(vmax + 1)) * 0.5;
  return min(u32(max(distance(centre, cull.eye.xyz), 0.0) / BUCKET_VOXELS), SORT_BUCKETS - 1u);
}

@compute @workgroup_size(SORT_WORKGROUP)
fn sort_translucent(@builtin(local_invocation_index) lid: u32) {
  if (lid < SORT_BUCKETS) {
    atomicStore(&bucket_count[lid], 0u);
    atomicStore(&bucket_cursor[lid], 0u);
  }
  workgroupBarrier();
  let n = atomicLoad(&args.instance_count);
  for (var i = lid; i < n; i += SORT_WORKGROUP) {
    atomicAdd(&bucket_count[cluster_bucket(visible[i])], 1u);
  }
  workgroupBarrier();
  if (lid == 0u) {
    // Far to near: the farthest bucket takes the front of the list, so it draws first.
    var at = 0u;
    for (var b = SORT_BUCKETS; b > 0u; b--) {
      bucket_base[b - 1u] = at;
      at += atomicLoad(&bucket_count[b - 1u]);
    }
  }
  workgroupBarrier();
  for (var i = lid; i < n; i += SORT_WORKGROUP) {
    let id = visible[i];
    let b = cluster_bucket(id);
    sorted[bucket_base[b] + atomicAdd(&bucket_cursor[b], 1u)] = id;
  }
}

@compute @workgroup_size(WORKGROUP)
fn cull_clusters(
  @builtin(workgroup_id) wg: vec3u,
  @builtin(num_workgroups) groups: vec3u,
  @builtin(local_invocation_index) lid: u32,
) {
  let i = (wg.y * groups.x + wg.x) * WORKGROUP + lid;
  var keep = false;
  var slot_in_group = 0u;
  if (i < cull.cluster_count) {
    let drawn_last_frame = has_bit(seen[i >> 5u], i);
    if (!PHASE_B && !drawn_last_frame && (cull.flags & CULL_ALL_CLUSTERS) == 0u) {
      // Phase A only redraws what was visible; phase B decides the rest.
    } else {
      let cl = clusters[i];
      let kind = (cl.y >> 23u) & 1u; // 1 translucent
      if ((cl.y >> 24u) == 0u || kind != select(0u, 1u, TRANSLUCENT)) {
        atomicAdd(&wg_skipped, 1u);
      } else {
        // Box in render space: integer math relative to the camera chunk, f32 last.
        let origin = (chunks[cl.y & 0xfffffu].xyz - cull.chunk.xyz) * 32;
        let vmin = vec3i(i32(cl.z & 31u), i32((cl.z >> 5u) & 31u), i32((cl.z >> 10u) & 31u));
        let vmax = vec3i(i32((cl.z >> 15u) & 31u), i32((cl.z >> 20u) & 31u), i32((cl.z >> 25u) & 31u));
        let lo = vec3f(origin + vmin);
        let hi = vec3f(origin + vmax + 1); // inclusive voxel max -> box edge
        let result = cull_cluster(lo, hi, (cl.y >> 20u) & 7u);
        if (result == 1u) {
          atomicAdd(&wg_face, 1u);
        } else if (result == 2u) {
          atomicAdd(&wg_frustum, 1u);
        } else if (PHASE_B && (cull.flags & CULL_OCCLUSION) != 0u && hiz_occluded(lo, hi)) {
          atomicAdd(&wg_occluded, 1u);
        } else {
          if (!TRANSLUCENT && PHASE_B && (cull.flags & CULL_WRITE_SEEN) != 0u) {
            atomicOr(&seen_next[i >> 5u], 1u << (i & 31u));
          }
          // Phase B skips what phase A already drew; the translucent pass has no
          // earlier draw to skip.
          keep = TRANSLUCENT || !PHASE_B || !drawn_last_frame;
          if (keep) {
            slot_in_group = atomicAdd(&wg_visible, 1u);
          } else {
            atomicAdd(&wg_already, 1u);
          }
        }
      }
    }
  }
  workgroupBarrier();
  if (lid == 0u) {
    let n = atomicLoad(&wg_visible);
    wg_base = atomicAdd(&args.instance_count, n);
    let base = select(select(0u, 6u, PHASE_B), 12u, TRANSLUCENT);
    atomicAdd(&counts[base], n);
    atomicAdd(&counts[base + 1u], atomicLoad(&wg_face));
    atomicAdd(&counts[base + 2u], atomicLoad(&wg_frustum));
    atomicAdd(&counts[base + 3u], atomicLoad(&wg_skipped));
    atomicAdd(&counts[base + 4u], atomicLoad(&wg_occluded));
    atomicAdd(&counts[base + 5u], atomicLoad(&wg_already));
  }
  workgroupBarrier();
  if (keep) {
    visible[wg_base + slot_in_group] = i;
  }
}
