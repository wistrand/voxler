// Fly controls. Look: drag on the canvas with the mouse or a finger. No pointer
// lock, so the cursor stays free for the overlay and the rest of the page. Keys:
// WASD move along the view, Space/C move up/down in world space, Shift sprints,
// + and - change the base speed. The wheel flies forward and back along the view, a
// step of a fraction of a second's travel, so it stays useful at any speed. Events
// only record state; update() applies it once per frame.

import type { FlyCamera } from "./camera.ts";

const MOUSE_RADIANS_PER_PX = 0.004;
const TOUCH_RADIANS_PER_PX = 0.005;
const SPRINT_FACTOR = 10;
const SPEED_STEP = 1.25; // per + or - press
const MIN_SPEED = 0.5; // voxels per second
const MAX_SPEED = 20000;
// How far one wheel notch flies, as seconds of travel at the current speed.
const WHEEL_SECONDS = 0.35;
// Wheel deltas come in pixels, lines or pages depending on the device; these turn the
// last two into pixels so a notch means the same thing either way.
const LINE_PX = 16;
const PAGE_PX = 800;
const NOTCH_PX = 100;
// Most a single event may carry. Some devices report a whole page at once, and without
// this one flick would put the camera somewhere else entirely.
const MAX_NOTCHES = 4;

// Voxels to fly for one wheel event: a slice of a second's travel at the current speed,
// so the same gesture crosses a room in a cave and a valley from the air. Positive is
// forward, which is a wheel pushed up (a negative deltaY). Pure; the class applies it.
export function wheelDolly(speed: number, deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * PAGE_PX : deltaY;
  const notches = Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, px / NOTCH_PX));
  return -notches * speed * WHEEL_SECONDS;
}

// The base speed after one press of + or -, kept in range. Pure.
export function stepSpeed(speed: number, factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return speed;
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed * factor));
}

export class FlyControls {
  speed = 20; // voxels per second, before sprint

  private readonly camera: FlyCamera;
  private readonly canvas: HTMLCanvasElement;
  private forward = false;
  private back = false;
  private left = false;
  private right = false;
  private up = false;
  private down = false;
  private sprint = false;
  private lookX = 0; // accumulated radians since the last update
  private lookY = 0;
  private dragId = -1; // pointer currently dragging the view, or -1
  private dragX = 0;
  private dragY = 0;
  private dragRate = 0;
  private dolly = 0; // voxels along the view, from the wheel, applied next update

  constructor(canvas: HTMLCanvasElement, camera: FlyCamera) {
    this.canvas = canvas;
    this.camera = camera;
    addEventListener("keydown", (e) => this.onKey(e, true));
    addEventListener("keyup", (e) => this.onKey(e, false));
    addEventListener("blur", () => this.releaseKeys());
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: true });
  }

  update(dt: number): void {
    const cam = this.camera;
    if (this.lookX !== 0 || this.lookY !== 0) {
      cam.setOrientation(cam.yaw - this.lookX, cam.pitch - this.lookY);
      this.lookX = 0;
      this.lookY = 0;
    }
    const b0 = cam.basis;
    if (this.dolly !== 0) {
      // A wheel step is a distance, not a rate: it does not scale with the frame.
      cam.translate(b0[6] * this.dolly, b0[7] * this.dolly, b0[8] * this.dolly);
      this.dolly = 0;
    }
    const f = (this.forward ? 1 : 0) - (this.back ? 1 : 0);
    const r = (this.right ? 1 : 0) - (this.left ? 1 : 0);
    const u = (this.up ? 1 : 0) - (this.down ? 1 : 0);
    if (f === 0 && r === 0 && u === 0) return;
    const step = (this.speed * (this.sprint ? SPRINT_FACTOR : 1) * dt) / Math.sqrt(f * f + r * r + u * u);
    const b = cam.basis;
    cam.translate(
      (b[0] * r + b[6] * f) * step,
      (b[1] * r + b[7] * f + u) * step,
      (b[2] * r + b[8] * f) * step,
    );
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone
    switch (e.code) {
      case "KeyW":
        this.forward = down;
        break;
      case "KeyS":
        this.back = down;
        break;
      case "KeyA":
        this.left = down;
        break;
      case "KeyD":
        this.right = down;
        break;
      case "Space":
        this.up = down;
        break;
      case "KeyC":
        this.down = down;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.sprint = down;
        break;
      case "NumpadAdd":
        if (down) this.scaleSpeed(SPEED_STEP);
        break;
      case "NumpadSubtract":
        if (down) this.scaleSpeed(1 / SPEED_STEP);
        break;
      default:
        // + and - are read as symbols, not physical positions: which key carries them
        // moves with the layout, and the help text names the symbol. Everything else
        // here is a position, so WASD stays put whatever the layout
        // (CLAUDE.md "Conventions").
        if (e.key === "+" || e.key === "=") {
          if (down) this.scaleSpeed(SPEED_STEP);
          break;
        }
        if (e.key === "-" || e.key === "_") {
          if (down) this.scaleSpeed(1 / SPEED_STEP);
          break;
        }
        return;
    }
    e.preventDefault();
  }

  private releaseKeys(): void {
    this.forward = this.back = this.left = this.right = this.up = this.down = this.sprint = false;
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.dragId !== -1) return; // one pointer looks at a time
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault(); // no text selection or focus change from a drag on the canvas
    this.dragId = e.pointerId;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    this.dragRate = e.pointerType === "mouse" ? MOUSE_RADIANS_PER_PX : TOUCH_RADIANS_PER_PX;
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== this.dragId) return;
    this.lookX += (e.clientX - this.dragX) * this.dragRate;
    this.lookY += (e.clientY - this.dragY) * this.dragRate;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerId === this.dragId) this.dragId = -1;
  }

  private scaleSpeed(factor: number): void {
    this.speed = stepSpeed(this.speed, factor);
  }

  private onWheel(e: WheelEvent): void {
    this.dolly += wheelDolly(this.speed, e.deltaY, e.deltaMode);
  }
}
