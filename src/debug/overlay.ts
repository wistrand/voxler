// Debug overlay: named text sections plus a bounded error log. Updated on change,
// never per frame. Starts hidden, because the world is what the page is for; F2 toggles
// it (bound in main.ts) and an error forces it visible whatever the toggle says.

const MAX_ERRORS = 20;

export class Overlay {
  private readonly root: HTMLElement;
  private readonly errors: HTMLElement;
  private readonly sections = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "overlay";
    this.root.hidden = true;
    this.errors = document.createElement("pre");
    this.errors.className = "errors";
    this.errors.hidden = true;
    this.root.append(this.errors);
    parent.append(this.root);
  }

  setSection(name: string, text: string): void {
    let el = this.sections.get(name);
    if (!el) {
      el = document.createElement("pre");
      el.dataset.section = name;
      this.root.append(el);
      this.sections.set(name, el);
    }
    el.textContent = text;
  }

  error(text: string): void {
    console.error(text);
    const entry = document.createElement("div");
    entry.textContent = text;
    this.errors.append(entry);
    while (this.errors.childElementCount > MAX_ERRORS) this.errors.firstElementChild?.remove();
    this.errors.hidden = false;
    this.root.hidden = false;
  }

  // Forces the overlay open, for the one caller that needs it whatever the default is:
  // a benchmark run, whose progress is the only thing on screen worth watching.
  show(): void {
    this.root.hidden = false;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }
}
