# Plan: voxel data, generation, streaming, edits

> Status: in progress (phases 1-2 done and verified; phases 3 and 5 superseded; phase 4
> streaming partly in via plan-sdf-generation phase 3: load range, hysteresis,
> nearest-first requests, budgets, eviction, neighbor readiness; frustum priority
> remains). Depends on [plan-foundation.md](plan-foundation.md) (worker
> pool, camera, bench harness). Formats are owned by
> [design-formats.md](design-formats.md); this plan implements them. Phase 3 (CPU
> noise generator) is superseded by [plan-sdf-generation.md](plan-sdf-generation.md):
> chunks are voxelized from a WGSL SDF on the GPU and read back. Phase 5 (raycast
> and edits) is superseded by [plan-world-modelling.md](plan-world-modelling.md),
> where edits are journaled so they survive regeneration. This plan's container,
> chunk table, and streaming still apply.

## Goal

Store and stream a world large enough that the renderer, not the data layer, is the
bottleneck: chunks generated deterministically in workers, held compactly, loaded and
unloaded around a moving camera under per-frame budgets, and editable with voxel
precision.

## Current state

Block registry (`src/world/blocks.ts`), chunk container (`ChunkData`,
`src/world/chunk.ts`), chunk keys and table (`keys.ts`, `chunk-table.ts`), payload
arena and store (`arena.ts`, `store.ts`), streaming (`streaming.ts`). No raycast or
edits yet; both moved to [plan-world-modelling.md](plan-world-modelling.md).

## Approach

- **Chunk container** with uniform, palette, and dense-scratch variants
  ([design-formats.md](design-formats.md) "Chunk storage"). Uniform is the common
  case and must be handled first-class everywhere.
- **Chunk table**: open-addressing hash table in typed arrays, numeric chunk key to
  slot index. Slots live in a pool (a `SharedArrayBuffer` when isolated) with a
  generation counter per slot, so a stale reference is detectable.
- **Generation** moved to the GPU: chunks are voxelized from the world SDF and read
  back ([plan-sdf-generation.md](plan-sdf-generation.md)); workers only
  palette-compress the readback into `ChunkData`. The original plan (CPU noise in
  workers, column height bounds for uniform chunks) is superseded; its uniform-chunk
  idea survives as Lipschitz-bound skipping on the GPU.
- **Streaming as an explicit state machine** per chunk:
  `absent → queued → generating (GPU) → compressing (worker) → generated → meshing →
  meshed → resident`, plus `evicting`. Every transition is driven by a budgeted scheduler on the main thread.
  Priority is distance to camera, boosted when inside the frustum.
- **Edits** moved to [plan-world-modelling.md](plan-world-modelling.md): they are
  entries in an ordered journal, replayed onto a regenerated chunk, so a brush moving
  or a chunk reloading never loses them. The API shape survives: one call that marks
  the owning chunk dirty and also marks neighbors when the voxel is on a chunk
  boundary (their faces change). Dirty chunks get high mesh priority; the far field
  is notified per brick.

Alternative considered: string or tuple keys in a `Map`. Rejected for GC and hashing
cost at tens of thousands of chunks.

## Testing methodology

- `deno test` for the container (get/set round trips across every palette width,
  palette growth and compaction, uniform promotion and demotion), the hash table
  (insert, delete, tombstones, resize), key packing at range limits and negatives.
- Generation determinism and correctness are tested in plan-sdf-generation (GPU
  property tests on Deno's WebGPU). No committed output hashes: GPU results may
  differ between vendors (CLAUDE.md "Invariants").
- `deno bench` for the container (`chunk_bench.ts`) and table lookups
  (`chunk-table_bench.ts`).
- Browser: streaming counters in the overlay; a flyover bench must show no chunks
  stuck in an intermediate state.

## Phases

### Phase 1: block registry and chunk container

- [x] Block registry: id → properties, loaded from a TS table (`BLOCKS` in
      `src/world/blocks.ts`, created in plan-sdf-generation phase 1; this phase added
      the `BLOCK_OPAQUE` lookup table for kernels)
- [x] Container with uniform and palette variants (`ChunkData` in
      `src/world/chunk.ts`); dense scratch is a plain `Uint16Array` via `toDense()`
- [x] Bit-packed index read/write for all widths; palette grow (`set()` widens and
      repacks) and compact (`compact()` drops unused ids and shrinks the width)
- [x] Uniform detection on write-back: `fromDense()` and `compact()` return a
      uniform chunk when one id remains
- [x] `ChunkParts` for moving chunks between threads (`toParts()`, `fromParts()`)

**Verify:** container unit tests pass; memory per chunk type reported by a bench.

Tests: `src/world/chunk_test.ts` (widths, round trips at every width, growth
through all widths against a reference, compaction back to uniform, layout, parts,
payload sizes). Bench: `src/world/chunk_bench.ts` prints payload bytes per chunk
type and times `fromDense`/`toDense`/`get`. First test run: 7 of 8 passed; the
growth test's own data generator was wrong (an LCG's `r() % 300` never produced
more than 256 distinct ids, so the palette correctly stayed at 8 bits while the test
expected 16). Test fixed to seed ids 0-299 explicitly and assert against the ids
actually set; all 8 pass.

Bench (Deno 2.9.5, Core Ultra X7 358H, one thread):

| Operation                     | Time per chunk | Chunks/s |
| ----------------------------- | -------------- | -------- |
| `fromDense`, terrain-like     | 186 µs         | 5,400    |
| `fromDense`, 200 ids          | 179 µs         | 5,600    |
| `toDense`, terrain-like       | 104 µs         | 9,700    |
| `toDense`, 200 ids            | 90 µs          | 11,100   |
| `get` x 32768, terrain-like   | 234 µs (7 ns per voxel) | |

Payload bytes: uniform 2, terrain-like (4 ids, 2 bits) 8200, noisy 200 ids (8 bits)
33168. A terrain chunk stored at 8 KiB is an eighth of the 64 KiB the voxelizer
reads back. One worker compresses about 5,400 chunks/s, so the pool is far above
the voxelizer's 6,860 chunks/s.

### Phase 2: chunk table and slot pool

- [x] Key packing and unpacking per the coordinate spec (`src/world/keys.ts`:
      `chunkKey`, `keyX/Y/Z`, `hashKey`)
- [x] Open-addressing table (`ChunkTable`, `src/world/chunk-table.ts`): linear
      probing, tombstones, rehash past half load; `reserve()` keeps growth off the
      frame path, `rehashes` counts any that slip through
- [x] Slot pool with generation counters (`ChunkStore`, `src/world/store.ts`) over a
      payload arena with SAB and copy variants (`PayloadArena`,
      `src/world/arena.ts`; layout in design-formats.md "Payload arena")

**Verify:** table unit tests, including randomized insert/delete against a `Map`
reference. Lookup bench at the planned resident chunk count.

Tests: `src/world/store_test.ts` (key round trips at range limits, 200k random
table operations against a Map, `reserve()` without rehash, arena round trip for
both buffer kinds with reuse and full detection, store replace/remove/stale handles,
full store). Bench: `src/world/chunk-table_bench.ts` (hit and miss lookups at 16k
and 64k resident).

Result: all 6 tests pass (45 in the suite). Lookup bench (same machine):

| Resident | Hit     | Miss    |
| -------- | ------- | ------- |
| 16,384   | 27 ns   | 50 ns   |
| 65,536   | 35 ns   | 66 ns   |

At the near field's ~8,700 chunks, even a full sweep of every chunk (never done per
frame) would cost about 0.25 ms.

### Phase 3: generator (superseded)

Superseded by [plan-sdf-generation.md](plan-sdf-generation.md) phases 1-3. The
uniform-classification idea carries over as Lipschitz-bound skipping on the GPU.
What stays in this plan: the worker job that palette-compresses a readback payload
into a container (plan-sdf-generation phase 3 uses the phase 1 container API).

### Phase 4: streaming scheduler

- [x] Load radius (horizontal circle and vertical separately, `?streamRadius`,
      `?streamHeight`) with unload hysteresis (`ChunkStreamer`,
      `src/world/streaming.ts`, built in plan-sdf-generation phase 3)
- [ ] Priority queue keyed by distance and frustum membership, rebuilt incrementally
      when the camera crosses a chunk boundary, not every frame. Done: distance
      order from offsets presorted once; a chunk crossing restarts the walk from the
      nearest offset, and the voxelizer queue is kept shallow (`queueTarget`) so
      stale far requests never pile up. Not done: frustum boost.
- [x] Per-frame budgets: offsets scanned (`scanPerFrame`), voxelizer batches (2 per
      frame), eviction sweep (`sweepPerFrame`). Results integrate as they arrive
      (voxelizer map callbacks, worker results); upload bytes arrive with meshing.
- [x] Neighbor readiness: a chunk is mesh-ready only when its six neighbors are
      generated (or known uniform). Done in `MeshScheduler`
      (`src/world/mesh-scheduler.ts`, plan-meshing phase 6): streaming tells it
      when chunks are stored or evicted (`ChunkStreamer.listener`). Chunks on the
      edge of the load range stay unmeshed, so the meshed radius is one less than
      the load radius.
- [x] Eviction frees slots and notifies the renderer and the far field: `MeshScheduler`
      drops the mesh and clears the chunk's bit in the far field's coverage mask
      (`src/far/coverage.ts`). The far field's own bricks need no notice; they are
      sampled from the field, not from chunks

**Verify:** flyover bench at increasing speeds; record the speed at which holes
appear. State counters return to steady state after the camera stops.

The hole count (`stream.holes` in bench results, `holes` in the overlay's streaming
line) is the measurement. Unit tests: `src/world/streaming_test.ts` (nearest first,
no duplicates, queue target, full fill with no holes, eviction after moving,
dense results through the compressor, stale and unsolicited results dropped,
re-requesting after `attach()`).

### Phase 5: raycast and edits (superseded)

Done, in [plan-world-modelling.md](plan-world-modelling.md) phases 3 and 4
(`src/world/raycast.ts`, `src/brush/voxel-ops.ts`, `src/brush/tool.ts`). Edits
have to survive chunk regeneration, which means they are journaled voxel ops replayed
after the field stage, not direct writes to a stored chunk. The raycast and
`setVoxel` API are unchanged in shape; they sit on the journal instead of on
`ChunkStore` directly.

## Open questions

- **Persistence.** Edited chunks could be saved to OPFS as palette payloads. Not
  needed until edits matter across sessions.
- **Vertical extent.** Finite world height (simpler scheduling, cheaper columns) or
  unbounded cy within the key range. Leaning finite with a configurable height.
- **Voxel id width.** `u16` covers block types; per-voxel color (for imported
  models) would need a different path. Decide if an import feature is planned.
