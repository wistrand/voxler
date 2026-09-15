// The only file in the engine that knows a URL exists.
//
// Every `?switch=` the demo has ever had is here, mapped to a field of `VoxlerOptions`.
// They are worth keeping: a setting you can put in a link is how every A/B in this repo
// was measured, and a bench result names the switches it ran under. What they stopped
// being is the configuration mechanism, which is what made the engine impossible to embed
// (see the note at the top of `src/options.ts`).
//
// Pure: it takes the params rather than reading `location`, so it is testable and so a
// host can feed it a query string of its own.

import type { VoxlerOptions, WorldSource } from "../options.ts";
import { SKIES } from "../render/sky.ts";
import { DEFAULT_WORLD, WORLDS } from "../worlds/index.ts";

// 1080p, so results compare across window sizes; CLAUDE.md's targets are at that size.
export const BENCH_DEFAULT_SIZE: readonly [number, number] = [1920, 1080];

export interface SearchProblem {
  readonly message: string;
}

function intOf(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}

function numOf(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

// `?switch=0` off, anything else on, absent means leave it to the default.
function flag(params: URLSearchParams, name: string): boolean | undefined {
  const raw = params.get(name);
  return raw === null ? undefined : raw !== "0";
}

function sizeOf(params: URLSearchParams): readonly [number, number] | "auto" | undefined {
  const m = params.get("size")?.match(/^(\d+)x(\d+)$/);
  if (m) return [Number(m[1]), Number(m[2])];
  // A benchmark renders at a fixed size whether or not one was asked for, or two runs in
  // two window shapes are not comparable.
  return params.has("bench") ? BENCH_DEFAULT_SIZE : undefined;
}

function farOf(params: URLSearchParams): VoxlerOptions["far"] {
  const mode = params.get("far") ?? "on";
  if (mode === "0" || mode === "off") return false;
  return {
    size: intOf(params, "farSize"),
    levels: intOf(params, "farLevels"),
    firstLevel: intOf(params, "farFirst"),
    bricks: intOf(params, "farBricks"),
    slabsPerFrame: intOf(params, "farSlabs"),
    scale: numOf(params, "farScale"),
    beam: flag(params, "farBeam"),
    // The one switch that is on only when asked: what the controller moves is visible
    // while the camera is still, so `?farAdapt=1` and nothing else turns it on.
    adapt: params.get("farAdapt") === "1",
    shadows: flag(params, "shadow"),
    debug: mode === "steps" || mode === "bricks" || mode === "levels" || mode === "blocks" ||
        mode === "height"
      ? mode
      : undefined,
  };
}

// The world a `?world=` names, and a note when it names one that does not exist. The
// caller decides what to do about the note; the demo puts it in the overlay.
export function worldFromSearch(
  params: URLSearchParams,
  problems: SearchProblem[] = [],
): { name: string; world: WorldSource } {
  let name = params.get("world") ?? DEFAULT_WORLD;
  if (!(name in WORLDS)) {
    problems.push({ message: `unknown world "${name}"; known: ${Object.keys(WORLDS).join(", ")}` });
    name = DEFAULT_WORLD;
  }
  return { name, world: WORLDS[name] };
}

export function optionsFromSearch(params: URLSearchParams, problems: SearchProblem[] = []): VoxlerOptions {
  const { world } = worldFromSearch(params, problems);

  // `?voxelBench` gives the voxelizer the GPU to itself: no streaming, no meshing, no
  // preview competing with what is being measured.
  const voxelBench = params.has("voxelBench");
  const streaming = params.get("stream") !== "0" && !voxelBench;
  const meshing = streaming && params.get("mesh") !== "0";

  const arenaMiB = intOf(params, "arenaMB");
  const sky = params.get("sky");
  if (sky !== null && !(sky in SKIES)) {
    // Not fatal: `resolveOptions` falls back to the world's own, and the demo shows the
    // note rather than refusing to start.
    problems.push({ message: `unknown sky "${sky}"; known: ${Object.keys(SKIES).join(", ")}` });
  }

  return {
    world,
    seed: intOf(params, "seed"),
    sky: sky ?? undefined,
    birds: flag(params, "birds"),
    workers: { count: intOf(params, "workers"), jobsPerMessage: intOf(params, "jobBatch") },
    stream: streaming
      ? {
        radius: intOf(params, "streamRadius"),
        height: intOf(params, "streamHeight"),
        arenaBytes: arenaMiB === undefined ? undefined : arenaMiB * 1048576,
        voxelSlots: intOf(params, "voxelSlots"),
      }
      : false,
    mesh: meshing
      ? {
        clusterQuads: intOf(params, "clusterQuads"),
        order: params.get("clusterOrder") === "morton" ? "morton" : undefined,
        ao: flag(params, "ao"),
        blockLight: flag(params, "light"),
      }
      : false,
    far: farOf(params),
    render: {
      size: sizeOf(params),
      previewScale: numOf(params, "previewScale"),
      // The preview starts off when meshes are drawn; `?preview=1` forces it on and
      // `?preview=0` off, which is the only way to see nothing at all.
      preview: params.get("preview") === "1" ? true : params.get("preview") === "0" ? false : undefined,
      textures: flag(params, "tex"),
      glow: flag(params, "glow"),
      wind: flag(params, "wind"),
      cull: intOf(params, "cull"),
      gizmo: flag(params, "gizmo"),
      // Unset leaves it to the world (the forest has it on); `?bloom=0` and `?bloom=1`
      // decide either way.
      bloom: flag(params, "bloom"),
      nearMiB: intOf(params, "nearMB"),
    },
  };
}

// The switches that drive the demo shell rather than the engine: they turn on a harness,
// a comparison or a self-test, and none of them belongs in a published package.
export interface AppSwitches {
  readonly bench: string | null;
  readonly runs: number | undefined;
  readonly voxelBench: boolean;
  readonly workerTest: boolean;
  readonly cullCheck: boolean;
  readonly farCheck: boolean;
  readonly regenCheck: boolean;
  // `?regen=n` regenerates n random resident chunks a frame: a soak test for chunk
  // regeneration, and not the streamer's own budget for chunks an edit has changed.
  readonly regen: number;
  readonly at: readonly [number, number, number] | null;
}

export function appSwitches(params: URLSearchParams): AppSwitches {
  const at = params.get("at")?.split(",").map(Number);
  return {
    bench: params.get("bench"),
    runs: intOf(params, "runs"),
    voxelBench: params.has("voxelBench"),
    workerTest: params.has("workerTest"),
    cullCheck: params.has("cullCheck"),
    farCheck: params.has("farCheck"),
    regenCheck: params.has("regenCheck"),
    regen: Math.max(0, Math.min(1024, intOf(params, "regen") ?? 0)),
    at: at && at.length === 3 && at.every(Number.isFinite) ? [at[0], at[1], at[2]] : null,
  };
}
