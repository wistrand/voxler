// World programs available to `?world=<name>`. Each is WGSL following the
// contract in agent_docs/design-formats.md "World program".

import forest from "./forest.wgsl" with { type: "text" };
import planet from "./planet.wgsl" with { type: "text" };
import monument from "./monument.wgsl" with { type: "text" };
import showcase from "./showcase.wgsl" with { type: "text" };
import terrain from "./terrain.wgsl" with { type: "text" };
import type { Sky } from "../render/sky.ts";

export interface WorldEntry {
  readonly code: string;
  // The world's anchor (world voxels), above the surface. Two things hang off it and
  // they are not the same thing: the bench scenes are paths measured as offsets from it
  // (`src/bench/scenes.ts`), and the camera starts here when the world has no `start`.
  // A scene's numbers are only comparable to the last run of the same scene, so this
  // moves only when the terrain under it does, never to compose a nicer opening view.
  readonly spawn: readonly [number, number, number];
  // Where the camera starts instead, when the opening view wants somewhere the benchmarks
  // must not follow. `?at=` overrides it; unset means `spawn`.
  readonly start?: readonly [number, number, number];
  // Which way it looks when it gets there, as [yaw, pitch] in radians. Unset means the
  // default, along -Z and a little down, which is the right answer for a heightfield and
  // the wrong one for a world you open at a distance from.
  readonly look?: readonly [number, number];
  // Sky and lighting preset (src/render/sky.ts); DEFAULT_SKY when unset.
  readonly sky?: string;
  // Far-field clipmap overrides, for worlds whose subject is distance. A world that is
  // mostly empty air can afford wider levels: an empty brick costs no pool slot, so
  // doubling `size` buys a finer cell at a given distance rather than more memory. The
  // `?far*` switches still win over anything set here.
  readonly far?: { readonly size?: number; readonly levels?: number; readonly bricks?: number };
  // Birds over the world (`src/render/birds.wgsl`). Drawn, not voxelized, because they
  // travel and a chunk is voxelized once; a world that asks for them pays one more
  // pipeline and one more pass, so it is opt-in.
  readonly birds?: boolean;
}

export interface WorldProgram {
  readonly name: string;
  readonly code: string;
  readonly seed: number;
  readonly spawn: readonly [number, number, number];
  readonly start?: readonly [number, number, number];
  readonly look?: readonly [number, number];
  readonly sky: Sky;
  readonly far?: WorldEntry["far"];
  readonly birds?: boolean;
}

export const WORLDS: Readonly<Record<string, WorldEntry>> = {
  // The floor under the spawn is 132 and the canopy within forty voxels tops out at 179:
  // the spawn stands over both, so the drop the grove bench scene takes lands under the
  // trees rather than in them. Measured from the chunk store, not guessed, and it has to
  // be measured again whenever the terrain's amplitudes move: a stale spawn puts the
  // camera inside the hill and every bench number it produces is for an empty frame
  // (gotchas.md "The grove bench walked 44 voxels underground").
  // A night wood: the moon is the only sky light, so the glowing plants carry the scene.
  // `start` opens on the valley the screenshots are taken in (docs/README.md), a bluff 88
  // voxels over the river with the snow line to one side. It is not the spawn, because
  // the grove bench walks 20 voxels under the spawn to get beneath the canopy and the
  // ground here is far enough down that the same walk would be an aerial shot: the scene
  // would stop measuring what it was written to measure.
  forest: { code: forest, spawn: [8, 188, 8], start: [-108, 267, 293], sky: "night", birds: true },
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
  // A ball rather than a heightfield. Sea level is 2600 voxels from the origin and the
  // whole planet is about 5,200 across, so it fits in a frame from far enough out.
  //
  // It opens in orbit rather than on the ground, and that is not showmanship. The camera
  // has yaw and pitch and no roll, and its up is the world's +Y, so on a sphere the ground
  // is only level where the local up happens to agree: at the poles. Stand anywhere else
  // and the horizon is a wall down one side of the frame. From out here the planet is a
  // planet, and flying in still works as long as you accept that down is wherever you left
  // it. `spawn` is a measured point on an equatorial continent (26 voxels over grass,
  // found by flying there and reading the block underfoot) because the bench scenes and
  // `?at=` want somewhere on the surface; `start` is the view.
  planet: {
    code: planet,
    spawn: [2161, 0, -1576],
    start: [2977, 3846, 3846],
    look: [0.6588, -0.6691],
    sky: "space",
    // Seven levels, not the eight the thin air would otherwise buy. Reach is 16,384 voxels
    // and the far side of the planet from the descent's start is 9,300: the eighth level
    // was marching, and having its slabs sampled, for a shell that is not there. A level
    // costs more here than in a heightfield world, because a shell passes through every
    // one of them and none of them is empty.
    far: { levels: 7 },
  },
  showcase: { code: showcase, spawn: [16, 12, 48] },
  terrain: { code: terrain, spawn: [16, 140, 48] }, // surface near the origin is about 75
};

export const DEFAULT_WORLD = "showcase";
