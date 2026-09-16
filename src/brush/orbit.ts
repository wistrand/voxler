// Orbiting brushes: the demo of a world function that moves. The world program stays
// a pure function of position (design-formats.md "World program"); what moves is the
// brush record, through `BrushStore.move()`, and the engine regenerates the chunks the
// brush leaves and enters, edits and all. That is the path the brush store was built
// for ("This is the path animation takes", src/brush/store.ts), and this is the first
// thing to take it.
//
// Each orbiter is one CSG sphere on a circle around a centre, at its own radius, height,
// period and phase, folded into the world with its own blend: a union adds a rolling
// ball of its material, a subtract carves a pit that heals behind it, a smooth union
// melts into the ground it passes. A brush moves only when its cell changes, since a
// move that lands on the same cell would still dirty every chunk in its box; so the
// number of regenerations a frame is the number of orbiters that crossed a voxel
// boundary this frame, times the chunks each box spans. Nothing here allocates per
// frame.

import { BrushStore } from "./store.ts";
import { csgOne } from "./build.ts";
import { BLEND_UNION, BRUSH_CSG, PRIM_SPHERE } from "./format.ts";

export interface OrbitSpec {
  readonly material: number; // block id
  readonly blend?: number; // BLEND_UNION unless said otherwise
  readonly k?: number; // blend radius, for the smooth blends
  readonly radius: number; // the sphere's, in voxels
  readonly orbit: number; // the circle's, in voxels
  readonly height: number; // the sphere's centre over the orbit centre
  readonly period: number; // seconds per revolution; negative runs the other way
  readonly phase?: number; // radians at t = 0
}

export class Orbits {
  // Brushes moved since the last `takeMoves()`, for the overlay.
  private moved = 0;
  private readonly ids: Int32Array;
  private readonly cell: Int32Array; // last cell handed to the store, x y z per orbiter
  private readonly store: BrushStore;

  constructor(
    store: BrushStore,
    readonly centre: readonly [number, number, number],
    readonly specs: readonly OrbitSpec[],
  ) {
    this.store = store;
    this.ids = new Int32Array(specs.length);
    this.cell = new Int32Array(specs.length * 3);
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      this.place(i, 0);
      this.ids[i] = store.add({
        kind: BRUSH_CSG,
        cell: [this.cell[i * 3], this.cell[i * 3 + 1], this.cell[i * 3 + 2]],
        blend: s.blend ?? BLEND_UNION,
        blendK: s.k ?? 0,
        material: s.material,
        ops: csgOne(PRIM_SPHERE, [s.radius]),
      });
    }
  }

  // Where orbiter `i` is at `seconds`, into `cell`. Returns true when that is a new cell.
  private place(i: number, seconds: number): boolean {
    const s = this.specs[i];
    const angle = (s.phase ?? 0) + (Math.PI * 2 * seconds) / s.period;
    const x = Math.round(this.centre[0] + Math.cos(angle) * s.orbit);
    const y = Math.round(this.centre[1] + s.height);
    const z = Math.round(this.centre[2] + Math.sin(angle) * s.orbit);
    const at = i * 3;
    const moved = x !== this.cell[at] || y !== this.cell[at + 1] || z !== this.cell[at + 2];
    this.cell[at] = x;
    this.cell[at + 1] = y;
    this.cell[at + 2] = z;
    return moved;
  }

  // Advances every orbiter to `seconds` and moves the brushes whose cell changed.
  update(seconds: number): void {
    for (let i = 0; i < this.specs.length; i++) {
      if (!this.place(i, seconds)) continue;
      const at = i * 3;
      this.store.move(this.ids[i], this.cell[at], this.cell[at + 1], this.cell[at + 2]);
      this.moved++;
    }
  }

  // Brushes moved since the last call.
  takeMoves(): number {
    const n = this.moved;
    this.moved = 0;
    return n;
  }

  get count(): number {
    return this.specs.length;
  }

  // Takes the brushes out of the world again.
  dispose(): void {
    for (let i = 0; i < this.ids.length; i++) if (this.store.has(this.ids[i])) this.store.remove(this.ids[i]);
  }
}
