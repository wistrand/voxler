// The field stage's brush fold (plan-world-modelling phase 5). Requires sdf/lib.wgsl
// and these three bindings, which the including shader declares:
//
//   brush_records: array<u32>   instance records, 16 u32 each (design-formats.md
//                               "Brush instance"), a chunk's run contiguous
//   brush_ops:     array<u32>   CSG and SDF parameter words
//
// This mirrors src/brush/field.ts; change one and change the other. Voxel brushes are
// not in the run: they are not a field, and the voxel stage writes them onto the
// dense ids afterwards (src/brush/voxel-ops.ts). The rules it rests on, in full in
// plan-world-modelling.md:
//
// - Every instance in a chunk's run is folded at every sample. None is skipped for
//   being far: outside its box a brush reports the distance to that box, which never
//   overestimates, and dropping it would let the field claim empty space where a
//   union sits or solid where a subtract carves.
// - That box distance is only taken when it is larger than the sample footprint.
//   It reaches zero at the box, not at the brush, so a consumer that treats a small
//   distance as a surface would find one at the corner of every bounding box: the
//   sphere-traced preview drew a grey slab around a sphere until this rule went in.
//   Above the footprint the value cannot be mistaken for a surface, which keeps the
//   saving where it pays (a brush the sample is nowhere near) and evaluates the op
//   list where it matters.
// - The material follows the fold in `pick` semantics. Material 0 means no brush
//   won, so the caller asks the world program instead; a subtract never contributes
//   a material.
// - A brush smaller than the sample footprint becomes its own bounding box rather
//   than dropping out. A drop-out would make brushes blink out of existence as the
//   sample coarsens, at the near/far boundary most of all; a box keeps them there,
//   coarser than they are. Library noise drops octaves finer than the footprint for
//   the same reason, and caves do drop out, but caves are defined by a zero crossing
//   with nothing left to stand in for them.

const BRUSH_WORDS: u32 = 16u;

const BRUSH_KIND_SDF: u32 = 0u;
const BRUSH_KIND_CSG: u32 = 1u;

const BLEND_UNION: u32 = 0u;
const BLEND_SUBTRACT: u32 = 1u;
const BLEND_INTERSECT: u32 = 2u;
const BLEND_SMIN: u32 = 3u;
const BLEND_SMAX: u32 = 4u;

const PRIM_SPHERE: u32 = 0u;
const PRIM_BOX: u32 = 1u;
const PRIM_ROUND_BOX: u32 = 2u;
const PRIM_TORUS: u32 = 3u;
const PRIM_CAPSULE: u32 = 4u;
const PRIM_CYLINDER: u32 = 5u;
const PRIM_ELLIPSOID: u32 = 6u;

// header, blend radius, local center, then the primitive's parameters.
const CSG_HEADER_WORDS: u32 = 5u;

fn brush_f32(at: u32) -> f32 {
  return bitcast<f32>(brush_ops[at]);
}

fn brush_vec3(at: u32) -> vec3f {
  return vec3f(brush_f32(at), brush_f32(at + 1u), brush_f32(at + 2u));
}

fn csg_op_words(prim: u32) -> u32 {
  switch prim {
    case 0u: { return CSG_HEADER_WORDS + 1u; } // sphere
    case 1u: { return CSG_HEADER_WORDS + 3u; } // box
    case 2u: { return CSG_HEADER_WORDS + 4u; } // round box
    case 3u: { return CSG_HEADER_WORDS + 2u; } // torus
    case 4u: { return CSG_HEADER_WORDS + 7u; } // capsule
    case 5u: { return CSG_HEADER_WORDS + 2u; } // cylinder
    default: { return CSG_HEADER_WORDS + 3u; } // ellipsoid
  }
}

// A signed permutation (design-formats.md "Brush instance"): out[r] = sign * v[src].
fn brush_rotate(code: u32, v: vec3f) -> vec3f {
  var out = vec3f(0.0);
  for (var r = 0u; r < 3u; r++) {
    let a = (code >> (r * 3u)) & 3u;
    let s = select(1.0, -1.0, ((code >> (r * 3u + 2u)) & 1u) != 0u);
    out[r] = s * v[a];
  }
  return out;
}

// Exterior distance to an axis-aligned box given its corners, 0 inside.
fn sd_box_range(p: vec3f, lo: vec3f, hi: vec3f) -> f32 {
  return length(max(max(lo - p, p - hi), vec3f(0.0)));
}

// Distance from a point inside the box to its nearest face, 0 outside: the other
// half of a signed box distance, kept separate so the exterior case stays cheap.
fn box_inner(p: vec3f, lo: vec3f, hi: vec3f) -> f32 {
  let d = min(p - lo, hi - p);
  return max(min(d.x, min(d.y, d.z)), 0.0);
}

// Folds (distance, material) `b` onto `a` by `blend`, with blend radius k.
fn brush_blend(a: vec2f, b: vec2f, blend: u32, k: f32) -> vec2f {
  switch blend {
    case 1u: { // subtract: a carve never contributes material
      return vec2f(op_subtract(a.x, b.x), a.y);
    }
    case 2u: { // intersect
      return select(a, b, b.x > a.x);
    }
    case 3u: { // smooth union
      return vec2f(op_smin(a.x, b.x, k), select(a.y, b.y, b.x < a.x));
    }
    case 4u: { // smooth intersect
      return vec2f(op_smax(a.x, b.x, k), select(a.y, b.y, b.x > a.x));
    }
    default: { // union
      return select(a, b, b.x < a.x);
    }
  }
}

// A CSG op list at a point in the brush's local frame. Folds left to right, so the
// first op's blend is ignored and the list needs no stack.
fn csg_field(offset: u32, count: u32, q: vec3f) -> vec2f {
  var acc = vec2f(1e30, 0.0);
  var at = offset;
  let end = offset + count;
  var first = true;
  loop {
    if (at >= end) { break; }
    let header = brush_ops[at];
    let prim = (header >> 8u) & 0xffu;
    let material = f32((header >> 16u) & 0xffffu);
    let k = brush_f32(at + 1u);
    let p = q - brush_vec3(at + 2u);
    let a = at + CSG_HEADER_WORDS;
    var d: f32;
    switch prim {
      case 0u: { d = sd_sphere(p, brush_f32(a)); }
      case 1u: { d = sd_box(p, brush_vec3(a)); }
      case 2u: { d = sd_round_box(p, brush_vec3(a), brush_f32(a + 3u)); }
      case 3u: { d = sd_torus(p, vec2f(brush_f32(a), brush_f32(a + 1u))); }
      case 4u: { d = sd_capsule(p, brush_vec3(a), brush_vec3(a + 3u), brush_f32(a + 6u)); }
      case 5u: { d = sd_cylinder(p, brush_f32(a), brush_f32(a + 1u)); }
      default: { d = sd_ellipsoid(p, brush_vec3(a)); }
    }
    let one = vec2f(d, material);
    if (first) {
      acc = one;
      first = false;
    } else {
      acc = brush_blend(acc, one, header & 0xffu, k);
    }
    at += csg_op_words(prim);
  }
  return acc;
}

// An SDF brush type: a WGSL function per type, parameters in the op pool. The set is
// compile-time because WGSL has no function pointers. No types yet; a world that
// places one without adding it here gets nothing, which the CPU mirror also reports.
fn sdf_brush_field(kind: u32, offset: u32, count: u32, q: vec3f) -> vec2f {
  return vec2f(1e30, 0.0);
}

// One instance at a world point. `at` is its record's first word.
fn brush_instance(at: u32, p: WorldPoint) -> vec2f {
  let cell = vec3i(
    bitcast<i32>(brush_records[at]),
    bitcast<i32>(brush_records[at + 1u]),
    bitcast<i32>(brush_records[at + 2u]),
  );
  let flags = brush_records[at + 3u];
  let kind = (flags >> 18u) & 3u;
  let material = f32((brush_records[at + 4u] >> 16u) & 0xffffu);
  let scale = bitcast<f32>(brush_records[at + 7u]);
  let lo = vec3f(
    bitcast<f32>(brush_records[at + 8u]),
    bitcast<f32>(brush_records[at + 9u]),
    bitcast<f32>(brush_records[at + 10u]),
  );
  let hi = vec3f(
    bitcast<f32>(brush_records[at + 11u]),
    bitcast<f32>(brush_records[at + 12u]),
    bitcast<f32>(brush_records[at + 13u]),
  );
  let blend_k = bitcast<f32>(brush_records[at + 14u]);
  // Into the brush's local frame: exact near the anchor (lib.wgsl wp_local), then the
  // inverse rotation, then the scale. Rotation is an isometry and the scale uniform,
  // so a local distance times the scale is the world distance.
  let q = brush_rotate(flags & 0x1ffu, wp_local(p, cell)) / scale;
  let dbox = sd_box_range(q, lo, hi) * scale;
  if (dbox > max(blend_k, sample_footprint)) {
    return vec2f(dbox, material);
  }
  // Too coarse to resolve the shape: stand its bounding box in for it. The box is
  // exact at the boundary and never overestimates inside, so a skip stays safe.
  let extent = min(hi.x - lo.x, min(hi.y - lo.y, hi.z - lo.z)) * scale;
  if (sample_footprint > extent) {
    return vec2f((sd_box_range(q, lo, hi) - box_inner(q, lo, hi)) * scale, material);
  }
  let offset = brush_records[at + 5u];
  let count = brush_records[at + 6u] & 0xffffu;
  var s: vec2f;
  if (kind == BRUSH_KIND_CSG) {
    s = csg_field(offset, count, q);
  } else {
    s = sdf_brush_field(brush_records[at + 4u] & 0xffffu, offset, count, q);
  }
  // The instance's material is the default; an op that names its own wins.
  return vec2f(s.x * scale, select(material, s.y, s.y != 0.0));
}

// Folds a chunk's instances onto a world sample. `start` and `count` are records,
// not words. Returns (distance, material); material 0 means the world program's
// material still decides.
fn brush_fold(p: WorldPoint, start: u32, count: u32, world: vec2f) -> vec2f {
  var acc = world;
  for (var i = 0u; i < count; i++) {
    let at = (start + i) * BRUSH_WORDS;
    let blend = (brush_records[at + 3u] >> 20u) & 7u;
    acc = brush_blend(acc, brush_instance(at, p), blend, bitcast<f32>(brush_records[at + 14u]));
  }
  return acc;
}
