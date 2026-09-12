// Coverage mask (plan-far-field phase 4): which chunks the near field is drawing.
//
// The far field must not draw its own coarse cells inside the meshed region. The near
// field leaves gaps on purpose (a window, a cave mouth, an overhang), and a far-field
// cell filling one pokes through the geometry in front of it. It also must keep
// drawing where the near field has nothing yet, so a chunk that is still streaming
// shows terrain rather than sky.
//
// So the march tests a bit per chunk when it hits a cell, and carries on marching if
// that chunk is the near field's. The mask is a camera-centred window of chunks,
// addressed toroidally like the clipmap, so following the camera only clears the
// planes that scrolled in.
//
// Who sets the bits: MeshScheduler, when it accepts a mesh or decides a chunk has no
// faces to draw, and when a chunk is evicted. Residency alone would be wrong: a
// resident chunk whose mesh has not landed yet draws nothing, and that is exactly
// when the far field should fill it in.

import { keyX, keyY, keyZ } from "../world/keys.ts";

// Chunks per side of the window. 64 x 32 x 64 covers the default streaming range
// (radius 16, height 6) several times over, and is 16 KiB of bits.
export const COVERAGE_X = 64;
export const COVERAGE_Y = 32;
export const COVERAGE_Z = 64;
export const COVERAGE_CELLS = COVERAGE_X * COVERAGE_Y * COVERAGE_Z;
export const COVERAGE_WORDS = COVERAGE_CELLS / 32;

export class CoverageMask {
  readonly words = new Uint32Array(COVERAGE_WORDS);
  // Chunk coordinate of the window's min corner.
  readonly origin = new Int32Array(3);
  // Words changed since the last upload, as a range.
  dirtyLo = COVERAGE_WORDS;
  dirtyHi = 0;
  covered = 0; // bits set

  private centred = false;

  // Toroidal cell of a chunk coordinate.
  index(cx: number, cy: number, cz: number): number {
    return (cx & (COVERAGE_X - 1)) +
      (cy & (COVERAGE_Y - 1)) * COVERAGE_X +
      (cz & (COVERAGE_Z - 1)) * COVERAGE_X * COVERAGE_Y;
  }

  inWindow(cx: number, cy: number, cz: number): boolean {
    return cx >= this.origin[0] && cx < this.origin[0] + COVERAGE_X &&
      cy >= this.origin[1] && cy < this.origin[1] + COVERAGE_Y &&
      cz >= this.origin[2] && cz < this.origin[2] + COVERAGE_Z;
  }

  set(key: number, covered: boolean): void {
    this.setAt(keyX(key), keyY(key), keyZ(key), covered);
  }

  setAt(cx: number, cy: number, cz: number, covered: boolean): void {
    if (!this.inWindow(cx, cy, cz)) return;
    const i = this.index(cx, cy, cz);
    const word = i >>> 5, bit = 1 << (i & 31);
    const had = (this.words[word] & bit) !== 0;
    if (had === covered) return;
    if (covered) this.words[word] |= bit;
    else this.words[word] &= ~bit;
    this.covered += covered ? 1 : -1;
    if (word < this.dirtyLo) this.dirtyLo = word;
    if (word >= this.dirtyHi) this.dirtyHi = word + 1;
  }

  get(cx: number, cy: number, cz: number): boolean {
    if (!this.inWindow(cx, cy, cz)) return false;
    const i = this.index(cx, cy, cz);
    return (this.words[i >>> 5] & (1 << (i & 31))) !== 0;
  }

  // Follows the camera chunk. Cells that scroll in are cleared: their bit belongs to a
  // chunk a window away, and eviction would clear it eventually, but "eventually" is
  // long enough to show terrain from somewhere else.
  center(cx: number, cy: number, cz: number): void {
    const want = [cx - COVERAGE_X / 2, cy - COVERAGE_Y / 2, cz - COVERAGE_Z / 2];
    const size = [COVERAGE_X, COVERAGE_Y, COVERAGE_Z];
    let jumped = !this.centred;
    for (let a = 0; a < 3; a++) if (Math.abs(want[a] - this.origin[a]) >= size[a]) jumped = true;
    if (jumped) {
      for (let a = 0; a < 3; a++) this.origin[a] = want[a];
      this.clear();
      this.centred = true;
      return;
    }
    for (let a = 0; a < 3; a++) {
      const from = this.origin[a];
      const to = want[a];
      if (from === to) continue;
      this.origin[a] = to;
      const lo = to > from ? from + size[a] : to;
      const hi = to > from ? to + size[a] : from;
      for (let p = lo; p < hi; p++) this.clearPlane(a, p);
    }
    this.centred = true;
  }

  clear(): void {
    this.words.fill(0);
    this.covered = 0;
    this.dirtyLo = 0;
    this.dirtyHi = COVERAGE_WORDS;
  }

  get dirty(): boolean {
    return this.dirtyHi > this.dirtyLo;
  }

  clearDirty(): void {
    this.dirtyLo = COVERAGE_WORDS;
    this.dirtyHi = 0;
  }

  private clearPlane(axis: number, plane: number): void {
    const o = this.origin;
    const sizes = [COVERAGE_X, COVERAGE_Y, COVERAGE_Z];
    const a = (axis + 1) % 3, b = (axis + 2) % 3;
    const c = [0, 0, 0];
    c[axis] = plane;
    for (let v = 0; v < sizes[b]; v++) {
      c[b] = o[b] + v;
      for (let u = 0; u < sizes[a]; u++) {
        c[a] = o[a] + u;
        this.setAt(c[0], c[1], c[2], false);
      }
    }
  }
}
