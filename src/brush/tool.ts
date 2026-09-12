// The placement tool (plan-world-modelling phase 4): turns a raycast hit into an
// edit, and keeps the undo log. Main thread, no DOM: input handling lives in
// main.ts, so scripted placement and hand placement go through the same calls.
//
// Every edit is a voxel brush (voxel-ops.ts), so undo is `store.remove(id)` and redo
// is adding the same descriptor again. Redo gives the brush a new sequence number,
// which puts it back at the end of the journal, where it was.

import type { RayHit } from "../world/raycast.ts";
import { packVoxel } from "./build.ts";
import { BRUSH_VOXEL, SHAPE_BOX, SHAPE_SPHERE, SHAPE_VOXEL, VOXEL_CARVE, VOXEL_SET } from "./format.ts";
import { ORIENTATION_COUNT } from "./orientation.ts";
import { type BrushDesc, BrushStore } from "./store.ts";

export const TOOL_SHAPES: readonly number[] = [SHAPE_VOXEL, SHAPE_BOX, SHAPE_SPHERE];

export interface ToolState {
  blockId: number;
  shape: number; // one of TOOL_SHAPES
  orientation: number; // 0..23
  // Box half-extents in voxels. Unequal on purpose, so an orientation is visible.
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  radius: number; // sphere
}

export class EditTool {
  readonly state: ToolState = { blockId: 1, shape: SHAPE_VOXEL, orientation: 0, sizeX: 1, sizeY: 3, sizeZ: 1, radius: 3 };
  private readonly store: BrushStore;
  // Applied edits are log[0, cursor); the rest are undone and can be redone.
  private readonly log: BrushDesc[] = [];
  private readonly ids: number[] = [];
  private cursor = 0;

  constructor(store: BrushStore) {
    this.store = store;
  }

  get undoDepth(): number {
    return this.cursor;
  }

  get redoDepth(): number {
    return this.log.length - this.cursor;
  }

  // The one path every edit takes. Returns the new instance id.
  apply(desc: BrushDesc): number {
    this.log.length = this.cursor;
    this.ids.length = this.cursor;
    const id = this.store.add(desc);
    this.log.push(desc);
    this.ids.push(id);
    this.cursor++;
    return id;
  }

  // Puts the current shape against the face the ray entered, the way a block goes on
  // the side you are looking at.
  place(hit: RayHit): number {
    return this.apply(this.describe(hit.fromX, hit.fromY, hit.fromZ, this.state.blockId));
  }

  // Takes the current shape out of the voxel the ray hit.
  remove(hit: RayHit): number {
    return this.apply(this.describe(hit.x, hit.y, hit.z, 0));
  }

  undo(): boolean {
    if (this.cursor === 0) return false;
    this.cursor--;
    this.store.remove(this.ids[this.cursor]);
    return true;
  }

  redo(): boolean {
    if (this.cursor === this.log.length) return false;
    this.ids[this.cursor] = this.store.add(this.log[this.cursor]);
    this.cursor++;
    return true;
  }

  rotate(delta: number): void {
    const o = (this.state.orientation + delta) % ORIENTATION_COUNT;
    this.state.orientation = o < 0 ? o + ORIENTATION_COUNT : o;
  }

  nextShape(): void {
    const i = TOOL_SHAPES.indexOf(this.state.shape);
    this.state.shape = TOOL_SHAPES[(i + 1) % TOOL_SHAPES.length];
  }

  describe(x: number, y: number, z: number, blockId: number): BrushDesc {
    const s = this.state;
    const mode = blockId === 0 ? VOXEL_CARVE : VOXEL_SET;
    let params: number[];
    if (s.shape === SHAPE_BOX) params = [-s.sizeX, -s.sizeY, -s.sizeZ, s.sizeX, s.sizeY, s.sizeZ];
    else if (s.shape === SHAPE_SPHERE) params = [0, 0, 0, s.radius];
    else params = [0, 0, 0];
    return {
      kind: BRUSH_VOXEL,
      cell: [x, y, z],
      orientation: s.orientation,
      ops: packVoxel([{ mode, shape: s.shape, id: blockId, params }]),
    };
  }

  describeState(): string {
    const s = this.state;
    const shape = s.shape === SHAPE_BOX
      ? `box ${s.sizeX * 2 + 1}x${s.sizeY * 2 + 1}x${s.sizeZ * 2 + 1}`
      : s.shape === SHAPE_SPHERE
      ? `sphere r${s.radius}`
      : "voxel";
    return `block ${s.blockId}  ${shape}  orientation ${s.orientation}  undo ${this.undoDepth}  redo ${this.redoDepth}`;
  }
}
