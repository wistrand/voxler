# Plan: near-field meshing

> Status: done (phases 1-7, tested; the AO decision landed with plan-rendering phase
> 5, and phase 6's browser check with the edit tool). Kept as a plan rather than
> promoted to an architecture doc. Depends on [plan-voxel-data.md](plan-voxel-data.md) phases 1-2
> (`ChunkData`, `ChunkStore`, done), chunks arriving in the store from
> [plan-sdf-generation.md](plan-sdf-generation.md) phase 3, and the worker pool from
> [plan-foundation.md](plan-foundation.md). Phases 1-3 (reference mesher, occupancy,
> greedy merge) need only `ChunkData` and can start now. Output formats
> (packed quad, cluster descriptor) are owned by
> [design-formats.md](design-formats.md).

## Goal

Turn a 32^3 chunk plus its neighbor boundaries into the minimum practical number of
packed quads, grouped into culling clusters, fast enough that meshing never limits
how quickly the camera can move or how quickly an edit appears.

## Current state

Phases 1-4 and 6: packed quad codec, neighbor planes, reference mesher, coverage harness,
test chunk set, binary mesher with column build, bitwise culling and greedy merge,
`MeshBuilder`, `ClusterBuilder`, optional baked AO, translucent culling, the
"chunk.mesh" worker job and its output buffer (`src/mesh/`), and `MeshScheduler`
(`src/world/mesh-scheduler.ts`) meshing streamed chunks in the browser. Meshes are
counted and recycled; nothing draws them yet (plan-rendering). No AO decision.

## Approach

**Binary greedy meshing on `u32` columns**, in CPU workers (why CPU and not compute:
[research-voxel-rendering.md](research-voxel-rendering.md) "Near-field meshing").

1. Build occupancy columns. For each axis, a 32 x 32 array of `u32` where bit i is
   "voxel at position i along that axis is opaque". Built in one pass over the
   chunk (uniform chunks short-circuit: all-air emits nothing; all-solid emits only
   faces against non-solid neighbors).
2. Neighbor boundary planes. For each of the six faces, a 32 x 32 bitmask of the
   neighbor chunk's adjacent layer, taken from the neighbor's container. This
   replaces the padding that 64-bit implementations use.
3. Face culling with bit ops. Visible +axis faces:
   `col & ~((col >>> 1) | (neighborPlus << 31))`; -axis faces are the mirror with
   `<< 1` and the neighbor bit in bit 0. Mind int32 semantics
   ([gotchas.md](gotchas.md) "Bitwise ops are int32").
4. Transpose face bits into per-slice row masks: for each face direction and each
   slice along its axis, 32 rows of `u32`.
5. Greedy merge per slice. Take the lowest set bit run in a row, extend it across
   following rows while those rows contain the same run with the same merge key,
   clear the merged bits, emit a quad.
6. Merge key. Quads merge only when block id (and AO pattern, if AO is baked) match.
   Per slice, group face bits by key first; most slices contain few distinct keys.
7. Clustering. Each face group (per direction, opaque and translucent separately)
   is split into clusters of up to `CLUSTER_QUADS` quads, padded with zero quads,
   with a tight local AABB per cluster.

**Reference mesher.** A naive culled-face mesher, one quad per visible face, kept
permanently as the test oracle. Every greedy output is checked against it.

**Output.** One transferable buffer per job: padded quads in cluster order, then
cluster descriptors (with the chunk slot field left for the renderer to fill), plus a
small header with counts. Uploaded by the renderer.

**Versioning.** A mesh job carries the chunk's edit version at dispatch. A result
older than the chunk's current version is dropped.

Alternative considered: port the 64-bit algorithm with `BigUint64Array` or paired
`u32` halves. Rejected; BigInt is too slow and paired halves double the work for no
gain over 32-wide chunks.

## Testing methodology

- **Oracle equivalence.** For each test chunk, rasterize both the greedy output and
  the reference output into a per-face coverage map (face direction, position, block
  id). The maps must be identical. Test chunks: empty, full, single voxel, checkerboard
  (worst case), random at several densities, generated terrain, and every chunk-corner
  neighbor configuration.
- **Quad count.** Greedy quad count is recorded per test chunk; a regression in
  merging shows up as a count increase even if coverage is correct.
- **Cluster checks.** Every quad lies inside its cluster's AABB; padding quads decode
  to degenerate; no cluster mixes faces or opaque with translucent.
- **Format round trip.** Decode every emitted quad with a TS port of the WGSL decode
  and compare corners to the reference.
- **Throughput.** `deno bench` on surface, cave, and checkerboard chunks; time per
  chunk and quads per chunk.

## Phases

### Phase 1: reference mesher and harness

- [x] Naive culled-face mesher producing packed quads (`meshReference()` in
      `src/mesh/reference.ts`), grouped by face, opaque only; border faces culled
      against neighbor planes (`src/mesh/planes.ts`: 6 x 32 u32 opacity bits,
      indexed by each face's tangent axes, built from a neighbor `ChunkData`,
      uniform, or missing)
- [x] Coverage-map comparison utility (`coverage()`, `diffCoverage()` in
      `src/mesh/coverage.ts`, also counting overlaps, out-of-bounds quads, and
      quads in the wrong face group) and the fixed test chunk set
      (`src/mesh/testchunks.ts`: 11 chunks x 3 neighbor setups)
- [x] Format decode port for tests (`src/mesh/quad.ts`: encode, decode, face and
      tangent tables, `quadCorners()`; the vertex shader must mirror it)

**Verify:** reference mesher passes hand-computed expectations for the small cases.

Tests (`src/mesh/reference_test.ts`): quad word round trip at field limits;
`quadCorners` for a +X quad; hand-computed counts (empty 0; full 6144 or 0; single
voxel 6, or 3 in a corner against opaque neighbors; checkerboard 98304 or 95232;
x < 8 slab 3072 or 1024); two touching voxels 10; per-face grouping; the oracle's
coverage matches an independent 34^3 padded-grid visibility rule on every test
chunk and neighbor setup; neighbor planes built from chunks land on the right bits.
All pass.

Registry change made here: `BLOCK_OPAQUE` now covers all 65536 ids and treats
unregistered ids as opaque, so worlds returning ids outside `BLOCKS` still mesh.

### Phase 2: occupancy and culling

- [x] Column build for all three axes (`BinaryMesher.buildColumns()` in
      `src/mesh/binary.ts`: one pass fills X columns directly from rows and sets Y
      and Z bits alongside), uniform short-circuits (air: no faces; opaque: columns
      all ones and the uniform id, no `toDense`)
- [x] Neighbor boundary planes from the six neighbors (uniform neighbors are a
      constant plane): `setPlane()` from phase 1
- [x] Bitwise face culling, emitting unmerged quads into a reused `MeshBuilder`
      (`src/mesh/builder.ts`), so meshing allocates nothing per chunk once warm

**Verify:** unmerged binary output equals the reference output exactly. Bench shows
this step's cost on its own.

Result: `binary_test.ts` passes (unmerged output matches the reference in count and
coverage on all 11 test chunks x 3 neighbor setups; uniform chunks; a reused mesher
leaves nothing behind). 60 tests pass in the suite. Bench written
(`src/mesh/mesh_bench.ts`: reference vs binary unmerged vs column build alone, on
terrain-like, random 50%, checkerboard, random neighbors). Dev machine (Arc B390
laptop, Deno 2.9.5), per chunk:

| Chunk        | Reference | Binary unmerged | Column build only |
|--------------|-----------|-----------------|-------------------|
| terrain-like | 2.1 ms    | 267 us          | 177 us            |
| random 50%   | 5.5 ms    | 905 us          | 417 us            |
| checkerboard | 2.3 ms    | 908 us          | 153 us            |

About 90 us of the column build is `toDense` (chunk_bench); building columns
straight from the palette indices would remove it. Left for phase 7.

### Phase 3: greedy merge

- [x] Slice transposition into row masks (`BinaryMesher.emitMerged()`: culled face
      bits of one direction go into 32 slices x 32 rows, bit u)
- [x] Per-key grouping within a slice. Deviation: done inline instead of grouping
      first. The width and height extensions compare block ids cell by cell
      (skipped for uniform chunks); same output, no grouping pass
- [x] Run extension across rows, emission in face-group order

**Verify:** coverage equivalence with the oracle on the full test set; quad counts
recorded as the baseline.

Result: greedy coverage equals the reference on all 11 test chunks x 3 neighbor
setups, with no overlaps, out-of-bounds or face mismatches; a full chunk is 6
quads of 32x32. 63 tests pass. `mesh(chunk, planes)` merges by default;
`merge = false` keeps the phase 2 output for tests and the bench. Quad count
baseline, pinned as upper bounds in `GREEDY_BASELINE` (`binary_test.ts`), per
neighbor setup:

| Chunk                   | Reference, empty | Greedy, empty | Greedy, opaque | Greedy, random |
|-------------------------|------------------|---------------|----------------|----------------|
| full                    | 6144             | 6             | 0              | 1365           |
| slab x < 8              | 3072             | 6             | 1              | 457            |
| terrain-like            | 7586             | 3867          | 3614           | 4259           |
| random 50%              | 50590            | 32664         | 31281          | 32264          |
| random 50%, 5 materials | 50864            | 46168         | 43556          | 45014          |
| checkerboard            | 98304            | 98304         | 95232          | 96791          |

The terrain-like test chunk is noisier than real terrain, so real surface chunks
should merge better.

Bench (`mesh_bench.ts`, random neighbors, Core Ultra X7 358H, Deno 2.9.5, after
phase 6, so the translucent palette scan is included), per chunk:

| Chunk        | Reference | Unmerged | Greedy  | Column build only | Greedy quads |
|--------------|-----------|----------|---------|-------------------|--------------|
| hills        | 1.4 ms    | 223 us   | 244 us  | 161 us            | 1591         |
| terrain-like | 1.7 ms    | 285 us   | 397 us  | 164 us            | 4259         |
| random 50%   | 6.5 ms    | 1.1 ms   | 1.9 ms  | 472 us            | 32264        |
| checkerboard | 3.0 ms    | 1.1 ms   | 2.3 ms  | 169 us            | 96791        |

Both surface chunks are under the 0.5 ms target. On hills the merge adds about 20 us
over unmerged output; two thirds of the time is the column build, about half of
which is `toDense` (83 us in chunk_bench).

### Phase 4: clustering

- [x] Split face groups into clusters with padding and AABBs (`ClusterBuilder` in
      `src/mesh/cluster.ts`, separate from the mesher; `CLUSTER_QUADS` was 64 here
      and is 32 since the plan-rendering phase 1 sweep; the tables below are at 64)
- [x] Compare emission order against sorting quads by Morton code of their center
      before splitting: mean cluster AABB volume measured below. Cull rate moved
      to [plan-rendering.md](plan-rendering.md) phase 4, which needs the cull pass

**Verify:** cluster checks pass; mean AABB volume recorded for both orderings.

Result: `cluster_test.ts` passes. It builds every test chunk with every neighbor
setup, both orders, and cluster sizes 1, 32, 64, 128 and 255, and checks
contiguous padded layout, one face per cluster, tight AABBs, zero padding quads,
quad counts, and coverage equal to the unclustered mesh. It also checks Morton
sort order, emission order preserved, reuse, and descriptor round trip. 69 tests
pass. Added a `hills` test chunk (terrain-like without the caves, the realistic
open-surface case) with its greedy baseline.

Mean cluster AABB at 64 quads per cluster, random neighbors, volume in voxels and
surface area in voxel faces (area tracks a box's mean projected size, volume
favors flat boxes):

| Chunk        | Clusters | Emission vol | Emission area | Morton vol | Morton area |
|--------------|----------|--------------|---------------|------------|-------------|
| hills        | 29       | 2274         | 1343          | 5432       | 1867        |
| terrain-like | 69       | 2041         | 1594          | 4400       | 1587        |
| random 50%   | 507      | 1020         | 1453          | 1630       | 807         |
| checkerboard | 1515     | 262          | 482           | 463        | 343         |
| full         | 24       | 369          | 825           | 478        | 1042        |

Settled in plan-rendering phase 4 with culling on: Morton order drew 2% more
clusters than emission order on the same flyover and hid about as many, while
costing 3x more to build, so `ORDER_EMISSION` stays the default.

Emission order clusters one slice at a time along the face axis, so its boxes are
flat. Morton order gives more compact boxes where quads are scattered (random,
checkerboard), and bigger ones on surfaces. Also tried, and not kept: 2D Morton on
the tangent axes only (hills 6107 / 2052), and slice first then 2D Morton (hills
2359 / 1415, about emission). Default is `ORDER_EMISSION`: cheapest, and smallest
on the surface chunks that dominate the near field. Both orders stay in
`ClusterBuilder` until the cull-rate comparison.

Bench, clustering alone on the greedy mesh (64 quads per cluster):

| Chunk        | Emission | Morton  |
|--------------|----------|---------|
| hills        | 19 us    | 58 us   |
| terrain-like | 63 us    | 126 us  |
| random 50%   | 546 us   | 1.2 ms  |
| checkerboard | 1.3 ms   | 3.0 ms  |

Morton costs 2-3x more (key build and radix sort), another point for emission order
unless the cull-rate comparison says otherwise.

### Phase 5: ambient occlusion

- [x] Spike both options below: CPU half (quad count, mesh time, data) done;
      fragment cost and look need a renderer and moved to
      [plan-rendering.md](plan-rendering.md) phase 5
- [x] Implement the winner; record the decision in
      [research-voxel-rendering.md](research-voxel-rendering.md)

Options:
- **Baked per-vertex AO** (Lysenko). AO pattern joins the merge key, which reduces
  merging near edges. Needs the neighbor voxel ring, including diagonal neighbors
  across chunk edges and corners.
- **Shader AO** from per-chunk occupancy bits uploaded to a storage buffer and read
  in the fragment shader. Merging stays maximal; costs 4 KB per near chunk and
  fetches per fragment.

**Verify:** oracle equivalence still holds (coverage ignores AO); visual check for
diagonal seams ([gotchas.md](gotchas.md) "AO anisotropy").

Result, CPU half. Baked AO is in the mesher behind an optional input:
`mesh(chunk, planes, options)`, where `options.shell` is a padded 34^3 opacity grid
holding all 26 neighbors' touching voxels (`src/mesh/ao.ts`: `faceAo`,
`vertexAo`, `shellFromPlanes`). Faces on the chunk border need the shell's edges
and corners, so a worker job with baked AO reads 26 neighbors, not 6. AO bytes are
computed during the transpose and join the merge key (identical four-corner
pattern). Encoding: occlusion level per corner, 0 unoccluded, so meshes without AO
read as unoccluded. `ao_test.ts` checks coverage is unchanged and every unit face
under a quad has the quad's AO, computed independently, on all test chunks x
setups, merged and unmerged; 74 tests pass.

Shader AO needed nothing new from the mesher: `BinaryMesher.occupancy()` returned
the X columns, which are the chunk's opacity bitset in voxel order (4 KB). Deleted
with the rest of the losing path.

Baked block light landed later and works the same way, from a second padded grid
(`options.light`, `src/mesh/light.ts`): the level of each visible face joins the merge
key beside its AO byte, so a pool of light under a glowing block breaks its quads into
steps just as AO breaks them at a crevice. It is
[plan-living-world.md](plan-living-world.md) phase 4, and it costs the forest about
13% more quads.

Greedy quad count without and with baked AO:

| Chunk        | Empty neighbors | Opaque neighbors | Random neighbors |
|--------------|-----------------|------------------|------------------|
| hills        | 1032 -> 1777    | 945 -> 1697      | 1591 -> 3100     |
| terrain-like | 3867 -> 4753    | 3614 -> 4506     | 4259 -> 5857     |
| random 10%   | 14804 -> 16381  | 14306 -> 15954   | 14577 -> 16333   |
| random 50%   | 32664 -> 48485  | 31281 -> 47167   | 32264 -> 48683   |
| full         | 6 -> 6          | 0 -> 0           | 1365 -> 3071     |
| checkerboard | 98304 -> 98304  | 95232 -> 95232   | 96791 -> 96791   |

Mesh time, greedy without and with baked AO, random neighbors (`mesh_bench.ts`):
hills 244 -> 483 us, terrain-like 397 -> 770 us, random 50% 1.9 -> 5.6 ms,
checkerboard 2.3 -> 5.0 ms. (A quick timing loop run earlier read about 2.5x lower
in absolute terms, same ratios; the bench numbers stand.) Baked AO doubles mesh
time on surface chunks, which puts terrain-like over the 0.5 ms target, and adds
70-95% quads on the realistic `hills` chunk: the flat tops merge fine, but every
height step splits the runs next to it. Random neighbors overstate the quad count
(noise on every border).

Decided (plan-rendering phase 5): baked AO. Shader AO keeps merging maximal and
needs no 26-neighbor gather, but its fragment cost, probed in the renderer, is
worse at ground level and only even from above, and it would still owe 4 KB per
near chunk of uploads and a chunk-border lookup. Numbers and the probe's method in
[plan-rendering.md](plan-rendering.md) phase 5; the decision in
[research-voxel-rendering.md](research-voxel-rendering.md) "Ambient occlusion".

What the decision cost the mesher: a job with AO reads 26 neighbors, so
`src/mesh/neighbors.ts` owns the order (faces first, then edges and corners),
`fillShell()` writes the whole shell from them, and `MeshScheduler` waits for 26
neighbors instead of 6. `?ao=0` keeps the A/B and the 6-neighbor path.

### Phase 6: translucency and worker integration

- [x] Translucent rules: opaque neighbors cull translucent faces, equal translucent
      neighbors cull each other, translucent never culls opaque
- [x] Worker job: read chunk and neighbors from the slot pool, output a transferable
      buffer from a reused pool
- [x] Edit versioning and stale-result drop

**Verify:** unit tests for translucent culling rules. In the browser, rapid edits in
one chunk never show an older mesh after a newer one.

Result. Translucency: `BLOCK_TRANSLUCENT` (registered, not air, not opaque; water
and glass added to `BLOCKS`). The binary mesher runs a second pass per translucent
id in the chunk's palette (usually none, so opaque-only chunks pay one palette
scan): source columns of that id, occluder opaque | same id, planes opaque |
border id == id. Border ids (`setBorder`, 6 x 1024 u16) are built only for chunks
with translucent voxels. Translucent quads go to `mesher.translucent`; the cluster
builder puts their clusters after the opaque ones with the translucent bit set.
`meshReferenceTranslucent` is the oracle. Tests (`translucent_test.ts`): the rules
inside a chunk and across borders, uniform water, and greedy and unmerged coverage
equal to the reference on all 15 test chunks x 3 setups, with and without border
ids; opaque output unchanged by translucent voxels. New test chunks: hills with
water, water and glass, uniform water.

Since 2026-09-16 two translucent ids of one `fluid` hide each other's faces the way one
id does (`sameFluid` in `src/world/blocks.ts`), so a sea of shallow and deep water has
no wall down its depth contours.

Worker job: "chunk.mesh" (`src/mesh/job.ts`, layouts in design-formats.md "Mesh job
and output"). Shared arena: the job reads the chunk and its six neighbors in place;
copy path: the main thread copies those blocks into a pooled buffer that the job
sends back. Output is one pooled buffer: header, padded quads, descriptors.

Scheduling (`MeshScheduler`, main thread): neighbor readiness (plan-voxel-data
phase 4: a chunk meshes only when its six neighbors are stored), empty meshes
without a job for uniform chunks that can't have faces, at most one job per chunk
with changes resubmitted after it settles, stale results dropped by version,
budgets per frame (`DEFAULT_MESH_OPTIONS`), priority by distance. Shared-arena
safety: the store defers frees and the scheduler reclaims them once every job
submitted before the free has settled (gotchas.md "A shared arena block can be
reused under a running worker"). The pool gained `onSettled()` and a `cancel()`
that reports whether the job was still queued. Tests (`mesh-scheduler_test.ts`):
readiness, empty skips, job output equal to direct meshing on both paths, stale
drop and resubmit, 300 random edit/finish steps with accepted versions strictly
increasing, eviction while queued and while running, retired blocks not reused
until the job settles, budgets, and an end-to-end run through real Deno workers.
91 tests pass.

Browser: `main.ts` meshes streamed chunks (`?mesh=0` turns it off; overlay
"meshing" line; `mesh.*` stats in bench results). The job's 6-neighbor gather became
26 when baked AO won (phase 5); `?ao=0` still takes the 6-neighbor path.

Browser check, rapid edits never show an older mesh (done once the edit tool existed,
plan-world-modelling phase 4). Editing one voxel every frame for 120 frames, then
eight a frame for 60 frames, with the accepted mesh version of that chunk sampled
each frame:

| Edits | Mesh version went backwards | Worst lag | Ended at the last edit |
|-------|-----------------------------|-----------|------------------------|
| 120   | never                       | 1 version | yes                    |
| 480   | never                       | 1 version | yes                    |

Nothing was dropped as stale in either run, which is the interesting part: the
coalescing upstream keeps a stale result from arising at all. 480 edits became 50
stored versions of the chunk, because the brush store collapses a frame's edits into
one dirty chunk and the regeneration queue collapses repeat requests for a chunk
already in flight. The stale-drop rule itself stays covered by the unit tests, which
can drive a result out of order; the browser shows the path that makes it rare. The
final block was drawn where the last edit put it.

### Phase 7: throughput pass

Starting point (phases 3-4 benches): a surface chunk costs about 244 us (hills) to
397 us (terrain-like) to mesh plus 19-63 us to cluster, so the target already holds
without AO. The job adds neighbor planes (6 x 1024 `get()` calls, about 40 us
estimated from chunk_bench's 7 ns per `get`, unmeasured) and output copies. The
largest single cost is the column build, and `toDense` is about half of it:
building columns straight from the palette indices, and planes from the neighbors'
index words, are the first candidates.

- [x] Profile with `deno bench` and the Chrome worker profiler. `deno bench` done,
      with lines for the whole job and for neighbor planes. The browser worker
      profile is deferred: at these numbers meshing can't limit the frame, so it is
      worth doing once meshes are drawn and a flyover shows where time goes
- [x] Remove allocations inside the kernel (all scratch preallocated per worker)
- [x] Decide on WASM: port only if TS misses the mesh throughput target by a clear
      margin after optimization. Decided: no WASM for now (recorded in
      [research-voxel-rendering.md](research-voxel-rendering.md))

**Verify:** mesh throughput target in CLAUDE.md met on the surface chunk bench.

Changes (before: the phases 3-4 bench tables above):
- Column build straight from the packed palette indices (`src/mesh/rows.ts`,
  `RowReader`): an X column is a row of 32 voxels, exactly `bits` words, turned into
  row bits through a 256-entry byte table built per chunk from the palette (16-bit
  chunks read one index per voxel). Y and Z columns are 32 x 32 bit transposes of
  the X columns (`transpose32`, `columnsFromRows`). No `toDense`, no per-voxel loop.
- Merge id checks compare palette indices read from the packed words
  (`BinaryMesher.indexAt`); ids are distinct in a palette, so equal index means
  equal id. The dense id scratch (64 KiB) is gone.
- Neighbor planes read the packed rows too: Y and Z layers are 32 whole rows, X
  layers one voxel per row, instead of 6 x 1024 `get()` calls.
- Allocations: the mesher and cluster builder allocate nothing once warm (checked by
  reading the code, not measured); the job reuses one uniform `ChunkData` per id.
  Left: each job still makes small views per arena block it reads
  (`readParts`, `ChunkData.fromParts`), a few dozen short-lived objects per job on
  a worker.
- Tests (`rows_test.ts`): transpose against brute force, rows and single voxels
  at every index width, Y/Z columns from rows, `setPlane` against `get()` at every
  width and face, and the mesher against the reference on 8- and 16-bit chunks. The
  existing oracle tests cover the rest. 96 tests pass.

Result (`mesh_bench.ts`, same machine). The after run was about 2.45x faster across
the board on code that didn't change (reference mesher 1.4 ms -> 568 us, `toDense`
83 -> 34 us; gotchas.md "`deno bench` numbers on the dev laptop swing"), so the
"scaled" column divides the before number by 2.45 to compare like with like:

| Line                           | Before  | Before, scaled | After  | Real speedup |
|--------------------------------|---------|----------------|--------|--------------|
| column build, hills            | 161 us  | 66 us          | 13 us  | 5.0x         |
| column build, random 50%       | 472 us  | 193 us         | 12 us  | 16x          |
| unmerged, hills                | 223 us  | 91 us          | 45 us  | 2.0x         |
| greedy, hills                  | 244 us  | 100 us         | 52 us  | 1.9x         |
| greedy, terrain-like           | 397 us  | 162 us         | 108 us | 1.5x         |
| greedy + baked AO, hills       | 483 us  | 197 us         | 144 us | 1.4x         |
| cluster, emission, hills (control, unchanged) | 19 us | 7.6 us | 6.7 us | 1.1x |

New lines: the whole job (planes, mesh, cluster, output) for hills with hills
around it, 60 us; neighbor planes from 6 dense neighbors, 12 us. The column build
is now the same 12-13 us at every density (no per-voxel work). What's left in a
surface mesh is face emission and, for multi-id chunks, the per-cell palette index
checks while merging (terrain-like: greedy 108 us vs unmerged 59 us).

**Verify:** met. A surface chunk's whole job is 60 us here, about 150 us scaled to
the slow state, against the 0.5 ms target. At that rate one worker meshes several
thousand surface chunks a second, above the voxelizer's 3,200 chunks/s. No WASM.

## Open questions

- **AO strategy.** Settled: baked AO (plan-rendering phase 5). The worker job
  gathers 26 neighbors with AO on, 6 with `?ao=0`.
- **Cluster order.** Settled: emission order (plan-rendering phase 4 cull rates).
- **Cluster size.** Set by the rendering spike; the mesher reads it as a constant.
- **Translucent sorting.** Per-chunk back-to-front order is probably enough for
  water; glass may need finer sorting. Defer until visible.
- **Merge across block ids with the same texture.** Possible if the registry maps
  several ids to one appearance; small win, adds a lookup to the merge key.
