# Plan: SDF world generation

> Status: in progress (phases 1-4 done; phase 5, the in-page world editor, is optional
> and not started; open: world-file error line check, phone voxel bench). Replaces the
> CPU noise generator in
> [plan-voxel-data.md](plan-voxel-data.md) phase 3 and the chunk-reduction brick
> builder in [plan-far-field.md](plan-far-field.md) phase 2 (for unedited terrain).
> Depends on [plan-foundation.md](plan-foundation.md); phase 1 can start now.

## Goal

A world is WGSL code: a signed distance function plus a material function. The
engine samples it on the GPU at whatever resolution each consumer needs: full
voxels for near-field chunks, coarse cells for far-field bricks, and a direct
sphere-traced preview for authoring. Distant terrain never needs full-resolution
voxels, and writing a world feels like writing a shader.

## Current state

Phases 1-3 exist: SDF library, two worlds, world selection, sphere-traced preview,
minimal block registry, GPU voxelizer with readback, and streaming of voxelized
chunks into the `ChunkStore` (compressed in workers). Nothing meshes or draws the
stored chunks yet (plan-meshing, plan-rendering). The worker pool, GPU device, and multi-source
shader compile with per-file error lines (`compileShader()` in `src/gpu/shader.ts`)
come from the foundation.
Prior art: `../astrocatch` (MIT, same author) has GLSL `smin`, `sdSphere`,
`sdEllipsoid`, `sdTorus`, `sdBezierTube`, Hoskins hash, and 3D value/simplex noise
inside `docs/renderer.js` `STAR_FS`; no composition system and no seeded noise.

## Approach

**World program contract.** A world is a file `src/worlds/<name>.wgsl`, selected with
`?world=<name>`, concatenated after the SDF library at compile time. It defines:

```
fn world_sdf(p: WorldPoint) -> f32      // signed distance in voxels, negative inside
fn world_material(p: WorldPoint) -> u32 // block id where world_sdf < 0
const WORLD_LIPSCHITZ: f32              // bound on |gradient| of world_sdf, >= 1
```

The exact layout (including `WorldPoint`) will be owned by
[design-formats.md](design-formats.md) "World program" once phase 1 settles it.

**Precision.** f32 can't hold sub-voxel positions far from the origin, and hash-based
noise bands at large inputs. `WorldPoint` carries an integer voxel coordinate plus
an f32 fraction; library noise and repetition take that split form and stay exact
at any distance. Primitives placed near the origin can use a plain `vec3f`
(`wp_f32(p)`), accepting approximate results far away.

**SDF library** (`src/sdf/lib.wgsl`): primitives (sphere, box, round box, torus,
capsule, cylinder, plane, ellipsoid, quadratic Bezier tube), operators (union,
subtract, intersect, `smin`/`smax`, limited repetition, displacement), and seeded
noise built on integer hashes (value, gradient, fbm, ridged) with the seed from a
world uniform. Primitives and noise ported from astrocatch with attribution
comments; the hash replaced by an integer hash so results don't band.

**Sampling rules.**
- A voxel is solid when `world_sdf` at its center is negative. Only the sign is
  used, so non-exact SDFs (`smin`, ellipsoids, noise displacement) are fine here.
- Skipping uses the Lipschitz bound: if `|d(center)| > WORLD_LIPSCHITZ * half
  diagonal`, the whole region has one sign. Applied per chunk, then per 8^3
  sub-block, so empty sky and deep rock cost one evaluation.
- A far-field cell of size s is solid when `d(center) < t * s / 2`; the threshold
  t settles the reduction-rule question in plan-far-field (open question below).

**Near field: GPU voxelization with readback.** A compute pass takes a batch of chunk
coordinates, classifies them, and writes a u16 block id per voxel for mixed chunks
into a staging storage buffer. Results come back through a ring of mapped readback
buffers (the `GpuTimer` pattern), are copied into pooled `ArrayBuffer`s, and go to
workers for palette compression into the chunk store. Uniform chunks come back as a
flag and a block id, with no payload.

**Far field: no readback.** A compute pass samples the SDF at level-k cell centers
directly into the brick pool and indirection buffers. Edited chunks are the
exception: their bricks are rebuilt from CPU chunk data as plan-far-field planned.

**Preview.** A full-screen sphere-traced view of `world_sdf` (toggle key), for
writing worlds before the voxel pipeline exists and for checking voxelization
against the true surface.

Alternatives rejected (recorded with reasons in
[research-voxel-rendering.md](research-voxel-rendering.md) "SDF world generation"):
TypeScript SDFs in workers (slower per voxel; GLSL must be hand-translated), and a
node tree compiled to both TS and WGSL (limited to provided nodes; most up-front
work).

## Testing methodology

- **Compute correctness in `deno test`.** Deno's built-in WebGPU (wgpu/naga) runs
  the voxelizer headless. Tests check properties, not cross-platform hashes: a
  sphere world's voxel count is within a tolerance of its volume; classification is
  conservative (a chunk marked uniform has no mixed voxels when fully evaluated) over
  random worlds and seeds; readback round-trips.
- **Per-machine determinism.** The same world and seed produce identical voxels on
  repeated runs in one browser. Across GPU vendors, surface voxels may differ (f32);
  tests never compare against hashes from another machine.
- **Browser.** Voxelization throughput (chunks per second, readback latency) as a
  bench metric; preview versus voxels visual check.

## Phases

### Phase 1: library, world contract, preview

- [x] `src/sdf/lib.wgsl`: primitives (sphere, box, round box, torus, capsule,
      cylinder, ellipsoid, Bezier tube), operators (union, subtract, intersect,
      smin/smax, onion, `pick`), pcg3d-hashed seeded noise (`gnoise2`, `gnoise3`,
      `fbm2`, `fbm3`, `ridged2`) with per-octave integer lattice shifts
- [x] `WorldPoint` split form and the world program contract; example worlds
      `showcase` (primitives near the origin, repeated pillars across the plane) and
      `terrain` (fbm hills, masked ridged mountains, two-field caves)
- [x] `?world=<name>&seed=<n>` selection; world uniform (seed and block colors)
- [x] Sphere-traced preview pass (`SdfPreview`, `src/sdf/preview.ts`), P toggles
      it, G toggles the grid; 256-step cap; writes depth so the grid hides behind
      terrain. A world that fails to compile disables only the preview.
- [x] Record the contract in design-formats.md "World program"
- [x] Minimal block registry `src/world/blocks.ts` as the single source of block
      ids: generates the WGSL `BLOCK_*` constants and the color table (plan-voxel-
      data phase 1 extends it)

**Verify:** both example worlds render in the preview in Chrome; a syntax error in a
world file reports the world file's own line; noise at `?at=1000000,0,1000000` shows
no banding.

Result so far: `deno check` and the release build are clean. Both worlds' preview
pipelines compile and build under Deno's WebGPU (naga). Terrain height sampled in a
Deno compute pass at 1/64-voxel steps over 64 voxels: at x = 0, 1e6, and -1e6 the
largest step is 0.007-0.009 (slope about 0.6) and 4075-4093 of 4096 samples are
distinct, so no banding. In Chrome: `showcase` renders. `terrain` first showed
gray/black because the shared start point (y = 12) was inside the terrain (surface
near the origin is about 75): the preview "hit" at the camera. Fixed with per-world
spawn points (`WORLDS` in `src/worlds/index.ts`) and a preview that marches out of
solid before tracing, so flying through terrain shows what lies beyond. `terrain`
then rendered but at 220 ms GPU per frame (5 fps, full-window canvas). Fixes:
- `sample_footprint` in lib.wgsl: noise skips octaves finer than the sample's
  footprint (pixel width in the preview; reused later for far-field cells).
  `ridged2` renormalizes by the octaves it evaluated so distant mountains keep their
  height.
- Octave lattice shifts are an affine function instead of a pcg3d hash per octave.
- `terrain`: returns `y - 150` without noise above y = 160 (no peak exceeds 150);
  skips caves when the footprint exceeds 8 voxels.
- The preview renders at `?previewScale` (default 0.5) into offscreen targets, then
  `preview-blit.wgsl` upscales color and writes depth in the main pass. It is its
  own timed pass ("preview"); `GpuTimer` now reads back only passes that ran.

After these fixes `terrain` is fast in Chrome (user-confirmed). Still unchecked:
the world-file error line.

Note for later phases: bench scenes use fixed heights (30-40 voxels), which are
underground in `terrain`. Scenes will need world-aware spawn heights once there is
voxel load to measure.

### Phase 2: GPU chunk voxelizer

- [x] Compute pipeline (`voxelize.wgsl`, `Voxelizer` in `src/sdf/voxelizer.ts`):
      batches of 16 chunk coordinates, one workgroup per 8^3 sub-block, center
      sample plus Lipschitz bound skips all-air sub-blocks and evaluates only
      materials in all-solid ones; u16 ids and per-chunk atomic counters; kinds
      air / uniform / dense; `compact_dense` packs dense payloads
- [x] Readback ring (default 4 slots, `?voxelSlots=n`): headers mapped first, then
      only the dense prefix; ids copied into pooled `Uint16Array`s (`recycle()`)
- [x] Per-frame dispatch budget (2 batches; `?voxelBench` uses every free slot);
      voxelizer line in the overlay (queued, in flight, chunks/s by kind, MiB
      mapped, batch latency)
- [x] `deno test` property tests (`voxelizer_test.ts`): sphere volume, uniform and
      air classification, voxel layout, skip-versus-full equality on both real
      worlds, determinism
- [x] `?voxelBench`: voxelizes 25 x 25 x 8 chunks around the spawn with the preview
      off, saves `bench/results/voxelize-<world>.*.json`

**Verify:** property tests pass; throughput recorded on the dev machine and the
Android phone; readback never stalls the frame (no `mapAsync` awaited in the frame).

Result so far: `deno check` and the build are clean. Smoke run on Deno's WebGPU: a
radius-20 sphere gives 33552 solid voxels against a volume of 33510 (0.13%); 144
terrain chunks give byte-identical results with and without skipping (69 air, 1
uniform, 74 dense). Deno's timings (skip 387 ms, full 368 ms) are dominated by its
map latency and don't predict browser throughput.

`deno task test`: all 31 tests pass, including the five voxelizer property tests on
Deno's WebGPU.

`?voxelBench` in Chrome 152, Arc B390, terrain
(`bench/results/voxelize-terrain.20260911T101440Z.chrome-152-on-linux.json`): 5000
chunks in 0.73 s = 6860 chunks/s; 3967 air, 21 uniform, 1012 dense; 63 MiB mapped
(dense payloads only); 5.5 ms batch latency; 4 slots. 313 batches in 0.73 s is
about 430 batches/s, which is 4 slots x 120 Hz: throughput is bound by pumping once
per frame, not by the GPU or the readback. Dispatching again as soon as a slot
frees (from the map callback) or more slots should raise it; not needed yet. For
scale: refilling a 16-chunk-radius near field (about 8700 chunks) takes about 1.3 s
at this rate, and sprint flight needs about 1650 chunks/s, which the normal
2-batch-per-frame budget (about 3800 chunks/s at 120 Hz) covers.

Pending: the phone run, and frame-time impact during voxelization (the voxel bench
doesn't record frame times yet).

Open, found while building: fully solid chunks still evaluate `world_material` per
voxel, so deep rock costs as much as the surface. A world-declared "material
depends only on depth below surface" hint, or lazy materials for unexposed chunks
(plan-voxel-data), would remove most of that work.

### Phase 3: chunk store integration

- [x] Needs plan-voxel-data phases 1-2 (container, chunk table)
- [x] Workers palette-compress readback payloads into containers: job
      `chunk.compress` (`src/workers/jobs.ts`) runs `ChunkData.fromDense` and writes
      the result in arena block layout into a pooled buffer; the main thread copies
      it in with `ChunkStore.putBlock` and recycles both buffers (no garbage per
      chunk). Air and uniform results skip the worker and go straight to the store.
- [x] Streaming scheduler issues voxelization batches instead of CPU generation jobs:
      `ChunkStreamer` (`src/world/streaming.ts`), see plan-voxel-data phase 4

**Verify:** flyover bench keeps streaming up at sprint speed; state counters return
to steady state.

Measuring it: bench scenes are now offsets from the world's spawn point, and every
run records `stream.holes` (chunks within 4 horizontally and 1 vertically of the
camera that should be resident but aren't) per frame; the overlay's bench table
shows its p99 and max, the JSON has the full summary plus a streaming snapshot.
`streaming_test.ts` covers the scheduler with a fake voxelizer and compressor.

First flyover, terrain, Chrome 152, preview on
(`bench/results/flyover.20260911T103914Z.chrome-152-on-linux.json`): streaming did
not keep up. Holes p50 0, p95 21, max 32 of the 147 inner chunks; only about 610
chunks/s loaded, and the resident set stayed a disc of about 6 chunks instead of
16. Frame p50 25 ms, GPU preview 27 ms. Diagnosis: voxelization was tied to the
frame (dispatch only in the per-frame pump, a 32-chunk streamer queue), and every
batch waited behind the preview on the GPU (voxelizer latency 103 ms against 5.5 ms
in `?voxelBench`), so 4 slots gave about 465-610 chunks/s. Changes: the voxelizer
refills a slot as soon as it completes (`deliver()` calls `pump(1)`), 8 slots by
default, a 128-chunk streamer queue, and `?preview=0` to measure streaming without
the preview's GPU cost. The first version of the refill ran inside `deliver()`,
before the payload buffer was unmapped, and produced "used in submit while mapped"
validation errors (and stale readback); fixed by freeing the slot in `release()`
after unmapping (gotchas.md). Deno smoke run after the fix: no validation errors,
results unchanged, and 144 terrain chunks in 47 ms instead of 387 ms.

Result after the fixes, terrain flyover at sprint speed, Chrome 152, Arc B390,
1920x1080:

| Run                 | Holes p50/p99/max | Loaded (11.5 s)    | Resident at end        | Frame p50, missed | CPU frame p99 |
| ------------------- | ----------------- | ------------------ | ---------------------- | ----------------- | ------------- |
| preview on          | 0 / 0 / 0         | 19,408 (~1,700/s)  | 6,444, 256 requested   | 16.7 ms, 112      | 1.37 ms       |
| `preview=0`         | 0 / 0 / 0         | 36,959 (~3,200/s)  | 11,583, 0 requested    | 8.33 ms, 0        | 1.26 ms       |

(`flyover.20260911T104424Z` and `flyover.20260911T104449Z` in `bench/results/`.)
Verify met: no holes at sprint speed, and without the preview the full load range
stays resident with the request and compress counters back at 0. With the preview
on, the preview's GPU cost (17.5 ms) still slows filling of the outer range, but the
inner range never has holes. The arena held 37 MiB for 11,583 resident chunks
(about 3.2 KiB each; most are uniform). Caveat: `cpu.frame` doesn't include work in
map and worker callbacks (block copies, deliveries), which run between frames; the
120 Hz run with 0 missed frames says that work fits, but it isn't measured on its
own yet. The 5 streaming tests pass (60 in the suite).

### Phase 4: far-field bricks from the SDF

Built in [plan-far-field.md](plan-far-field.md) phase 2, which owns the result;
`src/far/far-build.wgsl` is the pass.

- [x] Compute pass fills bricks and indirection from the SDF, folded with the field
      brushes covering each cell (`brush_fold` in `src/brush/brush.wgsl`), or placed
      brushes vanish at the near/far boundary
- [x] Edited regions fall back to CPU reduction from chunk data
      (`src/far/reduce.ts`, in a worker)
- [x] Per clipmap slab rather than per whole grid (plan-far-field phase 3)

**Verify:** met. The sampled bricks agree with the same grid
reduced from chunk data on 97.35% of solid cells, and the cells they miss are all
sub-cell features the centre sample cannot see, never invented ones
([plan-far-field.md](plan-far-field.md) phase 2).

Brushes extend this contract rather than replacing it: placed instances are folded
into the field after `world_sdf`, under the same Lipschitz rule, and voxel ops are
replayed after voxelization. See
[plan-world-modelling.md](plan-world-modelling.md).

### Phase 5 (optional): live world editing

- [ ] In-page WGSL editor for the world file; recompile, clear, and regenerate
- [ ] Errors mapped to editor lines in the overlay

**Verify:** editing a world updates the preview and the voxels without a reload.

## Open questions

- **`WorldPoint` ergonomics.** How much of the library takes the split form, and how
  authors write simple shapes without thinking about it.
- **Readback format.** Dense u16 (64 KiB per mixed chunk) is simplest. u8 ids or a
  GPU-side occupancy bitmask plus sparse ids would cut bandwidth; decide from phase 2
  throughput numbers, especially on the phone and in Firefox (slower `mapAsync`).
- **Lipschitz bounds.** Authors declare `WORLD_LIPSCHITZ`; noise displacement raises
  it. A wrong bound silently skips real surfaces. Phase 2's conservative-
  classification test samples for this, but a debug mode that checks skipped regions
  at full resolution may be needed. Brushes make this sharper: the bound over a
  region becomes the max of the terrain's and of every brush overlapping it
  ([plan-world-modelling.md](plan-world-modelling.md)).
- **Far-field threshold t.** Settle with the plan-far-field reference comparison.
- **Cross-vendor differences.** Acceptable for a single-player engine; a networked
  or shared-world use would need CPU generation or fixed-point noise.
