# Plan: foundation

> Status: mostly done. All six phases landed and every box is ticked. Still open:
> Safari, Firefox on Windows, and Android touch checks (deferred for hardware) and the
> sporadic-stall investigation (phase 6). Apple silicon is no longer among them: an M3
> was measured over the tailnet, and what it says about per-pass timings is in
> [gotchas.md](gotchas.md) "GPU pass timings do not mean the same thing on an Apple GPU".
> Promote to `architecture-*` once those close. First plan in the build order; every
> later plan depends on the device setup, frame loop, instrumentation, worker pool,
> and bench harness built here.

## Goal

A running WebGPU page with a camera, per-frame instrumentation, a worker pool, and a
repeatable benchmark harness, before any voxel code. Measurement comes first because
the project's whole claim is speed: every later phase is verified against numbers
this harness produces.

## Current state

Scaffold (`deno.json`, `build.ts`, `serve.ts`, `index.html`), GPU startup
(`src/gpu/`), debug overlay and stats (`src/debug/`), frame loop and fly camera
(`src/main.ts`, `src/camera/`), a renderer drawing sky, debug grid, and axis gizmo
(`src/render/`), GPU timing (`src/gpu/timer.ts`), the worker pool
(`src/workers/`), and the benchmark harness (`src/bench/`, `bench/results/`).

## Approach

- **Deno + TypeScript, esbuild for the browser bundle.** A `build.ts` script calls
  esbuild (via `npm:esbuild` in Deno) with separate entry points for the main bundle
  and each worker. WGSL files load as text.
- **Own dev server.** A small `Deno.serve` static server that always sends
  COOP/COEP headers, so `SharedArrayBuffer` works in development
  ([gotchas.md](gotchas.md) "SharedArrayBuffer needs cross-origin isolation").
- **No runtime dependencies.** Math helpers, noise, and GPU helpers are in-repo.
  The frame path must be allocation-free, which is easier to guarantee in code we own.
  `@webgpu/types` is a dev-only type dependency if Deno's built-in WebGPU types don't
  match the browser API closely enough.
- **Camera as integer chunk plus float64 offset.** Established here so no later code
  ever holds an absolute f32 world position.
- **Caps object.** One startup probe records adapter info, granted features, and
  granted limits; all later code reads `caps`.

Alternative considered: Vite with npm. Rejected for toolchain consistency with Deno
and because the dev server needs custom headers either way.

## Testing methodology

- **Unit tests** (`deno test`): pure logic (math helpers, job queue ordering, ring
  buffers, percentile computation). GPU compute tests arrived later
  (plan-sdf-generation phase 2) and run on Deno's built-in WebGPU, skipping when no
  adapter exists.
- **Kernel benchmarks** (`deno bench`): V8 is the same engine as Chrome, so kernel
  timings in Deno are representative of worker timings in Chrome.
- **Browser bench scenes**: a URL parameter selects a deterministic scene (seed plus
  scripted camera path). The run collects frame-time percentiles and counters and
  prints one JSON object. Results are saved to
  `bench/results/<scene>.<UTC timestamp>.<browser>.json` (dated on purpose, so runs
  accumulate as history; the browser tag separates devices). `bench/` is gitignored, so
  that history is local to the machine that made it: a claim names a file as a pointer
  and carries the numbers themselves.
- **Manual checks**: Chrome DevTools allocation timeline for the zero-allocation
  invariant; overlay values sanity-checked by eye.

## Phases

### Phase 1: scaffold

- [x] `deno.json` with tasks `dev`, `build`, `serve`, `check`, `test`, `bench`
- [x] `build.ts`: esbuild bundle, worker entry points, WGSL text loader, watch mode
- [x] `serve.ts`: static server with COOP/COEP headers, serves `dist/`
- [x] `index.html` with a full-window canvas and a clear message when WebGPU is
      unavailable
- [x] Source layout per the CLAUDE.md Layout table (directories are created by the
      phase that first puts a file in them)

**Verify:** `deno task dev` serves the page; `crossOriginIsolated` is `true` in the
console; `deno task build` produces a bundle with no warnings.

Result: `deno check` clean; release build clean with no warnings; `curl` against
`serve.ts --dev` shows COOP, COEP, and CORP headers on every response and 404 for
missing and `..` paths. Later phases exercised the rest: `isolated yes` in Chrome
and Firefox, `.wgsl` imports from phase 2, the worker entry from phase 5.

### Phase 2: device and caps

- [x] `requestAdapter({ powerPreference: "high-performance" })` at the core feature
      level (compatibility mode can't run vertex pulling), then `requestDevice`
      with every wanted optional feature the adapter has and raised limits from
      `adapter.limits` ([gotchas.md](gotchas.md) "Default limits are low")
- [x] Unsupported page: no `navigator.gpu`, no adapter, or limits below the
      engine's minimum each get a specific message naming supported browsers
- [x] `src/gpu/caps.ts`: freeze adapter info, features, and granted limits into `Caps`
- [x] Canvas context configured with the preferred format
- [x] Error plumbing: `onuncapturederror`, `getCompilationInfo()` messages with the
      source line and a caret, `create*PipelineAsync` rejections, all shown in the
      overlay (`src/debug/overlay.ts`, F2 toggles it)
- [x] `device.lost` handler that recreates the device and rebuilds GPU resources
      (throttled: three losses in 30 s stop the retries and show a message)
- [x] Minimal GPU helpers: `compileShader()` (multi-source, errors mapped back to
      the source file and line) and `createRenderPipeline()` in `src/gpu/shader.ts`;
      the explicit "frame" bind group layout in `Renderer`. Buffers and textures are
      created directly with labels; a wrapper added nothing. A pipeline cache was
      dropped until pipelines have variants to cache.

A sky gradient pass (`src/render/sky.wgsl`, drawn by `Renderer`) exercises the whole
path: WGSL import, compile diagnostics, explicit pipeline layout, per-frame
descriptor reuse.

**Verify:** overlay prints the caps report in every target browser
([research-webgpu-support.md](research-webgpu-support.md) "Verdict"), including a
run with default limits only. A deliberately broken shader shows a readable error.
Calling `voxler.gpu.device.destroy()` from the console triggers a clean rebuild.

Result: `deno check` and the release build are clean. Caps report confirmed in
Chrome 152 and Firefox 154 on Linux and Chrome 152 on Android (values in
[research-webgpu-support.md](research-webgpu-support.md) "Observed devices"). The
broken-shader message, `device.destroy()` recovery, and a `?defaultLimits` run work.
Deferred until the hardware is at hand: Safari, Firefox on Windows.

### Phase 3: frame loop, camera, input

- [x] `requestAnimationFrame` loop with separate update and render steps (`frame()`
      in `src/main.ts`; dt clamped so a hidden tab doesn't jump the camera)
- [x] Fly camera (`src/camera/controls.ts`): drag to look with mouse or touch
      (pointer lock was tried first and removed: it trapped the cursor and blocked
      selecting overlay text), WASD along the view, Space/C world up/down, Shift
      sprint, wheel to fly forward and back, +/- for speed
- [x] Camera state as chunk coordinate plus float64 offset (`FlyCamera` in
      `src/camera/camera.ts`); view matrix in render space; reversed-Z infinite
      projection with `depth32float` (`src/util/mat4.ts`)
- [x] Float64 matrix math copied into one preallocated uniform `ArrayBuffer`, written
      once per frame (`CameraUniform`); reused render pass descriptors
- [x] Debug geometry: grid on world y = 0 built from integer chunk offsets in the
      vertex shader, world X/Z axes highlighted (`grid.wgsl`); corner axis gizmo
      (`gizmo.wgsl`); sky now follows the view direction
- [x] `?at=x,y,z` URL switch and `voxler.camera.setPosition()` for teleporting

**Verify:** fly to coordinates around one million on each axis and confirm the test
grid does not jitter. Allocation timeline is flat over ten seconds of flight.

Result: `deno check` and the release build are clean; shaders and pipelines also
validate under Deno's built-in WebGPU (wgpu/naga). In Chrome on Linux: no grid
jitter at `?at=1000000,10,1000000`, and a flat allocation timeline during flight.
Not yet checked: touch look on Android (skipped for now). Unit tests for `mat4` and
`FlyCamera` pass (`deno task test`).

### Phase 4: instrumentation

- [x] CPU section timers (`performance.now`) into fixed-size ring buffers
      (`Stats` in `src/debug/stats.ts`; sections frame, update, render;
      `RingBuffer` in `src/util/ring.ts`)
- [x] GPU pass timers via `timestamp-query` when granted, resolved into a ring of
      four readback buffers and read frames later; degrade to CPU-only (`GpuTimer`
      in `src/gpu/timer.ts`; one timed pass, "main")
- [x] Counters: visible clusters, quads drawn, upload bytes, worker queue depth,
      jobs completed. They landed with the systems that produce them, as planned:
      `FrameCounters` (draws, upload bytes) filled by `Renderer` here; the worker pool
      line (queued, running, done per second, dropped, failed, busy %) in phase 5; the
      cull results (tested, drawn, by face, by frustum, hidden, empty) in
      plan-rendering, read back through `CounterReadback` (`src/gpu/counters.ts`), which
      is the generalization of the timestamp ring this item asked for. The on-screen
      panel carries a one-line version of the same thing for a reader who is not
      debugging: resident chunks and the voxels they stand for, quads, clusters drawn
      against clusters live, far-field bricks (`describeCounts()` in `src/main.ts`),
      built on the panel's own quarter-second tick and never in the frame path.
- [x] Overlay as a DOM element updated a few times per second, not every frame;
      skipped entirely while the overlay is hidden
- [x] p50/p95/p99 over a sliding window (`summarize()` in `src/util/percentile.ts`)
      for frame interval, each CPU section, and each GPU pass. Intervals over 1 s
      (hidden tab, debugger) are kept out of the window.

**Verify:** overlay values move as expected when the scene changes. Toggling the
overlay does not change frame time beyond noise.

Result: `deno check` and the release build are clean. `GpuTimer` exercised against
Deno's WebGPU: 12 frames produced 12 samples with no validation errors. In Chrome on
Linux the stats respond to scene changes and hiding the overlay (F2) leaves the
frame interval unchanged. Ring and percentile unit tests pass.

### Phase 5: worker pool and job system

- [x] Pool of module workers sized from `navigator.hardwareConcurrency` minus one
      (`?workers=n` overrides); `WorkerPool` in `src/workers/pool.ts`, one generic
      worker `src/workers/voxel.worker.ts` running handlers from `jobs.ts`
- [x] Job queue with priorities (`PriorityQueue` in `queue.ts`: remove and
      re-prioritize in O(log n)), cancellation, and per-(kind, key) versions so only
      the latest version of a key is delivered. Queued jobs stay on the main thread
      (one job per worker in flight) so they remain cancellable.
- [x] Transfer lists for all buffers; worker-side `BufferPool` (power-of-two size
      classes) refilled by `WorkerPool.recycle()`; dropped results recycle their
      buffers automatically
- [x] `SharedArrayBuffer` path when `canShareMemory()`, copy path otherwise
      (`allocShared()` in `buffers.ts`); the job API is the same either way

**Verify:** a synthetic job (sum a large typed array) saturates all workers.
Cancelled jobs never deliver results. Both SAB and copy paths pass the same test.

The self-test (`src/workers/selftest.ts`) implements this verify step; it runs in
the browser with `?workerTest` and under `deno task test` (`pool_test.ts`).

Result: `deno check` and the release build are clean (first real worker entry:
`dist/workers/voxel.worker.js`). `?workerTest` in Chrome 152 on Linux, 15 workers,
cross-origin isolated: shared path 150/150 results, 0 idle workers, 91%
utilization; copy path 150/150, 0 idle, 86%; cancellation leaked 0 of 30; stale
versions delivered only the latest. Deno with 4 workers gave the same pattern
(89-93%). Frame interval stayed at the 120 Hz vsync during the run. Queue and
buffer unit tests pass, and `pool_test.ts` runs the self-test under `deno task test`.

Known limitation: with idle workers, several versions of one key can run at once
on different workers (only the latest is delivered). Wasted work, not wrong
results; revisit if meshing under rapid edits shows it.

### Phase 6: bench harness and baseline

- [x] Scene registry: `?bench=<name>` loads a seed and a scripted camera path
      (`SCENES` in `src/bench/scenes.ts`; poses are pure functions of normalized
      time, so every run renders the same path at any frame rate)
- [x] Paths: straight flyover at sprint speed, 360-degree spin in place, teleport
      stress (8 seeded jumps within 50k voxels)
- [x] Run collects percentiles and counters, prints JSON, stops the loop
      (`BenchRun` in `runner.ts`, `BenchSession` in `session.ts`). Warm-up is
      rendered but not measured. Renders at 1920x1080 by default (`?size=WxH`
      overrides, and the frame is letterboxed into the window at that size's aspect
      rather than stretched to the window's, so the same run looks the same whatever
      shape the window is). `&runs=n` repeats and reports the p50 spread between runs.
      Results POST to the dev server, which writes
      `bench/results/<scene>.<UTC timestamp>.<browser>.json`. Only the dev build posts:
      `serve.ts --dev` is the one server that answers that route, so `build.ts` defines
      `__BENCH_SAVE__` false for a release build and the fetch in `src/bench/save.ts` is
      compiled out with it. A run off the published site still measures and reports; the
      JSON stays in the console.
- [x] Record the empty-scene baseline and revise the performance targets in CLAUDE.md
      if the hardware tiers there are wrong (dev-machine row added; see below)

**Verify:** two runs of the same scene on the same machine agree on p50 within a few
percent. Baseline recorded in `bench/results/`.

How to read results: the frame interval is capped by vsync, so on a fast machine
its p50 is just the display refresh; missed frames (intervals over 1.5 x the
median) show hitches. CPU and GPU times are the actual cost and are what to compare
between runs and changes.

Result: baseline in `bench/results/*.20260911T09*.chrome-152-on-linux.json` (Chrome
152, Intel Arc B390, 1920x1080, 120 Hz display, isolated, timestamps on). Empty
scene (sky, grid, gizmo):

| Scene      | CPU frame p50 / p99      | GPU main p50 / p99 | Missed frames |
| ---------- | ------------------------ | ------------------ | ------------- |
| spin x2    | 0.14 / 0.32, 0.12 / 0.30 | 0.26 / 0.27 (both) | 2, 2          |
| flyover x2 | 0.12 / 0.30, 0.13 / 0.32 | 0.25 / 0.26 (both) | 0, 3          |
| teleport   | 0.12 / 0.33              | 0.25 / 0.28        | 0             |

Verify outcome: GPU p50 identical across repeated runs; CPU p50 differed by 8-20%
but only 10-25 µs (2-5 ticks of the 5 µs timer). The spread check now passes a
metric within 5% or within 0.05 ms (`spreadOk()` in `runner.ts`), which these runs
meet.

Open: sporadic stalls, 0-3 per run, 60-75 ms each. CPU frame time stays normal
through them except one 4.5 ms `render` (consistent with blocking in
`getCurrentTexture()` on a stalled swap chain). Inferred to be outside the engine
(compositor or GPU process on Wayland); confirm with a Chrome performance trace
before any work goes into it.

## Open questions

- **Automated browser runs.** Headless Chrome with WebGPU would let bench scenes run
  from a `deno task`. Options: `jsr:@astral/astral` or Playwright. Both add a
  dependency the user must approve and fetch, and headless WebGPU may need flags.
- **Render in a worker via OffscreenCanvas.** Frees the main thread entirely.
  Decide after phase 6 shows how much main-thread time the render path costs.
- **Deployment host.** If the target host can't set COOP/COEP, a service-worker shim
  is needed before `SharedArrayBuffer` can be relied on in production.
