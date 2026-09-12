// The voxel stage (plan-world-modelling phase 3): ordered voxel writes applied to a
// chunk's dense ids after the field stage generated them. Pure.
//
// Voxel brushes and player edits are one thing: an edit is a voxel brush with a
// one-op list, and the journal is the order over every voxel brush, which is the
// instance sequence number `BrushStore` already keeps. So there is no second store
// and no second format, and undo is `store.remove(id)`.
//
// A chunk is never mutated in place. Regenerating it is the field stage followed by
// a replay of the ops overlapping it, in sequence order, which is what makes an edit
// survive a chunk being generated again.
//
// The ops reach the worker packed into one self-contained buffer (`packChunkOps`),
// transferred with the compress job, rather than through shared memory: an edit
// burst is small, the copy path has to exist anyway, and a shared journal would need
// the same deferred-free machinery the chunk arena has.

import { CHUNK_SIZE, voxelIndex } from "../world/coords.ts";
import {
  BRUSH_VOXEL,
  SHAPE_BOX,
  SHAPE_ELLIPSOID,
  SHAPE_SPHERE,
  SHAPE_VOXEL,
  VOXEL_CARVE,
  VOXEL_HEADER_WORDS,
  VOXEL_PAINT,
  VOXEL_REPLACE,
  VOXEL_SET,
  voxelId,
  voxelMode,
  voxelOpRange,
  voxelOpWords,
  voxelShape,
} from "./format.ts";
import { packVoxel } from "./build.ts";
import { codeSign, codeSource, invertCode } from "./orientation.ts";
import type { BrushStore } from "./store.ts";

// Packed chunk ops: a count, then per instance the anchor, the rotation, the op word
// count, and the op words. Self-contained, so the worker needs no store.
//
//   0            instance count                   u32
//   per instance: cellX, cellY, cellZ             i32 x3
//                 rotation code                   u32
//                 op word count                   u32
//                 op words
const INSTANCE_HEADER_WORDS = 5;

const range = new Int32Array(6);
let scratch = new Int32Array(256);

// A chunk's instances in sequence order, into the shared scratch.
function gather(store: BrushStore, key: number): number {
  for (;;) {
    try {
      return store.instancesIn(key, scratch);
    } catch {
      scratch = new Int32Array(scratch.length * 2);
    }
  }
}

// Ops for one chunk, in sequence order, or null when it has none. The buffer is
// meant to be transferred, so a fresh one is built per call; this runs once per
// chunk regeneration, not per frame.
export function packChunkOps(store: BrushStore, key: number): ArrayBuffer | null {
  return packFrom(store, scratch, gather(store, key));
}

function packFrom(store: BrushStore, list: Int32Array, n: number): ArrayBuffer | null {
  let words = 1;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (store.kindOf(list[i]) !== BRUSH_VOXEL) continue;
    words += INSTANCE_HEADER_WORDS + store.opsCountOf(list[i]);
    count++;
  }
  if (count === 0) return null;
  const buffer = new ArrayBuffer(words * 4);
  const u32 = new Uint32Array(buffer);
  const i32 = new Int32Array(buffer);
  u32[0] = count;
  let at = 1;
  for (let i = 0; i < n; i++) {
    const id = list[i];
    if (store.kindOf(id) !== BRUSH_VOXEL) continue;
    store.cellOf(id, range);
    i32[at] = range[0];
    i32[at + 1] = range[1];
    i32[at + 2] = range[2];
    u32[at + 3] = store.rotationOf(id);
    const opWords = store.opsCountOf(id);
    u32[at + 4] = opWords;
    const offset = store.opsOffsetOf(id);
    for (let w = 0; w < opWords; w++) u32[at + INSTANCE_HEADER_WORDS + w] = store.ops.u32[offset + w];
    at += INSTANCE_HEADER_WORDS + opWords;
  }
  return buffer;
}

// True when a chunk's dense ids would change: used to decide whether a uniform or
// air result still has to go through the voxel stage.
export function hasChunkOps(store: BrushStore, key: number): boolean {
  const n = gather(store, key);
  for (let i = 0; i < n; i++) if (store.kindOf(scratch[i]) === BRUSH_VOXEL) return true;
  return false;
}

// Applies a packed op list to a chunk's dense ids, in the order it was packed. The
// chunk is at chunk coordinate (cx, cy, cz); `dense` holds CHUNK_VOLUME ids in voxel
// order. Worker side: no store, no DOM.
export function applyChunkOps(dense: Uint16Array, cx: number, cy: number, cz: number, packed: ArrayBuffer): void {
  const u32 = new Uint32Array(packed);
  const i32 = new Int32Array(packed);
  const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
  const count = u32[0];
  let at = 1;
  for (let i = 0; i < count; i++) {
    const ax = i32[at], ay = i32[at + 1], az = i32[at + 2];
    const rot = u32[at + 3];
    const inv = invertCode(rot);
    const opWords = u32[at + 4];
    let op = at + INSTANCE_HEADER_WORDS;
    const end = op + opWords;
    while (op < end) {
      applyOp(dense, i32, u32, op, ax - ox, ay - oy, az - oz, rot, inv);
      op += voxelOpWords(voxelShape(u32[op]));
    }
    at = end;
  }
}

// One op, with the brush anchor already in chunk-local coordinates.
function applyOp(
  dense: Uint16Array,
  i32: Int32Array,
  u32: Uint32Array,
  op: number,
  ax: number,
  ay: number,
  az: number,
  rot: number,
  inv: number,
): void {
  voxelOpRange(i32, u32, op, range);
  // The op's local range, rotated into chunk-local space and clipped to the chunk.
  let x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0;
  for (let r = 0; r < 3; r++) {
    const a = codeSource(rot, r);
    const lo = range[a], hi = range[3 + a];
    const s = codeSign(rot, r);
    const min = (s > 0 ? lo : -hi) + (r === 0 ? ax : r === 1 ? ay : az);
    const max = (s > 0 ? hi : -lo) + (r === 0 ? ax : r === 1 ? ay : az);
    if (r === 0) {
      x0 = Math.max(0, min);
      x1 = Math.min(CHUNK_SIZE - 1, max);
    } else if (r === 1) {
      y0 = Math.max(0, min);
      y1 = Math.min(CHUNK_SIZE - 1, max);
    } else {
      z0 = Math.max(0, min);
      z1 = Math.min(CHUNK_SIZE - 1, max);
    }
  }
  if (x0 > x1 || y0 > y1 || z0 > z1) return;

  const header = u32[op];
  const mode = voxelMode(header);
  const id = voxelId(header);
  const match = u32[op + 1] & 0xffff;
  const shape = voxelShape(header);
  const p = op + VOXEL_HEADER_WORDS;
  const rel = local;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        // Chunk-local to brush-local: undo the anchor, then the rotation.
        world[0] = x - ax;
        world[1] = y - ay;
        world[2] = z - az;
        for (let r = 0; r < 3; r++) rel[r] = codeSign(inv, r) * world[codeSource(inv, r)];
        if (!inShape(shape, i32, p, rel)) continue;
        const at = voxelIndex(x, y, z);
        const was = dense[at];
        switch (mode) {
          case VOXEL_CARVE:
            dense[at] = 0;
            break;
          case VOXEL_REPLACE:
            if (was === match) dense[at] = id;
            break;
          case VOXEL_PAINT:
            if (was !== 0) dense[at] = id;
            break;
          default: // VOXEL_SET
            dense[at] = id;
            break;
        }
      }
    }
  }
}

const world = new Int32Array(3);
const local = new Int32Array(3);

function inShape(shape: number, i32: Int32Array, p: number, q: Int32Array): boolean {
  switch (shape) {
    case SHAPE_VOXEL:
      return q[0] === i32[p] && q[1] === i32[p + 1] && q[2] === i32[p + 2];
    case SHAPE_BOX:
      for (let i = 0; i < 3; i++) {
        const lo = Math.min(i32[p + i], i32[p + 3 + i]);
        const hi = Math.max(i32[p + i], i32[p + 3 + i]);
        if (q[i] < lo || q[i] > hi) return false;
      }
      return true;
    case SHAPE_SPHERE: {
      const r = i32[p + 3];
      let d = 0;
      for (let i = 0; i < 3; i++) {
        const t = q[i] - i32[p + i];
        d += t * t;
      }
      return d <= r * r;
    }
    default: { // SHAPE_ELLIPSOID
      let d = 0;
      for (let i = 0; i < 3; i++) {
        const r = i32[p + 3 + i];
        if (r === 0) return false;
        const t = (q[i] - i32[p + i]) / r;
        d += t * t;
      }
      return d <= 1;
    }
  }
}

// A one-op voxel brush: the shape of every player edit. `setVoxel` and the fills
// below are the whole edit API; each returns the instance id, which is also the undo
// handle (`store.remove(id)`).
export function setVoxel(store: BrushStore, x: number, y: number, z: number, id: number): number {
  return store.add({
    kind: BRUSH_VOXEL,
    cell: [x, y, z],
    ops: packVoxel([{ mode: id === 0 ? VOXEL_CARVE : VOXEL_SET, shape: SHAPE_VOXEL, id, params: [0, 0, 0] }]),
  });
}

// A box of voxels, corners inclusive and in any order.
export function fillBox(
  store: BrushStore,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  id: number,
): number {
  const lo = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)];
  const hi = [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)];
  return store.add({
    kind: BRUSH_VOXEL,
    cell: [lo[0], lo[1], lo[2]],
    ops: packVoxel([{
      mode: id === 0 ? VOXEL_CARVE : VOXEL_SET,
      shape: SHAPE_BOX,
      id,
      params: [0, 0, 0, hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
    }]),
  });
}

// A sphere of voxels centred on a voxel.
export function fillSphere(store: BrushStore, x: number, y: number, z: number, radius: number, id: number): number {
  return store.add({
    kind: BRUSH_VOXEL,
    cell: [x, y, z],
    ops: packVoxel([{
      mode: id === 0 ? VOXEL_CARVE : VOXEL_SET,
      shape: SHAPE_SPHERE,
      id,
      params: [0, 0, 0, Math.max(0, Math.round(radius))],
    }]),
  });
}
