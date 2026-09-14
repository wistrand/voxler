// The two probe buffers behind the `mark` switch: one ray marched through the clipmap
// (`probe_far` in far.wgsl) and one line of points asked of the world program itself
// (`probe_world` in far-build.wgsl). Both are flat `array<u32>` so there is no struct
// alignment to get wrong across the boundary, and the word layout lives here, with
// src/far/probe_test.ts holding the shaders to it (CLAUDE.md "Binary formats have one
// owner").
//
// Neither runs in the frame path. A mark is a click.

export const PROBE_WORDS = 24;
export const WORLD_PROBE_SAMPLES = 24;
export const WORLD_PROBE_HEADER = 12;
export const WORLD_PROBE_WORDS = WORLD_PROBE_HEADER + WORLD_PROBE_SAMPLES * 4;

// What one marked ray met. Distances are in voxels, `world` is the hit cell's min corner
// in world voxels, and `cellVoxels` is how wide that cell is, so the two together say how
// coarse the thing on screen is.
export interface RayProbe {
  readonly dir: readonly [number, number, number];
  readonly hit: boolean;
  // The ray met a cell the near field is drawing and carried on past it (far.wgsl).
  readonly stopped: boolean;
  readonly block: number;
  // 0 x, 1 y, 2 z, 3 no face crossed: the ray began inside this level (`entry_normal`).
  readonly axis: number;
  readonly level: number;
  readonly levels: number;
  readonly steps: number;
  readonly bricks: number;
  readonly cellVoxels: number;
  readonly world: readonly [number, number, number];
  readonly t: number;
  // Where the beam pre-pass would have started this ray, so a hit the frame missed can
  // be told from a hit that is not there. 1e9 means the beam found nothing.
  readonly beam: number;
  // The near field claims the chunk this cell is in, so the march passed through it.
  readonly covered: boolean;
  // The near field's depth at the clicked pixel, reversed-Z: 0 means it drew nothing
  // there and what is on screen is the far field's.
  readonly nearDepth: number;
}

// One point of the world, asked twice: at the footprint a voxel would be sampled with
// and at the footprint the brick was built with.
export interface WorldProbeSample {
  readonly at: readonly [number, number, number];
  readonly fineSdf: number;
  readonly fineBlock: number;
  readonly coarseSdf: number;
  readonly coarseBlock: number;
}

// Which word holds what. `probe_far` writes by these indices and the decoder reads by
// them, and src/far/probe_test.ts holds the shader to the same list: a word written in
// one place and read from another is the whole reason this table exists.
export const RAY_WORD = {
  ndcX: 0,
  ndcY: 1,
  dirX: 2,
  dirY: 3,
  dirZ: 4,
  hit: 5,
  stopped: 6,
  block: 7,
  axis: 8,
  level: 9,
  steps: 10,
  bricks: 11,
  cellVoxels: 12,
  worldX: 13,
  worldY: 14,
  worldZ: 15,
  t: 16,
  beam: 17,
  covered: 18,
  nearDepth: 19,
  levels: 20,
} as const;

export function decodeRayProbe(words: Uint32Array): RayProbe {
  const f = new Float32Array(words.buffer, words.byteOffset, words.length);
  const i = new Int32Array(words.buffer, words.byteOffset, words.length);
  const w = RAY_WORD;
  return {
    dir: [f[w.dirX], f[w.dirY], f[w.dirZ]],
    hit: words[w.hit] !== 0,
    stopped: words[w.stopped] !== 0,
    block: words[w.block],
    axis: words[w.axis],
    level: words[w.level],
    steps: words[w.steps],
    bricks: words[w.bricks],
    cellVoxels: words[w.cellVoxels],
    world: [i[w.worldX], i[w.worldY], i[w.worldZ]],
    t: f[w.t],
    beam: f[w.beam],
    covered: words[w.covered] !== 0,
    nearDepth: f[w.nearDepth],
    levels: words[w.levels],
  };
}

export function decodeWorldProbe(
  words: Uint32Array,
  origin: readonly [number, number, number],
  step: readonly [number, number, number],
  count: number,
): WorldProbeSample[] {
  const f = new Float32Array(words.buffer, words.byteOffset, words.length);
  const out: WorldProbeSample[] = [];
  for (let s = 0; s < Math.min(count, WORLD_PROBE_SAMPLES); s++) {
    const at = WORLD_PROBE_HEADER + s * 4;
    out.push({
      at: [origin[0] + step[0] * s, origin[1] + step[1] * s, origin[2] + step[2] * s],
      fineSdf: f[at],
      fineBlock: words[at + 1],
      coarseSdf: f[at + 2],
      coarseBlock: words[at + 3],
    });
  }
  return out;
}
