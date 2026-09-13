// A `?bench=<scene>&runs=<n>` session: runs the scene n times back to back, builds
// one JSON result per run, logs it, and POSTs it to the dev server, which saves it
// under bench/results/. After the last run the caller stops the frame loop.

import type { FlyCamera } from "../camera/camera.ts";
import type { FrameCounters, PoolCounters } from "../debug/stats.ts";
import type { Caps } from "../gpu/caps.ts";
import type { GpuTimer } from "../gpu/timer.ts";
import {
  BenchRun,
  MAX_ABSOLUTE_SPREAD_MS,
  MAX_RELATIVE_SPREAD,
  p50Spread,
  type RunSummary,
  spreadOk,
} from "./runner.ts";
import { saveBenchResult } from "./save.ts";
import type { Scene } from "./scenes.ts";

// Environment captured when a run ends.
export interface BenchContext {
  world: string;
  streaming: Record<string, number> | null; // streamer stats at the end of the run
  caps: Caps;
  // Milliseconds from page load to the frame the session started on: the world's
  // pipelines, its clipmap and its chunks all have to be there first, or the run
  // measures an empty frame (main.ts `benchReady`).
  readyMs: number;
  counters: FrameCounters;
  pool: PoolCounters;
  width: number;
  height: number;
}

export interface BenchResult extends RunSummary {
  scene: string;
  world: string;
  description: string;
  seed: number;
  run: number;
  runs: number;
  date: string;
  browser: string;
  adapter: string;
  format: string;
  resolution: [number, number];
  devicePixelRatio: number;
  crossOriginIsolated: boolean;
  timestampQuery: boolean;
  workers: number;
  readyMs: number;
  warmupMs: number;
  durationMs: number;
  counters: FrameCounters;
  streaming: Record<string, number> | null;
  url: string;
}

export class BenchSession {
  readonly scene: Scene;
  readonly runs: number;
  private run: BenchRun | null = null;
  private timer: GpuTimer | null = null;
  private readonly results: BenchResult[] = [];
  private readonly saved: string[] = [];
  private readonly onGpuSample = (pass: number, ms: number) => this.run?.recordGpu(pass, ms);
  private readonly onChange: () => void;
  private readonly spawn: readonly [number, number, number];

  constructor(scene: Scene, runs: number, spawn: readonly [number, number, number], onChange: () => void) {
    this.scene = scene;
    this.spawn = spawn;
    this.runs = runs;
    this.onChange = onChange;
  }

  get finished(): boolean {
    return this.results.length === this.runs;
  }

  // Before rendering: sets the camera for this frame.
  drive(now: number, camera: FlyCamera, timer: GpuTimer): void {
    if (this.finished) return;
    if (timer !== this.timer) {
      // First frame, or a new Renderer after device loss.
      if (this.timer) this.timer.onSample = null;
      timer.onSample = this.onGpuSample;
      this.timer = timer;
    }
    if (!this.run) this.run = new BenchRun(this.scene, timer.passNames, this.spawn);
    this.run.drive(now, camera);
  }

  // After rendering. Returns true when the whole session has finished.
  record(
    interval: number,
    cpuFrame: number,
    cpuUpdate: number,
    cpuRender: number,
    holes: number,
    context: () => BenchContext,
  ): boolean {
    const run = this.run;
    if (!run) return this.finished;
    run.record(interval, cpuFrame, cpuUpdate, cpuRender, holes);
    if (!run.finished) return false;

    const result = this.buildResult(run.summarize(), context());
    this.results.push(result);
    this.saved.push("saving...");
    console.info(`bench result ${result.scene} run ${result.run}/${result.runs}`, JSON.stringify(result));
    this.save(result, this.saved.length - 1);
    this.run = null;
    if (this.finished && this.timer) this.timer.onSample = null;
    this.onChange();
    return this.finished;
  }

  status(): string {
    const lines = [`bench ${this.scene.name} (${this.scene.description})`];
    if (this.run) {
      const phase = this.run.measuring ? `measuring ${(this.run.progress * 100).toFixed(0)}%` : "warm-up";
      lines.push(`run ${this.results.length + 1}/${this.runs}: ${phase}`);
    }
    if (this.results.length > 0) {
      // A near-field draw when one ran, else the first timed pass that ran (passes
      // not encoded have no samples). The rest are in the saved JSON.
      const metrics = this.results[0].metrics;
      const ran = (k: string) => (metrics[k]?.count ?? 0) > 0;
      const gpuName = ["gpu.near.a", "gpu.near"].find(ran) ??
        Object.keys(metrics).find((k) => k.startsWith("gpu.") && ran(k));
      lines.push(
        `run  interval p50   cpu frame p50/p99   ${gpuName ? `${gpuName} p50/p99   ` : ""}missed  holes p99/max  saved`,
      );
      this.results.forEach((r, i) => {
        const m = r.metrics;
        const cpu = `${m["cpu.frame"].p50.toFixed(3)} / ${m["cpu.frame"].p99.toFixed(3)}`;
        const gpu = gpuName ? `${m[gpuName].p50.toFixed(3)} / ${m[gpuName].p99.toFixed(3)}`.padEnd(21) : "";
        const holes = m["stream.holes"] ? `${m["stream.holes"].p99} / ${m["stream.holes"].max}` : "-";
        lines.push(
          `${String(r.run).padEnd(5)}${m.interval.p50.toFixed(3).padEnd(15)}${cpu.padEnd(20)}${gpu}` +
            `${String(r.missedFrames).padEnd(8)}${holes.padEnd(15)}${this.saved[i]}`,
        );
      });
    }
    if (this.finished && this.runs > 1) {
      const spread = Object.entries(p50Spread(this.results));
      lines.push("p50 spread across runs:");
      for (const [name, s] of spread) {
        lines.push(
          `  ${name.padEnd(12)}${(s.relative * 100).toFixed(1).padStart(6)}%  ${s.absolute.toFixed(3)} ms` +
            `  ${spreadOk(s) ? "ok" : "differs"}`,
        );
      }
      const bad = spread.filter(([, s]) => !spreadOk(s)).length;
      lines.push(
        bad === 0
          ? `runs agree (each metric within ${MAX_RELATIVE_SPREAD * 100}% or ${MAX_ABSOLUTE_SPREAD_MS} ms)`
          : `${bad} metric(s) differ between runs`,
      );
    }
    if (this.finished) lines.push("done; the frame loop has stopped. Reload to run again.");
    return lines.join("\n");
  }

  private buildResult(summary: RunSummary, ctx: BenchContext): BenchResult {
    const scene = this.scene;
    return {
      scene: scene.name,
      world: ctx.world,
      description: scene.description,
      seed: scene.seed,
      run: this.results.length + 1,
      runs: this.runs,
      date: new Date().toISOString(),
      browser: ctx.caps.browser,
      adapter: ctx.caps.adapter,
      format: ctx.caps.format,
      resolution: [ctx.width, ctx.height],
      devicePixelRatio: devicePixelRatio,
      crossOriginIsolated: ctx.caps.crossOriginIsolated,
      timestampQuery: ctx.caps.timestampQuery,
      workers: ctx.pool.size,
      readyMs: ctx.readyMs,
      warmupMs: scene.warmupMs,
      durationMs: scene.durationMs,
      counters: { ...ctx.counters },
      streaming: ctx.streaming,
      url: location.search,
      ...summary,
    };
  }

  private async save(result: BenchResult, index: number): Promise<void> {
    this.saved[index] = await saveBenchResult(result);
    this.onChange();
  }
}
