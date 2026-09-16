// Marking: with the `mark` switch on, a click on the view collects everything worth
// knowing about the pixel under the cursor and posts it to the dev server, which writes
// it to marks/<UTC timestamp>.json. It exists because "look at this weird block" is a
// picture, and a picture of a shaded colour cannot say whether the block is a block id, a
// face turned away from the light, or a hole with something behind it. This answers that
// from the engine's own state.
//
// What a mark carries, and why each part is in it:
//
//   camera, pixel, ray   so the view can be reproduced exactly (`?at=` plus the look)
//   near                 whether the raster pass drew that pixel at all, and what the
//                        chunk under the hit holds if it is resident: the near field's
//                        answer to the same question, at one voxel
//   far                  what the ray met marching from zero: block, level, cell size,
//                        the cell's world position, distance, steps, and whether the
//                        beam pre-pass would have started the ray past it
//   world                the world program asked directly along a line through the hit,
//                        at a voxel's footprint and at the cell's, which is what says
//                        whether the thing on screen is in the world at all
//   options, stats       the clipmap the frame is using and what it currently holds
//
// Saving is the dev server's alone, like a bench result: `build.ts` defines
// `__BENCH_SAVE__` false for a release build and the fetch below goes with it, so the
// published bundle carries no POST. The mark is still printed to the console there.

import type { FarField } from "../far/far-field.ts";
import { decodeRayProbe, decodeWorldProbe, type RayProbe, type WorldProbeSample } from "../far/probe.ts";
import type { ChunkStore } from "../world/store.ts";
import { BLOCKS } from "../world/blocks.ts";
import { chunkKey } from "../world/keys.ts";
import { CHUNK_SIZE, voxelIndex } from "../world/coords.ts";

declare const __BENCH_SAVE__: boolean;
const CAN_SAVE = typeof __BENCH_SAVE__ === "undefined" ? true : __BENCH_SAVE__;

// How far the core sample through the hit reaches, in cells, and how many points it
// takes. Centred on the hit cell and running straight up, because what a marked cell
// usually needs saying about it is where the surface above it really is.
const SAMPLE_POINTS = 17;
const SAMPLE_SPAN_CELLS = 2;

export interface MarkInput {
  readonly far: FarField;
  readonly store: ChunkStore | null;
  // The clicked point in normalised device coordinates, and in pixels for the record.
  readonly ndc: readonly [number, number];
  readonly pixel: readonly [number, number];
  readonly canvas: readonly [number, number];
  readonly camera: {
    readonly position: readonly [number, number, number];
    readonly yaw: number;
    readonly pitch: number;
    readonly fovY: number;
  };
  readonly world: { readonly name: string; readonly seed: number };
  // Whatever the app wants on the record: URL switches, the on-screen switches, stats.
  readonly context?: Record<string, unknown>;
}

export interface Mark {
  readonly at: string;
  readonly browser: string;
  readonly url: string;
  readonly world: { readonly name: string; readonly seed: number };
  readonly camera: MarkInput["camera"] & { readonly ray: readonly [number, number, number] };
  readonly pixel: { readonly x: number; readonly y: number; readonly canvas: readonly [number, number] };
  readonly far: (RayProbe & { readonly blockName: string }) | null;
  readonly near: {
    readonly drewThePixel: boolean;
    readonly chunk: readonly [number, number, number] | null;
    readonly resident: boolean;
    readonly blockAtHit: number | null;
    readonly blockNameAtHit: string | null;
  };
  readonly world_samples: readonly (WorldProbeSample & {
    readonly fineName: string;
    readonly coarseName: string;
  })[];
  readonly context?: Record<string, unknown>;
}

// By id, not by index: BLOCKS is not in id order past the first dozen, and by index
// every desert mark read as moss (index 20) when it was red sand (id 20).
const BLOCK_NAMES = new Map(BLOCKS.map((b) => [b.id, b.name]));

function blockName(id: number): string {
  return BLOCK_NAMES.get(id) ?? `#${id}`;
}

// Collects one mark. Runs two GPU probes and maps their results, so it is awaited from a
// click handler and never from the frame loop.
export async function collectMark(input: MarkInput): Promise<Mark | null> {
  const rayWords = await input.far.probeRay(input.ndc[0], input.ndc[1]);
  if (rayWords === null) return null;
  const ray = decodeRayProbe(rayWords);

  // The core sample runs up through the hit cell, a cell at a time, so it spans the
  // cell the far field drew and the ones above and below it.
  const cell = Math.max(1, ray.cellVoxels);
  const half = Math.floor(SAMPLE_POINTS / 2);
  const stepY = Math.max(1, Math.round((cell * SAMPLE_SPAN_CELLS * 2) / SAMPLE_POINTS));
  const origin: [number, number, number] = [
    ray.world[0] + (cell >> 1),
    ray.world[1] + (cell >> 1) - stepY * half,
    ray.world[2] + (cell >> 1),
  ];
  const step: [number, number, number] = [0, stepY, 0];
  const worldWords = ray.hit
    ? await input.far.probeWorld(origin, step, SAMPLE_POINTS, 1, cell)
    : null;
  const samples = worldWords === null ? [] : decodeWorldProbe(worldWords, origin, step, SAMPLE_POINTS);

  const store = input.store;
  let chunk: [number, number, number] | null = null;
  let resident = false;
  let blockAtHit: number | null = null;
  if (ray.hit) {
    const cx = Math.floor(ray.world[0] / CHUNK_SIZE);
    const cy = Math.floor(ray.world[1] / CHUNK_SIZE);
    const cz = Math.floor(ray.world[2] / CHUNK_SIZE);
    chunk = [cx, cy, cz];
    if (store !== null) {
      const slot = store.slotOf(chunkKey(cx, cy, cz));
      resident = slot !== -1;
      if (resident) {
        blockAtHit = store.blockAtSlot(
          slot,
          voxelIndex(
            ray.world[0] - cx * CHUNK_SIZE,
            ray.world[1] - cy * CHUNK_SIZE,
            ray.world[2] - cz * CHUNK_SIZE,
          ),
        );
      }
    }
  }

  return {
    at: new Date().toISOString(),
    browser: navigator.userAgent,
    url: location.href,
    world: input.world,
    camera: { ...input.camera, ray: ray.dir },
    pixel: { x: input.pixel[0], y: input.pixel[1], canvas: input.canvas },
    far: ray.hit ? { ...ray, blockName: blockName(ray.block) } : null,
    near: {
      drewThePixel: ray.nearDepth > 0,
      chunk,
      resident,
      blockAtHit,
      blockNameAtHit: blockAtHit === null ? null : blockName(blockAtHit),
    },
    world_samples: samples.map((s) => ({
      ...s,
      fineName: blockName(s.fineBlock),
      coarseName: blockName(s.coarseBlock),
    })),
    context: input.context,
  };
}

// Posts a mark to the dev server. Returns where it landed, or a short status.
export async function saveMark(mark: Mark): Promise<string> {
  console.log("mark", mark);
  if (!CAN_SAVE) return "not saved (this build has no dev server; the mark is in the console)";
  const route = "/__mark/save";
  try {
    const res = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mark),
    });
    return res.ok ? (await res.json()).path : `not saved (HTTP ${res.status}; it is in the console)`;
  } catch (err) {
    return `not saved (${err instanceof Error ? err.message : String(err)}; it is in the console)`;
  }
}
