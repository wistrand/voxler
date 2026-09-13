// The small always-on panel: a frame rate, a row of switches, and a line of text while
// the world is still compiling. Separate from `Overlay` on purpose. The overlay is a wall
// of numbers for working on the engine and starts hidden; this is the handful of things
// someone looking at the world wants without reading the key list first.
//
// Nothing here runs per frame except `frame()`, which increments a counter. The text is
// rewritten on the same slow tick the overlay uses, so the DOM is touched a few times a
// second and never inside the frame path (CLAUDE.md "Never allocate in the per-frame
// path").

export interface HudButton {
  readonly label: string;
  // Shown as the button's tooltip, and the place to say what the key for it is.
  readonly title: string;
  // Whether the switch is currently on, read on every refresh. A button whose state
  // lives elsewhere (a key press, a reload) stays in step without being told.
  on(): boolean;
  press(): void;
}

// How often the readout is rewritten. Long enough that the DOM work is nothing, short
// enough that a frame rate reads as live.
const REFRESH_MS = 250;

export class Hud {
  private readonly root: HTMLElement;
  private readonly fps: HTMLElement;
  private readonly note: HTMLElement;
  private readonly buttons: readonly HudButton[];
  private readonly nodes: HTMLButtonElement[] = [];
  private frames = 0;
  private last = 0;
  private next = 0;
  private shown = "";

  constructor(parent: HTMLElement, buttons: readonly HudButton[]) {
    this.buttons = buttons;
    this.root = document.createElement("div");
    this.root.id = "hud";
    this.fps = document.createElement("span");
    this.fps.className = "fps";
    this.fps.textContent = "--";
    this.root.append(this.fps);
    for (const b of buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = b.label;
      el.title = b.title;
      // Pointer events on the canvas are what drag-to-look listens to, and a press that
      // reached both would spin the camera while the button was clicked.
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", () => {
        b.press();
        this.paint();
      });
      this.root.append(el);
      this.nodes.push(el);
    }
    this.note = document.createElement("span");
    this.note.className = "note";
    this.note.hidden = true;
    this.root.append(this.note);
    parent.append(this.root);
    this.paint();
  }

  // One frame drawn. The only thing this class does in the frame path.
  frame(): void {
    this.frames++;
  }

  // The line under the switches, for what the engine is doing before it can draw the
  // world. Empty hides it.
  status(text: string): void {
    if (text === this.shown) return;
    this.shown = text;
    this.note.textContent = text;
    this.note.hidden = text === "";
  }

  // Call once a frame with the frame's timestamp; it rewrites at most every REFRESH_MS.
  refresh(now: number): void {
    if (now < this.next) return;
    const elapsed = now - this.last;
    // The first call has no interval behind it, and a resumed tab has a useless one.
    if (this.last !== 0 && elapsed > 0 && elapsed < 4 * REFRESH_MS) {
      this.fps.textContent = `${Math.round(this.frames * 1000 / elapsed)} fps`;
    }
    this.frames = 0;
    this.last = now;
    this.next = now + REFRESH_MS;
    this.paint();
  }

  private paint(): void {
    for (let i = 0; i < this.buttons.length; i++) {
      const el = this.nodes[i];
      const on = this.buttons[i].on();
      // `classList.toggle` with a second argument is idempotent, so this is a no-op on
      // the ticks where nothing changed.
      el.classList.toggle("on", on);
    }
  }
}
