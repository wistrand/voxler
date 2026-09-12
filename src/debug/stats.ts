// Frame statistics: frame-interval and CPU section timings in fixed-size rings,
// plus formatting for the overlay. Recording (push, begin, end) is allocation-free
// and runs every frame; format() allocates and runs only at overlay rate.

import type { GpuTimer } from "../gpu/timer.ts";
import { newSummary, summarize, type Summary } from "../util/percentile.ts";
import { RingBuffer } from "../util/ring.ts";

export const STATS_WINDOW = 240; // samples per ring, about 4 s at 60 fps

// CPU sections, indices into Stats.cpu.
export const CPU_FRAME = 0;
export const CPU_UPDATE = 1;
export const CPU_RENDER = 2;
const CPU_NAMES = ["frame", "update", "render"] as const;

// Per-frame counts reported by the renderer. Later plans add clusters, quads,
// worker queue depth, and jobs completed here.
export interface FrameCounters {
  draws: number;
  uploadBytes: number;
}

// Cumulative worker pool numbers (WorkerPool satisfies this). Rates are derived
// from the change between two format() calls.
export interface PoolCounters {
  readonly size: number;
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly dropped: number;
  readonly failed: number;
  readonly busyMs: number;
}

export class Stats {
  readonly frameInterval = new RingBuffer(STATS_WINDOW); // ms between rAF callbacks
  readonly cpu: readonly RingBuffer[] = CPU_NAMES.map(() => new RingBuffer(STATS_WINDOW));
  private readonly starts = new Float64Array(CPU_NAMES.length);
  private readonly scratch = new Float64Array(STATS_WINDOW);
  private readonly summary: Summary = newSummary();
  private lastFormatTime = -1;
  private lastCompleted = 0;
  private lastBusyMs = 0;

  begin(section: number): void {
    this.starts[section] = performance.now();
  }

  end(section: number): void {
    this.cpu[section].push(performance.now() - this.starts[section]);
  }

  format(gpu: GpuTimer | null, counters: FrameCounters | null, pool: PoolCounters | null): string {
    const lines = [`${"".padEnd(12)}${"p50".padStart(8)}${"p95".padStart(8)}${"p99".padStart(8)}  ms`];
    const s = summarize(this.frameInterval, this.scratch, this.summary);
    const fps = s.count > 0 ? `  ${(1000 / s.mean).toFixed(1)} fps` : "";
    lines.push(this.row("interval", s) + fps);
    for (let i = 0; i < CPU_NAMES.length; i++) {
      lines.push(this.row(`cpu ${CPU_NAMES[i]}`, summarize(this.cpu[i], this.scratch, this.summary)));
    }
    if (!gpu || !gpu.enabled) {
      lines.push(`gpu         ${gpu ? "timestamp-query not granted" : "no device"}`);
    } else {
      for (let i = 0; i < gpu.passNames.length; i++) {
        lines.push(this.row(`gpu ${gpu.passNames[i]}`, summarize(gpu.rings[i], this.scratch, this.summary)));
      }
    }
    if (counters) {
      lines.push(`draws ${counters.draws}  upload ${counters.uploadBytes} B/frame`);
    }
    if (pool) lines.push(this.poolLine(pool));
    return lines.join("\n");
  }

  private poolLine(pool: PoolCounters): string {
    const now = performance.now();
    const elapsed = this.lastFormatTime < 0 ? 0 : now - this.lastFormatTime;
    const rate = elapsed > 0 ? ((pool.completed - this.lastCompleted) * 1000) / elapsed : 0;
    const busy = elapsed > 0 ? (pool.busyMs - this.lastBusyMs) / (elapsed * pool.size) : 0;
    this.lastFormatTime = now;
    this.lastCompleted = pool.completed;
    this.lastBusyMs = pool.busyMs;
    return `workers ${pool.size}  queued ${pool.queued}  running ${pool.running}  ` +
      `done ${pool.completed} (${rate.toFixed(0)}/s)  dropped ${pool.dropped}  ` +
      `failed ${pool.failed}  busy ${(busy * 100).toFixed(0)}%`;
  }

  private row(name: string, s: Summary): string {
    if (s.count === 0) return `${name.padEnd(12)}${"-".padStart(8)}`;
    return `${name.padEnd(12)}${s.p50.toFixed(2).padStart(8)}${s.p95.toFixed(2).padStart(8)}${
      s.p99.toFixed(2).padStart(8)
    }`;
  }
}
