// Debug overlay: named text sections plus a bounded error log. Updated on change,
// never per frame. F2 toggles it (bound in main.ts); an error forces it visible.

const MAX_ERRORS = 20;

export class Overlay {
  private readonly root: HTMLElement;
  private readonly errors: HTMLElement;
  private readonly sections = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "overlay";
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

  get visible(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }
}
