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
field. That same clipmap is what the near field's shadow rays march, so shadows cost
no shadow map and no second draw of the scene.

```
 world SDF (WGSL)
  ├─ voxelize (GPU) ──readback──> chunk store ──> mesh (workers) ──> quad arena ──> cull ──> draw ──┐
  │                                    │ edited chunks                                              ├──> frame
  └─ sample bricks (GPU) ──────────────┴──> clipmaps ──> ray march (compute) ───────────────────────┘
                                             └──> shadow rays, marched by the draw above
```

## Status

The foundation plan is mostly done (all phases landed; a few deferred checks
remain). SDF generation phases 1-4 are in (the WGSL library, world programs, the
sphere-traced preview, the GPU voxelizer, and SDF-sampled far-field bricks); its
phase 3 streams voxelized chunks into the `ChunkStore` (voxel data phases 1-2, plus
streaming from phase 4); streaming keeps up at sprint speed over terrain with no
holes. Only the optional in-page world editor is left. Meshing is done, phases 1-7 (reference mesher, quad codec, coverage harness,
binary mesher with greedy merge, quad clusters, baked AO, translucency, the worker
mesh job, `MeshScheduler`, throughput: a surface chunk's mesh job takes 60-150 us
without block light, no WASM). Streamed chunks are meshed in workers and drawn by plan-rendering phases
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
The far field is done: a brickmap clipmap with toroidal indirection and a shared brick
pool, sampled from the world SDF on the GPU a slab at a time as the camera scrolls
(brushes folded in, no chunks involved), reduced from chunk data in a worker for chunks
an edit has changed and from the level below for the coarse levels, marched level by
level in compute at full resolution behind a beam pre-pass, and composited behind the
near field, which wins every pixel it drew (depth) and every chunk it is drawing (a
coverage mask). The march costs 0.59 ms p50 at 1080p over the flyover bench. It is on by
default (`?far=0` turns it off) and stays a plan file rather than an architecture doc for
now. A world picks its own clipmap where the defaults do not suit it (`far` in
`src/worlds/index.ts`), and the level count it gets is that trimmed to the distance its
fog closes the view at, because a level past the fog horizon marches for a result the sky
pass already drew. Blocks light the cells around them here too, gathered at the hit
rather than baked, which is the near field's job done a different way. A
controller that watches what the march and the brick sampling cost and moves the slab
budget, the level count and the march resolution to fit the frame exists
(`src/far/adapt.ts`, `?farAdapt=1`), but it is not the default: what it moves is visible
while the camera is still. Its clipmap is also what shadow rays
march ([plan-living-world.md](agent_docs/plan-living-world.md) phase 5), so turning the
far field off turns shadows off with it.
The living world is done: emissive blocks, wind in the vertex stage, the forest world
program, block light flood filled in the mesh job and baked per quad corner, per-world
sky and lighting presets (`src/render/sky.ts`) including a night with a moon, and
shadows marched against the far field's clipmap. The forest has grown since: four tree
species over three leaf greens, mountains with a rock band and snow on top, undergrowth
that climbs past the tree line as alpine scrub, ferns thickest down at the waterline,
waterfalls where a gorge and a steep step agree, jellyfish in the water, and birds over
it. The birds
are the one thing in the engine that is neither in the world SDF nor in a chunk: they
travel, and a chunk is voxelized once, so they are drawn from state a compute pass steps
each frame (`src/render/birds-*.wgsl`, six flocks of boids and four hunters working them).
Their wing beat follows the work they are doing: climbing beats fast through the whole arc,
gliding down holds the wings out and rides. They stay off the ground by asking the far
field's clipmap what is under them, which is the same occupancy the shadow rays march, so
`?far=0` takes that away with the shadows. Clicking one picks it out (amber, and a line in
the on-screen panel); clicking nothing clears it; and with one picked, the follow switch
chases it instead of the ground.
A world opts in with `birds` in `src/worlds/index.ts` and pays one more pipeline and two
more passes for it; the passes cost under the GPU timer's resolution. What those cost to get
right is in [plan-living-world.md](agent_docs/plan-living-world.md), and most of it was
about scatter and rarity rather than about shapes.
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
| 8     | [plan-living-world.md](agent_docs/plan-living-world.md)     | emissive materials, motion, a fantasy forest world, block light, night and shadows | done |
| 9     | [plan-monument-valley.md](agent_docs/plan-monument-valley.md) | the Monument Valley buttes as a world program, and the far field seen across a kilometre | in progress |

The renderer plans are built and plan-living-world has landed: what the engine draws
rather than how fast it draws it. What it left open is in that plan's phases 4 and 5
(every light in the world shares one colour, and the far field casts no shadows; it does
have block light now, gathered at the hit rather than baked, see
[plan-far-field.md](agent_docs/plan-far-field.md) "Block light") and in the grove bench,
which no longer holds 120 Hz now that it walks through the wood rather than under it.

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
`store.ts`, `streaming.ts`, `raycast.ts`, `mesh-scheduler.ts`) exist.

| Path             | Role                                                           |
| ---------------- | -------------------------------------------------------------- |
| `src/main.ts`    | entry point, frame loop                                        |
| `src/camera/`    | fly camera state (pure), input controls, and the follow flyover |
| `src/gpu/`       | device setup, caps probe, pipeline and resource helpers        |
| `src/world/`     | block registry, chunk container, chunk table, streaming, mesh scheduling |
| `src/sdf/`       | WGSL SDF library, GPU voxelizer, sphere-traced preview         |
| `src/worlds/`    | world programs (`<name>.wgsl`, selected with `?world=`)        |
| `src/brush/`     | brush records and op lists, the CPU and WGSL field folds, the voxel stage, the instance store, the edit tool |
| `src/mesh/`      | binary greedy mesher, reference mesher, clusters, baked AO and block light, mesh job (worker-side, pure) |
| `src/render/`    | arenas, cull and draw passes, Hi-Z, shading, sky presets, block textures, the bird flock |
| `src/far/`       | brick builder, clipmaps, far-field march and composite, shadow rays, the adaptive reach |
| `src/workers/`   | `WorkerPool`, job queue, buffer pool, the worker, job handlers |
| `src/util/`      | math, ring buffers, timers                                     |
| `src/debug/`     | the debug overlay (caps, stats, camera, errors), the on-screen panel (frame rate, switches, compile progress) and frame `Stats` |
| `src/bench/`     | benchmark scenes, runner, session                              |
| `bench/results/` | dated benchmark result files (generated, gitignored, local to a machine) |
| `index.html`     | page shell, copied to `dist/` by the build                     |
| `build.ts`       | esbuild bundling (`buildRelease()`, `watch()`)                 |
| `serve.ts`       | static server for `dist/` with COOP/COEP headers               |
| `dist/`          | build output, gitignored; CI copies it into the published site under `play/` |
| `agent_docs/`    | deep dives (linked below)                                      |
| `docs/`          | the GitHub Pages site: landing page and screenshots, published with a demo built in CI (`docs/README.md`) |

WGSL lives next to the TS that owns the pipeline (`src/render/cull.wgsl`, ...).

## Commands

```bash
deno task dev      # watch build + serve from 127.0.0.1:8000, or the next free port; PORT=<n> pins it
deno task build    # clean release bundle into dist/; fails on any esbuild warning
deno task serve    # serve an existing dist/ without rebuilding
deno task docs     # build, then serve the GitHub Pages site with no COOP/COEP, as Pages
                   # serves it (127.0.0.1:8001; BASE=voxler to mirror the project subpath)
deno task check    # type-check src/, build.ts, serve.ts
deno task test     # unit tests; GPU tests use Deno's built-in WebGPU (skip without an adapter)
deno task bench    # kernel benchmarks (meshing, palette compression, reduction)
```

`docs` is the only one that does not send COOP/COEP, and that is the point of it: Pages
cannot set headers, so the published site is not cross-origin isolated and
`SharedArrayBuffer` is unavailable there. Previewing with `serve` would hide that. The
engine has a path for it (the arena falls back to a plain `ArrayBuffer` and mesh jobs copy)
and `docs` is how to check it still does. It serves at `/`; `BASE=voxler` puts it under the
subpath a project site actually lives at (`https://<user>.github.io/<repo>/`), which is
worth a look after touching a path in `docs/index.html`, because an absolute one works at
the root and 404s once deployed.

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
Another machine on the tailnet can be driven too, which is how the Apple silicon row in
the performance table was measured: ssh to it, start a *second* Chrome with its own
profile and nothing else (`open -na "Google Chrome" --args --user-data-dir=/tmp/... `
`--remote-debugging-port=9222`, which keeps the flag-free-profile invariant and leaves the
one the user is looking at alone), tunnel the port back (`ssh -f -N -L 9223:127.0.0.1:9222
<host>`) and speak the DevTools protocol to it over a WebSocket. The MCP server here
launches its own local Chrome and cannot be pointed at that one mid-session. A bench run
on the far machine POSTs its result to this one like any other, so it lands in
`bench/results/` with its own browser string.
Always open the `ts.net` hostname, never the Tailscale IP: the certificate names
the hostname, and an IP URL fails validation in a fresh profile. The server
launches its own Chrome with an isolated profile (no flags, per the
"flag-free browser profile" invariant); to drive the browser you already have
open, start Chrome with `--remote-debugging-port=9222` and add
`--browserUrl http://127.0.0.1:9222` to the server's args instead of
`--isolated`.

URL switches: `?world=<name>&seed=<n>` picks the world program (`showcase`, `terrain`, `forest`,
`monument`; default `showcase`); `?defaultLimits` requests no raised limits (tests the default-limits
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
emission, `?wind=0` holds swaying blocks still, `?light=0` meshes and draws without block
light and `?shadow=0` stops marching shadow rays; `?sky=<day|night|desert>` overrides the
world's own sky and lighting preset (`src/render/sky.ts`); `?birds=0` turns the bird flock off in a world
that has one; `?far=0` turns the far
field off (it is on by default) and `?far=steps|bricks|levels` picks a debug view
(F queues every clipmap level again);
`?farLevels=n` sets how many levels are allocated (and so the most the clipmap can
reach), overriding the default, which is the world's own count trimmed to the distance
its fog closes the view at (`fogHorizonVoxels()` in `src/render/sky.ts`: levels past it
march for a result the sky pass already drew); `?farSize=n` the bricks per side of every level (a power of two: a wider level
means a finer cell at a given distance and fewer level crossings, paid for in bricks),
`?farFirst=k` the finest level's cell size (2^k voxels), `?farBricks=n` the
brick pool capacity, `?farSlabs=n` the brick slabs sampled per frame to start from,
`?farScale=0.1..1` the march resolution as a fraction of the frame (1 by default; below
it a terrace's top face is thinner than the sampling and distant contour lines break up)
and `?farBeam=0` turns the beam pre-pass off; `?farAdapt=1` lets the far field move its own
reach, slab budget and march resolution to fit what is left of the frame after every
other pass (`src/far/adapt.ts`); it is off by default because what it moves is visible
while the camera is still, and a bench run forces it off whatever the switch says; `?farCheck` compares the sampled bricks
against the same region reduced from resident chunk data; `?preview=1`
forces the SDF preview on (it starts off while meshes are drawn, and its pipelines are
built the first time it is switched on, not at startup). Look by dragging
(mouse or touch); the wheel flies towards and away from whatever the cursor is over
(not along the view: a thing can be approached without turning to face it), and +/-
change the speed. On-screen: a small panel top right with the frame rate, the switches worth reaching for
(sky, far field, shadows, meshes, SDF preview, chunk grid, the follow flyover, the debug
overlay), a line of what the world is currently holding (resident chunks and the voxels
they stand for, quads, clusters drawn against clusters live, far-field bricks) and, while
a world is still compiling its pipelines, which stages are outstanding. The counts are
built on the panel's own quarter-second tick, never in the frame path. The switches that are compiled into the shaders (the sky and shadows) reload
the page carrying the camera in `?at=`; the rest flip on the running renderer.
Click a bird to pick it out, and anywhere else to clear it; a drag is a look, not a click.
Keys:
F2 overlay (it starts hidden; an error or a bench run opens it),
K follow, which follows two different things depending on what is picked. With a bird
picked out by a click it chases that bird, trailing and looking at it, over a position
that arrives a few frames late from the GPU (`Renderer.trackedBird`); Space/C move the
camera up and down behind it, and clearing the selection ends the chase. With nothing
picked it is the ground flyover (`src/camera/follow.ts`: picks up whatever is under the
camera and flies along it, which over a stream follows the stream; while it runs, +/- set
its speed, Space/C raise and lower it, and dragging re-aims it, all through the same keys
that fly the camera by hand. It never passes under a surface or through anything: a
corridor probe ahead of the flight lifts it over what is coming, and `speed` is speed
through the air, so a climb is taken out of the forward step rather than added to it),
P SDF preview, G grid, M meshes, F rebuild far-field bricks; editing: E place, Q remove, R rotate (Shift+R the
other way), B block, X shape, Z undo, Y redo, aimed by the camera ray (overlay `edit`
line).
Console handle: `voxler` (`gpu`, `renderer`, `camera`, `controls`, `follow`, `pool`,
`store`, `streamer`, `mesher`, `brushes`, `tool`, `edit`). Edits are made with the keys above, through
`voxler.tool` (`apply`, `place`, `remove`, `undo`, `redo`), or through `voxler.edit`
(`csgSphere` places a field brush), e.g.
`voxler.edit.fillBox(voxler.brushes, x0, y0, z0, x1, y1, z1, id)`; the returned id
undoes it with `voxler.brushes.remove(id)`.

Benchmarks: `?bench=<flyover|spin|teleport|cave|grove>&runs=n` on the dev server
(`grove` walks under the forest's canopy and wants `?world=forest`). Renders at
1920x1080 unless `?size` is given, stops the loop when done, and saves one JSON per
run to `bench/results/<scene>.<UTC timestamp>.<browser>.json` (dated on purpose;
never rename or edit them). `bench/` is gitignored, so the files are local to whichever
machine produced them and nobody else can open the one a claim names. Compare CPU and GPU
times, not the vsync-capped frame interval. **A perf claim carries the numbers themselves,
in the doc, with the two result files named beside them as a local pointer.** A claim that
is only a pair of filenames is unreadable to anyone but the machine it was made on.
Scene paths are offsets from the world's spawn point, so always check the spawn still stands on the
ground after changing a world's terrain: a stale one runs the whole scene underground
and every number it produces is for an empty frame
([gotchas.md](agent_docs/gotchas.md)). `stream.holes` in each result counts chunks
near the camera that should be resident but weren't (0 means streaming kept up).

## Docs

- Plans: see the Status table above.
- [agent_docs/design-formats.md](agent_docs/design-formats.md): coordinate spaces, chunk storage, packed quad, cluster descriptor, chunk table, camera uniform, world program contract, brick layout. Read before changing any encoder, WGSL decode, or world file.
- [agent_docs/research-voxel-rendering.md](agent_docs/research-voxel-rendering.md): options weighed for meshing, draw submission, culling, far field, SDF generation, language; why each choice won.
- [agent_docs/research-voxel-engine-comparison.md](agent_docs/research-voxel-engine-comparison.md): how voxler sits against other voxel engines, and a ranked list of techniques from them worth borrowing for the far field.
- [agent_docs/research-webgpu-support.md](agent_docs/research-webgpu-support.md): dated snapshot of WebGPU support per browser and OS, optional features, limits, Linux dev setup. Re-check before relying on version numbers.
- [agent_docs/gotchas.md](agent_docs/gotchas.md): JS, worker, WebGPU, and WGSL traps. Skim before touching workers, uploads, shaders, or the frame loop.

## Invariants

- Never allocate in the per-frame path. Preallocate typed arrays, matrices, queues,
  descriptors, and bind groups. No array or object literals, closures, or spread per
  frame. GC pauses show up as p99 spikes. Reading voxels is the easy one to miss:
  `ChunkStore.read()` builds five objects a call, so anything walking voxels goes through
  `blockAt`/`blockAtSlot` and holds the slot across a column
  ([gotchas.md](agent_docs/gotchas.md) "Reading one voxel through `ChunkStore.read()`").
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
  Change an encoder and its decoder (worker and WGSL) in the same change. A stride written
  out by hand in a shader is not connected to its TypeScript constant by anything, and
  missing one reader is silent, so each such format has a test that reads the shaders and
  checks the arithmetic: `src/world/block-table_test.ts` for the block table's four
  readers, `src/far/brick-layout_test.ts` for the brick and clipmap layout's three
  (`far.wgsl`, `shadow.wgsl`, `far-build.wgsl`). Add the reader to the test in the same
  change that adds the reader.
- Baked per-corner values (AO, block light) join the mesher's merge key. Adding one
  fragments quads wherever it varies, which is a memory and draw cost, not just a
  shading one; measure the quad count, not only the frame time.
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
- Shadow rays read the far field's clipmap, so shadows exist only where it is built:
  `?far=0` turns them off with it, and nothing outside the clipmap's window casts one.
- A change presented as a performance improvement includes before and after numbers
  from the bench harness, written out where the claim is. `bench/` is gitignored, so the
  result files are local to one machine: naming them is a pointer, never the evidence.
- Anything that adapts to measured cost is off during a bench run. A setting that moves
  under the measurement makes two results incomparable, which is worse than the setting
  being wrong.

## Target platforms

WebGPU only, no WebGL fallback. Primary: Chrome/Edge desktop (Windows, macOS,
ChromeOS, Linux on allowlisted Intel and NVIDIA GPUs) and Safari 26 on macOS 26 and
iOS 26. Secondary: Firefox on Windows and Apple Silicon macOS. Details and exclusions
in [research-webgpu-support.md](agent_docs/research-webgpu-support.md).

## Performance targets

Measured on the dev machine (Intel Arc B390 iGPU, Chrome 152 on Linux) at 1920x1080 with
everything on: near field, far field, textures, baked AO, block light, shadows,
translucency. Dated 2026-09-12, results in `bench/results/*.20260912T183*`, except the
flyover, whose current numbers are `flyover.20260912T201507Z`. Never compare
the vsync-capped `interval`; compare CPU frame time and the GPU passes. Rerun the four
terrain scenes after any change that claims a frame-time effect, and `grove` as well for
anything that touches the forest. A run starts only once the world is there: every result
carries `readyMs`, and one without that field predates the gate and its first run is
suspect ([gotchas.md](agent_docs/gotchas.md) "A bench that starts before the world is
built").

**The table has been overtaken and only the forest has been re-measured.** It is the
18:35 snapshot. Since then the far field marches at full resolution by default and carries
block light, and the same terrain flyover re-run at 20:15
(`flyover.20260912T201507Z` against `flyover.20260912T183537Z`) costs `gpu.far` 3.08 ms
p50 against 0.79 and CPU frame 1.36 p50 against 0.71, and misses 46 frames of 1151 where
the older run missed 2: the flyover no longer holds 120 Hz. `spin`, `cave` and `teleport`
were not re-run and their rows are from before that change, and none of the four predates
the readiness gate, so their first runs are suspect. The forest's own rows are current:
the grove was re-measured on 2026-09-13 after the world gained mountains, a fourth tree
species, falls and a different scatter and its spawn moved to 188
(`grove.20260913T091555Z`). Re-run the four terrain scenes before quoting them.

| Metric                                     | Target                                  | Measured                                        |
| ------------------------------------------ | --------------------------------------- | ----------------------------------------------- |
| Frame time, dev machine (Arc B390, 120 Hz) | under 8.3 ms (hold 120 Hz)              | flyover misses 46 frames of 1151 since the far field went full resolution; spin, cave and teleport held it when last run (interval p99 8.34); the grove misses 12 of 1425 |
| GPU per frame, flyover                     | under 8.3 ms                            | 6.3 ms (sum of pass p50s, 20:15 run; 4.0 before the full-resolution march); spin 4.5, cave 3.8, teleport 2.5, all from 18:35 |
| Frame time, integrated GPU (Apple silicon) | under 16.7 ms                           | met: an M3 on macOS 26.4.1 (Chrome 152, `apple / metal-3`) holds its 60 Hz panel with 0 missed frames in both flyover and grove; CPU frame 1.18 and 0.47 p50. Its pass timings are not comparable to the rows above ([gotchas.md](agent_docs/gotchas.md) "GPU pass timings do not mean the same thing on an Apple GPU") |
| Frame time, discrete GPU                   | under 7 ms                              | unmeasured, no hardware                         |
| Main-thread CPU per frame                  | under 2 ms, flat in resident chunks     | p50 0.34-1.69; p99 0.70-5.26, over in scenes that stream hard |
| Near-field meshed radius                   | 16 chunks (512 voxels) horizontally     | as configured (`?streamRadius`)                 |
| Far-field view distance                    | as far as the fog, no further           | levels are trimmed to the sky's fog reach per world (`levelsForReach`), so a world sets `far` and gets the levels it can see; 21.7 MiB of bricks in terrain, 7.0 in the forest |
| Mesh throughput, surface chunk             | under 0.5 ms per chunk per worker       | 60-150 us without block light (plan-meshing phase 7) |
| Mesh memory                                | 8 bytes per quad plus cluster padding   | 10.4% padding over the flyover                  |
| Streaming                                  | no visible holes at sprint flight speed | `stream.holes` 0 in all five scenes             |

Where the frame goes at 1080p, flyover p50 (`flyover.20260912T201507Z`): far-field march
3.08 ms, near-field opaque draw 2.10 (about 1.2 of that is shadow rays, measured at 18:35),
far-field slab sampling 0.59, translucent cull 0.26, beam pre-pass 0.13, everything else
under 0.07. The march is the largest pass in the frame since it went full resolution;
`?farScale=0.5` is the switch that buys it back, at the cost of distant contour lines
breaking up. The empty-scene baseline is CPU 0.12 ms p50, GPU 0.25 (plan-foundation
phase 6).

Four things are over target, and each is recorded where it belongs rather than smoothed
away here:

- **The far-field march is 3.08 ms p50** in the flyover, near 40% of the frame's GPU time,
  since it went to full resolution and picked up block light. What it bought is distant
  terraces and contour lines that survive the distance; whether that trade holds on a
  slower GPU is unmeasured.
- **CPU frame p99**, 3.7 ms in the flyover and 5.3 in the teleport against a 2 ms target.
  That is the main thread applying mesh results and uploading them in bursts, not
  steady-state work; p50 is 1.4 and 1.6.
- **The grove bench's far-field build spikes.** 4.98 ms p50 and 19.2 p99 in a world an
  order richer than terrain, which is what misses 12 frames of 1425
  (`grove.20260913T091555Z`); `?farSlabs=1` trades the p99 for a slower catch-up. Two
  earlier readings of this scene were wrong in opposite directions and both are recorded:
  runs that walked underground ([gotchas.md](agent_docs/gotchas.md) "The grove bench
  walked 44 voxels underground") and runs that started before the world was built
  (same file, "A bench that starts before the world is built").
- **Shadows cost about 1.2 ms** of the near-field draw at 1080p: flyover `gpu.near.a`
  0.72 ms p50 with `?shadow=0` and 1.90 without it
  (`flyover.20260912T184002Z` against `flyover.20260912T183537Z`). Whether that is worth
  paying is a per-machine call the engine does not make yet.

## Conventions

- TypeScript strict, ES modules, Deno toolchain; browser bundle via esbuild.
- Never add a runtime dependency without asking. Math, noise, and GPU helpers are
  written in-repo to keep control of allocation and bundle size.
- WGSL shaders are `.wgsl` files imported with `with { type: "text" }`. Every GPU
  object gets a `label`.
- Whatever `apply_fog()` mixes toward must be continuous and smooth in the view
  direction. It is not only the sky: it is part of the shade of every fogged voxel, so a
  step in it is a line drawn across the frame
  ([gotchas.md](agent_docs/gotchas.md) "A step in the sky's colour").
- Surfaces are lit and fogged by `surface_light()` (or `surface_light_shadowed()`,
  which is the same light with the direct term scaled) and `apply_fog()` in
  `src/render/shading.wgsl`, over constants a world's sky preset generates
  (`src/render/sky.ts`); never write a second lighting model, or the near field, the
  preview, and the far field drift apart.
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
- Take a pointer's position from `clientX`/`clientY` against `getBoundingClientRect()`,
  never from `offsetX`/`offsetY`: the two disagree under browser zoom
  ([gotchas.md](agent_docs/gotchas.md) "`offsetX` on a pointer event").
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
  That line also carries the world's sky preset, whether it has birds over it (`birds`,
  `src/render/birds-common.wgsl`) and, when the defaults do not suit it, its clipmap
  (`far`). Reach, cell size and fog density are one decision and not three:
  the fog has to have taken the view before the last level ends
  ([gotchas.md](agent_docs/gotchas.md) "A wider clipmap level can be cheaper than a
  narrower one"). The level count asked for here is a ceiling, trimmed at startup to the
  world's fog horizon; the direction that is not automatic is the other one, a world whose
  reach is shorter than its fog, which cuts visibly and needs thicker air.
  A new block type is one entry in `BLOCKS` (`src/world/blocks.ts`); worlds see it as
  `BLOCK_<NAME>`; a name that is not an identifier becomes one (`leaves-dark` is
  `BLOCK_LEAVES_DARK`). A block that glows carries an `emission` colour, added to the lit
  surface by the near field, the preview and the far field alike; keep it small enough
  that lit plus emission stays under 1, because nothing tonemaps and the block would
  clip to white. A block that lights its neighbours carries `light`, a level 0 to
  `LIGHT_MAX` that falls by one a voxel and is flood filled in the mesh job and baked
  into the quads around it. A block that *moves* carries either `sway`, which the vertex
  stage applies to its faces, or `flow`, which scrolls its texture down them instead:
  sway is for a thing attached at one end, flow for a surface that is going somewhere,
  and swaying a sheet of water pushes it into its neighbours and flickers
  ([gotchas.md](agent_docs/gotchas.md) "Animate flowing water with the texture").
- Anything that travels is drawn, not voxelized, and anything that stays put is voxelized,
  not drawn. A chunk is voxelized once and a brick sampled once, so a position that depends
  on time would put every chunk it crosses back through the voxelizer every frame; the two
  kinds of motion a block has (`sway` in the vertex stage, `flow` in the texture) animate a
  thing that stays where it is. The birds are the only thing on the other side of that line
  so far (`src/render/birds-common.wgsl`), and what it costs them is everything the world
  gives a block for free: no chunk, no brick, no block id, no shadow, no place in the far
  field, and a state buffer of their own to keep between frames.
- Whether a placed object exists, what kind it is and how big it is are properties of the
  *object*, so read the world at the object's own base, never at the point being shaded.
  A world function sees one point at a time; a test that varies across a tree's own
  footprint puts the tree in the field for some of its voxels and not others, and what
  that looks like is a tree cut in half along a contour
  ([gotchas.md](agent_docs/gotchas.md) "A plant decided per sample point is a plant cut in
  half"). Only the object's *shape* may depend on the point being asked about. Put the
  read behind the object's bounding test, because it runs per object per sample, and make
  the threshold a ramp rather than a line or the edge of the population is a contour too.
- Use `wp_repeat_near()` (`src/sdf/lib.wgsl`) for the neighbour cells in a 3x3 scatter
  loop, never plain `wp_repeat()`. `wp_repeat` is periodic and the loop offsets the point
  by whole periods, so it hands back the same number every iteration and the neighbours'
  objects land on the sample's own cell: nine objects to a cell, each cut off at the cell
  boundary it crosses ([gotchas.md](agent_docs/gotchas.md) "Domain repetition loses the
  neighbour offset"). Getting this right divides a scatter's population by nine, so the
  acceptance rates are tuned after it, never before.
- A scatter on a lattice needs three more things or it still reads as a grid, and all
  three are needed: the jitter covers the whole cell (half a cell leaves a band down every
  boundary nothing can occupy, and the budget to respect is the object's reach against the
  cell, not the jitter against it); there are *several* tries to a cell at a fraction of
  the chance each, because one per cell is a stratified sample and stratified is not
  random; and the density is a field read at the candidate's own position, never one value
  per cell, or the clumps have square edges
  ([gotchas.md](agent_docs/gotchas.md) "One per cell is a grid, whatever the jitter").
  Read the density behind the object's bounding test and the extra tries pay for
  themselves.
- Something suspended inside a solid is a material, not a shape. A jellyfish in a lake or
  an ore in rock adds nothing to the union: the field has already called those voxels
  solid, so putting the shape in the union only fights the surrounding solid over which
  of the two is more deeply inside, and the surrounding solid usually wins. Return its
  distance, test the sign, and swap the block id
  ([plan-living-world.md](agent_docs/plan-living-world.md) phase 3).
- A world's `sample_footprint` gates change what a feature *is*, never whether it exists.
  The far-field builder sets the footprint to the clipmap level's cell size, so
  `if (sample_footprint <= X) { place trees }` means the far field has no trees past X,
  and the wood ends in a line ([gotchas.md](agent_docs/gotchas.md) "A footprint gate
  deletes a feature from the far field"). Swap to a cheaper stand-in at the detail
  footprint and drop the feature only once it is narrower than a cell, because below that
  it can only be drawn inflated to one. A broad continuous feature (a canopy) survives
  being drawn coarsely; a small bright one (a glowing cap) becomes a cell-sized lantern,
  so it needs a much finer gate.
- A world names a sky and lighting preset from `SKIES` (`src/render/sky.ts`); unset
  means `DEFAULT_SKY`. The preset is generated into WGSL and prepended to every shader
  that lights or fogs a surface, so it is the one lighting model with different numbers
  in it, never a second model. Never write `smoothstep(a, a, x)` against generated
  constants: WGSL rejects equal ends at compile time, whatever branch guards the call
  ([gotchas.md](agent_docs/gotchas.md)).
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
