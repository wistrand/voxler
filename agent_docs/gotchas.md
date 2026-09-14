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
- **A slab that comes back after the window moved lands on the wrong bricks.** The
  clipmap's windows are camera-centred and addressed toroidally, so a brick's grid cell
  never moves, but *which* brick sits at `u, v` of a slab moves every time the window
  scrolls along one of the other two axes. A build takes several frames to come back, and
  `applyReport` recomputed the slab's cells from the level's origin as it was *then*: any
  scroll in the meantime shifted the CPU's shadow of the indirection off what the GPU had
  written. The shadow is what frees pool slots, so slots went back to the pool while the
  GPU was still pointing at them, and the next brick built into that slot appeared
  wherever the stale pointer was: a block of another place's ground standing in mid-air,
  a few hundred voxels out, coming and going with the camera. Found by marking six of
  them (the `mark` switch): every one was a solid `stone` cell where the world's own SDF
  said +7 to +28 voxels of open air, and `stone` is what the world returns below the
  soil, which is to say from inside a hill somewhere else. Anything that comes back from
  the GPU frames later has to be addressed by what it was built with, not by what the
  window holds now (`slabCellAt` in src/far/clipmap.ts, and the test in
  src/far/clipmap_test.ts).
- **A loop with the world program in it is not a loop to the compiler.** The marked-point
  probe started as one invocation looping over samples, asking `world_sdf` and
  `world_material` at two footprints inside the loop: four call sites. The forest's world
  program is large enough that inlining it four times took the far field's pipelines from
  185 ms to compile to 66.8 seconds, and the page sat on "compiling far" for over a
  minute. Rewritten as one sample and one footprint per invocation, a single call site
  each like `build_slab` has, it is back to ordinary. Count call sites of a world program,
  not lines: each one is the whole world again. The probes are also compiled only when
  marking is switched on, because even one extra copy of the march and the world program
  is seconds that nobody who never marks should wait through.
- **What that cell is made of, and where it is.** A far-field cell's colour has lighting,
  block light and fog in it by the time it reaches the screen, so reading an artefact off
  a shaded screenshot is guesswork: a dark cell can be a dark block, a face pointing away
  from the light, or a hole showing something behind. `?far=blocks` writes the hit's block
  id into the red channel and `?far=height` its world height, both unshaded, so a capture
  answers the question exactly. That is how the dark blocks on the forest's mountains were
  split into two different things: bare rock below the snow line, which is what the world
  says, and a scatter of rock *above* it, which is steep ground where the world's own
  "dirt over stone" rule reads a face deeper than its soil is thick. Take the two captures
  in one sitting at a still camera and cross-reference them per pixel.
- **A level boundary the camera looks up at is a line of black cells.** The same
  boundary, the other half of the same bug. Starting the cell walk from the face the ray
  crossed fixes every brick after the first; the *first* brick of a level had no crossed
  face to report, because what the ray crossed was the level's window, a box around the
  camera and not a surface. It was given the Y face as a stand-in, and the shading takes
  a face to mean `n[axis] = -sign(dir[axis])`, so every ray that was climbing got a
  normal pointing *down*: no sun, almost no sky, black. Over the forest's mountains at
  night that is a row of black dashes marching down the ridge, and where a whole brick
  was solid, a black box the size of the brick (888 pixels in one blob). Fixed by saying
  no face was crossed (`FACE_NONE`) and taking the normal from the cells around the hit
  instead (`entry_normal` in `src/far/far.wgsl`), a step's cap from the occupancy
  gradient and its riser from the ray. Over the seam's 6,360 pixels: mean luminance 51.6
  against 63.2 for the far field around it, with 1,691 pixels under 20, became 71.6
  against 65.0 with none. A face is a direction only where a face was crossed; entering
  something is not crossing it.

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
- **A cull check that runs after the birds compares two different pictures.**
  `?cullCheck` draws the near field again with nothing culled and counts the pixels where
  the depth differs, so it has to be encoded while the frame's depth still holds the near
  field and nothing else. It was encoded after the bird pass, which writes depth of its
  own, so in the forest every check failed, by 3,000 to 160,000 pixels, and reported a
  cull bug that was not there. `?birds=0` gave 0 to 3 pixels over the same flight. Fixed
  by encoding the check right after the near field's phase B pass. A correctness check
  that fails always is worse than none: it is read as noise, and the one time it is real
  nobody looks.

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

### A wall at an angle the grid does not like

- **Symptom:** dark one-pixel lines running down an otherwise flat voxel cliff, worst
  where the wall is long and straight. Reads as a rendering bug; is not one.
- **Diagnosis:** a surface at an arbitrary angle to the axes staircases. Reading the
  chunk store across 40 voxels of one butte wall found the surface stepping by exactly
  one voxel 19 times, and each step has a side face that rasterizes as a one-pixel line
  when seen near head-on. Greedy meshing then merges consecutive side faces into long
  quads, which is what turns per-voxel stipple into a ruled line.
- **Fix:** put the surface on the grid. Snapping a world's plan faces to multiples of 45
  degrees took the same wall from 19 steps to 1; moving a wall's fine detail from geometry
  to material (a stain rather than a groove) removes the rest, because a colour change
  makes no side faces at all.
- **Takeaway:** measure the voxels, not the pixels. Half a day of pixel statistics said
  "crack", "AO" and "T-junction" in turn; one read of the chunk store along the wall
  settled it. And when a world needs fine vertical detail on a wall, prefer a material
  that varies over a shape that does.

### The near field's coverage is a chunk, not a pixel

- **Symptom:** sky-coloured steps down the silhouette of a butte, on the edge of its talus
  ramp, with desert on both sides. Reported first as "the sky color seems to appear on the
  borders of the pillars", and it was exactly that.
- **Diagnosis:** the far-field march stopped dead at the first cell inside a chunk the
  near field is drawing, on the reasoning that the raster pass owns that pixel. It does
  not: coverage is per 32-voxel chunk, and along a silhouette a ray grazes a covered chunk
  the raster pass never filled. The march stopped, wrote alpha 0, the blit discarded, and
  the sky drawn before it showed through. Measured: 560 sky pixels on one ramp with the
  near field on, 0 with `?mesh=0&preview=0`, and at `?sky=night` the same pixels came back
  as night sky, which is what proved they were sky and not a material.
- **Fix:** march *past* a covered cell instead of stopping on it. By the time the march
  runs, the pass's own depth test has already found this pixel empty, so the near field
  has no geometry anywhere along this ray and whatever is behind the covered chunk is what
  should be drawn. 560 sky pixels to 0, and 1,200 pixels changed in the whole frame, all
  of them at silhouettes.
- **Takeaway:** a per-chunk mask cannot answer a per-pixel question. When one renderer
  defers to another, it has to defer on the thing the other actually drew, and the depth
  buffer is the only thing that knows that.

### A near-level surface is a contour map, and the fix is wavelength

- **Symptom:** the desert floor in even parallel ribs from the camera to the middle
  distance, one voxel high, each with a black side. Reported as "this looks very broken",
  and it was the worst case of the terracing in "A wall at an angle the grid does not
  like" rather than a new bug.
- **Diagnosis:** a shallow ramp in a voxel world is a contour map. The step spacing is one
  over the slope, so the *flattest* surface in a world is the one that draws the most
  visible lines: 9 voxels of dune over a 512-voxel lattice is a slope of 0.035, a step
  every twenty-six voxels. Each step's side face is vertical, takes no sun from overhead
  and reads near-black against a lit floor, and the greedy mesher merges consecutive ones
  into long quads, so they come out ruled instead of stippled.
- **Fix:** spend the relief budget on wavelength. 7 voxels over 8,192 plus 4 over 2,048 is
  a slope near 0.005 and a terrace every couple of hundred voxels, which reads as a bench.
- **What did not work:** adding a fine ripple to make the terrace edges ragged. The edges
  stopped being straight and there were four times as many of them, which is worse: the
  count is what the eye picks up, not the straightness.
- **Takeaway:** on anything near level, amplitude is free and slope is not. Add an octave
  only if it is long enough not to cut new terraces.

### A wider clipmap level can be cheaper than a narrower one

- **Symptom:** the far field cost 7.3 ms a frame marching a clear-air desert at 1080p,
  with eight levels of 32^3 bricks.
- **Diagnosis:** march cost follows how many *levels* a ray crosses on its way out, not
  only how many cells. Doubling a level's width to 64^3 and dropping to six levels halved
  the level crossings, and it halves the cell size at any given distance as a bonus:
  3.5 ms, and finer than what it replaced. The bricks are affordable only because the
  world is mostly empty air and an empty brick takes no pool slot (30,382 bricks against
  8,101 in a world with monuments a kilometre apart; a dense world would pay differently).
- **Fix:** a world picks its own clipmap (`far` in `src/worlds/index.ts`, `?farSize=n` to
  try one). What it costs is reach, and fog has to cover the end of the last level, so the
  world's fog density and its clipmap are one decision, not two.
- **Takeaway:** reach, cell size and level count trade against each other three ways.
  Measure the combination in the world that has to run it; the default that suits terrain
  suits nothing else automatically.

### The covered-cell path is not hot

- **Symptom:** none. This is a failed optimisation, recorded so it is not tried twice.
- **The idea:** the far march tests `near_covers()` once per cell and marches past a
  covered one, up to twenty-four times in a brick. The near field's radius is 512 voxels,
  which at 32^3 levels is exactly the first two, so those looked like two whole levels
  walked cell by cell inside ground the raster pass owns. A brick at a fine level lands
  inside one chunk, so one mask lookup should have replaced all of them.
- **Measured:** no difference at all. 5.37 ms p50 without the brick test, 5.37 to 5.44
  with it, back to back at the same camera, and 2.36 against 2.23 in an earlier
  unthrottled state.
- **Why:** `march_far()` skips every pixel the near field already drew, so a ray that
  reaches the march is one the near field drew nothing along, and the inner levels along
  such a ray hold empty bricks, which cost one indirection read and no cell walk. A brick
  with geometry in it is a brick the raster pass would have drawn. The covered-cell path
  is for silhouettes, and a silhouette is a sliver of the frame.
- **Takeaway:** the march's cost is in the outer levels, where rays are long and bricks
  are occupied. An optimisation aimed at the near/far boundary is aimed at the cheap end.
  Read `?far=steps` before optimising a loop on an argument about where the work must be.

### A footprint gate deletes a feature from the far field

- **Symptom:** in the forest, the wood stops. Past about a kilometre there are no trees
  and no giant mushrooms, only bare hills, and the edge is a line rather than a fade.
  Reported as "the far field cut also seems to miss entire objects, as trees or
  mushrooms".
- **Diagnosis:** not the far field at all. `forest()` had
  `if (sample_footprint <= TREE_FOOTPRINT)` around the trees, the giants and the rocks,
  and the far-field brick builder sets `sample_footprint` to the level's cell size
  (`src/far/far-build.wgsl`). TREE_FOOTPRINT is 4.4 voxels, so the second clipmap level
  on (8-voxel cells, past 512 voxels) evaluated a world with no trees in it. The gate was
  cost control and it read as deletion.
- **Fix:** a gate changes the representation, it does not remove the thing. Past the
  detail footprint a tree is a crown ellipsoid and a trunk cylinder, placed and sized from
  the same numbers so the swap moves nothing sideways; past a footprint as wide as its own
  crown it goes, because by then it cannot be drawn without being inflated to a cell.
- **The second half of it:** the same imposter for the giant mushrooms came out as flat
  neon plates hanging over the wood, wider than the mushroom and the brightest thing in
  the frame. A cap is small, bright and thin-lipped: quantised to an 8-voxel cell the lip
  becomes a full cell and the cap becomes a plate, and emission makes sure you look at it.
  Giants keep a much finer gate than trees for that reason, and use a dome with no lip
  above 3 voxels. **A broad continuous feature survives being drawn coarsely; a small
  bright one does not.**
- **Takeaway:** `sample_footprint` is read by the voxelizer at 1 voxel, by the preview at
  a pixel cone, and by the far-field builder at 1 to 256 voxels. Any `if` on it is a
  statement about what the far field contains. Check a world's footprint gates before
  blaming the clipmap for missing geometry.

### Dithering a level boundary shows both levels at once

- **What was tried:** every clipmap level's window is a camera-centred box, so the
  distance at which a ray gives up one level for the next is the same for every ray: a
  circle drawn on the world. Spreading the switch over a band, each ray shrinking the
  window it marches by a hashed fraction, turns the circle into a band.
- **Why it is worse:** the two levels do not hold the same world. Inside the band each ray
  answers from a different one, so the geometry of the level a ray did *not* pick shows
  through the gaps in the geometry of the one it did. Standing still that is a ragged
  edge; moving, the band sweeps across the frame and the far field boils. Reported as
  "other voxel mesh shines through, in the seam", which is exactly what it is.
- **Hashing the direction instead of the pixel** made it coarser, not better: patches of
  the wrong level instead of a screen door of it.
- **Taken out.** The hard boundary is coherent, and coherent beats soft when the two sides
  disagree about what is there. What would actually work is *blending* the two, which
  means marching both, and that is the cost the level walk exists to avoid.

### A plant decided per sample point is a plant cut in half

- **Symptom:** trees and mushrooms near the water are clipped. Not shaded oddly, not
  moved: the parts of them over one side of an invisible line are simply missing, and the
  line is the waterline.
- **Cause:** the forest gated its plants on `dry = ground - water_top` evaluated at the
  *sample point*. A world function is asked about one point at a time, and a tree is
  thirty voxels across, so for the points where the local ground was high enough the tree
  was in the field and for the rest it was not. The same shape came back different for
  different parts of itself.
- **Fix:** every test that decides whether a plant exists, or how big it is, reads the
  world at the plant's own base (`plant_base()` in `src/worlds/forest.wgsl`) and never at
  the point being shaded. Then the answer is one answer for the whole plant.
- **And make the cutoff soft.** A hard threshold on a per-plant value does not clip
  anything, but it does draw the edge of the wood as a contour line. `shore_fade()` ramps
  over a band: the fade is the plant's chance of standing *and* a factor on its size, so
  the wood thins and shrinks into the shore instead of stopping.
- **It has to be cheap, because it runs per plant per sample.** Read behind the plant's
  bounding test, so only sample points already standing inside a plant pay for it, and
  work out what actually cancels: inside the stream's cut the ground and the water surface
  are the same land height less their own constants, so the difference is the cut profile
  and `land_height` drops out. The first version called the full ground and water at every
  candidate and took the forest's brick build from 6 ms to 55; the same test costs one
  extra noise field now.
- **Takeaway:** anything about a placed object -- whether it is there, what species it is,
  how big it is -- is a property of the object, so read it where the object is. Only its
  *shape* may depend on the point being asked about.

### Domain repetition loses the neighbour offset

- **Symptom:** every scatter in every world looks like it is on a grid, and the objects
  are cut off along the grid lines. Reported three times over several sessions, and
  survived two fixes aimed at the jitter and at the density, because neither was the
  cause.
- **The bug:** the 3x3 neighbour loop is written as "offset the sample point by a whole
  cell, then ask which cell it is in and where it is inside that cell":

      let q = wp_offset(p, -vec3f(shift));      // shift is (i, j) * period
      let id = wp_repeat_id(q, period);          // the neighbour's cell: correct
      var local = wp_repeat(q, period);          // WRONG: the same value every iteration

  `wp_repeat` is periodic, and `shift` is a whole number of periods, so
  `wp_repeat(q) == wp_repeat(p)`. The neighbour's *identity* comes through and its
  *position* does not, so all nine objects are placed around the sample point's own cell
  centre instead of around their own cells. Nine objects crowd onto every cell, each one
  visible only while the sample point is inside that cell, so every object that reaches
  past a cell boundary is cut off at it. That is a grid of clipped objects, and it is
  also nine times the intended population, which is why the woods looked dense.
- **Fix:** `wp_repeat_near(q, period, shift)` in `src/sdf/lib.wgsl`, which is
  `wp_repeat(q, period) + vec3f(shift)`. Use it for every neighbour lookup; the plain
  `wp_repeat` is only right for the cell the sample point is in.
- **When you fix it, the population drops by nine.** The forest went from a closed canopy
  to a meadow with four trees in it, because the density had been tuned against the bug.
  Every acceptance rate in a world using this idiom has to be re-tuned once it is correct.
- **Takeaway:** a periodic function eats a whole-period offset. If a lookup shifts the
  point by the period and then asks a periodic question, the shift is gone and only an
  index survives it.

### One per cell is a grid, whatever the jitter

- **Symptom:** from above, the trees are on a grid. Still on a grid after the jitter was
  widened to fill the cell, which is the fix in the entry below and was not enough.
- **Cause:** one candidate to a cell is a *stratified* sample, and stratified is not
  random. Two trees are never close together and no gap is ever much wider than a cell,
  whatever the jitter does inside it, and that regularity is what the eye reads as a grid.
  The clumping did not save it either: `grove_density` was sampled once at the cell's
  centre, so the *patches* were on the lattice too and had square edges.
- **Fix, both halves:**
  - **Several tries to a cell, each at a fraction of the chance.** Three tries at a third
    of the acceptance keeps the count and loses the lattice, because two can land next to
    each other and all three can fail. `TREE_TRIES` and `GIANT_TRIES` in
    `src/worlds/forest.wgsl`.
  - **A density that varies continuously**, read at the candidate's own position rather
    than at its cell's centre, so nothing about the placement knows where the cell
    boundaries are.
- **Pay for it by moving the density behind the bound.** The density is a noise field and
  it was being read for every candidate cell, most of which the sample point is nowhere
  near. Read behind each plant's bounding test instead, three tries came out *cheaper*
  than one: the forest's brick build went 10.1 ms to 8.5 per build frame.
- **Takeaway:** jitter fixes the position of a thing within its cell. It does not fix the
  *number* of things per cell, and one per cell is what the grid actually is.

### A jittered lattice is still a lattice unless the jitter fills the cell

- **Symptom:** from above, the trees are on a grid.
- **Cause:** the jitter was half a cell, so every tree stood within a quarter cell of its
  lattice point. That leaves a band half a cell wide down every cell boundary that no tree
  can ever occupy, and from above those empty bands are the grid, however random the trees
  inside the cells look.
- **Fix:** let the jitter cover the whole cell. It costs nothing: the 3x3 neighbourhood
  the lookup walks stays sufficient as long as a plant's reach is under one cell, which it
  is by a factor of two (a 31-voxel crown in a 74-voxel cell), and that holds however far
  the plant is jittered inside its own cell.
- **Takeaway:** the budget the jitter has to respect is the plant's *reach* against the
  cell, not the jitter against the cell. Check which one is binding before settling for
  half.

### Animate flowing water with the texture, not the geometry

- **Symptom:** a waterfall built out of a block with `sway` flickers badly, worse the more
  it sways.
- **Cause:** two things at once. `sway` moves the *faces* in the vertex stage, so a sheet
  of water pushes into the blocks around it and out again every frame; and the block was
  translucent, so those moving faces sort against the still water behind them differently
  frame to frame.
- **Fix:** `flow` in the block table instead. The fragment scrolls the block's texture
  down its faces at that many tiles a second and the geometry never moves, so there is
  nothing to interpenetrate and nothing to re-sort. The falling block is opaque as well,
  because broken water is not see-through. The texture gradients stay those of the
  unscrolled uv, or the mip level swims with the scroll.
- **Takeaway:** `sway` is for things attached at one end: a frond, a leaf, a cap. For a
  surface that is *flowing* rather than moving, animate the material.

### Only a rare thing reads as a special thing

- **Symptom:** waterfalls everywhere. Reported as "too many waterfalls, they should only
  appear in tight gorges".
- **Cause:** the fall was marked wherever the stream's terracing was steep, and a stream
  that descends the whole way turns up a riser every seven metres of height it loses. A
  correct local test produced a global result nobody wanted: a quarter of the water came
  out white.
- **Fix:** three conditions that have to agree, not one. Steep, in the middle of the
  channel (so the shallows to either side stay water), and inside a gorge stretch picked
  by one octave of noise over a thousand voxels. That last one is the rarity dial and
  nothing else can be: steepness is a property of the step, and the stream is full of
  steps. 0.4% of the water is white now, and the falls are 10 to 15 voxels tall.
- **What did not work:** gating on how high the land is. The stream is in a valley, so the
  land at the water is low *wherever the water is*, and the gate never fired anywhere.
  Gating on the mountain mask failed the other way: the mask saturates at 1 over a whole
  range, so a threshold on it selects everything or nothing.
- **Takeaway:** when a feature should be rare, the rarity needs its own field at its own
  scale. Tightening a local test until the count comes down gets you a feature that is
  both rare and wrong, or one that never appears.

### A table with one owner and four hand-written readers

- **Symptom:** sky through large areas of the world, worst looking down from altitude,
  where the ground should be. The far field had 1,767 bricks where it should have had
  6,424, and a probe of the clipmap found level 2 empty and the levels under it empty even
  deep underground, where solid stone should be a `ENTRY_SOLID` brick.
- **Cause:** the block table grew from two `vec4f` per block to three (adding `flow`), and
  four shaders index it by a multiplier written out by hand. Three were updated;
  `far-build.wgsl` still read `far_colors.color[id * 2u].a`, which is the *solidity* test
  the far-field builder uses to decide whether a cell counts. At the wrong stride it read
  some other block's emission slot, found alpha under 1, and skipped the cell as "not
  solid". Most of the terrain simply stopped existing in the clipmap.
- **Why it was silent:** nothing connects the stride in TypeScript to the multipliers in
  WGSL, and both sides compile perfectly at the wrong number. The near field was
  unaffected (it was one of the three that were updated) so the world still looked right
  from the ground, where the near field draws.
- **Fix and guard:** `src/world/block-table_test.ts` reads the four shaders and checks
  every index multiplier and every declared array length against `BLOCK_TABLE_STRIDE`. It
  fails on the original bug; that was checked by reintroducing it.
- **Takeaway:** when a binary format has one owner and hand-written readers, the readers
  are the format. Widening one is not done until something *fails* if a reader is missed.

### What a heavy world costs to compile

- **Measured cold** on the dev machine (Chrome 152, Arc B390), from `renderer.startup`,
  with the browser's shader cache missed by perturbing the world source:

  | World    | sky | near | voxelize | far  |
  |----------|-----|------|----------|------|
  | forest   | 76  | 140  | 120      | 140  |
  | monument | 61  | 107  | 1394     | 1303 |

  Milliseconds. The two world modules (the voxelizer's and the far-field builder's) are
  started together and finish together, so the wait is the slower of them, not their sum.
- **It is the world program, not the engine.** The forest and the monument valley run the
  same engine and differ by a factor of ten, and what differs is how much SDF there is to
  inline: a butte is a body, up to two tiers, a thumb and up to three pinnacles, each one
  a call to the same substantial function.
- **Loop unrolling is not the cause.** The obvious theory is that the 3x3 neighbourhood
  loops are unrolled and the body inlined nine times. Forcing the compiler not to unroll
  the monument's, with a loop bound it cannot fold, moved the numbers by nothing:
  voxelize 1394 to 1569, far 1303 to 1261. Either it was not unrolling them or unrolling
  is not where the time goes.
- **Do not read a warm number as a cold one.** The same forest measured 229 ms on a page
  that had been loaded dozens of times against 140 cold, and a heavier world can look
  ten times faster warm. Change a byte of the world source before measuring.

### A low-passed height flies into the hill it is following

The follow flyover (`src/camera/follow.ts`) held `surface + height`, smoothed over a time
constant so a one-voxel step in a river bed was not a step in the flight. Over rising
ground that low pass is a lag, and a lag against a cliff is the camera inside the rock.
Three things it needed, and none of them is a shorter time constant:

- **Look along the corridor it is about to cross, not at the column it is over.** The
  height it wants is the highest thing within the next lookahead, so the lift starts while
  the obstacle is still ahead.
- **Probe from above the camera.** A downward probe that starts at the camera finds the
  ground at the foot of a cliff, never its rim, so the flight reads a wall as a floor and
  aims at it. It starts `clearAbove` over the camera instead.
- **Make the easing asymmetric.** Coming down is slow (it is cosmetic) and going up is
  quick (it is not). Rising is the move that cannot end inside a hill, so when the two
  disagree the flight lifts. The same asymmetry is in the rate limit: the climb rate grows
  with how far there is to go, because a rate fixed at a walking pace cannot clear a
  hundred-voxel wall inside the distance that saw it.

The related one is about what a speed means. Moving at `speed` along the ground and
climbing on top of that makes the camera fastest exactly where it is working hardest,
which reads as a lurch. `speed` is speed *through the air*: the frame's travel budget is
spent on the climb first and what is left goes forward, so a steep lift stops the flight
advancing rather than speeding it up, and the perceived rate never changes.

### A voxel probe through `ChunkStore.read` allocates a chunk per voxel

`store.read(handle)` builds a `ChunkData` (and `ChunkData.uniform` a fresh palette) on
every call, which is fine for the mesh scheduler and not fine for anything that walks a
column of voxels: the follow flyover probes a few thousand a frame, and that was a few
thousand objects a frame in the frame path (CLAUDE.md "Never allocate in the per-frame
path"). One chunk answers 32 probes down a column, so the caller keeps the last one, keyed
by `chunkKey`, and clears the key at the start of each frame so a chunk that has streamed
in or been regenerated is never answered from the frame before. Anything else that reads
voxels one at a time needs the same.

### A bench that starts before the world is built measures an empty frame

`Renderer` is handed to the frame loop as soon as it can draw a sky. Its pipelines, its
clipmap and its chunks arrive over the seconds after that, and a benchmark started then
measures a frame with nothing in it. What that looks like is not an error but a *good*
result: `gpu.near.a` 0.07 ms, no `gpu.far.build` samples at all, `resident` 0, and an
interval that holds 120 Hz comfortably. Two grove runs saved on 2026-09-13 (091102,
091328) are exactly that, and they sit next to runs of the same build that cost 5 ms a
frame in the far-field build.

`benchReady()` in `src/main.ts` gates the session on three things, none of which the
warm-up covers: every stage in `WORLD_STAGES` has recorded itself in `renderer.startup`,
`far.stats.queued` is 0, and `streamer.stats.holes` is 0. It waits at most
`BENCH_READY_TIMEOUT_MS` and then starts anyway with an error on the overlay, so a world
that never settles still produces a result rather than hanging. Every result carries
`readyMs`, the wait in milliseconds: **a result whose `readyMs` is missing was produced
before this existed and its first run is suspect.** The forest takes about 2.2 seconds.

The warm-up is a settling time, not a wait for the world, and no warm-up long enough to
cover a cold pipeline compile would be a sensible warm-up.

### A trunk that tapers under a voxel leaves its crown in the air

The conifer's trunk tapered from `trunk_r * 1.9` at the foot to `trunk_r * 0.3` at the
tip, which at the small end is under half a voxel: the voxelizer finds nothing there, so
the top of the trunk simply does not exist, and the three or four tiers of needles it was
carrying come out as separate slabs stacked in the air. From over a ridge, where conifers
take over as the ground climbs to the tree line, that reads as a few trees floating.

A taper is a number in an SDF and a voxel is a sampling rate; they have to be told about
each other. `max(trunk_r * 0.3, 0.75)` is the whole fix. Anything a world draws thinner
than about a voxel is not thin, it is absent, and what hangs off it is left hanging.

Finding it took a connected-component pass over the chunk store rather than a screenshot:
flood fill the plant blocks, count what never reaches the ground. **Discard any component
that touches the box wall**, or the metric is dominated by trees whose trunk is simply
outside the box: with the wall components counted the number was 9 blobs and did not move
for four different changes, and with them discarded it was 2 blobs of 9 voxels.

### A plant draped over the terrain is cheap, and anchoring it costs three times the world

Every plant in the forest is placed at `local.y = y - ground`, the ground under the
*sample point*, not under the plant's own foot. That drapes it: each column carries the
plant at its own local ground, so on a slope the crown sits lower than the trunk and on a
steep enough one it comes apart. It also means a tree's species and the tree line are
decided per sample point, which is the thing
[gotchas.md](gotchas.md) "A plant decided per sample point is a plant cut in half"
says not to do.

Anchoring it properly was built and measured and then taken out. It needs
`land_height` at each accepted plant's base, which is the most expensive function in the
world, and no reordering saves it: the tests that are cheap enough to run first do not
reject enough. Two grove runs of each, both gated on a built world
(`grove.20260913T091555Z` against `grove.20260913T091653Z`): `gpu.far.build` 4.98 ms p50
against 21.04, missed frames 12 against 31, and the world takes 3.6 s to build instead of
2.2. For a difference that a connected-component sweep of the near field could not
measure at all: the forest's steepest wooded ground is a slope of about 0.44, which
shears a crown by a dozen voxels and does not detach it.

**The drape is the right trade at this relief and would not be at twice it.** What made
the floating trees was the conifer's trunk, above.

### Reading one voxel through `ChunkStore.read()` allocates five objects

`read()` returns a `ChunkData` view, and building it makes three typed-array views, a
`ChunkParts` and the `ChunkData` itself. That is the right shape for a job that then reads
a whole chunk, and the wrong one for anything walking a column of voxels: the follow
flyover probes about thirty-five columns a frame and was allocating roughly a thousand
objects a frame in the frame path (CLAUDE.md "Never allocate in the per-frame path"). It
showed as a 1.7 ms spike in an otherwise 0.05 ms step.

Two things fix it, and both are needed:

- **`ChunkStore.blockAt` / `blockAtSlot`** decode one voxel straight out of the arena
  through views built once (`PayloadArena.blockAt`). That is a second hand-written reader
  of the chunk block layout, so `store_test.ts` checks it against `read().get()` at every
  index width.
- **Hold the slot across a column.** A column crosses one chunk every 32 voxels, so
  caching `slotOf` turns a hash probe per voxel into one per chunk, and a uniform chunk
  (open air, deep rock) answers from its id without touching the arena. `raycast.ts` has
  always done this. Clear the cache every frame, or a chunk that has streamed in, been
  evicted or been regenerated is answered out of a stale slot.

Together: 0.37 ms a step to 0.09 at a normal height, over the forest.

### A probe that is shallower than the camera can climb goes blind

`Follow.probeDepth` was 200 while `MAX_HEIGHT` was 400, so a flight raised past 200 voxels
found no ground under it: the heading fan matched nothing and held its line, the height
probe returned NaN, and `start()` fell back to the default height, dropping the camera
hundreds of voxels the moment the flyover was switched on from altitude.

Depth costs nothing where there *is* ground, because the scan stops at the first solid
voxel; only the empty case pays for it. So the rule is to derive the depth from the range
the camera can occupy rather than picking a number that looks generous.

The same shape of bug: every smoothed term in a controller has to be reset when it
restarts. `Follow.start()` reset the turn rate and the pitch and not the vertical rate,
which had been added later, so switching the flyover off and on again started the next
flight mid-climb. The test for it compares a restarted flight against a fresh one step for
step, which is stronger than asserting it does not move: the first step may well turn and
climb, it just must not inherit the last flight's rates.

### A bind group layout that forgets a shader stage gives you "a previous error"

The boid step is a compute pass that reads the camera uniform, which every other pass
reads too, so it binds the renderer's own frame bind group. That layout declared
`VERTEX | FRAGMENT` visibility, because until then nothing in compute had wanted it. The
result is not a message about the camera or about visibility. `createComputePipeline`
returns an object that is already invalid, the failure surfaces frames later at the
encoder, and all it says is:

```
[Invalid ComputePipeline "birds step"] is invalid due to a previous error.
```

The previous error is never printed, because nothing asked for it. Two habits close the
gap: wrap a pipeline built outside `createRenderPipeline()` in a `pushErrorScope` /
`popErrorScope` and report what comes back (`Renderer.init` does this for the boid step),
and when adding the first compute reader of a shared bind group, check its `visibility`
before anything else.

### A flock is state, and state is the thing this engine does not have

Everything else in a voxler world is a pure function of position, seed and time, which is
what lets the voxelizer, the preview and the far field agree without talking to each
other. Boids are not: a bird's next heading is a function of what its neighbours are
doing, and no function of position can answer that. So the flock is the one thing in the
frame that survives from the last one, in a storage buffer a compute pass steps
(`src/render/birds-step.wgsl`).

What that costs, and what it buys back:

- **Nothing seeds the buffer.** A fresh GPU buffer is zeroed, and a zeroed `pos.w` is what
  tells the step to place a bird, so there is no upload, no init pipeline and nothing to
  redo after a device loss.
- **The flock is carried, not respawned.** When it drifts past `HOME` voxels from the
  camera it is translated by the whole box, one axis at a time, so its shape survives the
  trip; the draw has already faded it to nothing out there, so the carry is invisible.
- **The neighbourhood is the whole flock**, one workgroup to a flock, loaded into
  workgroup memory once. At twenty-four birds that is 576 pair tests a flock a frame. A
  radius query would need a grid, and a grid is more machinery than four dozen birds are
  worth.
- **Birds are kept inside the near field's meshed radius.** They test and write the near
  field's depth and draw before the far field marches, and the far field composites by
  depth rather than testing against it, so a bird further out than the depth buffer holds
  real terrain would be drawn in front of a hill it is behind.

### The flock is the first thing that had to know where the ground is

Birds fly in a band of absolute heights, which says nothing about the terrain: the
forest's mountains stand well through it. Three ways to give a drawn object a ground
height, and only one of them was small:

- **Sample the world SDF.** Correct anywhere, and it means compiling the world module into
  another pipeline. The forest's takes 140 ms cold and the monument's 1.4 s.
- **Keep a heightfield on the CPU.** The chunk store is already there and the column probe
  is already cheap (`ChunkStore.blockAtSlot`), but a scrolling field with incremental
  refill is a clipmap by another name.
- **Ask the clipmap that already exists.** The far field holds the world around the camera
  as occupancy, and `shadow.wgsl` already binds it for the near field's shadow rays. A
  point test (`sh_solid_at`) is a dozen lines beside the ray march, and the flock's step
  binds the same three buffers at group 2. No new data, no CPU work, nothing to keep in
  step. `?far=0` leaves the buffers unwritten, `counts.x` is 0, and the birds fall back to
  the absolute band, which is the same degradation the shadows already take.

Three things were needed before it held, and the first two on their own did not:

- **Probe ahead, not just down.** A slope rising into a bird flying level has nothing
  under the bird until far too late. The probes run under the bird and under where it will
  be a second from now.
- **Put the lift outside the steering clamp.** Everything else in a flock is a preference
  and is clamped together; this is not one. Clamped with the rest, the boid terms diluted
  it and a bird still ended up four voxels inside a hillside.
- **Keep a bounded escape.** Ground can arrive faster than a bird can climb: a chunk that
  streams in under it, a cliff met square on. The step walks up out of solid rock in
  bounded steps, which does nothing on the frames that matter.

Checked by reading the flock back and asking the *chunk store* for the ground, which is a
different source from the clipmap the step asks: 1776 samples over twenty seconds, none
below the surface, tightest clearance 1.1 voxels.

### A bound is paid for everywhere, a shape only where it stands

Ferns grow larger by the water, which sounds free: most of the world is not by water, so
most ferns stay the size they were. It is not free, because the *bound* has to be built for
the biggest a fern in that cell could be, and the bound is tested on every sample near
every fern whether or not the fern turns out to be large. At half again the reach it covers
more than twice the area, and everything behind it — the density field, the shore read, the
five bezier tubes — runs on twice as many samples.

Measured on the grove: `gpu.far.build` 4.98 ms p50 to 8.85, the GPU sum 8.5 ms to 14.4, and
the interval dropped a vsync tier from 8.34 to 16.66. At a fifth again (0.22) it is back
inside the frame. **Most of what reads as a lush bank is the density and where the plant is
allowed to stand, not its size**, and those two are behind the bound where they cost
nothing extra.

Two other things the same measurement taught:

- **Order the gates cheapest-first, and make the cheap one conservative.** The fern's
  density is one octave and its shore read is three plus a conditional land read. Testing
  the density against the *best* bonus any bank could give, then the shore, then the exact
  test, keeps the shore read off every cell that could not stand anywhere.
- **`sample_footprint` decides who pays.** The voxelizer samples at 1 and the far field's
  finest cell is 2 voxels, so a gate anywhere between the two puts a feature in the meshes
  and in no brick. Undergrowth was gated at 3.3 and so lived in the finest clipmap level —
  whose window is ±256 voxels, entirely inside the near field's 512-voxel meshed radius, so
  every fern in a brick sat behind a mesh that was already drawing it. Moving the gate to
  1.5 took the far-field build's p99 from 19.2 ms to 13, and the only thing lost is that
  ferns no longer cast their own shadows, since shadow rays march those bricks.
  `src/worlds/forest_test.ts` holds the gate between the two numbers.

### GPU pass timings do not mean the same thing on an Apple GPU

The same flyover, 1080p, Chrome 152 on both machines:

| pass         | Arc B390, Linux | M3, macOS |
|--------------|-----------------|-----------|
| `gpu.near.a` | 2.10            | 2.88      |
| `gpu.far`    | 3.08            | 5.57      |
| `gpu.near.t` | 0.07            | 5.83      |
| `gpu.main`   | 0.07            | 6.23      |
| sum of p50s  | 6.49            | 21.76     |

The translucent pass draws sixty clusters and `main` draws a fullscreen triangle and a
blit. Neither is six milliseconds of work on an M3, and the giveaway is the sum: 21.76 ms
of GPU per frame in a run that held a 16.66 ms interval and **missed zero frames**. Apple's
GPU is tile-based and defers fragment work to the end of a pass, so the timestamps around a
pass do not bracket that pass's own work the way they do on an immediate-mode GPU.

So: **compare a pass against itself across a change on one machine, never across machines,
and never add the passes up on Apple.** What does carry across is the frame interval, the
missed-frame count, `stream.holes` and the CPU times, which are measured on the CPU.

### Quiet is not the same as arrived

`benchReady()` waited for the world by asking whether anything was outstanding: no queued
clipmap slabs, no streaming holes. On the dev machine that worked, because the pipelines
take two seconds to compile and by the time they land the streamer is busy. On a machine
with a warm shader cache they landed in 140 ms, and at 140 ms there were no holes because
nothing had been *asked for* yet, and no queued slabs because the clipmap had not been told
where the camera was. The gate walked straight through and the first run measured a world
still arriving: `readyMs` 140, nine missed frames, against zero for the second run.

Every check in a readiness gate has to be a positive one. It now asks that a slab has been
built and chunks are resident, as well as that nothing is queued, requested or compressing.
On the Mac that moved `readyMs` from 140 to 6469 and the first run's misses from 9 to 0; on
the dev machine, from 2052 to 6705 and from 52 to 31.

**A gate tuned on one machine is tuned to that machine's timings.** This one only showed up
because the same build ran somewhere else.

### A gitignore pattern without a leading slash matches at every depth

`bench/` in `.gitignore` was meant for the benchmark results at the repo root. A pattern
with no leading slash matches at any depth, so it also swallowed `src/bench/`: the scene
table, the runner, the session and the voxelizer bench, all of them imported by
`src/main.ts` and none of them ever committed.

Nothing local notices. `deno task check`, `test` and `build` all read the working tree,
where the files are sitting right there. The first thing that sees the repo as a repo is
CI, which checks out and fails on three `TS2307 Cannot find module` errors for files you
can open in your editor.

`/bench/` is the fix: anchored, so it means the one at the root and nothing else.

**Two habits worth keeping:**

- After touching `.gitignore`, ask what else the pattern caught:
  `git ls-files --others --ignored --exclude-standard -- src/` lists source files that can
  never reach CI. It should be empty.
- To check a build against what git actually has rather than what is on disk, copy the
  index into a scratch directory and run the tasks there:

  ```
  git ls-files -z | xargs -0 -I{} sh -c 'mkdir -p "$2/$(dirname "$1")" && cp "$1" "$2/$1"' _ {} /tmp/stage
  cd /tmp/stage && deno task check && deno task test && deno task build
  ```

  That is the same view the runner gets, and it takes a minute instead of a push.

### A fixed render size is stretched to the window, and a stretched pixel is not square

`?size=WxH` sets the backing store and nothing else. The element was laid out at
`width: 100vw; height: 100vh`, so the browser scaled the frame by one factor across and
another down, and what the picture looked like depended on the window: a 1920x1080 render
in a square window is squashed to 56% of its width. Every `?bench=` run is a fixed size
too, 1920x1080 by default, so this was the normal case, not an odd one.

Nothing about it is loud. The scene still draws, the numbers are still right, and the
projection is correct for the render target; only the last step, laying the image out on
the page, is wrong. It shows up as a circle that is an ellipse and a bird that is fatter
than it should be, both of which read as "the model is a bit off" rather than "the CSS is
wrong".

The canvas now carries the render target's aspect and fits inside the window
(`canvas.fit` in `index.html`, set by `applySize()` in `src/main.ts`). The rule that
does it is worth reading before changing:

```css
canvas.fit { width: min(100vw, calc(100vh * var(--fit-aspect))); height: auto; }
```

The obvious spelling, `width: 100vw; height: auto; max-height: 100vh`, is wrong in one
direction only. An aspect ratio transfers a min or max constraint into an axis that is
`auto`, and here the width was stated outright, so clamping the height left the width at
100vw: a tall window letterboxed correctly and a short wide one stretched exactly as
before. The bug hid behind whichever window shape it was first tried in.

**A pointer maps through the element, not the render target.** `pickBirdAt()` and the
wheel dolly take NDC from `getBoundingClientRect()` and the aspect from `canvas.width /
canvas.height`, which was written to survive the stretch and now agrees with the element
anyway. Both spaces are needed: the rect says where the cursor is on the image, the render
target says what shape the image is.

### `deno task build` disarms the dev server that is already running

`serve.ts --dev` serves `dist/`, and `deno task build` writes a release bundle into the
same `dist/`. Run a build while a dev server is up and it keeps serving, keeps reloading,
and quietly hands out a bundle with the dev-only paths compiled out of it: saving a
benchmark result is the one that shows, because `__BENCH_SAVE__` is false in a release
build and the overlay then says `not saved` on a machine that has the very server the save
needs.

It heals itself the moment a source file changes, because the watcher rebuilds in dev
mode, so the symptom appears and vanishes without anything being fixed. `deno task docs`
runs `deno task build` first, so previewing the published site does it too.

**A trailing newline is not a change.** esbuild's watcher compares contents, so `touch`
will not trigger the rebuild that puts the dev bundle back. Change a byte, or restart
`deno task dev`.

### A frame counter incremented once for two different draws

The gizmo's block ended with `counters.draws += 2`, and the second one was not the
gizmo's: it stood in for the sky or preview blit drawn earlier, which had no increment of
its own. Nothing said so. The moment the gizmo became conditional the background stopped
being counted whenever the gizmo was off, and `draws` in the overlay dropped by two for a
switch that removes one draw.

**Increment the counter next to the draw it counts.** A tally collected somewhere
convenient is correct exactly until one of the things it tallies becomes optional, and the
overlay is where a wrong count is least likely to be questioned.

### A missing callback rendered a world with no chunks in it, and it looked fine

Extracting `Voxler` from `main.ts` left four callbacks behind: `pool.on("chunk.compress")`,
the `MESH_JOB` handlers, `streamer.listener`, and `streamer.voxelStage`. The first is the
one that matters: without it a compressed chunk never reaches the `ChunkStore`, so the
store stayed empty, nothing was ever meshed, and the near field had nothing to draw.

What makes this worth writing down is that the page looked right. The far field samples the
world function straight into its clipmap and needs no chunks at all, so it drew the terrain
on its own: a complete-looking world, from the right function, at the right place, with the
horizon and the fog where they should be. The screenshots taken of it went into the
documentation. What was missing was only the near field, and without a side-by-side you do
not notice the absence of ambient occlusion and per-voxel grain in a landscape you have
never seen with it.

It surfaced sideways. A brush placed through the new API did nothing, because a field brush
reaches the world through the voxelizer and the voxelizer's output was going nowhere; a
voxel brush did nothing because `voxelStage` was the journal replay. Chasing the brush
found the chunk store empty.

**Where the near field is concerned, "it draws" is not the check.** `mesher.stats.meshes`
and `near.refreshStats().clusters` are, and both being zero while the frame looks populated
is the exact signature of this. `refreshStats()` has to be called first: `near.stats` holds
whatever it held last time, so reading it directly reports zeros that mean nothing.

**A callback chain has no type error to give you.** The store does not know about meshing,
the mesher does not know about the renderer, and the renderer is replaced wholesale on
device loss, so every link is a field assignment that compiles whether or not anyone makes
it. Two compositions of the same engine is the condition that allows one of them to be
missing a link, which is the argument for `main.ts` using `Voxler` rather than paralleling
it (plan-packaging.md phase 1).

### A round world has no up for a camera that only has yaw and pitch

`src/worlds/planet.wgsl` is a shell rather than a heightfield: the ground is
`length(p) - (RADIUS + height(direction))` and up is `normalize(p)`. The field works, the
plants scatter on it, and from orbit it is a planet. Standing on it is where it comes apart.

`FlyCamera` has a yaw and a pitch and no roll, and its up is the world's +Y
(`setOrientation` builds the basis from those two angles alone). On a sphere the local up
agrees with that in exactly two places, the poles. Anywhere else the ground is tilted by
the angle between them, and at the equator it is a wall running down one side of the frame.
The first surface screenshot of this world looked like a cliff face because it *was* the
ground, stood on end.

There is no cheap fix. Roll is not a fourth angle bolted to the other two: the camera
basis, the controls that drive it, the follow flyover and anything that assumes "up is +Y"
would all have to carry an orientation instead. What the planet does instead is open in
orbit (`look` in `src/worlds/index.ts`, added for this) and say so.

**A world whose up is not +Y needs more than a world program.** The contract in
[design-formats.md](design-formats.md) "World program" is about the field, and the field is
the easy half. The camera, and anything that reasons about height rather than radius, is
the other half.

### Fog density is what a world can be seen from, not just how hazy it looks

The planet is 5,200 voxels across and wants to be looked at from outside. Under the day
sky it was the colour of the sky: `fogDensity` 0.00035 leaves 8% of a surface at 7,300
voxels, so the whole world had mixed into the background and what was left was a faint
disc.

The far field was working perfectly and the picture was nearly empty, which is the
confusing part. Fog is applied by `apply_fog()` to every fogged voxel and to the sky
identically, so a world lost in it looks like a world that was never built.

`SPACE` in `src/render/sky.ts` is a twentieth of that density, and the planet appears. The
trade is real and is the reason it is a separate preset rather than a tweak: thin air also
means no aerial perspective at ground level, so distance there has to be carried by
something else. Note the coupling in the other direction too: `fogHorizonVoxels()` trims
the clipmap to where fog has taken the view, so lowering the density is also what buys the
levels that reach the far side of the planet (CLAUDE.md "A new world").

### A curved world is a staircase, and ambient is what stops it reading as holes

The planet's oceans came out shredded into vertical combs with black gaps, and it looked
like the far field had lost half its bricks. Three things were ruled out in turn by
switching them off: shadows (`?shadow=0`, identical), the beam pre-pass (`?farBeam=0`,
identical), and then the giveaway, which was that the *land* was combed too.

It is not missing geometry. A sphere quantised into axis-aligned voxels is a staircase, and
at a grazing angle you are looking at the risers rather than the treads. Under the `space`
sky those risers face away from the only light and have almost no fill to catch, so they go
to the same near-black as the sky behind the planet, and a step reads as a hole. The same
frame under `?sky=day` reads as terracing and nothing else, which is what proved it.

The fix was ambient, 0.16 to 0.45 in total, with the direct light left hard. **A world with
no flat ground cannot have a sky with no fill.** A heightfield never shows this because its
steps face the camera; only a curved surface turns its whole visible area into risers.

There is a ceiling on that fix, and `src/world/blocks_test.ts` found it: the first attempt
went to 0.50 and failed the test that holds every sky against the brightest emissive block,
because nothing tonemaps and a glowcap under that much fill clips to white and stops being
green. The room between "risers are black" and "glowcaps are white" is what a sky for a
curved world has to fit in.

### A Lipschitz bound is a promise about the steepest thing in the world, including the ramps

The planet declared `WORLD_LIPSCHITZ = 6` and its field reached about **54**, so region
skipping cut holes through the oceans and the coasts.

The mountains were not the problem. The problem was a smoothstep:

```wgsl
let coast = smoothstep(0.0, 0.10, land);   // a ramp over a tenth of a slow field
return (6.0 + rolling + ridges) * coast;    // multiplying up to 160 voxels of relief
```

`land` is a 1024-voxel-wavelength field, so it moves about 0.03 per voxel, so a ramp 0.10
wide spans **three voxels** and carries the whole relief across it. That is a gradient of
54 hiding inside a line that looks like a shaping detail rather than a slope.

Widening that band to 0.8 dropped the term to 4.2 and made the coastlines into continental
shelves, which looked better anyway. But the first correction was still wrong: it went to 9
having counted only three of the five terms, and the audit that followed found the rest.

    the sphere                                              1.0
    the rolling field, 42 voxels at a 256 wavelength        2.2
    the ridges, 78 at 512, doubled by their squared crests  4.1
    the `range` smoothstep, multiplying those ridges        1.0
    the `coast` smoothstep, multiplying all the relief      4.2
                                                           ----
                                                           12.5   declared: 9

**A bound is arithmetic, not a guess**, and the terms that get missed are the smoothsteps,
because they read as shaping and behave as slopes. Write the sum out where the constant is
declared, so the next person changing an amplitude can see what it was made of. The final
13 cost nothing measurable: `gpu.far.build` is 0.92 ms p50 at 9 and at 13
(`descent.20260913T174809Z`), because on this world the skipping that a tighter bound buys
was not where the time was going anyway.
