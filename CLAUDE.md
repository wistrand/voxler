# Voxler

Guidance for agents working in this repo. Read this first, then the relevant
file in `agent_docs/`.

## What this is

A WebGPU voxel engine in TypeScript and WGSL for very large worlds at high frame
rates. Worlds are WGSL programs: a signed distance function plus a material
function, sampled on the GPU at whatever resolution each consumer needs. Hybrid
renderer: chunks near the camera are voxelized from the SDF, read back, meshed with
binary greedy meshing in CPU workers, split into quad clusters, culled on the GPU
(frustum, face direction, two-phase Hi-Z), and drawn with one indirect draw by
vertex pulling from storage buffers. The far field is sampled from the SDF straight
into a brickmap clipmap, ray-marched in compute, and composited behind the near
field.

```
 world SDF (WGSL)
  ├─ voxelize (GPU) ──readback──> chunk store ──> mesh (workers) ──> quad arena ──> cull ──> draw ──┐
  │                                    │ edited chunks                                              ├──> frame
  └─ sample bricks (GPU) ──────────────┴──> clipmaps ──> ray march (compute) ───────────────────────┘
```

## Status

The foundation plan is mostly done (all phases landed; a few deferred checks
remain). SDF generation phases 1-2 (library, worlds, preview, GPU voxelizer) are
in, and phase 3 streams voxelized chunks into the `ChunkStore` (voxel data phases
1-2, plus streaming from phase 4); streaming keeps up at sprint speed over terrain
with no holes. Meshing is done, phases 1-7 (reference mesher, quad codec, coverage harness,
binary mesher with greedy merge, quad clusters, baked AO, translucency, the worker
mesh job, `MeshScheduler`, throughput: a surface chunk's mesh job takes 60-150 us,
no WASM). Streamed chunks are meshed in workers and drawn by plan-rendering phases
1-4 (range-allocated GPU arenas, two-phase GPU culling with a Hi-Z pyramid,
GPU-written indirect draws, baked AO, lighting and fog, block textures, and a
translucent pass ordered far to near). plan-rendering is done; it stays a plan for
now rather than being promoted to an architecture doc.
World modelling is done: brush records, op lists, the CPU field fold and
the instance store (`src/brush/`); chunk regeneration, which puts a resident chunk
back through the voxelizer and replaces its payload in place; and the voxel stage,
where voxel brushes and player edits are one journal replayed onto a regenerated
chunk, so edits survive regeneration; placement, a voxel raycast plus an edit tool with
undo and redo bound to the keyboard; and the field stage, where SDF and CSG brushes
are folded into the world program in the voxelizer, in the SDF preview, and in the
far-field brick builder.
The far field is done: a five-level brickmap clipmap with toroidal indirection and a
shared brick pool, sampled from the world SDF on the GPU a slab at a time as the camera
scrolls (brushes folded in, no chunks involved), reduced from chunk data in a worker for
chunks an edit has changed and from the level below for the coarse levels, marched level
by level in compute at half resolution behind a beam pre-pass, and composited behind the
near field, which wins every pixel it drew (depth) and every chunk it is drawing (a
coverage mask). The march costs 0.59 ms p50 at 1080p over the flyover bench. It stays a
plan file rather than an architecture doc for now, and stays off unless `?far=` asks for
it: nothing yet decides how far the clipmap should reach for a given machine.
Main-thread cost per frame is flat in the resident chunk count; GPU cost follows
what is drawn. Build the plans in this order. Each
plan tracks its own phases; update the status column when a plan starts or lands.

| Order | Plan                                                        | Scope                                                                  | Status      |
| ----- | ----------------------------------------------------------- | ---------------------------------------------------------------------- | ----------- |
| 1     | [plan-foundation.md](agent_docs/plan-foundation.md)         | scaffold, device and caps, frame loop, instrumentation, workers, bench | mostly done |
| 2     | [plan-sdf-generation.md](agent_docs/plan-sdf-generation.md) | WGSL SDF library, world programs, preview, GPU voxelizer, SDF bricks   | in progress |
| 3     | [plan-voxel-data.md](agent_docs/plan-voxel-data.md)         | chunk container, chunk table, streaming (generator and edits superseded) | in progress |
| 4     | [plan-meshing.md](agent_docs/plan-meshing.md)               | binary greedy meshing, clusters, AO, translucency, worker jobs         | done        |
| 5     | [plan-rendering.md](agent_docs/plan-rendering.md)           | arenas, GPU culling, two-phase Hi-Z, indirect draw, shading            | done        |
| 6     | [plan-far-field.md](agent_docs/plan-far-field.md)           | brickmap clipmap, compute ray march, composite, far-field edits        | done        |
| 7     | [plan-world-modelling.md](agent_docs/plan-world-modelling.md) | brushes (SDF, CSG, voxel), placement, the edit journal, regeneration | done        |
| 8     | [plan-living-world.md](agent_docs/plan-living-world.md)     | emissive materials, motion, a fantasy forest world program              | in progress |

The renderer plans are built; plan-living-world is where the work goes now, and it is
about what the engine draws rather than how fast.

Plans interleave: plan-sdf-generation phases 1-2 need only the foundation; its
phase 3 needs plan-voxel-data phases 1-2, and its phase 4 needs plan-far-field
phases 1 and 3. The rendering plan's phase 1 spike can run right after the
foundation. plan-world-modelling needs only what is already done (the world
contract, the voxelizer, the chunk store), and it takes over raycast and edits from
plan-voxel-data phase 5. When a plan lands, promote it to `agent_docs/architecture-<sub>.md`,
delete the plan file, and note the move here.

## Layout

Directories under `src/` are created by the phase that first puts a file in them;
today `src/gpu/`, `src/render/`, `src/camera/`, `src/util/`, `src/debug/`,
`src/workers/`, `src/bench/`, `src/sdf/`, `src/worlds/`, `src/mesh/`, `src/brush/`, `src/far/`, and `src/world/`
(`coords.ts`, `blocks.ts`, `chunk.ts`, `keys.ts`, `chunk-table.ts`, `arena.ts`,
`store.ts`, `streaming.ts`, `mesh-scheduler.ts`) exist.

| Path             | Role                                                           |
| ---------------- | -------------------------------------------------------------- |
| `src/main.ts`    | entry point, frame loop                                        |
| `src/camera/`    | fly camera state (pure) and input controls                     |
| `src/gpu/`       | device setup, caps probe, pipeline and resource helpers        |
| `src/world/`     | block registry, chunk container, chunk table, streaming, mesh scheduling |
| `src/sdf/`       | WGSL SDF library, GPU voxelizer, sphere-traced preview         |
| `src/worlds/`    | world programs (`<name>.wgsl`, selected with `?world=`)        |
| `src/brush/`     | brush records and op lists, the CPU and WGSL field folds, the voxel stage, the instance store, the edit tool |
| `src/mesh/`      | binary greedy mesher, reference mesher, clusters, mesh job (worker-side, pure) |
| `src/render/`    | arenas, cull and draw passes, Hi-Z, shading, block textures     |
| `src/far/`       | brick builder, clipmaps, far-field march and composite         |
| `src/workers/`   | `WorkerPool`, job queue, buffer pool, the worker, job handlers |
| `src/util/`      | math, ring buffers, timers                                     |
| `src/debug/`     | overlay (caps, stats, camera, errors) and frame `Stats`        |
| `src/bench/`     | benchmark scenes, runner, session                              |
| `bench/results/` | dated benchmark result files (generated, committed)            |
| `index.html`     | page shell, copied to `dist/` by the build                     |
| `build.ts`       | esbuild bundling (`buildRelease()`, `watch()`)                 |
| `serve.ts`       | static server for `dist/` with COOP/COEP headers               |
| `dist/`          | build output, gitignored                                       |
| `agent_docs/`    | deep dives (linked below)                                      |

WGSL lives next to the TS that owns the pipeline (`src/render/cull.wgsl`, ...).

## Commands

```bash
deno task dev      # watch build + serve from 127.0.0.1:8000, or the next free port; PORT=<n> pins it
deno task build    # clean release bundle into dist/; fails on any esbuild warning
deno task serve    # serve an existing dist/ without rebuilding
deno task check    # type-check src/, build.ts, serve.ts
deno task test     # unit tests; GPU tests use Deno's built-in WebGPU (skip without an adapter)
deno task bench    # kernel benchmarks (meshing, palette compression, reduction)
```

Server env for `dev` and `serve`: `HOST` (bind address, default `127.0.0.1`), `PORT`,
and `TLS_CERT` + `TLS_KEY` (PEM paths). Certs live in the gitignored `.certs/`; the
`serve` task can read only `dist` and `.certs`, so never widen its `--allow-read` to
reach certs elsewhere. Any non-loopback `HOST` needs TLS, because WebGPU only exists
in secure contexts. For the tailnet, generate the pair with
`tailscale cert --cert-file .certs/tailnet.crt --key-file .certs/tailnet.key <machine>.<tailnet>.ts.net`
(run under sudo, `chown` the files back to your user), bind `HOST` to the machine's
Tailscale IP, and open the `ts.net` name. Certs last 90 days.

Browser checks: `.mcp.json` configures `chrome-devtools-mcp`, so a session with
that MCP server can open the page, read the overlay, and run benchmarks itself.
Always open the `ts.net` hostname, never the Tailscale IP: the certificate names
the hostname, and an IP URL fails validation in a fresh profile. The server
launches its own Chrome with an isolated profile (no flags, per the
"flag-free browser profile" invariant); to drive the browser you already have
open, start Chrome with `--remote-debugging-port=9222` and add
`--browserUrl http://127.0.0.1:9222` to the server's args instead of
`--isolated`.

URL switches: `?world=<name>&seed=<n>` picks the world program (`showcase`, `terrain`, `forest`;
default `showcase`); `?defaultLimits` requests no raised limits (tests the default-limits
invariant); `?at=x,y,z` starts the camera at a world position; `?workers=n` sets
the pool size; `?workerTest` runs the worker pool self-test into the overlay;
`?jobBatch=n` caps jobs per worker message (1 disables batching);
`?size=WxH` renders at a fixed size; `?previewScale=0.1..1` sets the SDF preview's
resolution (default 0.5); `?preview=0` starts with the preview off; `?voxelBench` measures voxelizer throughput around the
spawn and saves the result; `?voxelSlots=n` sets voxelizer readback slots (default 8);
`?stream=0` turns chunk streaming off; `?streamRadius=n` and `?streamHeight=n` set
the load range in chunks (default 16 and 6); `?arenaMB=n` sizes chunk memory
(default 128); `?regen=n` regenerates n random resident chunks a frame (the soak
test for chunk regeneration) and `?regenCheck` compares each replacement against the
chunk it replaces (`stream.regenDiffer`); `?mesh=0` turns meshing off; `?cull=n` sets the cull mask (1
frustum, 2 face direction, 4 occlusion: 0 draws everything, 3 skips the Hi-Z test,
7 is the default); `?cullCheck` compares the drawn frame against an unculled draw
every 30 frames (overlay `near` line, `near.cullCheck*` in bench results);
`?clusterQuads=n` sets the cluster size (default `CLUSTER_QUADS`);
`?clusterOrder=morton` orders cluster quads by Morton code instead of mesher
order; `?nearMB=n`
sizes the near-field quad arena (default 64); `?ao=0` meshes and draws without
baked AO (the phase 5 A/B; it also drops the mesh job back to 6 neighbors); `?tex=0`
draws flat block colors instead of sampling the block textures; `?glow=0` drops block
emission and `?wind=0` holds swaying blocks still; `?far=on|steps|bricks|levels`
turns the far field on and picks its debug view (F queues every clipmap level again);
`?farLevels=n` sets the level count, `?farFirst=k` the finest level's cell size
(2^k voxels), `?farBricks=n` the brick pool capacity, `?farSlabs=n` the brick slabs
sampled per frame, `?farScale=0.1..1` the march resolution as a fraction of the frame
and `?farBeam=0` turns the beam pre-pass off; `?farCheck` compares the sampled bricks
against the same region reduced from resident chunk data; `?preview=1`
forces the SDF preview on (it starts off while meshes are drawn). Look by dragging
(mouse or touch); the wheel flies forward and back, and +/- change the speed. Keys:
F2 overlay,
P SDF preview, G grid, M meshes, F rebuild far-field bricks; editing: E place, Q remove, R rotate (Shift+R the
other way), B block, X shape, Z undo, Y redo, aimed by the camera ray (overlay `edit`
line).
Console handle: `voxler` (`gpu`, `renderer`, `camera`, `pool`, `store`, `streamer`,
`mesher`, `brushes`, `tool`, `edit`). Edits are made with the keys above, through
`voxler.tool` (`apply`, `place`, `remove`, `undo`, `redo`), or through `voxler.edit`
(`csgSphere` places a field brush), e.g.
`voxler.edit.fillBox(voxler.brushes, x0, y0, z0, x1, y1, z1, id)`; the returned id
undoes it with `voxler.brushes.remove(id)`.

Benchmarks: `?bench=<flyover|spin|teleport|cave|grove>&runs=n` on the dev server
(`grove` walks under the forest's canopy and wants `?world=forest`). Renders at
1920x1080 unless `?size` is given, stops the loop when done, and saves one JSON per
run to `bench/results/<scene>.<UTC timestamp>.<browser>.json` (dated on purpose;
never rename or edit them). Compare CPU and GPU times, not the vsync-capped frame
interval. A perf claim cites two result files, before and after. Scene paths are
offsets from the world's spawn point; `stream.holes` in each result counts chunks
near the camera that should be resident but weren't (0 means streaming kept up).

## Docs

- Plans: see the Status table above.
- [agent_docs/design-formats.md](agent_docs/design-formats.md): coordinate spaces, chunk storage, packed quad, cluster descriptor, chunk table, camera uniform, world program contract, brick layout. Read before changing any encoder, WGSL decode, or world file.
- [agent_docs/research-voxel-rendering.md](agent_docs/research-voxel-rendering.md): options weighed for meshing, draw submission, culling, far field, SDF generation, language; why each choice won.
- [agent_docs/research-webgpu-support.md](agent_docs/research-webgpu-support.md): dated snapshot of WebGPU support per browser and OS, optional features, limits, Linux dev setup. Re-check before relying on version numbers.
- [agent_docs/gotchas.md](agent_docs/gotchas.md): JS, worker, WebGPU, and WGSL traps. Skim before touching workers, uploads, shaders, or the frame loop.

## Invariants

- Never allocate in the per-frame path. Preallocate typed arrays, matrices, queues,
  descriptors, and bind groups. No array or object literals, closures, or spread per
  frame. GC pauses show up as p99 spikes.
- Per-frame CPU work scales with changes (new meshes, edits, clipmap slabs), never
  with the number of resident chunks or clusters. Anything that touches every
  resident item each frame runs in compute.
- Never mesh, palette-compress, or reduce bricks on the main thread; generation runs
  on the GPU. The main thread does input, scheduling, uploads, and command encoding.
- Never await a GPU readback (`mapAsync`) in the frame path. Readbacks (stats,
  voxelized chunks) resolve frames later and are consumed when they arrive.
- Never send absolute world coordinates to the GPU as f32. World positions are
  integers on the CPU; shaders subtract the camera chunk in `i32` and convert last.
- Generation is a pure function of (world program, seed, brush set, position),
  evaluated in WGSL. Output is identical across runs on one machine and browser;
  surface voxels may differ between GPU vendors (f32). Tests assert properties, never
  hashes from another machine.
- A world is evaluated in two stages, always in this order: the field stage (terrain
  SDF plus SDF and CSG brushes, on the GPU) and then the voxel stage (voxel brushes
  and edits, replayed from the journal on the CPU). Regenerating a chunk is stage 1
  followed by a replay of stage 2, which is what makes edits survive regeneration.
  Never mutate a stored chunk without journaling the op
  ([plan-world-modelling.md](agent_docs/plan-world-modelling.md)).
- `world_sdf` and every brush may underestimate the distance to a surface, never
  overestimate it. Region skipping needs only that the field is Lipschitz, so a
  bounded brush returns the distance to its own box outside that box; returning a
  large constant there silently deletes the brush.
- Region skipping is conservative: skip a chunk, sub-block, or cell only when
  `|d| > WORLD_LIPSCHITZ * half diagonal`. A wrong skip silently deletes terrain.
- Never reuse a shared-arena block a worker may still read. In shared mode the
  store defers frees and `MeshScheduler` reclaims them after the jobs that could
  read them settle; a new job kind reading the arena in place needs the same stamps
  ([gotchas.md](agent_docs/gotchas.md) "A shared arena block can be reused under a
  running worker").
- Binary formats have one owner, [design-formats.md](agent_docs/design-formats.md).
  Change an encoder and its decoder (worker and WGSL) in the same change.
- Core WebGPU at default limits is the baseline. Optional features
  (`timestamp-query`, `subgroups`, `shader-f16`, ...) and raised limits are read from
  `caps`, and the engine has a working path without them.
- Always request the core feature level. Compatibility mode has no vertex-stage
  storage buffers, so vertex pulling can't run there.
- Never rely on multi-draw indirect or anything behind `--enable-unsafe-webgpu`.
  Test in a flag-free browser profile.
- Hot CPU kernels (meshing, palette compression, reduction) are pure functions over typed
  arrays with no DOM or GPU access, so they run in workers, in `deno test`/`deno bench`,
  and can move to WASM unchanged in shape.
- The reference mesher is never deleted. Greedy mesher output must match it in
  face coverage.
- Occlusion culling stays two-phase. Single-phase Hi-Z shows holes on fast turns.
- A change presented as a performance improvement includes before and after numbers
  from the bench harness.

## Target platforms

WebGPU only, no WebGL fallback. Primary: Chrome/Edge desktop (Windows, macOS,
ChromeOS, Linux on allowlisted Intel and NVIDIA GPUs) and Safari 26 on macOS 26 and
iOS 26. Secondary: Firefox on Windows and Apple Silicon macOS. Details and exclusions
in [research-webgpu-support.md](agent_docs/research-webgpu-support.md).

## Performance targets

Measured on the dev machine (Intel Arc B390 iGPU, Chrome 152 on Linux) at 1920x1080
with everything on: near field, far field, textures, baked AO, translucency. Dated
2026-09-12, results in `bench/results/*.20260912T1630*` and `flyover.20260912T163338Z`. Never
compare the vsync-capped `interval`; compare CPU frame time and the GPU passes. Rerun
the four scenes after any change that claims a frame-time effect.

| Metric                                     | Target                                  | Measured                                        |
| ------------------------------------------ | --------------------------------------- | ----------------------------------------------- |
| Frame time, dev machine (Arc B390, 120 Hz) | under 8.3 ms (hold 120 Hz)              | held in all four scenes (interval p99 8.34)     |
| GPU per frame, flyover                     | under 8.3 ms                            | 2.9 ms (sum of pass p50s); spin 3.7, cave 3.5   |
| Frame time, integrated GPU (M1, Iris Xe)   | under 16.7 ms                           | unmeasured, no hardware                         |
| Frame time, discrete GPU                   | under 7 ms                              | unmeasured, no hardware                         |
| Main-thread CPU per frame                  | under 2 ms, flat in resident chunks     | p50 0.35-1.58; p99 0.73-4.86, over in scenes that stream hard |
| Near-field meshed radius                   | 16 chunks (512 voxels) horizontally     | as configured (`?streamRadius`)                 |
| Far-field view distance                    | 32k voxels                              | 32,768 (8 clipmap levels), 21.7 MiB of bricks   |
| Mesh throughput, surface chunk             | under 0.5 ms per chunk per worker       | 60-150 us (plan-meshing phase 7)                |
| Mesh memory                                | 8 bytes per quad plus cluster padding   | 8.3% padding over the flyover                   |
| Streaming                                  | no visible holes at sprint flight speed | `stream.holes` 0 in flyover, spin and cave      |

Where the frame goes at 1080p, flyover p50: far-field march 0.85 ms, far-field slab
sampling 0.66, near-field opaque draw 0.66, translucent cull 0.33, far-field beam 0.13,
Hi-Z 0.13, everything else under 0.07. The flyover run that holds the whole frame
(interval p50 through max all 8.34, no missed frames) is `flyover.20260912T163338Z`. The empty-scene baseline is CPU 0.12 ms p50, GPU 0.25
(plan-foundation phase 6).

Two numbers are over target and both are the same thing: CPU frame p99 is 3.6 ms in the
flyover and 4.9 in the teleport, against a 2 ms target. That is the main thread applying
mesh results and uploading them in bursts, not steady-state work; p50 is 0.8 and 1.6.
The teleport also shows `stream.holes` 147 for one frame after each jump, which is the
near field having nothing yet: the far field draws through it, so what it costs is
detail for a few frames, not a hole in the world.

## Conventions

- TypeScript strict, ES modules, Deno toolchain; browser bundle via esbuild.
- Never add a runtime dependency without asking. Math, noise, and GPU helpers are
  written in-repo to keep control of allocation and bundle size.
- WGSL shaders are `.wgsl` files imported with `with { type: "text" }`. Every GPU
  object gets a `label`.
- Surfaces are lit and fogged by `surface_light()` and `apply_fog()` in
  `src/render/shading.wgsl`; never write a second lighting model, or the near
  field, the preview, and the far field drift apart.
- Compile shaders with `compileShader()` and build pipelines with
  `createRenderPipeline()` from `src/gpu/shader.ts`, so failures reach the overlay.
  Pass `camera.wgsl` as the first source for any shader that reads the camera;
  errors are reported against the original file and line.
- Import `src/gpu/globals.ts` (side effect) in any file that uses `GPUBufferUsage`,
  `GPUTextureUsage`, `GPUShaderStage`, or `GPUMapMode`; the bundled DOM lib lacks
  their types. Never replace them with numeric literals.
- All GPU resources hang off `Renderer` (or objects it owns). Device loss discards
  it and builds a new one; never cache GPU objects outside it.
- A new render or compute pass that should be timed gets an entry in
  `TIMED_PASSES` in `renderer.ts` and `timer.passWrites(i)` on its descriptor. Call
  `passWrites` only when the pass is actually encoded that frame; skipped passes are
  simply not timed. A new per-frame count goes in `FrameCounters`
  (`src/debug/stats.ts`).
- Tests are `*_test.ts` and benchmarks `*_bench.ts`, next to the code they cover.
- Never use pointer lock. Camera look is drag-to-look with pointer capture, and the
  overlay receives pointer events so its text can be selected and copied.
- Key bindings match `KeyboardEvent.code` (physical position) so WASD works on any
  layout. Keys shown by label in help text must have the same label everywhere
  (letters, Space, Shift, F-keys); never bind punctuation keys like Backquote by code.
  A binding whose meaning is the *symbol* rather than the position (+ and - for speed)
  reads `KeyboardEvent.key` instead, and accepts the unshifted character too (`=` for
  `+`), so it works wherever the layout puts it.
- Worker entry points are `src/workers/<name>.worker.ts`; the build emits each as
  `dist/workers/<name>.worker.js`, and `new Worker(new URL(...))` must use that
  output path. See `workerEntries()` in `build.ts`. Restart `deno task dev` after
  adding a worker file.
- New CPU work is a job kind, not a new worker: add a handler to `HANDLERS` in
  `src/workers/jobs.ts` and a result handler with `pool.on(kind, ...)`. Output
  buffers come from `ctx.alloc()`; the consumer returns them with `pool.recycle()`
  (queued, sent back once per frame by `pool.flushRecycled()` in the frame loop).
  Key jobs by what they compute (chunk key) and pass a version that increases on
  every change, so stale results drop. Build a fresh input object and transfer array
  per job: the pool holds both until the job is dispatched
  ([gotchas.md](agent_docs/gotchas.md) "A job's input and transfer list").
- Keep worker messages few and small: every `postMessage` costs the main thread
  tens of microseconds (gotchas.md "postMessage is expensive"). The pool already
  batches jobs, results, and returned buffers; name shared buffers by id
  (`pool.share()`, `sharedBuffer()` in workers) instead of putting a
  `SharedArrayBuffer` in each job, and batch anything else where a message per
  item would do.
- WebGPU calls live only in `src/gpu/`, `src/render/`, `src/sdf/`, and `src/far/`.
- A new block texture is one entry in `TEXTURES` (`src/render/textures.ts`), painted
  in code; blocks name it in their `texture` triple as [top, side, bottom]. No image
  assets: textures are generated at startup.
- A new world is `src/worlds/<name>.wgsl` plus one line in `WORLDS`
  (`src/worlds/index.ts`), following design-formats.md "World program". Check it
  in the preview (P) first: an underestimated `WORLD_LIPSCHITZ` shows as holes there.
  A new block type is one entry in `BLOCKS` (`src/world/blocks.ts`); worlds see it as
  `BLOCK_<NAME>`. A block that glows carries an `emission` colour, added to the lit
  surface by the near field, the preview and the far field alike; keep it small enough
  that lit plus emission stays under 1, because nothing tonemaps and the block would
  clip to white.
- Use explicit bind group layouts for shared resources, not `layout: "auto"`.
- Terminology: *voxel* (one cell), *block id* (its `u16` type), *chunk* (32^3
  voxels), *quad* (one packed greedy face), *face group* (a chunk's quads for one
  direction), *cluster* (up to `CLUSTER_QUADS` quads of one face group, the unit of
  GPU culling), *arena* (the quad storage buffer), *brick* (8^3 far-field cells),
  *level* (a far-field clipmap level), *near field* / *far field*. Use these words,
  not synonyms.
- When a plan phase lands, tick its boxes and record measured numbers in the plan.
  To reconcile docs after a large change, ask the agent to "update the docs".

## Documentation Style

- Markdown links for doc references you want an agent to follow, not backticks.
  Backticks are fine for source paths in tables and inline code. Align table columns.
- No AI-isms (no "powerful", "seamlessly", "leverage", rule-of-three, "not just
  X but Y"). No em dashes or emojis in project copy. State the point directly.
- Concise; assume the agent is competent. Add only what it can't infer (project
  names, rules, constraints, and the why). Cut explanations of general concepts.
- State each rule on its own line as always/never; a rule buried mid-paragraph gets skipped.
- Mark inferred claims and open questions; don't present a guess as a fact.
- Once code exists, point at constants in source instead of copying their values.
- Keep this file the routing entry point; move subsystem detail into agent_docs/.
