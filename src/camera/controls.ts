// Fly controls. Look: drag on the canvas with the mouse or a finger. No pointer
// lock, so the cursor stays free for the overlay and the rest of the page. Keys:
// WASD move along the view, Space/C move up/down in world space, Shift sprints,
// + and - change the base speed. The wheel flies towards and away from whatever the
// cursor is over, a step of a fraction of a second's travel, so it stays useful at any
// speed; aiming with the cursor rather than the view means a thing can be approached
// without turning to face it first. Events only record state; update() applies it once
// per frame.
//
// Touch has no keys and no wheel, so two fingers carry both: where they have moved from
// where they landed is a stick that flies while it is held (up the screen is forward,
// across is a strafe), and spreading or closing them is the wheel, flying towards or away
// from whatever is between them. A stick rather than a tap-to-move because flying is a
// thing you do for a while, and the deflection is analog, so a small push crawls and a
// big one sprints. One finger still looks; the second one landing ends the look, because
// a gesture that both turns and flies is impossible to aim.

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
// towards what the cursor is over, which is a wheel pushed up (a negative deltaY).
// Pure; the class applies it along the ray through the cursor.
export function wheelDolly(speed: number, deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * PAGE_PX : deltaY;
  const notches = Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, px / NOTCH_PX));
  return -notches * speed * WHEEL_SECONDS;
}

// A pinch of this many pixels is one wheel notch. Bigger than a notch of scroll on
// purpose: fingers travel further than a wheel does, and the two should cross a room
// with about the same effort.
const PINCH_PX = 90;
// The stick's dead zone and the deflection that means full speed, in pixels. The dead
// zone is what keeps a pinch from also creeping forward: two fingers never spread without
// their midpoint wandering a few pixels.
const STICK_DEAD_PX = 14;
const STICK_FULL_PX = 150;
// Fingers tracked at once. Two drive everything; the rest are ignored rather than
// dropped, so resting a palm does not end the gesture.
const MAX_TOUCHES = 8;

// Voxels to fly for a pinch, from one finger distance to another, as a slice of a
// second's travel like a wheel notch. Positive is towards whatever is between the
// fingers, which is spreading them. Pure; the class applies it along the ray through
// their midpoint.
export function pinchDolly(speed: number, from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return 0;
  const notches = Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, (to - from) / PINCH_PX));
  return notches * speed * WHEEL_SECONDS;
}

// One axis of the two-finger stick: how far the fingers have travelled from where they
// landed, as a fraction of full speed, past a dead zone. Pure.
export function stickAxis(offsetPx: number): number {
  if (!Number.isFinite(offsetPx)) return 0;
  const past = Math.abs(offsetPx) - STICK_DEAD_PX;
  if (past <= 0) return 0;
  return Math.sign(offsetPx) * Math.min(1, past / (STICK_FULL_PX - STICK_DEAD_PX));
}

// How far to travel along one axis of the move vector this frame. Keys are a direction,
// so a diagonal is normalised and moves at the base speed; the touch stick is a
// deflection, so half of one is half the speed. Dividing by the magnitude only once it is
// past one does both. Pure.
export function stepScale(speed: number, sprinting: boolean, dt: number, f: number, r: number, u: number): number {
  const mag = Math.sqrt(f * f + r * r + u * u);
  if (mag === 0 || !Number.isFinite(mag) || !(dt > 0)) return 0;
  return (speed * (sprinting ? SPRINT_FACTOR : 1) * dt) / Math.max(1, mag);
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
  // Voxels to fly from the wheel, as a vector rather than a distance: the wheel flies
  // towards whatever the cursor is over, not along the view, so two events at different
  // cursor positions are two different directions and have to add as vectors.
  private readonly dolly = new Float64Array(3);
  private readonly dollyDir = new Float64Array(3);
  // Fingers on the canvas, as parallel arrays so a gesture allocates nothing.
  private readonly touchId = new Int32Array(MAX_TOUCHES).fill(-1);
  private readonly touchX = new Float64Array(MAX_TOUCHES);
  private readonly touchY = new Float64Array(MAX_TOUCHES);
  private touches = 0;
  // The two-finger gesture: where the midpoint started, how far apart the fingers were
  // at the last move, and the stick as it stands. -1 for the distance means no gesture.
  private pinchFrom = -1;
  private stickOriginX = 0;
  private stickOriginY = 0;
  private stickForward = 0;
  private stickStrafe = 0;

  // Kept so `dispose()` can take them off again. Two of them are on the window rather
  // than the canvas, because a key released after the pointer left the canvas still has
  // to be released, and a window listener outlives the element it was added for: an
  // engine that is torn down without this keeps steering a camera nobody can see.
  private readonly listeners: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement, camera: FlyCamera) {
    this.canvas = canvas;
    this.camera = camera;
    // A canvas cannot hold focus unless it is given a tab index. Without one, clicking the
    // view leaves focus wherever it was, and the keys keep going to the editor you just
    // left. Left alone if the host has set its own.
    if (!canvas.hasAttribute("tabindex")) canvas.tabIndex = 0;
    const on = <T extends Event>(
      target: EventTarget,
      type: string,
      handler: (e: T) => void,
      options?: AddEventListenerOptions,
    ) => {
      const fn = handler as EventListener;
      target.addEventListener(type, fn, options);
      this.listeners.push(() => target.removeEventListener(type, fn, options));
    };
    on<KeyboardEvent>(globalThis, "keydown", (e) => this.onKey(e, true));
    on<KeyboardEvent>(globalThis, "keyup", (e) => this.onKey(e, false));
    on(globalThis, "blur", () => this.releaseKeys());
    on<PointerEvent>(canvas, "pointerdown", (e) => this.onPointerDown(e));
    on<PointerEvent>(canvas, "pointermove", (e) => this.onPointerMove(e));
    on<PointerEvent>(canvas, "pointerup", (e) => this.onPointerUp(e));
    on<PointerEvent>(canvas, "pointercancel", (e) => this.onPointerUp(e));
    // Not passive, and the default is prevented: the wheel flies the camera, and a canvas
    // embedded in a page would otherwise scroll the page at the same time, which reads as
    // the view fighting you.
    on<WheelEvent>(canvas, "wheel", (e) => {
      e.preventDefault();
      this.onWheel(e);
    }, { passive: false });
  }

  // Every listener off, and the keys released so a camera someone else is driving does
  // not keep the last direction held.
  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.releaseKeys();
  }

  // Which way the up and down keys are pressed, -1, 0 or 1, and whether sprint is held.
  // Read by anything that drives the camera instead of these controls and still wants
  // those keys to mean something (the follow flyover raises and lowers with them).
  get vertical(): number {
    return (this.up ? 1 : 0) - (this.down ? 1 : 0);
  }

  get sprinting(): boolean {
    return this.sprint;
  }

  // True while two fingers are flying the camera. What a click means is the host's
  // business, but a finger lifted off a gesture is not one.
  get gesturing(): boolean {
    return this.touches >= 2;
  }

  update(dt: number): void {
    const cam = this.camera;
    if (this.lookX !== 0 || this.lookY !== 0) {
      cam.setOrientation(cam.yaw - this.lookX, cam.pitch - this.lookY);
      this.lookX = 0;
      this.lookY = 0;
    }
    const d = this.dolly;
    if (d[0] !== 0 || d[1] !== 0 || d[2] !== 0) {
      // A wheel step is a distance, not a rate: it does not scale with the frame.
      cam.translate(d[0], d[1], d[2]);
      d[0] = 0;
      d[1] = 0;
      d[2] = 0;
    }
    const f = (this.forward ? 1 : 0) - (this.back ? 1 : 0) + this.stickForward;
    const r = (this.right ? 1 : 0) - (this.left ? 1 : 0) + this.stickStrafe;
    const u = (this.up ? 1 : 0) - (this.down ? 1 : 0);
    const step = stepScale(this.speed, this.sprint, dt, f, r, u);
    if (step === 0) return;
    const b = cam.basis;
    cam.translate(
      (b[0] * r + b[6] * f) * step,
      (b[1] * r + b[7] * f + u) * step,
      (b[2] * r + b[8] * f) * step,
    );
  }

  // Whether a key press is ours. The listeners are on the window rather than the canvas,
  // because a key released after the pointer has left the view still has to be released,
  // and because a full-page view is never focused until someone clicks it. So the test is
  // not "is the canvas focused" but "is anything else focused": a page that embeds the
  // view puts a text field, a checkbox or an editable block next to it, and WASD typed
  // into one of those must reach it rather than fly the camera.
  private handlesKeys(): boolean {
    const active = globalThis.document?.activeElement;
    return active === null || active === undefined || active === this.canvas ||
      active === globalThis.document?.body;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone
    // A key going down elsewhere is not ours. A key coming up always is: it may have gone
    // down here and been released after the focus moved, and a direction left held down
    // flies the camera away on its own.
    if (down && !this.handlesKeys()) {
      this.releaseKeys();
      return;
    }
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
    this.stickForward = 0;
    this.stickStrafe = 0;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === "touch") {
      this.addTouch(e);
      if (this.touches >= 2) {
        // The second finger ends the look and starts the two-finger gesture: turning and
        // flying at once cannot be aimed, and the finger that was looking is now half of
        // the stick. A third joins the count and nothing else: restarting the gesture
        // would snap the stick back to centre under a resting palm.
        if (this.touches === 2) {
          this.endLook();
          this.beginGesture();
        }
        e.preventDefault();
        return;
      }
    }
    if (this.dragId !== -1) return; // one pointer looks at a time
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault(); // no text selection or focus change from a drag on the canvas
    this.dragId = e.pointerId;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    this.dragRate = e.pointerType === "mouse" ? MOUSE_RADIANS_PER_PX : TOUCH_RADIANS_PER_PX;
    this.canvas.setPointerCapture(e.pointerId);
    // The default is prevented above, which would also have stopped the click moving
    // focus, so take it deliberately: clicking the view is how you give it the keyboard
    // back after typing somewhere else.
    this.canvas.focus({ preventScroll: true });
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === "touch" && this.moveTouch(e)) {
      if (this.touches >= 2) {
        this.trackGesture();
        return;
      }
    }
    if (e.pointerId !== this.dragId) return;
    this.lookX += (e.clientX - this.dragX) * this.dragRate;
    this.lookY += (e.clientY - this.dragY) * this.dragRate;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerId === this.dragId) this.dragId = -1;
    if (e.pointerType !== "touch") return;
    const had = this.touches;
    this.removeTouch(e.pointerId);
    if (had >= 2 && this.touches < 2) this.endGesture();
    // A finger left over from a gesture looks again, from where it is now rather than
    // from where it landed, or the view snaps by however far the gesture travelled.
    if (this.touches === 1 && this.dragId === -1) {
      this.dragId = this.touchId[0];
      this.dragX = this.touchX[0];
      this.dragY = this.touchY[0];
      this.dragRate = TOUCH_RADIANS_PER_PX;
    }
  }

  // --- touch bookkeeping ---------------------------------------------------------

  private addTouch(e: PointerEvent): void {
    if (this.indexOfTouch(e.pointerId) !== -1 || this.touches >= MAX_TOUCHES) return;
    const i = this.touches++;
    this.touchId[i] = e.pointerId;
    this.touchX[i] = e.clientX;
    this.touchY[i] = e.clientY;
  }

  private moveTouch(e: PointerEvent): boolean {
    const i = this.indexOfTouch(e.pointerId);
    if (i === -1) return false;
    this.touchX[i] = e.clientX;
    this.touchY[i] = e.clientY;
    return true;
  }

  private removeTouch(id: number): void {
    const i = this.indexOfTouch(id);
    if (i === -1) return;
    const last = --this.touches;
    this.touchId[i] = this.touchId[last];
    this.touchX[i] = this.touchX[last];
    this.touchY[i] = this.touchY[last];
    this.touchId[last] = -1;
  }

  private indexOfTouch(id: number): number {
    for (let i = 0; i < this.touches; i++) if (this.touchId[i] === id) return i;
    return -1;
  }

  // Ends the look without giving the pointer back: a captured finger keeps reporting to
  // the canvas after it has slid off it, and a finger that stops reporting stays counted
  // as down, which leaves the stick pushed and every click after it swallowed as part of
  // a gesture that has ended.
  private endLook(): void {
    this.dragId = -1;
  }

  // The first two fingers are the gesture; where they are now is where the stick rests
  // and how far apart they are is where the pinch starts.
  private beginGesture(): void {
    this.stickOriginX = (this.touchX[0] + this.touchX[1]) / 2;
    this.stickOriginY = (this.touchY[0] + this.touchY[1]) / 2;
    this.pinchFrom = Math.hypot(this.touchX[0] - this.touchX[1], this.touchY[0] - this.touchY[1]);
    this.stickForward = 0;
    this.stickStrafe = 0;
  }

  private trackGesture(): void {
    const midX = (this.touchX[0] + this.touchX[1]) / 2;
    const midY = (this.touchY[0] + this.touchY[1]) / 2;
    // Up the screen is forward, which is why the sign flips: clientY grows downwards.
    this.stickStrafe = stickAxis(midX - this.stickOriginX);
    this.stickForward = stickAxis(this.stickOriginY - midY);
    const apart = Math.hypot(this.touchX[0] - this.touchX[1], this.touchY[0] - this.touchY[1]);
    const amount = pinchDolly(this.speed, this.pinchFrom, apart);
    this.pinchFrom = apart;
    if (amount !== 0) this.addDolly(midX, midY, amount);
  }

  private endGesture(): void {
    this.pinchFrom = -1;
    this.stickForward = 0;
    this.stickStrafe = 0;
  }

  private scaleSpeed(factor: number): void {
    this.speed = stepSpeed(this.speed, factor);
  }

  private onWheel(e: WheelEvent): void {
    const amount = wheelDolly(this.speed, e.deltaY, e.deltaMode);
    if (amount === 0) return;
    this.addDolly(e.clientX, e.clientY, amount);
  }

  // Adds a step of flight along the ray through a point on the canvas, which is what
  // both the wheel and a pinch are: towards what is under the cursor or between the
  // fingers, not along the view.
  private addDolly(clientX: number, clientY: number, amount: number): void {
    // Where the cursor is, as NDC over the canvas as it is displayed. The rect and
    // `clientX`/`clientY` are in the same space whatever the page zoom is, which
    // `offsetX` is not: under browser zoom Chrome reports it scaled, so the centre of
    // the canvas came out a fifth of the way towards a corner. Allocating a DOMRect is
    // fine here; a wheel event is a gesture, not the frame path.
    const rect = this.canvas.getBoundingClientRect();
    // The aspect comes from the render target, not the rect, because that is what the
    // projection used. Under `?size=` the element is letterboxed to that same aspect, so
    // the two agree; the render target is still the one to ask.
    const aspect = this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 1;
    const ndcX = rect.width > 0 ? ((clientX - rect.left) / rect.width) * 2 - 1 : 0;
    const ndcY = rect.height > 0 ? 1 - ((clientY - rect.top) / rect.height) * 2 : 0;
    const dir = this.camera.rayThrough(ndcX, ndcY, aspect, this.dollyDir);
    this.dolly[0] += dir[0] * amount;
    this.dolly[1] += dir[1] * amount;
    this.dolly[2] += dir[2] * amount;
  }
}
