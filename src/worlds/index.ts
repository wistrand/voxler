// World programs available to `?world=<name>`. Each is WGSL following the
// contract in agent_docs/design-formats.md "World program".

import forest from "./forest.wgsl" with { type: "text" };
import showcase from "./showcase.wgsl" with { type: "text" };
import terrain from "./terrain.wgsl" with { type: "text" };
import type { Sky } from "../render/sky.ts";

export interface WorldEntry {
  readonly code: string;
  // Default camera start (world voxels), above the surface; `?at=` overrides it.
  readonly spawn: readonly [number, number, number];
  // Sky and lighting preset (src/render/sky.ts); DEFAULT_SKY when unset.
  readonly sky?: string;
}

export interface WorldProgram {
  readonly name: string;
  readonly code: string;
  readonly seed: number;
  readonly spawn: readonly [number, number, number];
  readonly sky: Sky;
}

export const WORLDS: Readonly<Record<string, WorldEntry>> = {
  // The floor near the origin is about 94 and the canopy tops out near 112: the spawn
  // stands over it, so the drop the grove bench scene takes lands under the trees.
  // A night wood: the moon is the only sky light, so the glowing plants carry the scene.
  forest: { code: forest, spawn: [8, 120, 8], sky: "night" },
  showcase: { code: showcase, spawn: [16, 12, 48] },
  terrain: { code: terrain, spawn: [16, 140, 48] }, // surface near the origin is about 75
};

export const DEFAULT_WORLD = "showcase";
