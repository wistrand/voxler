// `?voxelBench` (plan-sdf-generation phase 2): voxelizes a fixed box of chunks
// around the spawn point as fast as the readback slots allow, then reports and
// saves throughput as bench scene "voxelize-<world>". The preview is turned off by
// the caller so the voxelizer has the GPU to itself.

import type { Caps } from "../gpu/caps.ts";
import type { Voxelizer } from "../sdf/voxelizer.ts";
import { CHUNK_SHIFT } from "../world/coords.ts";
import type { WorldProgram } from "../worlds/index.ts";
import { saveBenchResult } from "./save.ts";

const RADIUS = 12; // chunks each side horizontally: 25 x 25 columns
const BELOW = 3; // chunks below the spawn chunk
const ABOVE = 4; // chunks above it

export class VoxelBench {
  private readonly voxelizer: Voxelizer;
  private readonly world: WorldProgram;
  private startMs = 0;
  private endMs = 0;
  private total = 0;
  private status = "starting";
  private saved = "";
  finished = false;

  constructor(voxelizer: Voxelizer, world: WorldProgram) {
    this.voxelizer = voxelizer;
    this.world = world;
    const [x, y, z] = world.spawn.map((v) => Math.floor(v) >> CHUNK_SHIFT);
    for (let cy = y - BELOW; cy <= y + ABOVE; cy++) {
      for (let cz = z - RADIUS; cz <= z + RADIUS; cz++) {
        for (let cx = x - RADIUS; cx <= x + RADIUS; cx++) voxelizer.queueChunk(cx, cy, cz);
      }
    }
    this.total = voxelizer.stats.queued;
    voxelizer.onResult = (r) => {
      if (r.ids) voxelizer.recycle(r.ids);
    };
    this.startMs = performance.now();
  }

  // Once per frame, after the voxelizer was pumped.
  update(caps: Caps, slots: number): void {
    if (this.finished) return;
    const s = this.voxelizer.stats;
    if (!this.voxelizer.idle) {
      this.status = `${s.chunks}/${this.total} chunks`;
      return;
    }
    this.endMs = performance.now();
    this.finished = true;
    const seconds = (this.endMs - this.startMs) / 1000;
    const result = {
      scene: `voxelize-${this.world.name}`,
      world: this.world.name,
      seed: this.world.seed,
      date: new Date().toISOString(),
      browser: caps.browser,
      adapter: caps.adapter,
      chunks: s.chunks,
      air: s.air,
      uniform: s.uniform,
      dense: s.dense,
      batches: s.batches,
      readbackSlots: slots,
      seconds: Math.round(seconds * 1000) / 1000,
      chunksPerSecond: Math.round(s.chunks / seconds),
      mappedMiB: Math.round((s.mappedBytes / 1048576) * 10) / 10,
      lastBatchLatencyMs: Math.round(s.latencyMs * 10) / 10,
      url: location.search,
    };
    console.info("voxel bench", JSON.stringify(result));
    this.status = `${result.chunks} chunks in ${result.seconds} s = ${result.chunksPerSecond} chunks/s ` +
      `(air ${s.air}, uniform ${s.uniform}, dense ${s.dense}), ${result.mappedMiB} MiB mapped, ${slots} slots`;
    this.saved = "saving...";
    saveBenchResult(result).then((path) => (this.saved = path));
  }

  text(): string {
    return `voxel bench (${this.world.name}): ${this.status}${this.saved ? `\n${this.saved}` : ""}`;
  }
}
