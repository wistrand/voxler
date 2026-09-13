// World programs available to `?world=<name>`. Each is WGSL following the
// contract in agent_docs/design-formats.md "World program".

import forest from "./forest.wgsl" with { type: "text" };
import monument from "./monument.wgsl" with { type: "text" };
import showcase from "./showcase.wgsl" with { type: "text" };
import terrain from "./terrain.wgsl" with { type: "text" };
import type { Sky } from "../render/sky.ts";

export interface WorldEntry {
  readonly code: string;
  // Default camera start (world voxels), above the surface; `?at=` overrides it.
  readonly spawn: readonly [number, number, number];
  // Sky and lighting preset (src/render/sky.ts); DEFAULT_SKY when unset.
  readonly sky?: string;
  // Far-field clipmap overrides, for worlds whose subject is distance. A world that is
  // mostly empty air can afford wider levels: an empty brick costs no pool slot, so
  // doubling `size` buys a finer cell at a given distance rather than more memory. The
  // `?far*` switches still win over anything set here.
  readonly far?: { readonly size?: number; readonly levels?: number; readonly bricks?: number };
}

export interface WorldProgram {
  readonly name: string;
  readonly code: string;
  readonly seed: number;
  readonly spawn: readonly [number, number, number];
  readonly sky: Sky;
  readonly far?: WorldEntry["far"];
}

export const WORLDS: Readonly<Record<string, WorldEntry>> = {
  // The floor near the origin is about 94 and the canopy tops out near 112: the spawn
  // stands over it, so the drop the grove bench scene takes lands under the trees.
  // A night wood: the moon is the only sky light, so the glowing plants carry the scene.
  forest: { code: forest, spawn: [8, 120, 8], sky: "night" },
  // The floor is near y = 40 and the buttes stand a few hundred voxels over it; the
  // spawn is out on the open desert looking at them rather than under one.
  // The monuments stand a kilometre apart over an empty floor, so nearly every brick
  // outside one is empty and the levels can be twice as wide without the pool growing
  // with them. Six wide levels are both finer and cheaper than the default eight narrow
  // ones: half the cell size at any given distance, and 3.7 ms of march against 7.3 at
  // 1080p looking down the valley, because a ray crosses fewer levels to get out. What
  // they cost is reach, 16,384 voxels rather than 32,768, which is why the desert haze
  // is thicker than the view alone would want.
  monument: { code: monument, spawn: [0, 62, 0], sky: "desert", far: { size: 64, levels: 6, bricks: 98304 } },
  showcase: { code: showcase, spawn: [16, 12, 48] },
  terrain: { code: terrain, spawn: [16, 140, 48] }, // surface near the origin is about 75
};

export const DEFAULT_WORLD = "showcase";
