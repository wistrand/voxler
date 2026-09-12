import { FlyCamera } from "../camera/camera.ts";
import * as mat4 from "../util/mat4.ts";
import { CULL_FACE, CULL_FRUSTUM, CULL_VISIBLE, CULLED_FACE, CULLED_FRUSTUM, cullBox, frustumPlanes } from "./cull.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

function viewProjFor(camera: FlyCamera, aspect: number): Float64Array {
  const view = mat4.create(), proj = mat4.create(), vp = mat4.create();
  mat4.view(view, camera.offset, camera.basis);
  mat4.perspectiveReversedZ(proj, camera.fovY, aspect, camera.near);
  return mat4.multiply(vp, proj, view);
}

// True when the point projects inside the view volume (in front of the near
// plane, within the side planes).
function inside(vp: Float64Array, p: number[]): boolean {
  const c = mat4.transform(new Float64Array(4), vp, p[0], p[1], p[2], 1);
  return c[3] > 0 && Math.abs(c[0]) <= c[3] && Math.abs(c[1]) <= c[3] && c[2] <= c[3] && c[2] >= 0;
}

Deno.test("frustum planes keep exactly the points inside the view volume", () => {
  const rand = lcg(3);
  const camera = new FlyCamera();
  const planes = new Float64Array(20);
  for (let t = 0; t < 50; t++) {
    camera.setPosition(rand() * 32, rand() * 32, rand() * 32);
    camera.setOrientation(rand() * 6.28, (rand() - 0.5) * 3);
    const vp = viewProjFor(camera, 0.5 + rand() * 2);
    frustumPlanes(vp, planes);
    for (let i = 0; i < 200; i++) {
      const p = [(rand() - 0.5) * 200, (rand() - 0.5) * 200, (rand() - 0.5) * 200];
      let all = true;
      for (let k = 0; k < 5; k++) {
        if (planes[k * 4] * p[0] + planes[k * 4 + 1] * p[1] + planes[k * 4 + 2] * p[2] + planes[k * 4 + 3] < 0) {
          all = false;
        }
      }
      assert(all === inside(vp, p), `camera ${t}, point ${p}: planes say ${all}`);
    }
  }
});

Deno.test("cullBox never culls a box with any part in view or any front-facing quad plane", () => {
  const rand = lcg(11);
  const camera = new FlyCamera();
  const planes = new Float64Array(20);
  let culledFace = 0, culledFrustum = 0, visible = 0;
  for (let t = 0; t < 300; t++) {
    camera.setPosition(rand() * 32, rand() * 32, rand() * 32);
    camera.setOrientation(rand() * 6.28, (rand() - 0.5) * 3);
    const vp = viewProjFor(camera, 16 / 9);
    frustumPlanes(vp, planes);
    const eye = camera.offset;
    for (let b = 0; b < 40; b++) {
      // Random cluster box on the voxel grid within a few chunks of the camera.
      const lo = [0, 1, 2].map(() => Math.floor((rand() - 0.5) * 128));
      const hi = lo.map((v) => v + 1 + Math.floor(rand() * 32));
      const face = Math.floor(rand() * 6);
      const result = cullBox(planes, eye, lo, hi, face, CULL_FACE | CULL_FRUSTUM);
      if (result === CULLED_FACE) {
        culledFace++;
        // Every quad plane in the box faces away from the eye.
        const axis = face >> 1;
        const positive = (face & 1) === 0;
        for (let plane = positive ? lo[axis] + 1 : lo[axis]; plane <= (positive ? hi[axis] : hi[axis] - 1); plane++) {
          assert(positive ? eye[axis] <= plane : eye[axis] >= plane, `face ${face} plane ${plane} visible`);
        }
      } else if (result === CULLED_FRUSTUM) {
        culledFrustum++;
        // Dense samples of the box, surface and inside, all out of view.
        for (let i = 0; i <= 6; i++) {
          for (let j = 0; j <= 6; j++) {
            for (let k = 0; k <= 6; k++) {
              const p = [i, j, k].map((s, a) => lo[a] + ((hi[a] - lo[a]) * s) / 6);
              assert(!inside(vp, p), `box ${lo}-${hi} culled with a point in view`);
            }
          }
        }
      } else {
        assert(result === CULL_VISIBLE, "result");
        visible++;
      }
    }
  }
  assert(culledFace > 0 && culledFrustum > 0 && visible > 0, `${culledFace} face, ${culledFrustum} frustum, ${visible}`);
});

Deno.test("cull flags switch the tests off", () => {
  const planes = new Float64Array(20).fill(0);
  planes[3] = -1; // a plane nothing passes
  const eye = [100, 100, 100];
  assert(cullBox(planes, eye, [0, 0, 0], [1, 1, 1], 0, 0) === CULL_VISIBLE, "no flags");
  assert(cullBox(planes, eye, [0, 0, 0], [1, 1, 1], 1, CULL_FRUSTUM) === CULLED_FRUSTUM, "frustum only");
  assert(cullBox(planes, eye, [0, 0, 0], [1, 1, 1], 1, CULL_FACE) === CULLED_FACE, "face only: -X seen from +X");
});
