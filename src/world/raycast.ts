// Voxel raycast (plan-world-modelling phase 4, plan-voxel-data phase 5's raycast
// half): Amanatides and Woo's grid traversal over the chunk store. Main thread, no
// GPU; the store is read, never written.
//
// The whole point of the traversal is that it visits every voxel a ray crosses and
// no others, in order, with no floating-point accumulation: `t` for each axis is
// stepped by a constant. Chunks that hold one block id are crossed in one jump
// instead of 32 steps per axis, which is what makes a ray over open terrain cheap:
// most of what it crosses is uniform air.
//
// Coordinates are absolute world voxels as float64 (CLAUDE.md "Invariants": never
// f32, never sent to the GPU).

import { FACE_AXIS, FACE_SIGN } from "../mesh/quad.ts";
import { BLOCK_OPAQUE } from "./blocks.ts";
import { CHUNK_SIZE, voxelIndex } from "./coords.ts";
import { chunkInRange, chunkKey } from "./keys.ts";
import type { ChunkStore } from "./store.ts";

export interface RayHit {
  hit: boolean;
  x: number; // the voxel hit
  y: number;
  z: number;
  // The voxel the ray was in when it entered the hit one: where a placement goes.
  // Equal to (x, y, z) when the ray started inside a solid voxel.
  fromX: number;
  fromY: number;
  fromZ: number;
  face: number; // face of the hit voxel the ray entered through (quad.ts), -1 inside
  id: number; // block id hit
  distance: number; // voxels travelled to the hit
}

export function newRayHit(): RayHit {
  return { hit: false, x: 0, y: 0, z: 0, fromX: 0, fromY: 0, fromZ: 0, face: -1, id: 0, distance: 0 };
}

// What a ray stops on. Air never stops it; `opaqueOnly` lets it pass through water
// and glass, which is what a placement ray usually wants.
export interface RaycastOptions {
  maxDistance: number; // in voxels
  opaqueOnly: boolean;
}

export const DEFAULT_RAYCAST: RaycastOptions = { maxDistance: 128, opaqueOnly: false };

function stops(id: number, opaqueOnly: boolean): boolean {
  return opaqueOnly ? BLOCK_OPAQUE[id] === 1 : id !== 0;
}

// Fills a hit, and the voxel the ray came from: one step back along the face it
// entered through, or the hit itself when the ray started inside something solid.
function hit(out: RayHit, x: number, y: number, z: number, face: number, id: number, t: number): boolean {
  out.hit = true;
  out.x = out.fromX = x;
  out.y = out.fromY = y;
  out.z = out.fromZ = z;
  out.face = face;
  out.id = id;
  out.distance = t;
  if (face >= 0) {
    const d = FACE_SIGN[face];
    if (FACE_AXIS[face] === 0) out.fromX = x + d;
    else if (FACE_AXIS[face] === 1) out.fromY = y + d;
    else out.fromZ = z + d;
  }
  return true;
}

// Casts from `ox, oy, oz` along `dx, dy, dz` (need not be normalized; distances come
// out in voxels along a normalized direction). Returns `out.hit`.
export function raycastVoxels(
  store: ChunkStore,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  out: RayHit,
  options: RaycastOptions = DEFAULT_RAYCAST,
): boolean {
  out.hit = false;
  out.face = -1;
  out.id = 0;
  out.distance = 0;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len === 0) return false;
  const nx = dx / len, ny = dy / len, nz = dz / len;

  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  out.x = out.fromX = x;
  out.y = out.fromY = y;
  out.z = out.fromZ = z;
  const stepX = nx > 0 ? 1 : -1, stepY = ny > 0 ? 1 : -1, stepZ = nz > 0 ? 1 : -1;
  // Distance along the ray between successive crossings of each axis' planes, and to
  // the first crossing. An axis the ray does not move along never crosses.
  const dtX = nx === 0 ? Infinity : Math.abs(1 / nx);
  const dtY = ny === 0 ? Infinity : Math.abs(1 / ny);
  const dtZ = nz === 0 ? Infinity : Math.abs(1 / nz);
  let tX = nx === 0 ? Infinity : ((nx > 0 ? x + 1 - ox : ox - x) / Math.abs(nx));
  let tY = ny === 0 ? Infinity : ((ny > 0 ? y + 1 - oy : oy - y) / Math.abs(ny));
  let tZ = nz === 0 ? Infinity : ((nz > 0 ? z + 1 - oz : oz - z) / Math.abs(nz));

  let t = 0;
  let face = -1;
  const max = options.maxDistance;
  // The chunk whose uniform id is cached, and that id (-1: not uniform or unknown).
  let cachedKey = Number.NaN;
  let cachedId = -1;
  let cachedSlot = -1;

  while (t <= max) {
    const cx = x >> 5, cy = y >> 5, cz = z >> 5;
    if (!chunkInRange(cx, cy, cz)) return false;
    const key = chunkKey(cx, cy, cz);
    if (key !== cachedKey) {
      cachedKey = key;
      cachedSlot = store.slotOf(key);
      cachedId = cachedSlot === -1 ? -1 : store.slotUniformId(cachedSlot);
    }
    if (cachedSlot === -1) return false; // outside what is loaded: nothing to hit

    if (cachedId >= 0) {
      if (stops(cachedId, options.opaqueOnly)) return hit(out, x, y, z, face, cachedId, t);
      // A uniform chunk the ray passes through: jump to where it leaves, rather than
      // stepping voxel by voxel.
      const exit = chunkExit(x, y, z, tX, tY, tZ, dtX, dtY, dtZ, stepX, stepY, stepZ);
      if (exit.t > max) return false;
      t = exit.t;
      x = exit.x;
      y = exit.y;
      z = exit.z;
      face = exit.face;
      tX = exit.tX;
      tY = exit.tY;
      tZ = exit.tZ;
      continue;
    }

    const chunk = store.read(store.handle(cx, cy, cz));
    const id = chunk === null ? 0 : chunk.get(voxelIndex(x & 31, y & 31, z & 31));
    if (stops(id, options.opaqueOnly)) return hit(out, x, y, z, face, id, t);
    if (tX <= tY && tX <= tZ) {
      t = tX;
      tX += dtX;
      x += stepX;
      face = stepX > 0 ? 1 : 0; // entered through -X or +X
    } else if (tY <= tZ) {
      t = tY;
      tY += dtY;
      y += stepY;
      face = stepY > 0 ? 3 : 2;
    } else {
      t = tZ;
      tZ += dtZ;
      z += stepZ;
      face = stepZ > 0 ? 5 : 4;
    }
  }
  return false;
}

// Where the ray leaves the chunk holding (x, y, z): the first voxel outside it, the
// axis crossings advanced past everything inside. Reused per call, never allocated
// in a loop.
const exitOut = { t: 0, x: 0, y: 0, z: 0, face: -1, tX: 0, tY: 0, tZ: 0 };

function chunkExit(
  x: number,
  y: number,
  z: number,
  tX: number,
  tY: number,
  tZ: number,
  dtX: number,
  dtY: number,
  dtZ: number,
  stepX: number,
  stepY: number,
  stepZ: number,
): typeof exitOut {
  // Voxels left along each axis before the ray leaves the chunk, and the crossing
  // that takes it out.
  const leftX = stepX > 0 ? CHUNK_SIZE - 1 - (x & 31) : (x & 31);
  const leftY = stepY > 0 ? CHUNK_SIZE - 1 - (y & 31) : (y & 31);
  const leftZ = stepZ > 0 ? CHUNK_SIZE - 1 - (z & 31) : (z & 31);
  const outX = dtX === Infinity ? Infinity : tX + leftX * dtX;
  const outY = dtY === Infinity ? Infinity : tY + leftY * dtY;
  const outZ = dtZ === Infinity ? Infinity : tZ + leftZ * dtZ;
  const t = Math.min(outX, Math.min(outY, outZ));
  // How many crossings each axis makes before then; the axis that leaves makes one
  // more, which is the step out of the chunk.
  const nX = dtX === Infinity ? 0 : Math.min(leftX + 1, Math.max(0, Math.floor((t - tX) / dtX) + 1));
  const nY = dtY === Infinity ? 0 : Math.min(leftY + 1, Math.max(0, Math.floor((t - tY) / dtY) + 1));
  const nZ = dtZ === Infinity ? 0 : Math.min(leftZ + 1, Math.max(0, Math.floor((t - tZ) / dtZ) + 1));
  exitOut.t = t;
  exitOut.x = x + nX * stepX;
  exitOut.y = y + nY * stepY;
  exitOut.z = z + nZ * stepZ;
  exitOut.tX = dtX === Infinity ? Infinity : tX + nX * dtX;
  exitOut.tY = dtY === Infinity ? Infinity : tY + nY * dtY;
  exitOut.tZ = dtZ === Infinity ? Infinity : tZ + nZ * dtZ;
  exitOut.face = t === outX ? (stepX > 0 ? 1 : 0) : t === outY ? (stepY > 0 ? 3 : 2) : (stepZ > 0 ? 5 : 4);
  return exitOut;
}
