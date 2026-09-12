// Picks the far field's reach and build budget from what it is actually costing on this
// machine, instead of fixing them in a constant that is right for one GPU
// (plan-far-field.md "How far to reach"). Pure: it takes measured milliseconds and
// returns settings, and knows nothing about WebGPU.
//
// Three knobs, and they are not interchangeable:
//
//   slabsPerFrame   how much of the clipmap is sampled per frame. It changes nothing
//                   about what the far field looks like once it has caught up, only how
//                   long catching up takes, and it costs nothing at all while the queue
//                   is empty. Always the first to go and the first to come back.
//   levels          the clipmap's reach. Eight levels march in 1.44 ms at 1080p where
//                   five march in 0.79, so it is the lever that buys the most GPU time,
//                   and fog is already hiding most of what it buys: at the default
//                   density a surface 6,600 voxels out is nine parts fog to one part
//                   world, and the outer levels reach far past that.
//   scale           the fraction of the frame the march runs at. This is the one a
//                   viewer sees everywhere rather than only at the horizon: below full
//                   resolution a terrace's top face is thinner than the sampling, and
//                   the contour lines across distant terrain break up and double.
//
// So the order down is slabs, then reach, then sharpness, and the order back up is the
// reverse. Reach before sharpness is a judgement about fog: the levels being given up
// are the ones fog has already taken.
//
// The controller is deliberately slow. It decides once a window (a second or so of
// frames), moves one step at a time, and sits out a few windows after changing the level
// count, because a new level rebuilds itself and the burst of build work that follows
// would otherwise read as "still too expensive" and drop it straight back.

export interface AdaptOptions {
  // Fallback budget, used only until the frame has been measured (no `timestamp-query`,
  // or the first window of a run). What the controller normally works to comes from
  // `farBudgetMs()` below.
  budgetMs: number;
  framesPerWindow: number;
  minLevels: number;
  maxLevels: number;
  minSlabs: number;
  maxSlabs: number;
  // March resolutions the controller may pick, ascending. Discrete because changing it
  // rebuilds the march target.
  scales: readonly number[];
  // Slack between what the timed passes add up to and what a frame actually takes:
  // presenting, the main thread, and the fact that passes do not tile a frame exactly.
  reserveMs: number;
  // Floor and ceiling on the derived budget. The floor keeps a far field at all on a
  // machine whose near field has eaten the frame; the ceiling keeps it from taking a
  // whole slow frame just because the rest of that frame was cheap.
  minBudgetMs: number;
  maxBudgetShare: number;
}

export const DEFAULT_ADAPT_OPTIONS: AdaptOptions = {
  budgetMs: 2.8,
  framesPerWindow: 120, // about a second at 120 Hz
  minLevels: 3, // 512 voxels of reach: below this the near field is most of the view
  maxLevels: 8,
  minSlabs: 1,
  maxSlabs: 4,
  scales: [0.5, 0.75, 1.0],
  reserveMs: 1.5,
  minBudgetMs: 0.8,
  maxBudgetShare: 0.5,
};

// Plausible display periods, in ms: 240 Hz to 30 Hz. Anything outside this is a
// measurement to distrust, not a display.
const MIN_REFRESH_MS = 4;
const MAX_REFRESH_MS = 34;

// The display's frame period, from observed intervals between frames. Not their mean or
// median: a run that misses every other vsync has a median of two periods, and reading
// that as "the frames are long, there is room for more" is backwards. Dropped frames
// land on multiples of the period, so the *short* end of the distribution is the period
// itself, and a low percentile finds it without picking up a single jittery outlier.
export function refreshFromIntervals(lowPercentileMs: number): number {
  if (!Number.isFinite(lowPercentileMs)) return NaN;
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, lowPercentileMs));
}

// What is left of a frame for the far field: the display's period, less what every other
// pass costs, less slack. NaN for either measurement means there is nothing to derive
// from and the caller should keep its fallback.
//
// The reference only moves with things the controller does not control. Subtracting the
// far field's own passes as well would make it chase its own tail: shrink the far field,
// the leftover grows, grow it back.
export function farBudgetMs(refreshMs: number, otherGpuMs: number, o: AdaptOptions): number {
  if (!Number.isFinite(refreshMs) || !Number.isFinite(otherGpuMs)) return NaN;
  const left = refreshMs - otherGpuMs - o.reserveMs;
  return Math.min(refreshMs * o.maxBudgetShare, Math.max(o.minBudgetMs, left));
}

export interface AdaptSettings {
  levels: number;
  slabsPerFrame: number;
  scale: number; // fraction of the frame the march runs at
}

// What the controller saw and did in the window that just closed, for the overlay.
export interface AdaptReport {
  windows: number;
  budgetMs: number; // what the window was worked to, derived or the fallback
  marchMs: number; // mean over the window
  buildMs: number; // mean, scaled by how many frames of the window built anything
  buildMaxMs: number; // worst build frame: this is what misses a vsync
  buildDuty: number; // fraction of the window's frames that built anything
  action: string;
}

export class FarAdapt {
  readonly options: AdaptOptions;
  readonly settings: AdaptSettings;
  readonly report: AdaptReport = {
    windows: 0,
    budgetMs: 0,
    marchMs: 0,
    buildMs: 0,
    buildMaxMs: 0,
    buildDuty: 0,
    action: "holding",
  };
  private frames = 0;
  private buildFrames = 0;
  private cooldown = 0;

  // Index into options.scales, so the controller steps between the resolutions it was
  // given rather than inventing one.
  private scaleStep: number;

  constructor(
    levels: number,
    slabsPerFrame: number,
    scale: number,
    options: AdaptOptions = DEFAULT_ADAPT_OPTIONS,
  ) {
    this.options = options;
    this.scaleStep = nearestScale(options.scales, scale);
    this.settings = {
      levels: clamp(levels, options.minLevels, options.maxLevels),
      slabsPerFrame: clamp(slabsPerFrame, options.minSlabs, options.maxSlabs),
      scale: options.scales[this.scaleStep],
    };
  }

  // Call once a frame. Returns true on the frame a window closes and the settings
  // changed, which is the caller's cue to apply them.
  //
  // `marchMs` and `buildMs` are what those passes cost *on the frames they run*, read
  // from the GPU timer's rings, which lag by a few frames. `buildRan` says whether the
  // build ran this frame: a pass is only sampled on the frames it is encoded, so a
  // clipmap that has caught up leaves the build's ring holding its last cost forever,
  // and the controller would keep giving up reach to pay for work that stopped. The duty
  // cycle over the window turns "what it costs when it runs" into "what it costs a
  // frame", which is the number the budget is about.
  //
  // `queued` is how much of the clipmap is still waiting to be sampled: a build that is
  // cheap but never empties its queue is one that should be given more slabs, not fewer.
  // `budgetMs` is what this frame says the far field may have (`farBudgetMs()`); NaN
  // falls back to the option, which is what runs until a frame has been measured.
  frame(
    budgetMs: number,
    marchMs: number,
    buildMs: number,
    buildMaxMs: number,
    queued: number,
    buildRan: boolean,
  ): boolean {
    this.frames++;
    if (buildRan) this.buildFrames++;
    if (this.frames < this.options.framesPerWindow) return false;
    const duty = this.buildFrames / this.frames;
    this.frames = 0;
    this.buildFrames = 0;
    // Nothing built in the whole window: the build costs nothing a frame, whatever its
    // ring still says.
    if (duty === 0) {
      buildMs = 0;
      buildMaxMs = 0;
    } else {
      buildMs *= duty;
    }
    // Timestamps are optional (no `timestamp-query`, or the first windows of a run).
    // With no measurement there is nothing to adapt to, so hold.
    if (!Number.isFinite(marchMs) || !Number.isFinite(buildMs)) {
      this.report.action = "no timings";
      return false;
    }
    this.report.windows++;
    this.report.marchMs = marchMs;
    this.report.buildMs = buildMs;
    this.report.buildMaxMs = buildMaxMs;
    this.report.buildDuty = duty;
    this.report.budgetMs = Number.isFinite(budgetMs) ? budgetMs : this.options.budgetMs;
    if (this.cooldown > 0) {
      this.cooldown--;
      this.report.action = `settling (${this.cooldown + 1})`;
      return false;
    }

    const o = this.options;
    const s = this.settings;
    const total = marchMs + buildMs;
    const budget = Number.isFinite(budgetMs) ? budgetMs : o.budgetMs;

    // A build that spikes past the whole budget in a single frame is what drops a vsync,
    // whatever its mean says. Give it fewer slabs a frame and let it take longer.
    if (buildMaxMs > budget && s.slabsPerFrame > o.minSlabs) {
      s.slabsPerFrame--;
      this.report.action = `slabs ${s.slabsPerFrame} (build spiked to ${buildMaxMs.toFixed(1)} ms)`;
      return true;
    }
    // Over budget on average and the build is already as gentle as it goes: the march is
    // what does not fit, and the march is levels.
    if (total > budget) {
      if (s.slabsPerFrame > o.minSlabs) {
        s.slabsPerFrame--;
        this.report.action = `slabs ${s.slabsPerFrame} (${total.toFixed(1)} ms over ${budget.toFixed(1)})`;
        return true;
      }
      if (s.levels > o.minLevels) {
        s.levels--;
        this.cooldown = SETTLE_WINDOWS;
        this.report.action = `levels ${s.levels} (${total.toFixed(1)} ms over ${budget.toFixed(1)})`;
        return true;
      }
      if (this.scaleStep > 0) {
        this.scaleStep--;
        s.scale = o.scales[this.scaleStep];
        this.report.action = `${(s.scale * 100).toFixed(0)}% resolution (${total.toFixed(1)} ms over ${
          budget.toFixed(1)
        })`;
        return true;
      }
      this.report.action = `over budget at the floor (${total.toFixed(1)} ms)`;
      return false;
    }
    // Room to spare. Take the build budget back first and only then reach further: a
    // slab budget costs nothing while the queue is empty, so restoring it before the
    // camera moves is free, and it is what catches the clipmap up after the next jump.
    // Reach is the opposite: a level costs march time every frame from the moment it
    // exists.
    if (total < budget * HEADROOM) {
      if (s.slabsPerFrame < o.maxSlabs) {
        s.slabsPerFrame++;
        this.report.action = queued > 0
          ? `slabs ${s.slabsPerFrame} (${queued} slabs still queued)`
          : `slabs ${s.slabsPerFrame} (budget back for the next jump)`;
        return true;
      }
      if (this.scaleStep < o.scales.length - 1) {
        this.scaleStep++;
        s.scale = o.scales[this.scaleStep];
        this.report.action = `${(s.scale * 100).toFixed(0)}% resolution (${total.toFixed(1)} ms of ${
          budget.toFixed(1)
        })`;
        return true;
      }
      if (s.levels < o.maxLevels) {
        s.levels++;
        this.cooldown = SETTLE_WINDOWS;
        this.report.action = `levels ${s.levels} (${total.toFixed(1)} ms of ${budget.toFixed(1)})`;
        return true;
      }
    }
    this.report.action = "holding";
    return false;
  }
}

// Windows to sit out after changing the level count, while the new level builds itself.
const SETTLE_WINDOWS = 3;
// Fraction of the budget under which the controller reaches for more. The gap between
// this and 1 is the hysteresis: without it a setting that lands exactly on the budget
// oscillates every window.
const HEADROOM = 0.6;

// Index of the scale closest to `want`, so a `?farScale=` that is not one of the steps
// still starts somewhere sensible.
function nearestScale(scales: readonly number[], want: number): number {
  let best = 0;
  for (let i = 1; i < scales.length; i++) {
    if (Math.abs(scales[i] - want) < Math.abs(scales[best] - want)) best = i;
  }
  return best;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
