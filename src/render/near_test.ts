// Near-field drawing checks: the draw builtins self-test on Deno's WebGPU (skipped
// without an adapter), and the quad winding tables against the real camera
// matrices (no GPU).

import { FlyCamera } from "../camera/camera.ts";
import { FACE_AXIS, FACE_FLIP_MASK, FACE_SIGN, newQuad, QUAD_TRIANGLES, QUAD_TRIANGLES_FLIPPED, quadCorners } from "../mesh/quad.ts";
import * as mat4 from "../util/mat4.ts";
import { runDrawTest } from "./draw-test.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

Deno.test("draw builtins: firstVertex, firstInstance, indirect, winding", async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    console.log("no WebGPU adapter in this Deno; skipping");
    return;
  }
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  const failure = await runDrawTest(device, (m) => errors.push(m));
  device.destroy();
  assert(errors.length === 0, errors.join("\n"));
  assert(failure === null, failure ?? "");
});

Deno.test("quad triangles are counter-clockwise on screen seen from outside, every face", () => {
  const camera = new FlyCamera();
  const view = mat4.create(), proj = mat4.create(), viewProj = mat4.create();
  const corners = new Float64Array(12);
  const clip = new Float64Array(4);
  const q = newQuad();
  // Look straight at the face from outside: forward = -normal.
  const orientation: [number, number][] = [
    [Math.PI / 2, 0], // +X face, look toward -X
    [-Math.PI / 2, 0], // -X
    [0, -Math.PI / 2], // +Y, look down (clamped just short of vertical)
    [0, Math.PI / 2], // -Y
    [0, 0], // +Z, look toward -Z
    [Math.PI, 0], // -Z
  ];
  for (let face = 0; face < 6; face++) {
    Object.assign(q, { x: 10, y: 10, z: 10, w: 3, h: 2, face, id: 1, ao: 0 });
    quadCorners(q, corners);
    const eye = [11.5, 11, 11.5];
    eye[FACE_AXIS[face]] = 11 + FACE_SIGN[face] * 6;
    camera.setPosition(eye[0], eye[1], eye[2]);
    camera.setOrientation(orientation[face][0], orientation[face][1]);
    mat4.view(view, camera.offset, camera.basis);
    mat4.perspectiveReversedZ(proj, camera.fovY, 1, camera.near);
    mat4.multiply(viewProj, proj, view);
    const tris = ((FACE_FLIP_MASK >> face) & 1) !== 0 ? QUAD_TRIANGLES_FLIPPED : QUAD_TRIANGLES;
    const ndc: number[][] = [];
    for (const c of tris) {
      // Render space: chunk 0 is the camera chunk here, so local == render space.
      mat4.transform(clip, viewProj, corners[c * 3], corners[c * 3 + 1], corners[c * 3 + 2], 1);
      assert(clip[3] > 0, `face ${face}: corner behind the camera`);
      ndc.push([clip[0] / clip[3], clip[1] / clip[3]]);
    }
    for (let t = 0; t < 2; t++) {
      const [a, b, c] = ndc.slice(t * 3, t * 3 + 3);
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      assert(area > 0, `face ${face}, triangle ${t}: clockwise on screen (area ${area.toFixed(4)})`);
    }
  }
});
