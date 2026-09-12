// The fixed test chunk set for meshers (plan-meshing "Testing methodology"): shapes
// that stress face culling and merging, each with several neighbor setups. Shared
// by the mesher tests and, later, the mesher benchmarks. Deterministic. Pure.

import { hash32, random01 } from "../util/random.ts";
import { BLOCKS } from "../world/blocks.ts";
import { CHUNK_VOLUME, voxelIndex } from "../world/coords.ts";
import { PAD_VOLUME, padIndex, shellFromPlanes } from "./ao.ts";
import { BORDER_IDS, newBorders, newPlanes, uniformPlanes } from "./planes.ts";

// Translucent test ids.
export const WATER = BLOCKS.find((b) => b.name === "water")!.id;
export const GLASS = BLOCKS.find((b) => b.name === "glass")!.id;

export interface TestChunk {
  name: string;
  ids: Uint16Array;
}

export interface NeighborSetup {
  name: string;
  planes: Uint32Array;
  shell: Uint8Array; // padded AO shell matching planes, with edges and corners
  borders: Uint16Array; // neighbor border ids matching planes (opaque bit <=> opaque id)
}

function fill(fn: (x: number, y: number, z: number) => number): Uint16Array {
  const ids = new Uint16Array(CHUNK_VOLUME);
  for (let y = 0; y < 32; y++) {
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) ids[voxelIndex(x, y, z)] = fn(x, y, z);
  }
  return ids;
}

export function testChunks(): TestChunk[] {
  return [
    { name: "empty", ids: fill(() => 0) },
    { name: "full", ids: fill(() => 1) },
    { name: "single voxel, center", ids: fill((x, y, z) => (x === 16 && y === 16 && z === 16 ? 2 : 0)) },
    { name: "single voxel, corner", ids: fill((x, y, z) => (x === 31 && y === 31 && z === 31 ? 2 : 0)) },
    { name: "checkerboard", ids: fill((x, y, z) => ((x + y + z) & 1 ? 0 : 1)) },
    { name: "random 10%", ids: fill((x, y, z) => (random01(10, voxelIndex(x, y, z)) < 0.1 ? 1 : 0)) },
    { name: "random 50%", ids: fill((x, y, z) => (random01(50, voxelIndex(x, y, z)) < 0.5 ? 1 : 0)) },
    { name: "random 90%", ids: fill((x, y, z) => (random01(90, voxelIndex(x, y, z)) < 0.9 ? 1 : 0)) },
    {
      name: "random 50%, 5 materials",
      ids: fill((x, y, z) => {
        const h = hash32(voxelIndex(x, y, z) * 2654435761);
        return h % 2 === 0 ? 0 : 1 + ((h >>> 8) % 5);
      }),
    },
    {
      name: "terrain-like",
      ids: fill((x, y, z) => {
        const surface = 12 + Math.floor(6 * Math.sin(x * 0.3) * Math.cos(z * 0.25));
        if (y > surface) return 0;
        if (random01(3, voxelIndex(x, y, z)) < 0.04) return 0; // small caves
        return y === surface ? 3 : y > surface - 3 ? 2 : 1;
      }),
    },
    {
      // The same surface without caves: what an open surface chunk looks like.
      name: "hills",
      ids: fill((x, y, z) => {
        const surface = 12 + Math.floor(6 * Math.sin(x * 0.3) * Math.cos(z * 0.25));
        if (y > surface) return 0;
        return y === surface ? 3 : y > surface - 3 ? 2 : 1;
      }),
    },
    { name: "slab x < 8", ids: fill((x) => (x < 8 ? 1 : 0)) },
    {
      // Translucent: a lake filling the hills' air up to y = 14.
      name: "hills with water",
      ids: fill((x, y, z) => {
        const surface = 12 + Math.floor(6 * Math.sin(x * 0.3) * Math.cos(z * 0.25));
        if (y > surface) return y <= 14 ? WATER : 0;
        return y === surface ? 3 : y > surface - 3 ? 2 : 1;
      }),
    },
    {
      // Two translucent ids touching each other, opaque, and air.
      name: "water and glass",
      ids: fill((x, y, z) => {
        if (y < 4) return 1;
        if (y < 12) return x < 16 ? WATER : GLASS;
        return random01(7, voxelIndex(x, y, z)) < 0.2 ? GLASS : random01(8, voxelIndex(x, y, z)) < 0.2 ? 1 : 0;
      }),
    },
    { name: "uniform water", ids: fill(() => WATER) },
  ];
}

// A padded AO shell (ao.ts) agreeing with `planes`; edge and corner cells from
// `edge(i)` for padded index i.
function shellFor(planes: Uint32Array, edge: (i: number) => number): Uint8Array {
  const shell = new Uint8Array(PAD_VOLUME);
  for (let y = -1; y <= 32; y++) {
    for (let z = -1; z <= 32; z++) {
      for (let x = -1; x <= 32; x++) {
        const outside = (x < 0 || x > 31 ? 1 : 0) + (y < 0 || y > 31 ? 1 : 0) + (z < 0 || z > 31 ? 1 : 0);
        if (outside >= 2) shell[padIndex(x, y, z)] = edge(padIndex(x, y, z));
      }
    }
  }
  shellFromPlanes(shell, planes);
  return shell;
}

export function neighborSetups(): NeighborSetup[] {
  const random = newPlanes();
  for (let i = 0; i < random.length; i++) random[i] = hash32(i * 40503 + 7);
  const empty = uniformPlanes(false);
  const opaque = uniformPlanes(true);
  // Random borders: stone where the plane says opaque, else air, water, or glass.
  const randomBorders = newBorders();
  for (let i = 0; i < randomBorders.length; i++) {
    const face = Math.floor(i / BORDER_IDS), v = (i >>> 5) & 31, u = i & 31;
    const opaqueBit = (random[face * 32 + v] >>> u) & 1;
    randomBorders[i] = opaqueBit ? 1 : [0, WATER, GLASS][hash32(i + 1234) % 3];
  }
  return [
    { name: "empty neighbors", planes: empty, shell: shellFor(empty, () => 0), borders: newBorders() },
    { name: "opaque neighbors", planes: opaque, shell: shellFor(opaque, () => 1), borders: newBorders().fill(1) },
    {
      name: "random neighbors",
      planes: random,
      shell: shellFor(random, (i) => hash32(i + 99) & 1),
      borders: randomBorders,
    },
  ];
}
