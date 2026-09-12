# Gotchas and findings

Skim before touching workers, GPU uploads, WGSL, or anything in the frame loop.

The traps below were seeded from known platform behavior before any code existed.
Items marked **(unverified)** need confirming on real browsers; when confirmed or
disproved, drop the marker or correct the entry. Append new traps as they are hit.

## Contents
- JavaScript traps
- Worker and memory traps
- WebGPU API traps
- WGSL traps
- Rendering artifacts
- Findings

## JavaScript traps

- **Bitwise ops are int32.** `1 << 31` is negative and `x >> 1` sign-extends. Use
  `>>>` for column shifts and `x >>> 0` when a result must read as unsigned. Trailing
  zero count is `31 - Math.clz32(x & -x)`; there is no `ctz` builtin.
- **BigInt is not a 64-bit integer type for hot code.** Every op allocates or goes
  through a slow path. Never use BigInt in meshing, generation, or traversal. This is
  one reason chunks are 32 wide.
- **Shifts truncate to int32.** `world >> 5` is correct for chunk coordinates
  within int32. Never apply `|0` or shifts to values that can exceed that range
  (float64 camera offsets, accumulated time).
- **Per-frame allocation causes GC spikes.** Array literals, object literals,
  closures passed to `forEach`/`sort`, spread, and template strings in the frame path
  all allocate. WebGPU descriptors are objects too: build render pass descriptors,
  bind groups, and command-encoder descriptors once and reuse them; only swap the
  canvas texture view per frame. Some allocation is inherent to the API and
  accepted: `getCurrentTexture()`, `createView()`, `createCommandEncoder()`,
  `beginRenderPass()`, and `finish()` each return a new object every frame.
- **Bundled module-level `const` reads as `undefined` before its line.** esbuild
  emits top-level `const` as `var`, so a function called at module level before a
  later `const` is initialized sees `undefined` (a `TypeError` far from the cause)
  instead of a "before initialization" error; `deno check` doesn't catch it. In
  `src/main.ts`, declare a value above every module-level call that reads it
  (`world` before `benchSession()` was the first instance).
- **LCG low bits make bad test data.** `lcg() % n` cycles through far fewer than
  n values because an LCG's low bits have short periods; a chunk test expecting 300
  distinct ids got at most 256. Use `hash32()`/`random01()` (`src/util/random.ts`)
  or take high bits (`(r >>> 16) % n`) for test data.
- **`Map` with non-integer keys is slow at chunk scale.** Chunk lookup uses the
  numeric chunk key in a typed-array hash table
  ([design-formats.md](design-formats.md) "Coordinate spaces").

## Worker and memory traps

- **SharedArrayBuffer needs cross-origin isolation.** The page must be served with
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Check `crossOriginIsolated` at
  startup. Static hosts without header control (GitHub Pages) need a service-worker
  shim that injects the headers.
- **`postMessage` copies unless you transfer.** Always pass the transfer list for
  mesh output and job buffers. A transferred buffer is detached on the sender
  (`byteLength` 0); reuse from a pool only after it comes back.
- **Workers need their own bundle entry.** esbuild doesn't rewrite
  `new Worker(new URL(...))`, so the URL must name the built file
  (`./workers/<name>.worker.js`, relative to `dist/main.js`), not the `.ts` source.
  A new worker file is picked up by `deno task dev` only after a restart.
- **esbuild 0.25 rejects `with { type: "text" }`.** `deno check` needs the import
  attribute on `.wgsl` imports; esbuild errors on it unless a plugin loads the file.
  The `wgslText` plugin in `build.ts` does that; keep it when upgrading esbuild until
  a native text attribute is confirmed. Deno 2.9 runs these imports without any
  flag (checked), so `deno test` can import modules that import `.wgsl`; GPU tests
  (`src/sdf/voxelizer_test.ts`) run on Deno's built-in WebGPU, also flag-free.
- **The DOM lib lags WebGPU.** TypeScript 6.0's DOM lib (bundled with Deno 2.9)
  lacks the `GPUBufferUsage`/`GPUTextureUsage`/`GPUShaderStage`/`GPUMapMode`
  namespaces, doesn't list `"webgpu"` in `getContext` overloads, and doesn't type
  `featureLevel`. `src/gpu/globals.ts` declares the namespaces; `device.ts` casts
  the context. Drop both when the lib catches up.
- **Timer resolution depends on isolation.** Browsers coarsen `performance.now()`:
  about 5 µs in a cross-origin isolated page, 100 µs otherwise (known browser
  behavior, not measured here). CPU section times of a fraction of a millisecond
  are only meaningful with the COOP/COEP headers on; check `isolated yes` in the
  overlay before trusting them.
- **Worker kernels run slow until V8 tiers them up.** Measured in Deno: the first
  timed batch of a sum kernel ran about twice as slow as later batches after a light
  warm-up, and matched them once the warm-up did full per-job work. Benchmarks and
  self-tests must warm up with real work; a first-frames stutter in streaming may
  be the same effect.
- **Deno differs from the browser for workers.** Deno has no `crossOriginIsolated`
  global but always allows sharing `SharedArrayBuffer`; use `canShareMemory()`
  (`src/workers/buffers.ts`), never the global. Deno workers need `--allow-read` for
  their module (the test task grants `--allow-read=src`).
- **Halving an odd Hi-Z level drops its last row.** A mip chain rounds sizes down
  (90 -> 45 -> 22), so a 2x2 reduction leaves the source's last row or column out
  of every destination texel and its depth disappears from every level above. The
  upper levels then claim a coverage they do not have, and the occlusion test culls
  geometry that is visible: in a 40-frame test this showed as a few dozen missing
  pixels along the bottom edge, only in frames where a cluster's screen rectangle
  reached the top levels. `reduce_depth`/`reduce_level` in `hiz.wgsl` take 3
  samples along any axis whose source size is odd. `hiz_test.ts` guards it, but
  only because its depth pattern varies per pixel: an earlier pattern that was
  constant along y passed with the bug in place.
- **A job's input and transfer list belong to the pool until it is dispatched.**
  `WorkerPool.submit` stores both on the job and posts them later when a worker frees
  up, so a caller that reuses one object per job detaches the buffers of the job
  still waiting and every later `postMessage` throws `DataCloneError: ArrayBuffer at
  index 0 is already detached`. The symptom is a counter that only grows (jobs
  submitted and never answered), not a visible error in the frame path. Build a fresh
  input and transfer array per job; the pool's own reuse of request objects (it posts
  them synchronously) does not extend to yours.

- **postMessage is expensive.** A Chrome trace of a terrain flyover
  (plan-rendering phase 3) showed the main thread posting about 4,600 messages a
  second (a job and a returned buffer per chunk), with `WorkerPool.dispatch` and
  `WorkerPool.recycle` at 650 and 550 ms of self time in a 5.1 s trace (about 50
  us per message with the profiler attached) and each incoming result about 100
  us. That time is spent in message tasks between frames, so frame times hide
  most of it. Fixes, in order of what the traces showed: returned buffers batched
  per frame (`WorkerPool.flushRecycled()`; `recycle` fell from 550 ms to 50 ms in
  the next trace) and the shared arena sent to each worker once
  (`WorkerPool.share()`) instead of in every mesh job. What did not work: batching
  4 jobs and their results per message, tried when `dispatch` sat at 854 ms of a
  5.2 s trace. Fourfold fewer messages saved no measurable main-thread time and
  nearly doubled job latency (plan-rendering phase 3 A/B), so the cost is cloning
  and transferring the payload, not the message itself. Shrink what a message
  carries before reducing how many there are; `?jobBatch=n` re-runs it.
- **A shared arena block can be reused under a running worker.** Mesh jobs read
  chunk blocks in place from the `SharedArrayBuffer` arena. Evicting or replacing a
  chunk frees its block, and the next allocation may overwrite it while a queued or
  running job still reads it: a torn read gives a garbage mesh or a failed job, and
  nothing marks it stale. The store defers frees in shared mode and `MeshScheduler`
  reclaims them only after every job submitted before the free has settled
  (`ChunkStore.reclaim`, job stamps). Any new job kind that reads the arena in place
  must hold stamps the same way.
- **`deno bench` numbers on the dev laptop swing about 2.5x between runs.** Two runs
  a few hours apart differed by 2.4-2.9x on code that hadn't changed (reference
  mesher, `toDense`, table lookups), most likely the power profile or CPU clock
  state. Compare before and after within one run, or scale by a line whose code
  didn't change (the reference mesher in `mesh_bench.ts` serves as that control).
  A quick timing loop earlier in plan-meshing phase 5 read 2.5x low for the same
  reason.
- **A sampled reference is not a brute-force reference.** Checking a voxel traversal
  by walking the ray in fixed steps and taking the first solid cell looks like brute
  force and is not: a ray can clip a cell's corner over an interval far shorter than
  any step, so the sampler misses cells the traversal correctly finds, and reports the
  traversal as wrong. It cost a debugging round in plan-far-field phase 1. Write the
  reference as an exact DDA over the finest grid instead, which is both exact and
  independent of the acceleration structure being tested.
- **A readback needs COPY_SRC, and without it reads zeros.** `copyBufferToBuffer`
  from a buffer created without `COPY_SRC` raises a validation error the frame path
  never sees, and the staging buffer maps as zeros, so a test reads a plausible
  "nothing happened" instead of failing. It cost a debugging round twice: once on the
  cull check's textures (plan-rendering phase 4) and once on the translucent draw
  arguments (phase 5). Give any buffer or texture a test might read `COPY_SRC` when
  it is created.
- **GPU pass timings drift between bench runs, and the control-line trick does not
  rescue them.** In one sitting `gpu.hiz` (identical work every frame) read 0.137 to
  0.252 ms across four flyover runs, so an effect under about 0.3 ms of GPU total
  cannot be attributed on this machine: the texture A/B in plan-rendering phase 5
  came out with the textured cave *faster* than the untextured one, which is
  impossible. Scaling by an unchanged pass does not help, because the unchanged pass
  drifts by the same factor. When a change is expected to cost less than that, either
  measure something the timer can resolve (a counter, a throughput) or say the cost
  is below the floor and show the spread.
- **GPU memory is not garbage collected promptly.** Call `destroy()` on buffers and
  textures when done; dropping the JS reference leaves VRAM held until GC runs.

## WebGPU API traps

- **WebGPU needs a secure context.** Over plain HTTP to anything but localhost,
  `navigator.gpu` is undefined and the page shows the "no WebGPU" message even in a
  supported browser. `SharedArrayBuffer` has the same rule. Testing from another
  device needs HTTPS (`TLS_CERT`/`TLS_KEY` in `serve.ts`).

- **Default limits are low.** A device gets the spec defaults unless the limits are
  requested at `requestDevice`. `maxStorageBufferBindingSize`, `maxBufferSize`,
  `maxStorageBuffersPerShaderStage`, and compute workgroup limits must be requested
  from `adapter.limits` explicitly, and arenas sized from what was granted. iOS
  often grants only 256 MiB per buffer, and Firefox with resist-fingerprinting
  grants only the defaults, so the defaults must still run.
- **Optional features must be requested.** `timestamp-query`, `subgroups`,
  `shader-f16` and others exist only if listed in `requiredFeatures`. Probe
  `adapter.features`, request what's there, and record the result in `caps`.
- **`writeBuffer` copies through a staging area.** It's cheap per call but not free;
  large writes in one frame hitch. Offsets and sizes must be multiples of 4. Budget
  arena and clipmap uploads per frame.
- **Never reuse a readback buffer until it is unmapped.** Submitting a copy into a
  buffer that is still mapped is a validation error, the copy doesn't happen, and
  the next map reads the old contents as if they were new results. Found when the
  voxelizer refilled a slot from inside the callback that was still reading the
  slot's payload; `Voxelizer.release()` now frees a slot only after both of its
  buffers are unmapped.
- **Readback is async only.** `mapAsync` resolves frames later and a mapped buffer
  can't be used by the GPU. Use a ring of readback buffers for stats; never await a
  map in the frame loop.
- **Timestamp queries are optional and coarse.** Chrome rounds them to 100 µs unless
  `enable-webgpu-developer-features` is set, and Intel Macs don't expose them in
  Safari. Treat GPU times as trends, and fall back to CPU timing.
- **Browser flags hide bugs.** `--enable-unsafe-webgpu` bypasses Chrome's GPU
  blocklist and exposes experimental features. Test in a flag-free profile before
  calling anything done. Setup details:
  [research-webgpu-support.md](research-webgpu-support.md) "Development setup on Linux".
- **Compatibility mode can't run this renderer.** `featureLevel: "compatibility"`
  allows no storage buffers in the vertex stage. Always request the core feature
  level.
- **`layout: "auto"` drops unused bindings.** A bind group built against an auto
  layout fails if the shader stops using a binding (for example while debugging).
  Use explicit bind group layouts for shared resources.
- **Errors are asynchronous.** Validation errors surface via `pushErrorScope`/
  `popErrorScope` or `uncapturederror`, not exceptions. Shader compile errors come
  from `getCompilationInfo()`. Wire both into the dev overlay.
- **Device loss happens.** Driver resets, GPU switches, and long-running shaders
  resolve `device.lost`. Recreate the device and rebuild all GPU state from CPU-side
  data.
- **Canvas format varies.** `navigator.gpu.getPreferredCanvasFormat()` returned
  `rgba8unorm` in Chrome 152 on Linux and `bgra8unorm` in Firefox 154 on the same
  machine. Always build render targets from `caps.format`, never a literal.
  `bgra8unorm` isn't usable as a storage texture without `bgra8unorm-storage`, so
  compute passes write to an `rgba8unorm` or `rgba16float` target and a render pass
  composites to the canvas.
- **An encoder is locked while a pass is open.** `copyBufferToBuffer` (or any other
  encoder call) between `beginComputePass` and `end` fails with "Recording in
  [CommandEncoder] which is locked". Collect the copies and encode them after the
  pass ends.
- **`queue.writeBuffer` lands between submits, not between dispatches.** Writing a
  uniform, dispatching, writing it again and dispatching again in one command buffer
  gives both dispatches the last value. To vary per dispatch, put every value in one
  buffer and bind it with a dynamic offset (`hasDynamicOffset`, offsets aligned to
  `minUniformBufferOffsetAlignment`, 256 at default limits), or use one pass per
  value.
- **Mapping a readback buffer in the frame that encodes the copy into it fails.**
  `mapAsync` on a buffer that a not-yet-submitted command encoder copies into gives
  `[Buffer "..."] used in submit while mapped`, and the whole frame's command buffer
  is dropped. The map is queued at call time, the submit comes after. Poll the
  readback before encoding the pass that fills it, not after (`FarField.pollStats`).
- **Depth textures aren't filterable.** Read `depth32float` with `textureLoad`. The
  Hi-Z pyramid is a separate `r32float` texture built by compute.

## WGSL traps

- **No u64, no f64.** Bit structures stay 32-bit; positions stay camera-relative.
- **Uniformity analysis.** `textureSample` and derivatives must be in uniform control
  flow, or the shader fails to compile. Use `textureSampleGrad`/`textureSampleLevel`
  or restructure the branch.
- **Struct alignment.** `vec3<f32>` aligns to 16 bytes in storage and uniform
  buffers; a TS writer that packs 12 bytes silently misaligns every later field.
  Prefer `vec4` and packed `u32`.
- **Unbounded loops can reset the GPU.** A ray march that runs too long triggers a
  driver timeout and device loss. Every loop has a hard maximum iteration count.
- **Backends differ.** WGSL compiles to HLSL, MSL, or SPIR-V per platform. Integer
  ops, atomics, and loops can behave or perform differently. Test on more than one
  backend before calling a shader done.
- **Greedy UV tiling breaks mip selection.** Tiled UVs use `fract`, which creates
  derivative discontinuities at tile edges. Use `textureSampleGrad` with derivatives
  of the unwrapped UV.

## Rendering artifacts

- **Displacing greedy-meshed geometry opens hairlines at T-junctions.** Greedy meshing
  puts a long quad beside two short ones all the time, and a vertex displacement that
  varies *within* a quad pulls the long quad's straight edge off the short quads' shared
  vertices. Wind at a 13-voxel wavelength added 244 bright slivers to a canopy; the same
  amplitude at 85 voxels added 4. The deviation grows with the square of the wave
  number, so keep an animation's wavelength several quads long. There is no fixing it in
  the mesher short of emitting the T-junction vertices.
- **A material function answers for the point you give it, and a sphere trace stops
  outside the surface.** The SDF preview asked `world_material` at the hit point, which
  is a hair *above* the ground, and terrain's sea rule ("solid above the ground is
  water") painted every hill blue. Sample half a voxel along the negative normal, on the
  solid side. The voxelizer never had the bug because it asks at voxel centres.
- **A hard line along an LOD boundary is usually the normal, not the geometry.** In
  the far field's clipmap, levels quantize a surface to their own cell size, so a ray
  can enter the next level already inside solid ground. The cell walk then reported
  the hit with whatever axis it started at, and an axis-aligned face lit by ambient
  alone is about a third as bright as an up-facing one: a dark line one cell wide along
  every level boundary, clearest over flat water. Start the walk from the face the ray
  actually crossed. Read the pixels along a column and compare against a debug view
  that colors by level rather than guessing from a screenshot.

- **Float32 precision.** At a coordinate of about one million, f32 spacing is about
  0.06, enough to make geometry jitter. All GPU positions are camera-relative
  ([design-formats.md](design-formats.md) "Render space").
- **Greedy quads create T-junctions.** Adjacent merged quads share edges at vertices
  that aren't shared, which can show single-pixel sparkles. Camera-relative small
  coordinates reduce it; if still visible, the known mitigations are a tiny outward
  epsilon on quad corners or skipping merges across AO changes.
- **AO anisotropy.** A quad's triangulation must flip based on its corner AO values
  or the gradient shows a diagonal seam.
- **Single-phase Hi-Z culling shows holes.** Testing against last frame's depth
  culls geometry that just became visible during fast turns. The two-phase scheme in
  [plan-rendering.md](plan-rendering.md) exists to prevent this; don't simplify it
  to one phase.

- **`smoothstep` with equal ends is a WGSL compile error.** `smoothstep(a, a, x)` where
  both ends are the same constant fails at `createShaderModule`, not at run time, and a
  branch around the call does not save it: the module is validated whole. It bites when
  the constants are generated (`skyConstantsWgsl()`), because a preset that never draws
  the feature still has to produce a shader that compiles. Clamp the generated ends apart
  and scale the term by a strength constant instead of branching on it.

## Findings

Diagnosed bugs, as symptom, diagnosis, fix, takeaway. None diagnosed yet.

### Firefox 154-156 on Linux crashes while the tab is in the background

- **Symptom:** Firefox 154 (release channel) on Linux (Intel Arc B390, Vulkan)
  crashes the whole browser while the page is in a background tab. Observed after
  foundation phase 3 (frame loop running). Crash ID
  `dd901645-63b9-47ec-b84d-118660260911`, signature `[@ <T>::get ]`.
- **Diagnosis:** a Firefox bug in the parent process, not something a page can do
  legitimately. `MOZ_CRASH`: `Cannot get non-existent resource QueueId(1,1)`.
  Firefox drops a canvas swap chain (`WebGPUParent::SwapChainDrop`), which frees a
  DMA-BUF shared texture, whose Vulkan semaphore destructor looks up the WebGPU
  queue, which is already gone; wgpu-core panics. The Linux DMA-BUF swap chain path
  tears down after its device's queue. Inferred trigger: Firefox recycling canvas
  textures for a hidden tab; the same ordering could also follow our device-loss
  restart (`context.configure()` with a new device after the old one is lost).
- **Fix:** none on our side. It's Mozilla
  [bug 2037013](https://bugzilla.mozilla.org/show_bug.cgi?id=2037013) (Linux only),
  fixed in Firefox 157 by no longer holding Vulkan objects in `SharedTextureDMABuf`;
  152 and 155-156 are marked wontfix. The bug lists older crash signatures; ours
  (`[@ <T>::get ]`, newer wgpu message format) is the same crash.
- **Takeaway:** never add page-side workarounds for this. To test in Firefox on Linux
  before 157, either use Nightly/Beta 157+, or set
  `dom.webgpu.allow-present-without-readback` to false in `about:config` (inferred,
  untested: presents through CPU readback instead of DMA-BUF sharing, slower, so not
  for performance measurements).

### Compiling a heavy world's pipelines can take two minutes, and used to hold the frame

- **Symptom:** `?world=forest` showed a black screen for many seconds, sometimes two
  minutes, with `voxler.renderer` null and no error in the overlay.
- **Diagnosis:** `Renderer.init()` awaited every pipeline before returning, and the frame
  loop draws nothing until `voxler.renderer` exists. Timing the stages (`renderer.startup`,
  on the overlay's `world` line) on a cold shader cache: sky 20 ms, near 40, voxelize
  3400, far build 4600, and the SDF preview **117,800**. The preview compiles the world
  program into a sphere-tracing loop, so its cost grows with the world, and the forest
  with three tree species is a large program. Chrome caches compiled pipelines, so only
  the first load after a real change to the world pays it; a comment-only change does not
  invalidate the cache, which makes cold compiles hard to reproduce on purpose.
- **Fix:** `init()` now returns once the sky, grid and gizmo pipelines are up (about
  50 ms) and the frame loop starts there. Every pass already checked its own `ready`, so
  the sky draws, then the far field, then meshes, as each arrives. `renderer.worldReady`
  is the rest, and streaming waits on that. The preview is built the first time it is
  switched on, not at startup, because it is off by default and the slowest thing here to
  compile.
- **Takeaway:** never await a shader compile on the path to the first frame. Measure the
  stages before guessing which one is slow: the answer here was 25x the next worst.

### The grove bench walked 44 voxels underground

- **Symptom:** the grove scene reported 120 Hz, `stream.holes` 0 and a CPU frame of
  0.40 ms in a forest that plainly cost more than that.
- **Diagnosis:** scene paths are offsets from the world's spawn point. The forest world
  grew mountains and lakes under it and the spawn stayed at y = 70, where the floor is now
  94. Every frame of the run was inside solid rock, drawing nothing.
- **Fix:** the spawn stands over the canopy and the scene drops under it. On the real path
  the same scene misses about 100 frames of 1400.
- **Takeaway:** after changing a world's terrain, check its spawn and its bench scenes
  before trusting a number from them. A suspiciously good result is a result to check.

### A GPU pass that stops running keeps its last timing forever

- **Symptom:** the adaptive far-field controller walked the clipmap from eight levels
  down to three while the march it was supposedly paying for cost 0.2 ms, and kept
  reporting a 3.34 ms build that never changed by a hundredth between windows.
- **Diagnosis:** `timer.passWrites(i)` is called only on the frames a pass is actually
  encoded, which is the documented rule (a skipped pass is simply not timed). The other
  side of that rule is that the pass's ring keeps whatever it last held, with no way to
  tell "expensive" from "not running". The far field's brick build stops entirely once
  the clipmap has caught up, so its ring froze at the cost of the initial fill and the
  controller kept giving up reach to pay for work that had finished.
- **Fix:** the far field reports whether it encoded a build each frame, and the
  controller counts those frames and scales the ring's mean by the duty cycle. A window
  with no build frames costs zero, whatever the ring says.
- **Takeaway:** a value read from a pass ring is "what it costs when it runs", not "what
  it costs a frame". Anything that budgets against it needs to know how often it runs,
  and the rings cannot say.

### A step in the sky's colour is a line drawn across every voxel

- **Symptom:** a horizontal band edge across the frame at eye level, with voxels above it
  a different shade from voxels below, and no horizon anywhere in sight. Reported as
  "the horizon line somehow affects color of voxel even when horizon is not visible".
- **Diagnosis:** `sky_color()` is not only the sky. `apply_fog()` mixes every distant
  surface toward it, so its value along the view direction is part of the shade of every
  fogged voxel. It read `SKY_HORIZON` above `dir.y = 0` and `SKY_HORIZON * 0.55` below,
  a 45% jump in the fog target between two voxels a pixel apart. Measured as a +14.8
  luminance step over two rows of a 1080p frame, flat on either side.
- **Fix:** both halves start at `SKY_HORIZON` and ramp away from it, and the square root
  that shapes the gradient is eased out over the first few degrees. A plain square root
  meets continuously but with an infinite slope on both sides, which turns the step into
  a cusp: a thinner line, still a line.
- **Takeaway:** anything `apply_fog()` mixes toward has to be continuous *and* smooth in
  the view direction, or it is a feature drawn on the geometry rather than behind it.
  When a shading artifact tracks the camera's orientation instead of the world, look at
  what the shading reads from the direction.

### Half-resolution marching eats the thin face

- **Symptom:** distant terraced terrain draws ragged contour lines. A terrace's top face
  appears doubled, broken into dashes, or bleeding into the rows beside it, worst where
  the top is a very different colour from the side facing the camera.
- **Diagnosis:** the far field marched at half resolution. Terrain is terraced, and seen
  from anywhere but straight down a terrace's top face is foreshortened to one or two
  screen pixels, which is half a texel at half resolution: runs of it fall between
  samples entirely, and the bilinear upsample then smears whatever was sampled across two
  screen pixels. Not a filtering problem, an undersampling one; a sharper upsample would
  not recover a face that was never marched.
- **Fix:** full resolution by default, paid for by the adaptive controller giving up
  clipmap levels that fog has already taken (plan-far-field.md "How far to reach").
- **Takeaway:** a resolution scale is a sampling decision, so measure it against the
  thinnest feature in the scene, not against GPU time alone. The table that justified
  half resolution measured only the time.

### `?mesh=0` turns the SDF preview on, which is a different renderer

- **Symptom:** an hour of diagnosing a far-field artifact against images the far field
  never drew. The debug views (`?far=steps`, `?far=levels`) appeared broken, because the
  frame was not coming from the far field at all.
- **Diagnosis:** the preview starts on whenever meshes are not being drawn
  (`meshesByDefault` in `src/main.ts`), which is the sensible default for looking at a
  world, and a trap when `?mesh=0` was meant to isolate the far field. The two look
  similar at a glance: both are the same world, lit by the same functions.
- **Fix, when isolating the far field:** `?mesh=0&preview=0`. Check
  `voxler.renderer.showPreview` is false before trusting the picture, and check a debug
  view actually changes the colours before concluding it is broken.
- **Takeaway:** when a debug view does nothing, suspect that the thing being debugged is
  not the thing on screen.

### `offsetX` on a pointer event is not `clientX` minus the element

- **Symptom:** the wheel-to-cursor fly aimed a fifth of the way towards the top-left
  corner when the cursor was dead centre on the canvas. Every other position was off by
  the same constant fraction.
- **Diagnosis:** the handler read `e.offsetX` / `e.offsetY`, which are documented as the
  position relative to the target's padding edge. Under browser zoom Chrome reports them
  scaled by the zoom factor while `clientX` / `clientY` and `getBoundingClientRect()` stay
  in CSS pixels: dispatching at `clientX` 715 over a canvas whose rect starts at 0 gave
  `offsetX` 572, a factor of 0.8.
- **Fix:** `clientX - rect.left` over `rect.width`, from `getBoundingClientRect()`. The
  rect and the client coordinates are the same space whatever the zoom. Allocating a
  DOMRect is fine in a gesture handler; the no-allocation invariant is about the frame
  path.
- **Takeaway:** pick one coordinate space for a pointer and stay in it. Mixing `offset*`
  with `client*` or with a measured rect is a bug that only appears on a zoomed page,
  which is not the machine it will be written on.
