// Reusable mesh output buffer: grows as needed and is reset per chunk, so a mesher
// that keeps one allocates nothing per mesh once warmed up. Pure.

import { FACE_COUNT, type Mesh } from "./quad.ts";

export class MeshBuilder implements Mesh {
  quads = new Uint32Array(8192);
  count = 0;
  readonly groupStart = new Int32Array(FACE_COUNT + 1);

  reset(): void {
    this.count = 0;
    this.groupStart.fill(0);
  }

  // Marks the start of face group `face`; faces must be begun in order 0..5.
  beginGroup(face: number): void {
    this.groupStart[face] = this.count;
  }

  finish(): void {
    this.groupStart[FACE_COUNT] = this.count;
  }

  push(word0: number, word1: number): void {
    if (this.count * 2 + 2 > this.quads.length) {
      const grown = new Uint32Array(this.quads.length * 2);
      grown.set(this.quads);
      this.quads = grown;
    }
    this.quads[this.count * 2] = word0;
    this.quads[this.count * 2 + 1] = word1;
    this.count++;
  }
}
