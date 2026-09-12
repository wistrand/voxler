// World programs available to `?world=<name>`. Each is WGSL following the
// contract in agent_docs/design-formats.md "World program".

import forest from "./forest.wgsl" with { type: "text" };
import showcase from "./showcase.wgsl" with { type: "text" };
import terrain from "./terrain.wgsl" with { type: "text" };

export interface WorldEntry {
  readonly code: string;
  // Default camera start (world voxels), above the surface; `?at=` overrides it.
  readonly spawn: readonly [number, number, number];
}

export interface WorldProgram {
  readonly name: string;
  readonly code: string;
  readonly seed: number;
  readonly spawn: readonly [number, number, number];
}

export const WORLDS: Readonly<Record<string, WorldEntry>> = {
  forest: { code: forest, spawn: [8, 70, 8] }, // the floor near the origin is about 40
  showcase: { code: showcase, spawn: [16, 12, 48] },
  terrain: { code: terrain, spawn: [16, 140, 48] }, // surface near the origin is about 75
};

export const DEFAULT_WORLD = "showcase";
