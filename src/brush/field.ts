// CPU mirror of the field stage (plan-world-modelling phase 1): terrain distance in,
// brushes folded on top, distance and block id out. Pure.
//
// This is the reference the WGSL fold (phase 5) must match in shape, and the path
// the far field uses where it cannot sample the GPU. Primitives mirror
// src/sdf/lib.wgsl; change one and change the other.
//
// The rule the whole pipeline rests on: a reported distance may be smaller in
// magnitude than the true distance to the nearest surface, never larger (CLAUDE.md
// "Invariants"). Outside its box a brush reports the distance to that box, which is
// a safe lower bound, and is never dropped from the fold: dropping a union brush
// would let the field claim empty space where the brush sits, and dropping a
// subtract brush would claim solid where it carves.
//
// The box distance is only taken when it is larger than `footprint`, because it
// reaches zero at the box and not at the brush: a consumer that treats a small
// distance as a surface, as a sphere tracer does, would find one at the corner of
// every bounding box. Sampling by sign (the voxelizer) passes a footprint of one
// voxel, which keeps the saving everywhere it matters.

import {
  BLEND_INTERSECT,
  BLEND_SMAX,
  BLEND_SMIN,
  BLEND_SUBTRACT,
  BLEND_UNION,
  BRUSH_CSG,
  BRUSH_VOXEL,
  codeSign,
  codeSource,
  CSG_HEADER_WORDS,
  csgBlend,
  csgMaterial,
  csgOpWords,
  csgPrim,
  INSTANCE_WORDS,
  instanceInverseRotation,
  PRIM_BOX,
  PRIM_CAPSULE,
  PRIM_CYLINDER,
  PRIM_ELLIPSOID,
  PRIM_ROUND_BOX,
  PRIM_SPHERE,
  PRIM_TORUS,
  type WordBuffer,
} from "./format.ts";
import { rotateBounds } from "./orientation.ts";

// Primitives, mirroring src/sdf/lib.wgsl.

export function sdSphere(x: number, y: number, z: number, r: number): number {
  return Math.sqrt(x * x + y * y + z * z) - r;
}

export function sdBox(x: number, y: number, z: number, hx: number, hy: number, hz: number): number {
  const qx = Math.abs(x) - hx;
  const qy = Math.abs(y) - hy;
  const qz = Math.abs(z) - hz;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
}

export function sdRoundBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, r: number): number {
  return sdBox(x, y, z, hx - r, hy - r, hz - r) - r;
}

// Torus in the xz plane: major radius t0, tube radius t1.
export function sdTorus(x: number, y: number, z: number, t0: number, t1: number): number {
  const q = Math.sqrt(x * x + z * z) - t0;
  return Math.sqrt(q * q + y * y) - t1;
}

export function sdCapsule(
  x: number,
  y: number,
  z: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r: number,
): number {
  const px = x - ax, py = y - ay, pz = z - az;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dd = dx * dx + dy * dy + dz * dz;
  const h = dd > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy + pz * dz) / dd)) : 0;
  const cx = px - dx * h, cy = py - dy * h, cz = pz - dz * h;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) - r;
}

// Vertical capped cylinder: half height h, radius r.
export function sdCylinder(x: number, y: number, z: number, h: number, r: number): number {
  const dx = Math.abs(Math.sqrt(x * x + z * z)) - r;
  const dy = Math.abs(y) - h;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ox * ox + oy * oy);
}

// Not an exact distance, a bound near the surface (lib.wgsl "sd_ellipsoid").
export function sdEllipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number): number {
  const ax = x / rx, ay = y / ry, az = z / rz;
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  const bx = x / (rx * rx), by = y / (ry * ry), bz = z / (rz * rz);
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  return k1 > 0 ? k0 * (k0 - 1) / k1 : -Math.min(rx, Math.min(ry, rz));
}

// Polynomial smooth minimum, mirroring lib.wgsl op_smin.
export function opSmin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function opSmax(a: number, b: number, k: number): number {
  return -opSmin(-a, -b, k);
}

// Exterior distance from a point to an axis-aligned box, 0 inside. `box` holds min
// at [at..at+2] and max at [at+3..at+5], the layout instanceBox writes.
export function boxDistance(x: number, y: number, z: number, box: ArrayLike<number>, at = 0): number {
  const qx = Math.max(box[at] - x, x - box[at + 3]);
  const qy = Math.max(box[at + 1] - y, y - box[at + 4]);
  const qz = Math.max(box[at + 2] - z, z - box[at + 5]);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz);
}

// Folds `d` (with block id `id`) into the accumulator in out[0], out[1].
function blendInto(out: Float64Array, blend: number, d: number, id: number, k: number): void {
  const acc = out[0];
  switch (blend) {
    case BLEND_SUBTRACT:
      // A carve never contributes material.
      out[0] = Math.max(acc, -d);
      break;
    case BLEND_INTERSECT:
      if (d > acc) {
        out[0] = d;
        out[1] = id;
      }
      break;
    case BLEND_SMIN:
      out[0] = opSmin(acc, d, k);
      if (d < acc) out[1] = id;
      break;
    case BLEND_SMAX:
      out[0] = opSmax(acc, d, k);
      if (d > acc) out[1] = id;
      break;
    default: // BLEND_UNION
      if (d < acc) {
        out[0] = d;
        out[1] = id;
      }
      break;
  }
}

// A CSG op list evaluated at a local point. out[0] distance, out[1] block id.
export function csgField(
  ops: WordBuffer,
  offset: number,
  count: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  const { u32, f32 } = ops;
  out[0] = Infinity;
  out[1] = 0;
  let at = offset;
  const end = offset + count;
  while (at < end) {
    const header = u32[at];
    const prim = csgPrim(header);
    const k = f32[at + 1];
    const px = x - f32[at + 2];
    const py = y - f32[at + 3];
    const pz = z - f32[at + 4];
    const p = at + CSG_HEADER_WORDS;
    let d: number;
    switch (prim) {
      case PRIM_SPHERE:
        d = sdSphere(px, py, pz, f32[p]);
        break;
      case PRIM_BOX:
        d = sdBox(px, py, pz, f32[p], f32[p + 1], f32[p + 2]);
        break;
      case PRIM_ROUND_BOX:
        d = sdRoundBox(px, py, pz, f32[p], f32[p + 1], f32[p + 2], f32[p + 3]);
        break;
      case PRIM_TORUS:
        d = sdTorus(px, py, pz, f32[p], f32[p + 1]);
        break;
      case PRIM_CAPSULE:
        d = sdCapsule(px, py, pz, f32[p], f32[p + 1], f32[p + 2], f32[p + 3], f32[p + 4], f32[p + 5], f32[p + 6]);
        break;
      case PRIM_CYLINDER:
        d = sdCylinder(px, py, pz, f32[p], f32[p + 1]);
        break;
      case PRIM_ELLIPSOID:
        d = sdEllipsoid(px, py, pz, f32[p], f32[p + 1], f32[p + 2]);
        break;
      default:
        throw new Error(`csg op at ${at} has primitive ${prim}`);
    }
    // The first op starts the accumulator whatever its blend mode says.
    if (at === offset) {
      out[0] = d;
      out[1] = csgMaterial(header);
    } else {
      blendInto(out, csgBlend(header), d, csgMaterial(header), k);
    }
    at += csgOpWords(prim);
  }
}

// Field brush types written in WGSL have a CPU mirror here, registered by type id,
// so tests and the far-field fallback can evaluate them. Empty until phase 5 adds
// the first type.
export type SdfBrushFn = (
  ops: WordBuffer,
  offset: number,
  count: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
) => void;

const SDF_TYPES: SdfBrushFn[] = [];

export function registerSdfBrush(type: number, fn: SdfBrushFn): void {
  SDF_TYPES[type] = fn;
}

const worldBox = new Float64Array(6);
const localMin = new Float64Array(3);
const localMax = new Float64Array(3);
const rotMin = new Float64Array(3);
const rotMax = new Float64Array(3);
const rel = new Float64Array(3);
const local = new Float64Array(2);

// The world-space box of one instance, written into out[0..2] and out[3..5].
export function instanceBox(records: WordBuffer, at: number, out: Float64Array): void {
  const { i32, f32 } = records;
  const scale = f32[at + 7];
  for (let i = 0; i < 3; i++) {
    localMin[i] = f32[at + 8 + i] * scale;
    localMax[i] = f32[at + 11 + i] * scale;
  }
  // The rotation is a signed permutation, so a box maps to a box exactly.
  rotateBounds((records.u32[at + 3] >>> 9) & 0x1ff, localMin, localMax, rotMin, rotMax);
  for (let i = 0; i < 3; i++) {
    out[i] = rotMin[i] + i32[at + i];
    out[3 + i] = rotMax[i] + i32[at + i];
  }
}

// Distance and block id of one instance at a world point. Outside its box, by more
// than both the blend radius and the sample footprint, it reports the distance to
// the box, a safe lower bound.
export function instanceField(
  records: WordBuffer,
  at: number,
  ops: WordBuffer,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
  footprint = 1,
): void {
  const { u32, i32, f32 } = records;
  const flags = u32[at + 3];
  const kind = (flags >>> 18) & 3;
  const material = (u32[at + 4] >>> 16) & 0xffff;
  instanceBox(records, at, worldBox);
  const dbox = boxDistance(x, y, z, worldBox);
  const blendK = f32[at + 14];
  if (kind === BRUSH_VOXEL || dbox > Math.max(blendK, footprint)) {
    // Voxel brushes are not a field at all: they contribute nothing but their box,
    // which keeps the fold from claiming the space is empty.
    out[0] = dbox;
    out[1] = material;
    return;
  }
  const scale = f32[at + 7];
  const inv = instanceInverseRotation(records, at);
  rel[0] = x - i32[at];
  rel[1] = y - i32[at + 1];
  rel[2] = z - i32[at + 2];
  const lx = codeSign(inv, 0) * rel[codeSource(inv, 0)] / scale;
  const ly = codeSign(inv, 1) * rel[codeSource(inv, 1)] / scale;
  const lz = codeSign(inv, 2) * rel[codeSource(inv, 2)] / scale;
  const offset = u32[at + 5];
  const count = u32[at + 6] & 0xffff;
  if (kind === BRUSH_CSG) {
    csgField(ops, offset, count, lx, ly, lz, local);
  } else {
    const type = u32[at + 4] & 0xffff;
    const fn = SDF_TYPES[type];
    if (!fn) throw new Error(`no CPU mirror for SDF brush type ${type}`);
    fn(ops, offset, count, lx, ly, lz, local);
  }
  out[0] = local[0] * scale;
  // The instance's material is the default; an op that names its own wins.
  out[1] = local[1] === 0 ? material : local[1];
}

const one = new Float64Array(2);

// Folds every instance in `offsets` into the terrain sample (d0, id0). Instances are
// folded in the order given, which must be stable for the field to be deterministic.
export function foldInstances(
  records: WordBuffer,
  ops: WordBuffer,
  offsets: ArrayLike<number>,
  count: number,
  x: number,
  y: number,
  z: number,
  d0: number,
  id0: number,
  out: Float64Array,
  footprint = 1,
): void {
  out[0] = d0;
  out[1] = id0;
  for (let i = 0; i < count; i++) {
    const at = offsets[i] * INSTANCE_WORDS;
    instanceField(records, at, ops, x, y, z, one, footprint);
    blendInto(out, (records.u32[at + 3] >>> 20) & 7, one[0], one[1], records.f32[at + 14]);
  }
}
