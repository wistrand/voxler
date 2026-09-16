// What a host passes in, and what the engine reads.
//
// Until this file existed the configuration mechanism was `location.search`: 39 reads of
// `params.get(...)` at module scope in `main.ts`, which is unreachable from a page that
// embeds the engine rather than being it. The switches are not going away (a setting you
// can put in a link is how every A/B in this repo was measured), but they are now one
// source of options among others rather than the only one: `optionsFromSearch()` in
// `src/app/search-options.ts` turns a query string into a `VoxlerOptions`, and nothing
// else in the engine knows a URL exists.
//
// Two types, and the split matters. `VoxlerOptions` is what a caller writes: everything
// optional except the world, nested, and forgiving. `ResolvedOptions` is what the engine
// reads: every field present, every number clamped, nothing to decide later. Resolving
// happens once, at construction, so no frame-path code ever asks "was that set?".
//
// Pure: no DOM, no GPU, no globals. That is what lets the defaults be a test rather than
// a claim (`src/options_test.ts`).

import { MAX_LEVELS, DEFAULT_CLIPMAP_OPTIONS, levelsForReach } from "./far/clipmap.ts";
import type { WorldEntry } from "./worlds/index.ts";
import { DEFAULT_FAR_SCALE } from "./far/far-field.ts";
import { CLUSTER_QUADS, ORDER_EMISSION, ORDER_MORTON } from "./mesh/cluster.ts";
import { CULL_ALL, DEFAULT_NEAR_OPTIONS } from "./render/near-field.ts";
import { DEFAULT_SKY, fogHorizonVoxels, type Sky, SKIES } from "./render/sky.ts";
import { DEFAULT_MESH_OPTIONS, type MeshSchedulerOptions } from "./world/mesh-scheduler.ts";
import { DEFAULT_STREAM_OPTIONS, type StreamOptions } from "./world/streaming.ts";
import { DEFAULT_JOBS_PER_MESSAGE } from "./workers/pool.ts";

// A world, as a caller writes one. `code` is the WGSL: `WORLD_LIPSCHITZ`, `world_sdf` and
// `world_material` under the contract in design-formats.md "World program". Everything
// else has a default, and a world that sets none of it still runs.
export interface WorldSource {
  readonly code: string;
  // Above the surface, in world voxels. Also the origin the benchmark scenes measure
  // from, which is why it is not the same field as `start`.
  readonly spawn?: readonly [number, number, number];
  // Where the camera opens, when that should not be the spawn.
  readonly start?: readonly [number, number, number];
  // Which way it looks when it opens, [yaw, pitch] in radians.
  readonly look?: readonly [number, number];
  // A name from `SKIES`, or a preset of your own. Unset means `DEFAULT_SKY`.
  readonly sky?: string | Sky;
  // Clipmap overrides for a world whose subject is distance; see `far` in
  // `src/worlds/index.ts` for why a world would want them.
  readonly far?: { readonly size?: number; readonly levels?: number; readonly bricks?: number };
  // Birds over it (`src/render/birds-common.wgsl`). One more pipeline and two more passes.
  readonly birds?: boolean;
  // Bloom over its glowing blocks by default; `render.bloom` overrides it either way.
  readonly bloom?: boolean;
  // Brushes that move about the world (`orbits` in `src/worlds/index.ts`).
  readonly orbits?: WorldEntry["orbits"];
}

export interface CameraOptions {
  // World voxels. Unset means the world's `start`, then its `spawn`.
  readonly at?: readonly [number, number, number];
  readonly yaw?: number; // radians; 0 looks along -Z
  readonly pitch?: number; // radians; positive looks up
}

export interface WorkerOptions {
  readonly count?: number;
  readonly jobsPerMessage?: number;
  // How to make one. The default resolves the worker next to the engine bundle, which is
  // right for this repo's `dist/` and for any bundler that understands
  // `new URL(..., import.meta.url)`; anywhere else, pass your own.
  readonly factory?: (index: number) => Worker;
}

export interface StreamingOptions {
  readonly radius?: number; // chunks, horizontal
  readonly height?: number; // chunks, each way
  readonly arenaBytes?: number;
  readonly voxelSlots?: number;
}

export interface MeshingOptions {
  readonly clusterQuads?: number;
  readonly order?: "emission" | "morton";
  readonly ao?: boolean;
  readonly blockLight?: boolean;
}

export interface FarOptions {
  readonly size?: number; // bricks per side of a level, a power of two
  readonly levels?: number; // overrides the fog-horizon trim
  readonly firstLevel?: number; // finest cell size, 2^k voxels
  readonly bricks?: number; // pool capacity
  readonly slabsPerFrame?: number;
  readonly scale?: number; // march resolution, a fraction of the frame
  readonly beam?: boolean;
  readonly adapt?: boolean;
  readonly shadows?: boolean;
  // "on" draws it; the rest are debug views, and "off" is the same as `far: false`.
  readonly debug?: "steps" | "bricks" | "levels" | "blocks" | "height";
}

export interface RenderOptions {
  readonly size?: readonly [number, number] | "auto";
  readonly previewScale?: number;
  readonly preview?: boolean;
  readonly textures?: boolean;
  readonly glow?: boolean;
  readonly wind?: boolean;
  readonly cull?: number; // mask: 1 frustum, 2 face, 4 occlusion
  readonly gizmo?: boolean;
  readonly grid?: boolean;
  // Bloom over the glowing blocks. Unset takes the world's own default (`bloom` in
  // src/worlds/index.ts; the forest has it on). A second colour attachment on the near
  // pass and a blur chain over the frame, chosen when the renderer is built.
  readonly bloom?: boolean;
  readonly nearMiB?: number;
}

export interface VoxlerOptions {
  readonly world: WorldSource;
  readonly seed?: number;
  // Overrides the world's own sky, the way `?sky=` does.
  readonly sky?: string | Sky;
  readonly birds?: boolean;
  readonly camera?: CameraOptions;
  readonly workers?: number | WorkerOptions;
  readonly stream?: StreamingOptions | false;
  readonly mesh?: MeshingOptions | false;
  readonly far?: FarOptions | false;
  readonly render?: RenderOptions;
  readonly controls?: boolean;
  readonly autoResize?: boolean;
  readonly onError?: (message: string) => void;
}

// Defaults that are not already a `DEFAULT_*` somewhere else.
export const DEFAULT_SPAWN: readonly [number, number, number] = [0, 100, 0];
export const DEFAULT_START_PITCH = -0.25;
export const DEFAULT_PREVIEW_SCALE = 0.5;
export const DEFAULT_ARENA_BYTES = 128 * 1048576;
export const DEFAULT_VOXEL_SLOTS = 8;
export const DEFAULT_SLABS_PER_FRAME = 2;
export const DEFAULT_WORKERS = 4;

// Everything decided. The engine reads this and never the input.
export interface ResolvedOptions {
  readonly world: {
    readonly code: string;
    readonly seed: number;
    readonly spawn: readonly [number, number, number];
    readonly start: readonly [number, number, number];
    readonly look?: readonly [number, number];
    readonly sky: Sky;
    readonly birds: boolean;
    readonly orbits: WorldEntry["orbits"] | null;
  };
  readonly camera: { readonly at: readonly [number, number, number]; readonly yaw: number; readonly pitch: number };
  readonly workers: { readonly count: number; readonly jobsPerMessage: number; readonly factory?: (index: number) => Worker };
  readonly streaming: boolean;
  readonly stream: StreamOptions;
  readonly arenaBytes: number;
  readonly voxelSlots: number;
  readonly meshing: boolean;
  readonly mesh: MeshSchedulerOptions;
  readonly farOn: boolean;
  readonly far: {
    readonly clipmap: { readonly size: number; readonly levels: number; readonly firstLevel: number; readonly bricks: number };
    readonly slabsPerFrame: number;
    readonly scale: number;
    readonly beam: boolean;
    readonly adapt: boolean;
    readonly debug: string;
  };
  readonly shadows: boolean;
  readonly render: {
    readonly size: readonly [number, number] | null;
    readonly previewScale: number;
    readonly preview: boolean;
    readonly textures: boolean;
    readonly glow: boolean;
    readonly wind: boolean;
    readonly cull: number;
    readonly gizmo: boolean;
    readonly grid: boolean;
    readonly bloom: boolean;
    readonly nearMiB: number;
  };
  readonly controls: boolean;
  readonly autoResize: boolean;
  readonly onError?: (message: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// A number the caller may have left out, or set to something impossible. Non-finite is
// treated as absent rather than clamped, so a stray NaN is the default and not `min`.
function num(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : clamp(value, min, max);
}

function int(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.floor(num(value, fallback, min, max));
}

function resolveSky(named: string | Sky | undefined, fallback: string | Sky | undefined): Sky {
  for (const candidate of [named, fallback]) {
    if (candidate === undefined) continue;
    if (typeof candidate !== "string") return candidate;
    const found = SKIES[candidate];
    if (found !== undefined) return found;
  }
  return SKIES[DEFAULT_SKY];
}

export function resolveOptions(options: VoxlerOptions): ResolvedOptions {
  const world = options.world;
  const sky = resolveSky(options.sky, world.sky);
  const spawn = world.spawn ?? DEFAULT_SPAWN;
  const start = world.start ?? spawn;

  const streaming = options.stream !== false;
  const streamIn = streaming && options.stream ? options.stream : {};
  // `regenPerFrame` is deliberately not exposed: it is how many *edited* chunks the
  // streamer puts back through the voxelizer per frame, not a debug soak, and the two got
  // confused once already because they share a word.
  const stream: StreamOptions = {
    ...DEFAULT_STREAM_OPTIONS,
    radius: int(streamIn.radius, DEFAULT_STREAM_OPTIONS.radius, 1, 64),
    height: int(streamIn.height, DEFAULT_STREAM_OPTIONS.height, 1, 32),
  };

  // Meshing needs chunks to mesh, so `stream: false` turns it off whatever it says.
  const meshing = streaming && options.mesh !== false;
  const meshIn = options.mesh === false ? {} : options.mesh ?? {};
  const clusterQuads = int(meshIn.clusterQuads, CLUSTER_QUADS, 1, 255);

  const farOn = options.far !== false;
  const farIn = options.far === false ? {} : options.far ?? {};
  // A world may widen or shorten the clipmap for itself; an explicit option still wins.
  const farDefaults = { ...DEFAULT_CLIPMAP_OPTIONS, ...world.far };
  const size = int(farIn.size, farDefaults.size, 8, 128);
  const firstLevel = int(farIn.firstLevel, farDefaults.firstLevel, 1, 6);
  // Levels past the world's fog horizon march for a result the sky pass already drew, so
  // the default is trimmed to the horizon rather than taken as written. An explicit count
  // is taken as written, because a measurement wants the setting it asked for.
  const levels = farIn.levels !== undefined
    ? int(farIn.levels, farDefaults.levels, 1, MAX_LEVELS)
    : Math.min(farDefaults.levels, levelsForReach(size, firstLevel, fogHorizonVoxels(sky), MAX_LEVELS));

  const workersIn = typeof options.workers === "number" ? { count: options.workers } : options.workers ?? {};
  const renderIn = options.render ?? {};

  return {
    world: {
      code: world.code,
      seed: Number.isInteger(options.seed) ? (options.seed as number) >>> 0 : 1,
      spawn,
      start,
      look: world.look,
      sky,
      birds: (options.birds ?? world.birds) === true,
      orbits: world.orbits ?? null,
    },
    camera: {
      at: options.camera?.at ?? start,
      yaw: num(options.camera?.yaw ?? world.look?.[0], 0, -Math.PI * 2, Math.PI * 2),
      pitch: num(options.camera?.pitch ?? world.look?.[1], DEFAULT_START_PITCH, -Math.PI / 2, Math.PI / 2),
    },
    workers: {
      count: int(workersIn.count, defaultWorkerCount(), 1, 64),
      jobsPerMessage: int(workersIn.jobsPerMessage, DEFAULT_JOBS_PER_MESSAGE, 1, 256),
      factory: workersIn.factory,
    },
    streaming,
    stream,
    arenaBytes: int(streamIn.arenaBytes, DEFAULT_ARENA_BYTES, 16 * 1048576, 2048 * 1048576),
    // 16 and not 32: the ceiling the demo's `?voxelSlots=` has always had. Each slot is a
    // mapped readback buffer holding a whole batch, so the cost of a high one is memory
    // that never comes back.
    voxelSlots: int(streamIn.voxelSlots, DEFAULT_VOXEL_SLOTS, 1, 16),
    meshing,
    mesh: {
      ...DEFAULT_MESH_OPTIONS,
      clusterQuads,
      clusterOrder: meshIn.order === "morton" ? ORDER_MORTON : ORDER_EMISSION,
      ao: meshIn.ao !== false,
      blockLight: meshIn.blockLight !== false,
    },
    farOn,
    far: {
      clipmap: { size, levels, firstLevel, bricks: int(farIn.bricks, farDefaults.bricks, 4096, 1 << 20) },
      slabsPerFrame: int(farIn.slabsPerFrame, DEFAULT_SLABS_PER_FRAME, 1, 16),
      scale: num(farIn.scale, DEFAULT_FAR_SCALE, 0.1, 1),
      beam: farIn.beam !== false,
      adapt: farIn.adapt === true,
      debug: farIn.debug ?? "on",
    },
    // Shadow rays march the clipmap, so they need it built: no far field, no shadows,
    // whatever the option says.
    shadows: farIn.shadows !== false && farOn,
    render: {
      size: renderIn.size === "auto" || renderIn.size === undefined ? null : renderIn.size,
      previewScale: num(renderIn.previewScale, DEFAULT_PREVIEW_SCALE, 0.1, 1),
      // The preview and the meshes draw the same world, so the preview starts off
      // whenever there are meshes to draw.
      preview: renderIn.preview ?? !meshing,
      textures: renderIn.textures !== false,
      glow: renderIn.glow !== false,
      wind: renderIn.wind !== false,
      cull: int(renderIn.cull, CULL_ALL, 0, CULL_ALL),
      gizmo: renderIn.gizmo !== false,
      grid: renderIn.grid === true,
      // The world's own default unless the host or `?bloom=` said otherwise: the forest
      // has glowcaps at night and asks for it, a daylight world has nothing to bloom.
      bloom: renderIn.bloom ?? world.bloom === true,
      nearMiB: int(renderIn.nearMiB, DEFAULT_NEAR_OPTIONS.quadMiB, 8, 2048),
    },
    controls: options.controls !== false,
    autoResize: options.autoResize !== false,
    onError: options.onError,
  };
}

// One worker per core, less the main thread. No ceiling, which is what the demo has
// always done; `workers.count` is the way to ask for fewer. `hardwareConcurrency` is
// absent under Deno, which is why this is a function and not a constant.
export function defaultWorkerCount(): number {
  const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency;
  return Math.max(1, (cores || DEFAULT_WORKERS + 1) - 1);
}
