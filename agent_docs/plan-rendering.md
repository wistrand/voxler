# Plan: near-field rendering

> Status: done (all five phases landed and verified). Kept as a plan on purpose
> rather than promoted to architecture-rendering.md; the phase results below are the
> record until it is. Still deferred from phase 1: the draw-test checks on Firefox,
> Safari and Windows D3D12.
> Phase 1
> (spike) can start right after
> [plan-foundation.md](plan-foundation.md); the rest depends on
> [plan-meshing.md](plan-meshing.md) output. Quad, cluster, and chunk table layouts
> are owned by [design-formats.md](design-formats.md).

## Goal

Draw every resident chunk's quads with CPU cost that is flat in the number of
resident chunks and GPU cost dominated by the pixels actually covered. GPU-driven:
culling runs in compute, and the whole near field is one indirect draw per pass.

## Current state

`NearField` (`src/render/near-field.ts`) uploads streamed chunk meshes into quad,
cluster, and chunk storage buffers, with ranges from `RangeAllocator`
(`src/render/range-allocator.ts`), culls clusters in two phases per frame
(`src/render/cull.wgsl`, `src/render/hiz.ts`): face direction, frustum, and a Hi-Z
occlusion test, each phase drawing with one GPU-written `drawIndirect` by vertex
pulling (`src/render/near.wgsl`). Flat per-face shading. The phase 1 direct-draw
path was removed after its comparison.

## Approach

- **Three storage buffers.** The quad arena (packed quads, cluster-contiguous), the
  cluster table (one descriptor per cluster), and the chunk table (slot to chunk
  coordinate). A range allocator on the CPU hands out arena and cluster ranges per
  chunk mesh; uploads are `writeBuffer` calls under a per-frame byte budget.
- **Cull pass (compute).** One invocation per cluster slot: skip empty slots, test
  face direction against the camera, test the AABB against the frustum, then against
  the Hi-Z pyramid. Survivors are appended to a visible-cluster list with an atomic
  counter, which also becomes the `instanceCount` of the indirect draw arguments.
- **Draw (render).** One `drawIndirect` with `vertexCount = 6 * CLUSTER_QUADS`. The
  vertex shader reads `visible[instance_index]` for the cluster, computes quad and
  corner from `vertex_index`, fetches and decodes the quad, and adds the chunk origin
  from the chunk table. No vertex buffers. Rationale in
  [research-voxel-rendering.md](research-voxel-rendering.md) "Vertex format and draw
  submission".
- **Two-phase occlusion.** Phase A draws clusters that were visible last frame
  (tested against the frustum only). Build the Hi-Z pyramid from that depth. Phase B
  tests every other cluster against the pyramid and draws the newly visible ones.
  The union becomes next frame's "visible last frame" set.
- **Passes per frame.** Cull A, draw A, Hi-Z build, cull B, draw B (opaque, into a
  `depth32float` reversed-Z target), far-field compute and composite, translucent
  draw (sorted per chunk, same cluster path with a translucent flag).
- **Shading.** Block textures in a `texture_2d_array`, UVs tiled across greedy quads
  with `textureSampleGrad`, AO per the meshing decision, one directional light plus
  sky ambient, distance fog matched to the far field.

## Testing methodology

- Bench scenes from [plan-foundation.md](plan-foundation.md): flyover, spin,
  teleport, and cave (added in phase 4: a ground-level walk, the occlusion-heavy
  view; its waypoints are sampled from the terrain world at seed 1).
  Recorded per phase: frame p50/p99, main-thread CPU, GPU time per pass where
  timestamps exist, visible clusters, quads drawn, upload bytes.
- Culling correctness: a debug mode that runs the cull shader with culling disabled
  and diffs the rendered image; any pixel difference under a static camera is a cull
  bug. A second debug mode colors clusters by which phase drew them.
- `deno test` for the range allocators, a TS port of the cull tests (frustum, face
  direction, AABB projection to Hi-Z mip), and the upload scheduler.

## Phases

### Phase 1: cluster rendering spike

- [x] Synthetic quads and clusters in storage buffers; one `drawIndirect` with
      instance-per-cluster vertex pulling. Deviation: real streamed meshes instead of
      synthetic ones, since meshing had landed
- [x] Confirm `vertex_index` and `instance_index` semantics on every target
      browser and backend (D3D12, Metal, Vulkan). Self-test passes on Chrome 152
      Linux (Vulkan) and Deno's WebGPU (wgpu, Vulkan). Deferred by the user:
      Firefox, Safari (Metal), Windows (D3D12); the overlay's `near` line shows
      the result on any of them
- [x] Sweep `CLUSTER_QUADS` (for example 32, 64, 128) measuring vertex throughput and
      padding waste on real terrain meshes once meshing lands. Chosen: 32
- [x] Compare against direct per-face-group draws on the same data

**Verify:** results table and the chosen cluster size added to
[research-voxel-rendering.md](research-voxel-rendering.md).

Built so far:
- Upload: `MeshScheduler.onMesh` hands each accepted mesh output to
  `NearField.add()`; uploads run in `render()` under a 4 MiB per-frame budget
  (`NEAR_UPLOAD_BYTES_PER_FRAME`). Descriptors get the arena base added and the
  chunk slot filled on upload. A replaced or evicted chunk's descriptors are zeroed
  (count 0 draws nothing); its space is not reused until phase 2, and a full arena
  drops new meshes (`near` overlay line: `dropped`). After device loss the new
  renderer calls `MeshScheduler.remeshAll()`.
- Draw: pass order is now preview (offscreen), near (clears color and depth, draws
  meshes), main (loads; preview blit or sky behind the meshes with
  `greater-equal`, then grid and gizmo). `gpu.near` is the mesh draw alone; bench
  results from before this phase have no `gpu.near`. The preview starts off when
  meshes are drawn (`?preview=1` forces it on); M toggles meshes. Translucent
  clusters are skipped until phase 5.
- Cluster path: one `drawIndirect`, `vertexCount = 6 * clusterQuads`, one instance
  per allocated cluster (dead ones included, until phase 2); quads past a
  cluster's count and translucent clusters collapse to a degenerate point.
- Direct path: per chunk, per non-empty opaque face group, `draw(6 * n, 1,
  6 * firstQuad, slot)`: `firstVertex` selects the group's quads and
  `firstInstance` carries the chunk slot, so it depends on both builtins
  including their base.
- Draw builtins self-test (`src/render/draw-test.ts`, runs at renderer start,
  result on the overlay's `near` line as `draw test ok` or the failures):
  `vertex_index` includes `firstVertex`, `instance_index` includes `firstInstance`,
  `drawIndirect` with `firstInstance` 0, and a counter-clockwise NDC triangle is
  front-facing while a clockwise one is culled. Also a `deno test`
  (`near_test.ts`), which passes on the dev machine's Vulkan adapter, and a GPU-free
  test that the quad triangle tables are counter-clockwise on screen for every
  face seen from outside, using the real camera matrices.
- Cluster size per session: `?clusterQuads=n` (1-255) goes to every mesh job
  (`MeshSchedulerOptions.clusterQuads`); the vertex count per instance follows from
  the uploaded meshes. Bench results record `near.*` stats (padding from
  `near.paddedQuads` vs `near.realQuads`), `near.drawMode`, and
  `near.clusterQuads`.

Results: the table in [research-voxel-rendering.md](research-voxel-rendering.md)
"Vertex format and draw submission", from `bench/results/spin.20260911T120745Z`,
`T120811Z` (32), `T120822Z` (64), `T120834Z` (128), `T120859Z` (direct, 64), all
`chrome-152-on-linux`. Cluster size 32 chosen on exact padding and vertex counts;
GPU times swung 2x between identical runs, so the timing columns only show that
smaller clusters cost nothing measurable. Direct draws: 13,819 calls and 0.9 ms
main-thread time for 2,463 chunks, growing with resident chunks; the cluster path
stays. `draw test ok` on Chrome 152 Linux; other browsers deferred.

### Phase 2: arenas and uploads

- [x] Quad arena, cluster table, chunk table buffers sized from `caps` and a memory
      budget (`NearFieldOptions`: `?nearMB=n` quad arena, default 64 MiB, clamped
      to `maxStorageBufferBindingSize` and `maxBufferSize`; cluster table
      `capacityQuads / clusterQuads` entries, which can't run out first; chunk
      table one entry per store slot)
- [x] Range allocators (size-class free lists plus coalescing), fragmentation stats
- [x] Upload queue with a per-frame byte budget; chunk slot field in cluster
      descriptors filled on upload (from the phase 1 spike)
- [x] Free on eviction and on remesh (old range freed after the new one is live);
      freed cluster slots marked empty so the cull pass skips them

**Verify:** allocator unit tests with randomized alloc/free against a reference;
fragmentation stays bounded over a long flyover.

Built:
- `RangeAllocator`: two-level segregated fit (TLSF): free runs in size classes (a
  power of two, split 8 ways) found through two bitmaps, O(1) alloc and free,
  coalescing through an address-ordered block list. Request rounding picks a class
  where every run fits; the request's own class is also scanned first-fit, so
  allocation fails only when no free run is long enough. Typed arrays only; block
  handles, not offsets; `highWater` for the indirect instance count;
  `largestFree()` and `fragmentation()` (1 - largest free run / free units) for
  stats.
- `NearField` takes one quad range and one cluster range per chunk. A remesh
  allocates the new ranges, writes them, then zeroes and frees the old ones (the
  same frame is safe: writes and draws are ordered on one queue). Eviction zeroes
  and frees. A failed allocation keeps the chunk's previous mesh and counts
  `dropped`. The cluster draw's instance count is the cluster table's high-water
  mark, so freed slots below it cost a degenerate instance each until reused.
- Overlay `near` line and bench results (`near.*`): free runs, largest free run,
  fragmentation for both arenas.

Tests: `range-allocator_test.ts`: 80,000 random alloc/free steps over four
capacity and size mixes against a per-unit ownership reference (no overlaps, sizes
and bounds, used counts, largest free run and high-water mark match, and alloc
fails only when the reference has no long enough run; everything coalesces back to
one run), neighbor coalescing, a class-boundary size, block table exhaustion, and
churn at 60% occupancy with mesh-like sizes (no failures). `near-field_test.ts`
(Deno WebGPU): 400 random adds, replacements, and removals, then both buffers read
back: every live chunk's descriptors (offset, slot, AABB) and quads are exact and
every other cluster slot below the high-water mark is empty, every mesh buffer
recycled once, no validation errors. 104 tests pass.

Churn with a deliberately harsh size mix (runs up to 3.4% of the arena; real
meshes are about 0.01-0.25% of a 64 MiB arena), 200,000 steps:

| Occupancy | Failed allocations | Fragmentation, mean / worst |
|-----------|--------------------|-----------------------------|
| 50%       | 0                  | 0.44 / 0.57                 |
| 60%       | 0                  | 0.60 / 0.86                 |
| 70%       | 0.2%               | 0.78 / 0.93                 |
| 80%       | 8%                 | 0.91 / 0.96                 |

The fragmentation number runs high even when every allocation succeeds (many
medium runs, no single huge one); failed allocations are the measure that
matters.

Flyover result (`bench/results/flyover.20260911T130716Z`, `T130727Z`, `T130739Z`,
`chrome-152-on-linux`, terrain, one session of three runs, counters cumulative):

| Run | Chunks loaded / evicted | Meshes uploaded | Dropped | Free runs | Largest free run    | Fragmentation | gpu.near p50 / p99 |
|-----|-------------------------|-----------------|---------|-----------|---------------------|---------------|--------------------|
| 1   | 36,959 / 25,376         | 9,057           | 0       | 582       | 6.29 M of 8.39 M    | 0.092         | 2.85 / 4.20 ms     |
| 2   | 73,918 / 62,335         | 18,114          | 0       | 550       | 6.29 M              | 0.092         | 3.11 / 4.25 ms     |
| 3   | 110,877 / 99,294        | 27,171          | 0       | 575       | 6.30 M              | 0.091         | 2.99 / 4.20 ms     |

**Verify:** met. Fragmentation stays flat as the camera crosses several load
ranges; no mesh was dropped. The arena holds 2,335 meshes, 1.46 M padded quads,
17% of 64 MiB. The cluster draw had 65.5 k instances for 45.6 k live clusters:
30% are freed slots below the high-water mark, drawn as degenerate until reused;
phase 3's cull pass skips them.

Open, not caused by this phase: main-thread `cpu.render` p99 is 2.1-2.4 ms with
meshing on (these runs; also `flyover.20260911T115221Z`, before any mesh was
drawn) against 1.25 ms with streaming alone (`flyover.20260911T104449Z`), over the
2 ms target. Suspects: mesh job submits in bursts (an input per job, `postMessage`
on dispatch) and upload `writeBuffer` bursts (4 MiB per frame budget). Needs a
Chrome profile of a flyover before changing anything.

### Phase 3: cull and draw, frustum only

- [x] Cull compute with face-direction and frustum tests, atomic append, indirect
      args written by the GPU (counter reset by a tiny compute pass or `writeBuffer`
      at frame start). Reset: `copyBufferToBuffer` from a constant args buffer and
      `clearBuffer` for the counters, inside the frame's encoder
- [x] Opaque render pass with reversed-Z `depth32float` (the phase 1 "near" pass)
- [x] GPU counters read back through the stats ring (`CounterReadback`,
      `src/gpu/counters.ts`, 4 mappable slots like `GpuTimer`)

**Verify:** culling-disabled diff shows no missing pixels; main-thread CPU time is
flat as resident chunk count grows in a synthetic stress scene.

Built:
- Cull pass (`cull.wgsl`, `cull_clusters`), timed as `gpu.cull`: one invocation per
  cluster slot below the high-water mark, 64 per workgroup (2D dispatch past 65,535
  workgroups). Skips empty (freed) and translucent slots; face test: the cluster's
  quads lie on planes `[lo + 1, hi]` (positive faces) or `[lo, hi - 1]` (negative)
  along its axis and the eye must be in front of at least one; frustum test:
  box against 5 planes (left, right, bottom, top, near; no far plane with the
  infinite projection), taken from `view_proj` in float64 on the CPU
  (`frustumPlanes()` in `src/render/cull.ts`). Box corners come from integer math
  against the camera chunk, f32 last. Survivors are appended with one global
  atomic per workgroup; the append total is the draw's instance count. The vertex
  shader reads the cluster from `visible[instance_index]`.
- Per-frame CPU: a 128-byte cull uniform, two buffer resets, one dispatch, one
  `drawIndirect`, whatever the resident count.
- Counters per frame (visible, culled by face, culled by frustum, skipped) on the
  overlay `near` line and in bench results (`near.visibleClusters`,
  `near.faceCulled`, `near.frustumCulled`, `near.skippedClusters`).
- `?cull=0`: no face or frustum culling (still compacted through the cull pass).
- `?cullCheck`: every 30 frames the near field is drawn offscreen twice, culled and
  not culled, and a compute pass (`cull-check.wgsl`) counts differing pixels
  (color or depth) and pixels culled away. Results: `near.cullChecks`,
  `near.cullCheckFailures`, `near.cullCheckMaxDiff`, `near.cullCheckMissing`.

Tests: `cull_test.ts` (CPU): frustum planes keep exactly the points inside the
view volume (50 cameras x 200 points); over 300 cameras x 40 random boxes,
`cullBox()` never culls a box with a sample point in view (7 x 7 x 7 samples) or a
face-culled cluster with any quad plane facing the eye; flags switch tests off.
`near-field_test.ts` (Deno WebGPU): 5 x 2 x 5 chunks of real meshes, 24 random
poses, culled and unculled draws identical to the pixel with face and frustum
culling both active, and counts adding up. Checked that the check can fail: with
the face test inverted in `cull.wgsl`, all 24 poses differ (up to 57,597 px). 108
tests pass.

Flyover with `?cullCheck` (`bench/results/flyover.20260911T152106Z.chrome-152-on-linux`)
against the unculled phase 2 flyovers (`flyover.20260911T130716Z`, `T130727Z`,
`T130739Z`), same scene:

| Metric                  | Phase 2, no culling      | Phase 3            |
|-------------------------|--------------------------|--------------------|
| gpu.near p50 / p99      | 2.85-3.11 / 4.20-4.25 ms | 0.40 / 0.56 ms     |
| gpu.cull p50 / p99      | -                        | 0.14 / 0.21 ms     |
| cpu.render p50 / p99    | 0.46-0.50 / 2.11-2.38 ms | 0.53 / 2.36 ms     |
| cull checks, failures   | -                        | 44, 0              |

At the end of the run: 65,611 cluster slots tested, 6,410 drawn, 20,864 culled by
face, 18,346 by frustum, 19,991 skipped as empty (freed slots below the high-water
mark). Near-field GPU time dropped about 5.5x including the cull pass.

Spin with `?cullCheck` (`spin.20260911T152150Z`): gpu.cull 0.11 / 0.21 ms, gpu.near
0.46 / 1.19 ms (p50 / p99; 2.35-2.44 ms p50 unculled in phase 1), 8,971 of 50,627
clusters drawn. 29 checks, 2 with one differing pixel each, 0 pixels missing. A
culled-away pixel would count as missing, so these are equal-depth ties: where two
faces meet at an edge both reach the pixel at the same depth and the first drawn
wins, and the culled and unculled draws list clusters in different orders. The
check now counts depth differences and missing pixels as failures and color-only
differences apart (`near.cullCheckTies`).

Spin at three load radii (`spin.20260912T092631Z` radius 8, `T092514Z` radius 8
again, `T092534Z` radius 16, `T092649Z` radius 24), each fully loaded and idle:

| Radius | Resident chunks | Meshes | Clusters | Visible | cpu.render p50 / p99 | gpu.cull p50 | gpu.near p50 |
|--------|-----------------|--------|----------|---------|----------------------|--------------|--------------|
| 8      | 2,561           | 529    | 11,347   | 1,732   | 0.36 / 0.66 ms       | 0.045 ms     | 0.27 ms      |
| 16     | 10,361          | 2,463  | 50,627   | 8,971   | 0.36 / 0.74 ms       | 0.199 ms     | 0.77 ms      |
| 24     | 23,309          | 5,697  | 116,453  | 20,517  | 0.37 / 1.37 ms       | 0.183 ms     | 1.12 ms      |

**Verify:** met. No depth differences or missing pixels in 73 checks over a
flyover and a spin. Main-thread `cpu.render` p50 is flat (0.36-0.37 ms) while
resident chunks grow 9x and clusters 10x; GPU time grows with what is drawn, as
intended. The p99 does creep (0.66 -> 1.37 ms), so something per frame still
scales slightly with residency; worth a look with the p99 work below.

The `?cull=0` comparison run (`spin.20260912T092435Z`) is unusable: the world
never loaded (992 of 10,361 chunks, 225 ms frames, streaming still in flight), so
it measured a mid-load system, not culling switched off. The phase 1 spin is the
no-culling baseline instead: same scene, same 50,627 clusters and 1.62 M padded
quads, gpu.near p50 2.35 ms without culling against 0.77 ms with it, plus 0.20 ms
of cull.

The messaging changes below did not move `cpu.render` p99 (2.36 ms against
2.11-2.38 ms, one run). Next step for it: a new trace, to see whether
`WorkerPool.recycle` left the profile and what now fills the slow frames.

Worker messaging, from two Chrome traces of terrain flyovers taken during this
phase (gotchas.md "postMessage is expensive"), aimed at the `cpu.render` p99 over
2 ms noted in phase 2:
- Returned buffers are queued and sent once per frame
  (`WorkerPool.flushRecycled()`), and the shared arena goes to each worker once
  (`WorkerPool.share()`) so mesh jobs carry its id, not the `SharedArrayBuffer`.
  The first flyover after this showed no change in p99 (2.36 ms).
- The second trace: `WorkerPool.recycle` down from 550 ms to 50 ms of self time
  (5.2 s trace), but `dispatch` up at 854 ms with about 4,000 job messages a
  second and as many results, roughly 41 us each way. So the pool now sends up to
  4 jobs per message and the worker replies with their results together
  (`MAX_JOBS_PER_MESSAGE`), batching only what is already queued. Not yet
  measured, and it lost: three flyovers each way (`flyover.20260912T093648Z`,
  `T093659Z`, `T093711Z` at `?jobBatch=1`; `T093748Z`, `T093759Z`, `T093811Z` at
  `?jobBatch=4`), same content:

  | Jobs per message | cpu.render p50 | cpu.render p99 | Mesh job latency |
  |------------------|----------------|----------------|------------------|
  | 1                | 0.580 ms       | 2.18 ms        | 1.31 ms          |
  | 4                | 0.558 ms       | 2.31 ms        | 2.36 ms          |

  Fourfold fewer messages saved nothing measurable (p50 inside the 0.46-0.65 ms
  session spread, p99 slightly worse) and nearly doubled job latency, so a job
  message costs what its payload costs, not a fixed per-message overhead. The
  default is back to 1; the mechanism stays behind `?jobBatch=n`. The `cpu.render`
  p99 is still unattributed: the candidates left are the upload `writeBuffer`
  bursts and the per-frame streaming scans.

Radius 24 flyover, as a load data point: 62,240 chunks streamed in and 36,854 out
over 10 s, 5,569 meshes and 110,927 clusters resident, 16,426 drawn; gpu.cull 0.20
ms and gpu.near 0.74 ms p50; 120 Hz held with 7 missed frames of 1,193 and no
holes; quad arena 42% used, fragmentation 0.19 over 1,389 free runs (0.09 over 568
at radius 16), nothing dropped.

### Phase 4: two-phase Hi-Z occlusion

- [x] Hi-Z pyramid build (compute, `r32float`, min-depth for reversed-Z)
- [x] Visible-last-frame bitset per cluster slot, double-buffered
- [x] Phase A and phase B cull and draw
- [x] Compare cull rate with clusters built in `ORDER_EMISSION` and `ORDER_MORTON`
      (`src/mesh/cluster.ts`); keep the better one as the default. AABB size
      alone did not decide it (plan-meshing phase 4). Kept `ORDER_EMISSION`

**Verify:** no holes during the spin bench at high turn rates (compare against
culling disabled); quads drawn drops substantially in cave and dense-hill scenes.

Built:
- Frame: cull A, draw A, Hi-Z build, cull B, draw B, then the background. Timed as
  `gpu.cull.a`, `gpu.near.a`, `gpu.hiz`, `gpu.cull.b`, `gpu.near.b` (bench results
  before this phase have `gpu.cull` and `gpu.near` instead).
- Phase A culls and draws the clusters drawn last frame (one bit per cluster slot,
  two buffers swapped each frame) with the frustum and face tests. Phase B tests
  every cluster, adds the Hi-Z test, records next frame's bits, and draws what A
  did not. So a cluster that becomes visible appears a frame late only when the
  Hi-Z also hides it, and one that stops being visible loses its bit.
- `HiZPyramid` (`src/render/hiz.ts`, `hiz.wgsl`): half-resolution mip chain of
  minimum depth, rebuilt each frame from phase A's depth. The occlusion test takes
  the cluster box's screen rectangle, picks the level where it spans about two
  texels, and culls when the box's nearest point is behind the farthest surface
  already drawn there.
- `?clusterOrder=morton` picks the cluster quad order for the comparison above;
  `near.clusterOrder` is recorded in bench results.
- Overlay `near` line: clusters drawn again (A) and new (B), culled by face, by
  frustum, hidden, empty.

Tests: `hiz_test.ts` (Deno WebGPU): at a deliberately odd size, no level claims
more coverage than it has and the top level is the minimum of the whole depth
buffer. `near-field_test.ts`: the two-phase draw matches an unculled one pixel for
pixel over 24 random poses, and over a 40-frame continuous camera path with
occlusion culling active (the case where holes appear). 110 tests pass.

A real bug the motion test caught, now in gotchas.md ("Halving an odd Hi-Z level
drops its last row"): the pyramid lost the last row or column at every odd-sized
level, so its upper levels over-reported coverage and hid visible geometry along
the bottom of the screen.

Browser results (`spin.20260912T104452Z`, `flyover.20260912T104540Z`, both with
`?cullCheck`), against the same scenes in phase 3:

| Scene   | Clusters | Drawn, phase 3 | Drawn, phase 4 | Hidden | A / B split   | Near-field GPU, phase 3 -> 4 |
|---------|----------|----------------|----------------|--------|---------------|------------------------------|
| spin    | 50,627   | 8,971          | 7,517          | 2,208  | 6,875 / 642   | 0.58 -> 0.57 ms              |
| flyover | 65,248   | 6,410          | 5,370          | 1,413  | 4,963 / 407   | 0.54 -> 0.59 ms              |

(Near-field GPU is the sum of the pass p50s: cull.a + near.a + hiz + cull.b +
near.b, against cull + near before.)

**Verify:** no holes met: 74 checks over a spin and a flyover, 0 failures, 4
edge ties (equal depth, colors drawn in a different order). The other half is not
met on these scenes: occlusion hides 16% of the clusters that survive frustum and
face culling, but the pyramid (0.10 ms) and the second cull (0.05 ms) cost about
what the smaller draw saves. Both scenes look at open terrain from above, which
is the weak case; the phase asks for cave and dense-hill scenes, so a `cave` scene
was added (`src/bench/scenes.ts`): a slow pass at terrain level below the spawn,
enclosed by hills and rock. Temporal
reuse works as intended: 92% of what is drawn was already visible last frame.

Cluster order, same flyover and the same 1,242,694 quads
(`flyover.20260912T104540Z` mesher order, `T104654Z` `?clusterOrder=morton`), the
comparison plan-meshing phase 4 left open:

| Order            | Clusters drawn | Hidden by occlusion | Clustering cost (mesh_bench, hills) |
|------------------|----------------|---------------------|-------------------------------------|
| mesher (default) | 5,370          | 1,413               | 19 us                               |
| Morton           | 5,478          | 1,432               | 58 us                               |

Morton draws 2% more clusters and hides about as many, so its more compact boxes
buy nothing here while costing 3x more to build. `ORDER_EMISSION` stays the
default; the switch stays for a re-test once there are interior scenes, where box
shape should matter more.

What culling is worth in total, same flyover (`flyover.20260912T104808Z` culling
on, `T104839Z` `?cull=0`):

| Culling | Clusters drawn  | cull.a | near.a  | hiz  | cull.b | near.b | Total   |
|---------|-----------------|--------|---------|------|--------|--------|---------|
| on      | 5,294 of 45,620 | 0.044  | 0.347   | 0.102| 0.065  | 0.040  | 0.60 ms |
| off     | 45,620          | 0.049  | 2.688   | 0.106| 0.239  | 0.006  | 3.09 ms |

5.2x less near-field GPU time, 2.5 ms a frame on this scene. Face direction
(20,864 clusters) and the frustum (18,319) do nearly all of it; occlusion adds
1,288. With culling off the phase B cull also costs more (0.24 ms): every cluster
reaches the atomic append.

Cave scene (`cave.20260912T110346Z` with `?cullCheck`, `T110608Z` `?cull=3`,
`T110513Z` `?cull=7`; 2,363,138 quads, 86k live clusters, the camera at terrain
level among hills). `?cull=n` is now a mask (1 frustum, 2 face, 4 occlusion) and
the Hi-Z is built only when occlusion is on, so the two runs compare fairly:

| Culling        | Clusters drawn | near.a draw | Hi-Z      | Near-field total |
|----------------|----------------|-------------|-----------|------------------|
| no occlusion   | 9,738          | 0.590 ms    | not built | 0.722 ms         |
| with occlusion | 7,455          | 0.393 ms    | 0.131 ms  | 0.722 ms         |

Occlusion hid 3,309 clusters, 23% of what survives frustum and face culling, and
the smaller draw paid back exactly what the pyramid and the extra phase B work
cost: the totals were equal. That scene flew above the surface among rolling
hills, which is not the enclosed case it was meant to be.

Retuned `cave` scene. The path was found by driving the browser: scanning the
resident chunks for enclosed spots, then measuring the engine's own cull counters
at candidate viewpoints. Sealed cave pockets hid 99% but drew 20 clusters (a
meaningless frame); a ground-level route that hugs the terrain hid about 52% while
drawing a full view, so the scene now walks a path of waypoints sampled three
voxels above the surface (`CAVE_PATH` in `src/bench/scenes.ts`). Same content in
both runs (2,913,636 quads, 106,144 live clusters;
`cave.20260912T113440Z` `?cull=3`, `T113500Z` `?cull=7&cullCheck`):

| Culling        | Clusters drawn | near.a draw | Hi-Z      | Near-field total |
|----------------|----------------|-------------|-----------|------------------|
| no occlusion   | 11,921         | 0.852 ms    | not built | 1.049 ms         |
| with occlusion | 6,949          | 0.328 ms    | 0.131 ms  | 0.657 ms         |

**Verify:** met. No holes (38 checks in this scene, 0 failures; 111 checks over
all scenes), and at ground level occlusion hides 47.6% of what survives the other
tests and cuts near-field GPU time by 37%, 0.39 ms a frame. Seen from above it is
break-even (flyover and spin), which is the expected shape: the pyramid costs a
fixed 0.131 ms and only pays where geometry hides geometry. Cheapest improvement
if that fixed cost starts to matter: build fewer levels, or build from the
previous frame's full depth instead of phase A's.

### Phase 5: materials and shading

- [x] Texture array, `textureSampleGrad` tiling, mipmaps
- [x] AO spike, the GPU half of plan-meshing phase 5: draw a terrain scene with
      baked AO (`mesh(..., shell)`, AO in word1) and with shader AO (per-chunk
      occupancy from `BinaryMesher.occupancy()`, neighbor bits via the chunk
      table); compare fragment cost and look, then decide and record it in
      [research-voxel-rendering.md](research-voxel-rendering.md). The CPU costs
      are already measured in plan-meshing phase 5
- [x] AO (the winner), directional light, sky ambient, fog
- [x] Translucent pass with per-chunk ordering

**Verify:** visual checks for seams, T-junction sparkles, AO diagonals, texture
shimmer; GPU time recorded per pass.

Result, AO spike. Baked AO won; `?ao=0` keeps the A/B. What landed: `fillShell()`
(`src/mesh/ao.ts`) writes the padded 34^3 shell from all 26 neighbors in
`NEIGHBOR_OFFSETS` order (`src/mesh/neighbors.ts`, faces first, so the plain path
still reads entries 0-5); the mesh job carries 27 refs instead of 7 and builds the
shell when `input.ao` (`src/mesh/job.ts`); `MeshScheduler` waits for 26 neighbors
instead of 6 and re-queues on all of them; `near.wgsl` reads the AO byte per
corner, splits the quad along the darker diagonal
([gotchas.md](gotchas.md) "AO anisotropy"), interpolates, and darkens by
`AO_STRENGTH`.

Shader AO was measured with a probe rather than built: the fragment shader
reconstructed the voxel under each fragment and did the eight occupancy reads and
the bilinear blend at the addresses the real per-chunk bitset layout would use
(`slot * 1024 + (y << 5 | z)`, bit x), reading the quad arena in place of an
occupancy buffer that was never uploaded. So the arithmetic, the access pattern
and the locality were the real ones and the picture was noise. That makes the
probe optimistic: it pays no upload, no chunk-border handling, and no memory.

GPU means per frame at 1080p, one run each, terrain seed 1, same viewpoint path
(`cave.20260912T114939Z` / `T114952Z` `?ao=0` / `T115006Z` `?ao=probe`;
`flyover.20260912T115023Z` / `T115039Z` / `T115054Z`):

| Scene   | AO     | cull.a | near.a | Hi-Z  | cull.b | total | vs no AO |
|---------|--------|--------|--------|-------|--------|-------|----------|
| cave    | none   | 0.064  | 0.369  | 0.129 | 0.102  | 0.783 |          |
| cave    | baked  | 0.103  | 0.495  | 0.117 | 0.141  | 0.971 | +24%     |
| cave    | shader | 0.068  | 0.628  | 0.118 | 0.097  | 1.100 | +40%     |
| flyover | none   | 0.060  | 0.471  | 0.135 | 0.083  | 0.842 |          |
| flyover | baked  | 0.104  | 0.731  | 0.158 | 0.134  | 1.240 | +47%     |
| flyover | shader | 0.036  | 0.526  | 0.106 | 0.060  | 0.817 | -3%      |

The two scenes disagree, and the reason is which stage is busy. Ground level is
fill-bound: few clusters, large quads, so shader AO's eight reads per fragment cost
0.26 ms while baked AO's extra vertices cost 0.13 ms. Seen from above the near
field is vertex-bound: 1.8x the quads and 1.6x the clusters cost baked AO 0.40 ms
across the draw and both cull passes, while the fragment work barely moves.

Content at one viewpoint (`?at=26,58,38`, radius 16), baked against none: 1008 vs
562 quads per mesh (+79%), 145,392 vs 91,000 clusters, 37.8 vs 23.7 MiB of arena,
2.8 vs 2.1 ms mesh job latency, `cpu.render` p50 0.44 vs 0.34 ms.

Decision: baked AO, recorded in
[research-voxel-rendering.md](research-voxel-rendering.md) "Ambient occlusion".
The probe's win in the flyover is the optimistic number: shader AO would still owe
4 KB per near chunk of uploads (roughly doubling mesh upload traffic), 17 MiB at
radius 16 against baked AO's 14 MiB of extra quads, and either a padded 34^3 grid
(9.25 KB per chunk) or a chunk-table lookup per sample to get chunk borders right.
Baked AO is already written and tested, costs nothing per fragment, and the
fragment stage is where the rest of this phase lands. Revisit if the near field
becomes vertex-bound at a larger radius, or if the quad arena becomes the
constraint.

Result, lighting. `src/render/shading.wgsl` owns the sun direction and color, the
sky ambient term, and the fog density, and both the near field and the SDF preview
call `surface_light()` and `apply_fog()`, so a mesh and the preview behind it shade
the same (the far field will use them too). The near-field fragment shader builds
the face normal from the face index, multiplies by the AO factor, and fogs toward
`sky_color()` along the interpolated eye-to-fragment vector.

Cost, against the same scenes with the old fixed per-face shade
(`flyover.20260912T115023Z` -> `T115713Z`, `cave.20260912T114939Z` -> `T115727Z`,
GPU means):

| Scene   | near.a before | after | near-field total before | after |
|---------|---------------|-------|-------------------------|-------|
| flyover | 0.731         | 0.701 | 1.240                   | 1.194 |
| cave    | 0.495         | 0.649 | 0.971                   | 1.158 |

Flyover is unchanged (vertex-bound; the extra fragment math hides), cave costs
0.15 ms (fill-bound). Same shape as the AO spike, from the other side.

Result, textures. `src/render/textures.ts` paints each layer rather than loading one:
the project takes no runtime dependency and ships no image assets, and a 32^2 tile is
a few lines of arithmetic. Twelve layers in a `texture_2d_array`, mip chain
box-filtered on the CPU so the result is the same on every machine and a test can
check it. A block names three textures as [top, side, bottom] and `blockFaceTable()`
expands that to the six faces, which is what makes a grass block's sides differ from
its top.

Texture coordinates are the quad's own extent in voxels, so the sampler's repeat mode
lays one tile per voxel whatever a greedy quad merged into. `textureSampleGrad` with
the interpolated coordinates' own derivatives rather than `textureSample`: the two
agree today, and the explicit form keeps the mip selection tied to the surface rather
than to however the coordinates are formed, which is what a later change that wraps
them by hand would break.

Sampler: nearest magnification, linear minification and mip filtering, no anisotropy.
WebGPU allows anisotropy only when every filter is linear, and linear magnification
smears a 32-texel tile across one voxel, which fights the hard-edged look the rest of
the renderer keeps. Grazing ground goes through the mip chain instead.

Cost: not resolvable. Two runs each of flyover and cave, textured against `?tex=0`,
gave GPU totals of 1.556/1.389 against 1.079/1.267 (flyover) and 1.268/1.407 against
1.560/1.616 (cave). The cave says texturing is 0.3 ms *faster*, which it cannot be,
so about 0.3 ms is the noise floor here and the texture sample costs less than that
([gotchas.md](gotchas.md) "GPU pass timings drift between bench runs").

Result, translucent pass. Nothing could exercise it before: neither world used water
or glass, so translucent quads were meshed, counted, and never drawn, and the pass
had nothing to draw either. `terrain.wgsl` now has a sea at y = 30, unioned into the
world SDF as `max(y - SEA_LEVEL, h - y)`, which is the half-space below sea level
intersected with the outside of the ground, so the water meets the shore instead of
running through it and caves under the sea stay dry. Both halves are 1-Lipschitz, so
the bound is unchanged, and `world_material` needs one height lookup: solid above the
ground is sea. Sea level is 30 and not 0 because this world's surface runs from about
20 to 105 (measured over a 400 x 400 patch), so a sea at 0 would never have shown.

The pass itself is a third cull and a third draw, after the background rather than
before it, so water blends over the sky as well as the terrain. The cull is the same
shader under `TRANSLUCENT`: it takes the clusters the opaque passes skip, tests every
one, uses the Hi-Z pyramid the opaque depth already built (59 drawn and 3 hidden over
a flyover), and reads or writes no seen bits. Translucency is not part of the
two-phase scheme, because it draws over a depth buffer that is already complete and
there is nothing to predict. The draw blends, keeps back-face culling, and does not
write depth.

Ordering is a counting sort by distance in `sort_translucent`: 64 buckets of 16
voxels over the distance from the eye to a cluster's box, one workgroup counting,
prefixing and scattering into a second list drawn far to near. One workgroup is
enough for the few dozen clusters a water surface comes to and avoids an indirect
dispatch. Within a cluster the quads keep mesher order, which is why this is
per-chunk ordering and not sorted translucency. `near-field_test.ts` checks the
sorted list is a permutation of the culled one; the ordering itself was checked by
eye, with five glass slabs at different distances compounding correctly.

Cost: `near.t` is 0.026 ms and `cull.t` 0.26 to 0.35 ms
(`flyover.20260912T135922Z`, `T135934Z`). The cull being three times phase B's is
not explained: it scans the same table and rejects most clusters more cheaply. The
likely cause is scanning 100,000 slots to find 60 translucent ones, which a compact
list of translucent slots would avoid (see "Open questions").

One bug worth keeping: the grass side texture came out upside down. A face's V axis
points up and a texture's v = 0 is its first row, so a band painted at the top of the
image lands at the foot of the wall. `textures_test.ts` pins the orientation by
comparing the greenness of the first and last rows.

Two `cave` results from this session are invalid and should be ignored:
`cave.20260912T114810Z` and `T114825Z` drew no near field at all (the probe's
fragment-stage read of the quad arena is a static use even behind a false
`override`, so the draw pipeline failed validation for every configuration).

## Open questions

- **Arena growth.** Fixed size from a budget, or grow by allocating a larger buffer
  and `copyBufferToBuffer`. Start fixed.
- **Subgroup compaction.** With `subgroups`, the atomic append can be one atomic per
  subgroup. Measure whether append contention matters first.
- **Antialiasing.** MSAA on the opaque target vs a post-process pass. MSAA
  complicates Hi-Z and the far-field depth read. Decide after phase 5.
- **Translucent cull scans the whole cluster table.** It tests every slot to find the
  handful that are translucent, and measures three times phase B's cost for less
  work. A compact list of translucent slots, which the CPU could keep as meshes land,
  would make the pass proportional to what it draws.
- **Sorted translucency.** Ordering is per cluster; quads inside one keep mesher
  order. Only visible where translucent surfaces overlap within a cluster.
- **Mid-field LOD meshes.** Only if the near/far transition shows popping
  ([research-voxel-rendering.md](research-voxel-rendering.md) "Rejected or deferred").
