// Fly camera state. Position is an integer chunk coordinate plus a float64 offset
// inside that chunk, so no code ever holds an absolute f32 world position
// (CLAUDE.md "Invariants"; design-formats.md "Coordinate spaces").
// Pure: no DOM or GPU access.

import { CHUNK_SIZE } from "../world/coords.ts";

const MAX_PITCH = (89 * Math.PI) / 180;

export class FlyCamera {
  readonly chunk = new Int32Array(3);
  // Position inside `chunk`, each component in [0, CHUNK_SIZE). This is also the
  // eye position in render space, whose origin is the camera chunk's min corner.
  readonly offset = new Float64Array(3);
  // [right xyz, up xyz, forward xyz], orthonormal, updated by setOrientation().
  readonly basis = new Float64Array(9);
  yaw = 0; // radians; 0 looks along -Z, positive turns left (toward -X)
  pitch = 0; // radians; positive looks up
  fovY = (70 * Math.PI) / 180;
  near = 0.05;

  constructor() {
    this.setOrientation(0, 0);
  }

  setPosition(x: number, y: number, z: number): void {
    this.setAxis(0, x);
    this.setAxis(1, y);
    this.setAxis(2, z);
  }

  // Absolute world coordinate on one axis, as float64. For display and tests;
  // never send this to the GPU.
  worldPosition(axis: number): number {
    return this.chunk[axis] * CHUNK_SIZE + this.offset[axis];
  }

  translate(dx: number, dy: number, dz: number): void {
    this.offset[0] += dx;
    this.offset[1] += dy;
    this.offset[2] += dz;
    this.renormalize(0);
    this.renormalize(1);
    this.renormalize(2);
  }

  setOrientation(yaw: number, pitch: number): void {
    this.yaw = yaw % (2 * Math.PI);
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    const b = this.basis;
    b[0] = cy; // right
    b[1] = 0;
    b[2] = -sy;
    b[3] = sy * sp; // up = right x forward
    b[4] = cp;
    b[5] = cy * sp;
    b[6] = -sy * cp; // forward
    b[7] = sp;
    b[8] = -cy * cp;
  }

  private setAxis(axis: number, world: number): void {
    const c = Math.floor(world / CHUNK_SIZE);
    this.chunk[axis] = c;
    this.offset[axis] = world - c * CHUNK_SIZE;
  }

  private renormalize(axis: number): void {
    const o = this.offset[axis];
    if (o >= 0 && o < CHUNK_SIZE) return;
    const shift = Math.floor(o / CHUNK_SIZE);
    this.chunk[axis] += shift;
    this.offset[axis] = o - shift * CHUNK_SIZE;
  }
}
