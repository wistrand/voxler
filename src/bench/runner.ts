// One benchmark run: drives the camera along a scene's path and records per-frame
// samples into rings sized for the whole run. drive() and record() are called
// every frame and allocate nothing; summarize() runs once at the end.
// No DOM or GPU access.

import type { FlyCamera } from "../camera/camera.ts";
import { newSummary, summarize, type Summary } from "../util/percentile.ts";
import { RingBuffer } from "../util/ring.ts";
import type { Pose, Scene } from "./scenes.ts";

const MAX_FPS = 240; // sizes the rings; faster displays drop the oldest samples
const MISSED_FRAME_FACTOR = 1.5; // an interval over 1.5 x the median counts as missed

export interface MetricSummary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface RunSummary {
  frames: number;
  missedFrames: number;
  metrics: Record<string, MetricSummary>; // ms
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function toMetric(s: Summary): MetricSummary {
  return {
    count: s.count,
    mean: round3(s.mean),
    p50: round3(s.p50),
    p95: round3(s.p95),
    p99: round3(s.p99),
    max: round3(s.max),
  };
}

export class BenchRun {
  readonly scene: Scene;
  measuring = false;
  finished = false;
  private start = -1;
  private measuredMs = 0; // ms since the end of warm-up; negative during warm-up
  private readonly pose: Pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  private readonly spawn: readonly [number, number, number];
  private readonly holes: RingBuffer;
  private readonly interval: RingBuffer;
  private readonly cpuFrame: RingBuffer;
  private readonly cpuUpdate: RingBuffer;
  private readonly cpuRender: RingBuffer;
  private readonly gpuPassNames: readonly string[];
  private readonly gpu: RingBuffer[];

  // `spawn`: world position the scene's pose offsets are relative to.
  constructor(scene: Scene, gpuPassNames: readonly string[], spawn: readonly [number, number, number]) {
    this.scene = scene;
    this.spawn = spawn;
    this.gpuPassNames = gpuPassNames;
    const capacity = Math.ceil((scene.durationMs / 1000) * MAX_FPS) + 16;
    this.interval = new RingBuffer(capacity);
    this.cpuFrame = new RingBuffer(capacity);
    this.cpuUpdate = new RingBuffer(capacity);
    this.cpuRender = new RingBuffer(capacity);
    this.gpu = gpuPassNames.map(() => new RingBuffer(capacity));
    this.holes = new RingBuffer(capacity);
  }

  // Fraction of the measured part completed, for progress display.
  get progress(): number {
    return this.measuring || this.finished ? Math.min(1, this.measuredMs / this.scene.durationMs) : 0;
  }

  // Sets the camera for this frame. Call before rendering; `now` is the rAF time.
  drive(now: number, camera: FlyCamera): void {
    if (this.start < 0) this.start = now;
    const scene = this.scene;
    const elapsed = now - this.start;
    this.measuredMs = elapsed - scene.warmupMs;
    this.measuring = elapsed >= scene.warmupMs && this.measuredMs < scene.durationMs;
    this.finished = this.measuredMs >= scene.durationMs;
    const t = Math.min(1, Math.max(0, this.measuredMs / scene.durationMs));
    scene.pose(t, this.pose);
    camera.setPosition(this.spawn[0] + this.pose.x, this.spawn[1] + this.pose.y, this.spawn[2] + this.pose.z);
    camera.setOrientation(this.pose.yaw, this.pose.pitch);
  }

  // Frame samples in ms, plus the streamer's hole count. Ignored outside the
  // measured window.
  record(interval: number, cpuFrame: number, cpuUpdate: number, cpuRender: number, holes: number): void {
    if (!this.measuring) return;
    this.holes.push(holes);
    this.interval.push(interval);
    this.cpuFrame.push(cpuFrame);
    this.cpuUpdate.push(cpuUpdate);
    this.cpuRender.push(cpuRender);
  }

  // GPU pass samples arrive frames late (GpuTimer readback), so the window is
  // approximate by a few frames at each end.
  recordGpu(pass: number, ms: number): void {
    if (this.measuring) this.gpu[pass].push(ms);
  }

  summarize(): RunSummary {
    const capacity = this.interval.capacity;
    const scratch = new Float64Array(capacity);
    const s = newSummary();
    const metrics: Record<string, MetricSummary> = {
      interval: toMetric(summarize(this.interval, scratch, s)),
      "cpu.frame": toMetric(summarize(this.cpuFrame, scratch, s)),
      "cpu.update": toMetric(summarize(this.cpuUpdate, scratch, s)),
      "cpu.render": toMetric(summarize(this.cpuRender, scratch, s)),
    };
    for (let i = 0; i < this.gpuPassNames.length; i++) {
      metrics[`gpu.${this.gpuPassNames[i]}`] = toMetric(summarize(this.gpu[i], scratch, s));
    }
    // Not milliseconds: chunks missing near the camera, per frame (0 = streaming kept up).
    metrics["stream.holes"] = toMetric(summarize(this.holes, scratch, s));
    const n = this.interval.copyTo(scratch);
    const limit = metrics.interval.p50 * MISSED_FRAME_FACTOR;
    let missed = 0;
    for (let i = 0; i < n; i++) if (scratch[i] > limit) missed++;
    return { frames: n, missedFrames: missed, metrics };
  }
}

export interface Spread {
  relative: number; // (max - min) / mean of p50 across runs
  absolute: number; // max - min of p50 across runs, ms
}

// Runs agree on a metric when its p50 spread is within MAX_RELATIVE_SPREAD, or
// within MAX_ABSOLUTE_SPREAD_MS for values so small that timer ticks dominate
// (measured: CPU p50s near 0.12 ms differ by 2-5 ticks of the 5 µs timer, 8-20%).
export const MAX_RELATIVE_SPREAD = 0.05;
export const MAX_ABSOLUTE_SPREAD_MS = 0.05;

export function spreadOk(s: Spread): boolean {
  return s.relative <= MAX_RELATIVE_SPREAD || s.absolute <= MAX_ABSOLUTE_SPREAD_MS;
}

// Spread of p50 across runs, per metric.
export function p50Spread(runs: readonly RunSummary[]): Record<string, Spread> {
  const out: Record<string, Spread> = {};
  if (runs.length < 2) return out;
  for (const name of Object.keys(runs[0].metrics)) {
    const values = runs.map((r) => r.metrics[name]?.p50 ?? NaN).filter(Number.isFinite);
    if (values.length < 2) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const absolute = Math.max(...values) - Math.min(...values);
    out[name] = { relative: mean > 0 ? round3(absolute / mean) : 0, absolute: round3(absolute) };
  }
  return out;
}
