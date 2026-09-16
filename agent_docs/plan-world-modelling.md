# Plan: world modelling with brushes

> Status: done (phases 1-6, tested). Kept as a plan rather than promoted to an
> architecture doc. Depends on [plan-sdf-generation.md](plan-sdf-generation.md)
> phases 1-3 (world contract, voxelizer, streaming; done) and
> [plan-voxel-data.md](plan-voxel-data.md) phases 1-2 and 4 (chunk container, table,
> streaming; done). Supersedes the edit half of plan-voxel-data phase 5: raycast and
> `setVoxel` land here, on top of the journal this plan defines. The record and op
> formats are settled and owned by [design-formats.md](design-formats.md) ("Brush
> instance", "Brush ops").

## Goal

Place bounded, parameterised content into a world at runtime, by hand and by tool,
without recompiling a shader, and have it survive chunk regeneration.

A *brush* is a bounded piece of world content with a transform. Three forms, which
differ in what they can be evaluated by, not in what they look like:

| Form | Representation                                  | Produces      | Editable at runtime |
|------|--------------------------------------------------|---------------|---------------------|
| SDF  | WGSL function per brush type, parameters per instance | a field  | parameters only     |
| CSG  | data: a list of primitive and blend ops, interpreted   | a field  | yes                 |
| Voxel| data: a list of ordered voxel writes             | voxels only   | yes                 |

SDF and CSG brushes are fields, so the preview, the voxelizer, and far-field bricks
can all evaluate them. Voxel brushes are not a field: they have no distance, so they
exist only at voxel resolution and only after voxelization.

## Current state

Nothing of this exists. A world is one monolithic `world_sdf` evaluated at every
sample point: `showcase.wgsl` evaluates every object in the scene per voxel and per
preview ray step, which is why it holds eight objects and not eight thousand. The
only placement mechanism is `pillars()` in the same file: `wp_repeat_id` plus
`hash3`, giving one instance per grid cell, one type, no rotation, and the cell
period baked into the world file. Chunks are voxelized once when streaming loads
them; there is no path to regenerate a resident chunk. There are no edits.

## Approach

### Two stages, never one evaluator

The world is evaluated in two stages, in this order, and never in any other:

1. **Field stage.** Terrain `world_sdf`, then SDF and CSG brush instances folded in
   instance order. Order-free for union, deterministic for subtract because the fold
   order is fixed. Runs on the GPU in the voxelizer, the preview, and the far-field
   brick sampler.
2. **Voxel stage.** Voxel brushes and player edits, replayed from one ordered
   journal. Runs on the CPU in a worker, on the dense readback, before the chunk is
   compressed into `ChunkData`.

Regenerating a chunk is stage 1 followed by a replay of stage 2. That is what makes
edits survive regeneration, and it is why edits and voxel brushes are one format and
one journal rather than two mechanisms that have to agree.

### Bounded support is a Lipschitz rule, not an early return

Region skipping ([plan-sdf-generation.md](plan-sdf-generation.md) "Sampling rules",
`voxelize.wgsl`) does not need `world_sdf` to be a true distance. It needs the
reported field to be L-Lipschitz: if `|d(c)| > L * r` then no surface lies within
`r` of `c`. So:

- A brush may underestimate distance freely. It costs evaluation, never correctness.
- A brush must never overestimate it. Returning a large constant outside the brush's
  box is the natural way to write bounded support and is exactly the bug: the
  sub-block holding the brush reports the terrain's distance, gets skipped, and the
  brush is silently deleted.
- Outside its box, a brush returns the distance to that box. That is a safe lower
  bound and stays Lipschitz.

`terrain.wgsl` already reasons this way at `SKIP_ABOVE` ("at most the true distance,
and at least 10"); brushes make the rule load-bearing.

`WORLD_LIPSCHITZ` stops being one constant per world: the bound over a region is the
max of the terrain's and of every brush overlapping it. The CPU computes that max
per chunk while it gathers the chunk's instances and passes it with the batch. A CSG
brush's bound is the max over its ops, which the CPU can compute from the primitive
kinds; an SDF brush type declares its own.

### Instances are data, types are code

WGSL has no function pointers, so the set of SDF brush *types* is compile-time: a
`switch` over a type id, concatenated into the world shader the way world files
already are. Everything else is data:

- Instance records in a GPU storage buffer, gathered per voxelize batch.
- A per-chunk `(start, count)` into a per-batch instance index array, plus the
  chunk's Lipschitz bound. `chunks: array<vec4i>` in the batch already has a free
  `w` component; the rest goes in a parallel array.
- CSG and voxel op lists in one `u32` word pool, addressed by `(offset, count)` from
  the instance record, so a brush type needs no shader change at all.

CSG brushes fold left to right (`acc = blend(acc, prim)`), which is what
`showcase.wgsl` already does by hand with `pick` and `op_*`. No stack, no tree, so
the interpreter stays branch-light and its cost is bounded by the op count. A tree
with a stack is a later extension if authoring demands it.

### Placement and transforms

- Anchor: an integer voxel cell, never f32 world coordinates (CLAUDE.md
  "Invariants"). `wp_local(p, anchor)` is the entry point that already exists.
- Orientation: one of the 24 rotations of the cube. Stored as a packed signed
  permutation (3 x (2 bits source axis + 1 bit sign)) for both the forward and the
  inverse rotation, so the shader unpacks bits and needs no runtime-indexed table
  (near.wgsl "no runtime-indexed value arrays"). The CPU owns the 24-entry table.
- Scale: uniform only for SDF and CSG brushes (non-uniform scale divides the usable
  Lipschitz bound by the smallest axis). None for voxel brushes in the first pass.

### Indexing and dirtying

`BrushStore` holds instances and a chunk-keyed multimap from chunk key to instance
ids, built on `ChunkTable`. Adding, moving, deleting, or re-parameterising an
instance yields the affected chunk set (old world AABB union new world AABB), which
marks those chunks for regeneration. The journal is indexed the same way, so a
chunk's voxel stage is "the journal entries whose AABB overlaps this chunk, in
journal order".

Two ranges, and they differ. The **index range** is the box plus `BRUSH_INDEX_PAD`
(the chunk half-diagonal) plus the blend radius, because a brush left out of a
chunk's fold must not be able to hold a surface within the radius a skip test claims.
The **dirty range** is the box plus the blend radius and a voxel, because that is
where a voxel can actually change: outside its box a union contributes a positive
distance, which never turns air solid, and a subtract a negative one, which never
turns solid to air. Only a smooth union reaches further, by its blend radius.

That difference is worth about 27 chunks against 8 for a chunk-sized brush, which is
the difference between a brush that can be animated and one that cannot.

Intersect and smax have no bounded dirty range: `max(acc, box distance)` turns solid
into air anywhere in the world. They are useful inside a CSG op list, where they meet
another op rather than the world, and are rejected as an instance's blend
(`INSTANCE_BLENDS`).

### Animation

An SDF or CSG brush animates by changing its instance record over time, never by
reading a clock inside its field function. Time in the shader would break
determinism the moment two chunks were generated at different instants, and a
regenerated chunk would stop matching its neighbours. With time held on the CPU,
generation stays a pure function of (world, seed, brush set, position) at every
instant, and animation is `store.update()` plus the regeneration phase 2 provides.

Rate and latency are different numbers and the pipeline is pipelined, so a chunk can
be asked for again as soon as its last regeneration lands. Measured on terrain seed 1
at 119 fps, one chunk from `regenerate()` to drawn (meshed and uploaded):

| Measurement                              | First cut | With the two fixes below |
|------------------------------------------|-----------|--------------------------|
| Latency at rest, p50                     | 25.1 ms   | 16.7 ms (best 8.6)       |
| Latency behind a 128-chunk backlog, p50   | 33.3 ms   | 16.9 ms                  |
| Sustained rate per chunk                  | 46.8 Hz   | 57.7 Hz                  |
| Chunk regenerations a second, one brush   | 375       | 462                      |

So a chunk-sized brush animates at about 58 updates a second with 17 ms of lag, not
the few a second an earlier reading of these numbers suggested. Throughput is the
looser constraint: `regenPerFrame` allows about 950 chunks a second at the default 8
a frame, so roughly two brushes of eight chunks animate at full rate before the
budget binds, and raising it costs about 0.08 ms of main thread per chunk. Eight
chunks regenerated together land within 7.9 ms of each other, under one frame, so a
small brush moves as one update rather than tearing across chunk boundaries.

Two things got it there, both measured above:

- **Regeneration has its own lane in the voxelizer** and is not held back by the
  streaming queue target. A chunk being regenerated is already on screen with the
  wrong content, so it goes in front of a streaming backlog rather than behind it.
  That is the whole of the 33.3 to 16.9 ms improvement under load.
- **A replacement meshes without waiting for the next `MeshScheduler.update()`.**
  `stored(key, urgent)` submits the job at once when nothing is in the way, which is
  a frame sooner. Anything in the way (a full pool, a missing neighbour, a job
  already running) leaves the chunk queued, so this is a shortcut and not a second
  scheduling path.

What remains is close to the floor for this pipeline shape: a GPU round trip for
voxelization and a worker round trip for palette compression, neither of which can
resolve inside the frame that asked for them (CLAUDE.md "Invariants"), and the best
samples already land in one frame.

The rotation in a record is one of the 24, so smooth rotation needs an SDF brush type
that takes a rotation as a parameter and applies it internally, declaring a local box
that bounds the swept volume; rotation is an isometry, so its Lipschitz bound is
unchanged.

Frame-rate animation is a different feature and not this plan's: keep animated
brushes out of voxelization and ray-march them in their own pass against the near
field's depth, the way the SDF preview already marches a world. That buys zero
latency and smooth rotation, and costs the object being voxels at all: it cannot be
mined, it casts no baked AO, and the far field does not see it.

Alternative considered and deferred: hash scatter (generalising `pillars()` into a
cell-grid scatter helper) for natural content like forests and boulder fields. It
stays a pure function of position, needs no buffers, and works in all three
consumers, but it cannot be placed by hand, which is what this plan is for.

## Testing methodology

- **Orientations in `deno test`.** The 24 codes are distinct, each has determinant
  +1, forward composed with inverse is the identity, and applying one to a voxel set
  matches a reference rotation.
- **Bounded support as a property.** For random brushes and random points outside
  the brush box, a CPU mirror of the field fold never reports more than the true
  distance to the brush. This is the test that protects against silent deletion.
- **Conservative classification, extended.** `voxelize.wgsl` already takes
  `skip = 0` to evaluate every voxel; scenes with brushes must produce identical
  chunks with skipping on and off. The single most valuable test in this plan.
- **Journal replay.** Voxelizing then replaying the journal gives the same chunk as
  applying the same edits incrementally to a resident chunk, on random op sequences.
- **Index against brute force.** `BrushStore`'s dirty chunk set matches a scan of
  every instance AABB, under random add, move, and delete sequences.
- **Browser.** Place, move, and delete brushes at chunk corners and watch every
  affected chunk regenerate and remesh within a few frames. Voxelize throughput with
  and without brushes as a bench metric.

## Phases

### Phase 1: data model and store

- [x] Orientation packing (24 rotations, forward and inverse codes) and its tests
- [x] Instance record, CSG op words, voxel op words, word pool; written up in
      [design-formats.md](design-formats.md)
- [x] `BrushStore`: instances, the chunk-keyed index, add/move/delete/edit returning
      dirty chunk sets, Lipschitz max per chunk
- [x] CPU mirror of the field fold, for tests and for the far-field fallback

**Verify:** met. Orientation, index, and bounded-support property tests pass; 130
tests in all. No GPU and no rendering yet.

Result. `src/brush/` holds `orientation.ts` (the 24 rotations as packed signed
permutations, forward and inverse, identity first), `format.ts` (the records in
[design-formats.md](design-formats.md) "Brush instance" and "Brush ops", plus the
bounds and Lipschitz bound of an op list), `build.ts` (op-list builders, so nothing
hand-packs words), `field.ts` (the CPU field fold: primitives mirroring
`src/sdf/lib.wgsl`, the CSG interpreter, and the per-instance fold), and `store.ts`
(`BrushStore`: instances in the GPU's own record layout, the chunk index, and the
dirty set).

Two things the design pinned down that were not obvious before writing it:

**A brush is never dropped from a fold, only lower-bounded.** Outside its box a
brush reports the distance to that box. Dropping a union brush lets the field claim
empty space where the brush sits, and dropping a subtract brush lets it claim solid
where the brush carves; either deletes geometry the moment a skip test believes it.
`field_test.ts` checks the rule directly by sampling inside the radius each reported
distance claims to be clear, and it fails as intended when the field is changed to
return a large constant outside the box.

**The chunk index needs a pad, not just an overlap test.** Leaving a brush out of a
chunk's list is only safe when the brush cannot hold a surface within the radius a
skip test claims, and the widest claim is a whole chunk, half a diagonal across. So
`BRUSH_INDEX_PAD` is the chunk half-diagonal rounded up (28 voxels), and a brush's
blend radius is added on top, since a smooth blend reaches k beyond its own surface.
A brush is therefore indexed into more chunks than it touches, which costs index
nodes and nothing else.

Ops live in one word pool with a bump pointer and exact-size free runs, because an
edit usually rewrites a list at the same size. Instance ids are slot indices, so a
record's word offset is `id * INSTANCE_WORDS` and a batch gather is a copy.

`update(id, fields)` changes any record field (cell, orientation, blend, blend
radius, material, scale, type) and reindexes, which is the path animation takes;
`move()` is a wrapper over it.

Deferred from this phase: the Bezier tube has no CPU mirror (its WGSL version is a
sampling plus Newton approximation, and no brush needs it yet), and CSG lists fold
left to right with no stack.

### Phase 2: chunk regeneration

- [x] Re-voxelize a resident chunk on request: `Voxelizer` accepts a regenerate
      request, `ChunkStore` replaces the payload, `MeshScheduler.stored()` remeshes
- [x] Budgeted regeneration queue, priority by distance, coalescing repeated
      requests for one chunk the way mesh jobs already coalesce by version

**Verify:** met. 16,680 chunks regenerated standing still and 8,500 per flyover with
`?regenCheck` comparing every replacement: 0 differed, 0 holes, 0 stale mesh results,
and the mesh totals unchanged.

Result. Regeneration is a `ChunkStreamer` concern, not a new pipeline:
`streamer.regenerate(key)` (and `regenerateKeys`) puts a chunk back through the same
voxel source, compressor, and store path a first load takes. Nothing new was needed
in `Voxelizer` or `ChunkStore`: the store already replaces a payload on a repeat put
of the same key, keeps the handle, and retires the old block through the deferred
frees `MeshScheduler` reclaims, which is exactly what a worker reading that block in
the shared arena needs. `stored()` then tells the mesh scheduler, which bumps the
chunk's version and remeshes; a result from before the change drops as stale on its
own.

Three properties the queue has to hold, each tested in `streaming_test.ts`:

- **A chunk keeps its old data until the new payload lands.** Regeneration never
  removes the chunk first, so there is no hole and no flicker while the GPU works.
- **Repeat requests coalesce, and one asked for mid-flight runs after.** A chunk in
  flight moves to `REGEN_WAITING` instead of being queued twice, and is queued again
  when its result settles. The same rule as mesh jobs coalescing by version.
- **A lost source does not lose an edit.** After device loss, `attach()` re-queues
  every regeneration the old source was carrying, because `request()` would not ask
  again for a chunk that is still resident.
- **The work is bounded and nearest first.** `regenPerFrame` caps submissions and
  the pick scans up to `REGEN_SCAN` entries from a rotating cursor, which bounds the
  scan without starving anything. Requests go to the voxelizer's priority lane, ahead
  of streaming, and are not gated on the streaming queue target.

Cost, `?regen=8` against the same scene with none (`flyover.20260912T123113Z` and
`T123125Z` against `T123141Z` and `T123153Z`, two runs each, means):

| Metric           | baseline    | 8 chunks/frame |
|------------------|-------------|----------------|
| cpu.frame mean   | 1.12, 1.16  | 1.76, 1.79     |
| cpu.frame p99    | 3.60, 3.72  | 4.22, 4.25     |
| GPU total        | 1.02, 1.04  | 1.31, 1.37     |
| stream.holes max | 0           | 0              |

About 0.08 ms of main thread per regenerated chunk: the dispatch, the readback
handling, the compress hand-off, the store put, and the remesh submit. Eight a frame
is a soak rate, well above what editing produces, and `regenPerFrame` is what bounds
a burst.

`?regenCheck` copies a chunk's 32768 ids aside before each replacement and compares
after, counting differences in `stream.regenDiffer`. Debug only, and its cost was not
separated from run-to-run noise.

### Phase 3: voxel ops and the journal

- [x] Voxel op kinds: set, carve, fill box, fill sphere, replace-if, paint
- [x] Ordered journal with a chunk index; worker-side apply to the dense readback,
      between voxelization and palette compression
- [x] Replay on regeneration; undo removes an entry and dirties its chunks
- [x] `setVoxel` and `setVoxels` as one-op journal entries, with boundary neighbors
      marked dirty (plan-voxel-data phase 5's edit half lands here)

**Verify:** met. In the browser, a brick wall and a metal pillar placed across chunk
borders and a crater carved out of the ground all draw correctly; generating all
10,361 resident chunks again with `?regenCheck` left every voxel identical (0
differed) and the edits in place; removing one brush restored the generated ground
under it and left the others alone.

Result. There is no second store and no second format: an edit *is* a voxel brush
with a one-op list, and the journal is the order over the voxel brushes, which is the
sequence number every instance already carries. So undo is `store.remove(id)`, the
chunk index from phase 1 is the journal's index, and the dirty set that drives
regeneration needs nothing new.

That reuse needed one correction to phase 1. `instancesIn` returned ids ascending,
but ids come from a free list, so a reused id could reorder a fold or a replay.
Instances now carry a sequence number in the record's spare word and come back in
creation order, which fixes the replay and a latent ordering bug in the field fold at
the same time.

`src/brush/voxel-ops.ts` holds the stage: `packChunkOps` gathers a chunk's voxel
brushes into one self-contained buffer on the main thread, and `applyChunkOps` writes
them into the dense ids in the worker. The ops travel with the compress job rather
than through shared memory: an edit burst is small, the copy path has to exist
anyway, and a shared journal would need the same deferred-free machinery the chunk
arena has.

Two things the pipeline had to learn:

- **A uniform chunk still goes through the compressor when ops touch it.** The
  voxelizer reports air and uniform chunks without dense ids, and the streamer stored
  those directly. An edit in mid-air had nothing to write into, so the streamer now
  asks the voxel stage whether a chunk has ops and routes it through the worker,
  which materializes the dense ids from the uniform id.
- **An edit at a chunk boundary dirties its neighbours already.** `BRUSH_DIRTY_PAD`
  is one voxel, so a voxel at a chunk corner marks all eight chunks it touches, and
  the neighbours regenerate and remesh with the faces the edit changed. Regenerating
  a neighbour whose voxels cannot change is wasted work; marking it for a remesh only
  would be cheaper (see "Open questions").

### Phase 4: placement

- [x] Voxel raycast (Amanatides and Woo DDA) across chunks, skipping uniform air
      chunks in one step (plan-voxel-data phase 5's raycast half)
- [x] Place, move, delete and rotate a brush at the raycast hit; cycle the 24
      orientations from the keyboard
- [x] Undo and redo over a command log
- [x] A tool API over the same calls, so scripted placement and hand placement go
      through one path

**Verify:** met. A 7x7x7 box placed on the corner where eight chunks meet wrote all
343 voxels, so every affected chunk regenerated and stored; undo restored every voxel
in the surrounding 32^3 window exactly, and redo restored the placement exactly. Five
posts placed at different orientations stand and lie as they should.

Result. `src/world/raycast.ts` is the traversal: Amanatides and Woo over the chunk
store, with chunks holding a single block id crossed in one jump instead of up to 32
steps per axis. That jump is the only subtle part, so it is tested against an oracle
that samples the ray every 1/512 voxel and takes the first solid hit; a traversal
that skipped a voxel would report a different first hit. A separate test counts chunk
reads across twenty uniform chunks and requires zero.

The hit carries the voxel it entered *from*, computed from the face it entered
through, which is where a placement goes. Rays stop at the edge of what is loaded
rather than pretending the world beyond is air.

`src/brush/tool.ts` turns a hit into an edit. Every edit goes through `apply(desc)`,
so a key press and a script take the same path, and undo is `store.remove(id)` with
redo adding the same descriptor again. Redo gives the brush a new sequence number,
which puts it back at the end of the journal, where it was. The log is a cursor into
an array: a new edit after an undo drops what was undone.

Keys are in `main.ts` next to the other view keys: E place, Q remove, R rotate
(Shift+R the other way), B block, X shape, Z undo, Y redo. The overlay's `edit` line
shows the tool state and what the ray is aimed at. The default box shape is 3x7x3 on
purpose: a symmetric brush would make the 24 orientations invisible.

### Phase 5: field brushes in the voxelizer

- [x] Instance and word-pool upload per voxelize batch; per-chunk `(start, count)`
      and Lipschitz bound
- [x] WGSL fold over a chunk's instances, with the box-distance rule outside bounds
- [x] CSG op interpreter (linear fold) and the SDF brush type `switch`
- [x] Material follows the fold, in `pick` semantics

**Verify:** met, except that the throughput cost came out below what the available
metric can resolve. Conservative classification holds with brushes (the test below);
spheres placed from the console appear in the voxels without a reload, carve the
terrain, and blend into each other with `smin`.

Result. `src/brush/brush.wgsl` is the fold, included by the voxelizer and ready for
the preview and the far field. `src/brush/batch.ts` packs a batch: each chunk's
records go in one contiguous run so the shader indexes them with a `(start, count)`
and no indirection, and each record's op offset is rewritten to point into the
batch's own op words. A brush covering several chunks of a batch is written once per
chunk, which is bounded by the batch size and cheaper than a second level of indices.

Three things this made concrete:

- **The Lipschitz bound is per chunk now, not per world.** `brush_ranges[c].z` holds
  the largest bound among the chunk's brushes in 8.8 fixed point, and the skip test
  uses the larger of that and `WORLD_LIPSCHITZ`. Without it a steep brush would be
  skipped over and deleted, which is what the conservative-classification test
  checks: random brushes over a flat world, voxelized with skipping on and off,
  every voxel identical.
- **The all-solid shortcut had to learn about materials.** A sub-block entirely
  inside the world could skip the field and ask `world_material` alone, but a brush
  contributes a material as well as a distance, so with brushes the fold runs
  anyway. A chunk with none still takes the old shortcut.
- **Voxel brushes are not in the fold at all.** They are not a field, and the voxel
  stage writes them onto the dense ids afterwards. The chunk still reaches the
  compressor because the streamer asks the voxel stage, not the field, so a voxel
  brush in mid-air is not lost to an all-air chunk.

The two folds are checked against each other: a GPU test voxelizes a chunk of CSG
brushes and compares every voxel against `foldInstances` from the CPU mirror, away
from surfaces where f32 and f64 can disagree, over about 31,000 voxels.

Cost. Regenerating 64 chunks over and over, with none, eight and thirty-two brushes
covering them (up to 110 records in one batch, about seven brushes a chunk):
957, 944 and 954 chunks a second. Unchanged, because `regenPerFrame` binds long
before the voxelizer does. The voxelizer's own dispatch-to-delivery latency swings
between 3.8 and 5.3 ms in every condition, so it cannot resolve the shader's cost;
measuring that properly needs a GPU timer on the voxelize pass, which today submits
its own encoder outside the renderer's frame.

Per-chunk limits: `MAX_BRUSHES_PER_CHUNK` and `MAX_OP_WORDS_PER_CHUNK`. Over them the
extra instances are dropped and counted in `voxelize.brushesDropped`, so the limit is
loud rather than silent.

### Phase 6: preview and far field

- [x] Field brushes in the sphere-traced preview, gathered from a camera-centred
      grid rather than a per-chunk list
- [x] Far-field bricks sample field brushes; chunks touched by voxel ops fall back
      to CPU reduction. Landed with [plan-far-field.md](plan-far-field.md) phase 2:
      `far-build.wgsl` folds the brushes covering each cell through the same
      camera-centred grid the preview uses, and a chunk with voxel ops is reduced from
      its voxels in a worker (`src/far/edits.ts`) instead
- [x] LOD rule for brushes smaller than `sample_footprint`: a coarse proxy, not a
      drop-out, because the near/far boundary is only 512 voxels out

**Verify:** the preview half is met: the same three brushes, two of them blended with
`smin`, sit in the same places whether the frame is traced from the field or drawn
from the voxels. The near/far popping half cannot be checked until there is a far
field.

Result. The preview takes its brushes from `BrushGrid` (`src/brush/grid.ts`), a
fixed box of chunk-sized cells around the camera chunk, rebuilt when the store's
version or the camera chunk changes. A ray crosses many chunks, so it looks its cell
up as it goes rather than being handed a run the way the voxelizer is. Brushes
outside the grid are not in the field the preview traces: the field stays consistent,
so the trace shows no artifacts, it just does not show them. That is fine for an
authoring aid and would not be for the voxelizer, which is why the two use different
structures.

**The preview found a real bug in the field, not in itself.** Outside its box a brush
reports the distance to that box, which is a safe lower bound for anything that
samples by sign, and the voxelizer had been happy with it for a whole phase. A sphere
tracer is not: that distance reaches zero at the box, not at the brush, so the tracer
stopped on the bounding box and drew a grey slab around a sphere. The rule now is to
take the box distance only when it is larger than `sample_footprint`, which is the
threshold below which a consumer can mistake a value for a surface. The saving stays
where it pays, a brush the sample is nowhere near, and the op list is evaluated where
it matters. `field_test.ts` checks it at a box corner, where the shape is furthest
from its own bounds.

The LOD proxy is in the same place: past the footprint a brush becomes its own
bounding box rather than dropping out, so brushes coarsen instead of blinking out.
Library noise drops octaves finer than the footprint and caves drop out entirely, but
caves are a zero crossing with nothing to stand in for them; a brush has a box.

## Animation: a brush that moves

Landed 2026-09-16. The store's `move()` was written as the path animation takes and
nothing took it until the showcase's orbiting brushes (`src/brush/orbit.ts`, `orbits`
in `src/worlds/index.ts`): six CSG spheres on circles about the origin, stepped every
frame, moved only when the cell they round to changes, so a frame's regeneration is the
chunks the boxes of the brushes that crossed a voxel boundary span. Four are union
brushes of different materials riding on the floor, one a glass sphere smooth-blended
into it, one a subtract carving a pit the floor heals behind. The far field follows
because a regenerated chunk now marks its bricks dirty for the edit overlay whether or
not it holds voxel ops (`urgent` in the streamer's `stored` callback), so the shadow
moves with the brush rather than staying where the brush was at the last slab build.

Measured on the dev machine in the showcase at the spawn: at 5 to 10 voxels a second
each, about 190 chunks a second regenerate, `cpu.frame` 2.1 ms p50 against 0.6 with them
held still (`?orbit=0`), GPU passes unchanged; at twice the speed, 600 chunks a second
and 56 fps. The cost is the chunk granularity: a 10-voxel sphere's padded box spans up
to eight chunks, and every one of them goes back through the voxelizer and the mesher
for a one-voxel move. That is the bound on how much of a world can move this way, and
it is why the world function itself must never take time (CLAUDE.md "Anything that
travels is drawn").

## Open questions

- **Journal growth.** The journal is the source of truth and chunks are a cache, so
  it grows without bound. Compaction means baking a region to a stored payload and
  dropping its entries, which ties into the OPFS persistence question already open
  in [plan-voxel-data.md](plan-voxel-data.md). Not urgent until a session is long.
- **Preview gather.** A camera-centred uniform grid over the loaded region is the
  proposal; whether it is cheap enough at preview resolution is unmeasured.
- **CSG interpreter cost.** Bounded by the op count per instance and the instance
  count per chunk, but the inner loop runs per voxel. Unmeasured; phase 5 measures
  it before the interpreter grows a stack.
- **Sub-voxel placement.** Anchors are integer voxels. Field brushes could carry a
  sub-voxel offset in their parameters; voxel brushes cannot. Decide if hand
  placement ever needs it.
- **Instance count.** The per-chunk list is gathered per batch, so the ceiling is
  how many instances overlap one chunk, not how many exist. No bound is set yet.
- **Remesh without regenerating.** An edit at a chunk boundary changes the
  neighbour's visible faces but not its voxels, and it currently regenerates the
  neighbour to get the remesh. A second dirty class, "faces may have changed", would
  skip the voxelize and compress round trips for those chunks.
- **Journal size.** Every edit is an instance with its own op list and index nodes.
  Thousands of single-voxel edits in one chunk is the case that needs either merging
  adjacent ops or the baking described under "Open questions" above.
- **Normals where two brushes meet.** The preview's tetrahedron normal is noisy along
  the seam where one brush's field takes over from another's, which shows as a ragged
  dark patch between two brushes that nearly touch. Cosmetic, and only in the
  preview; the voxels are unaffected because they use the sign alone.
- **Marched dynamic objects.** Whether animated brushes get their own ray-marched
  pass (see "Animation") or whether the voxel path's few-updates-a-second is enough.
  Decide when something actually needs to move at frame rate.
- **Determinism.** Generation becomes a pure function of (world program, seed, brush
  set, position). The brush set and the journal are session state and must be saved
  with the world, which changes the invariant in CLAUDE.md.
