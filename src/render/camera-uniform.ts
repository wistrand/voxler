// Writes the camera uniform once per frame. Layout owned by
// agent_docs/design-formats.md "Camera uniform"; the WGSL struct is in camera.wgsl.
// Matrices are computed in float64 and copied to float32 at the end.

import "../gpu/globals.ts";
import type { FlyCamera } from "../camera/camera.ts";
import * as mat4 from "../util/mat4.ts";

export const CAMERA_UNIFORM_SIZE = 256;

// Seconds the animation clock wraps at (plan-living-world phase 2). Every wind term's
// period divides it, so the wrap is invisible and f32 keeps its precision: at 8 s a
// float still resolves under a microsecond.
export const WIND_PERIOD = 8;

// Longest frame the animation clock will admit, in seconds. A tab that was in the
// background comes back with a gap of minutes in it, and anything integrating against
// `dt` would take one enormous step; the frame loop already clamps the camera's own step
// the same way (MAX_FRAME_DT in main.ts).
export const MAX_ANIMATION_DT = 0.1;

// Element indices into the uniform's 32-bit words.
const VIEW = 0;
const VIEW_PROJ = 16;
const INV_VIEW_PROJ = 32;
const CHUNK = 48;
const OFFSET = 52;
const VIEWPORT = 56;
const TIME = 60;

export class CameraUniform {
  readonly buffer: GPUBuffer;
  private readonly data = new ArrayBuffer(CAMERA_UNIFORM_SIZE);
  private readonly f32 = new Float32Array(this.data);
  private readonly i32 = new Int32Array(this.data);
  private readonly view = mat4.create();
  private readonly proj = mat4.create();
  // Render space -> clip, float64, as written this frame (the cull pass derives
  // its frustum planes from it).
  readonly viewProj = mat4.create();
  // Public so passes that build rays from pixels can use it (the far field).
  readonly invViewProj = mat4.create();

  constructor(device: GPUDevice) {
    this.buffer = device.createBuffer({
      label: "camera",
      size: CAMERA_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // `time` is seconds; it is wrapped into WIND_PERIOD here, so callers can pass a clock
  // that has been running all session. `dt` is the frame's own length, for anything that
  // integrates rather than being a function of the clock (the boids in birds-step.wgsl).
  write(queue: GPUQueue, camera: FlyCamera, width: number, height: number, time = 0, dt = 0): void {
    mat4.view(this.view, camera.offset, camera.basis);
    mat4.perspectiveReversedZ(this.proj, camera.fovY, width / height, camera.near);
    mat4.multiply(this.viewProj, this.proj, this.view);
    mat4.invert(this.invViewProj, this.viewProj);

    const f = this.f32;
    for (let i = 0; i < 16; i++) {
      f[VIEW + i] = this.view[i];
      f[VIEW_PROJ + i] = this.viewProj[i];
      f[INV_VIEW_PROJ + i] = this.invViewProj[i];
    }
    this.i32[CHUNK] = camera.chunk[0];
    this.i32[CHUNK + 1] = camera.chunk[1];
    this.i32[CHUNK + 2] = camera.chunk[2];
    this.i32[CHUNK + 3] = 0;
    f[OFFSET] = camera.offset[0];
    f[OFFSET + 1] = camera.offset[1];
    f[OFFSET + 2] = camera.offset[2];
    f[OFFSET + 3] = 0;
    f[VIEWPORT] = width;
    f[VIEWPORT + 1] = height;
    f[VIEWPORT + 2] = 1 / width;
    f[VIEWPORT + 3] = 1 / height;
    f[TIME] = time - Math.floor(time / WIND_PERIOD) * WIND_PERIOD;
    f[TIME + 1] = Math.max(0, Math.min(MAX_ANIMATION_DT, dt));
    f[TIME + 2] = 0;
    f[TIME + 3] = 0;
    queue.writeBuffer(this.buffer, 0, this.data);
  }
}
