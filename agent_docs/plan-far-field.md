# Plan: far-field ray marching

> Status: done (phases 1-5, plus the adaptive reach in "How far to reach" below).
> Promote to `agent_docs/architecture-far-field.md` when the open questions below are
> settled. Depends on [plan-voxel-data.md](plan-voxel-data.md) (chunk
> data and edit events) and on the opaque pass from
> [plan-rendering.md](plan-rendering.md) phase 3. Brick and indirection layouts are
> owned by [design-formats.md](design-formats.md).

> Brushes: done in phase 2. The GPU builder folds the field brushes covering each
> cell (`brush_fold` in `src/brush/brush.wgsl`, through the same camera-centred grid
> the preview uses), and chunks touched by voxel ops are reduced from chunk data in a
> worker instead. That was [plan-world-modelling.md](plan-world-modelling.md) phase
> 6's unfinished half.

## Goal

Render terrain out to tens of thousands of voxels beyond the meshed near field at a
fixed, budgeted GPU cost, with no visible seam where raster ends and ray marching
begins, and with edits reflected at every distance.

## Current state

All five phases are in. `src/far/clipmap.ts` holds L camera-centred levels with toroidal
indirection and decides which slabs to build, `src/far/pool.ts` allocates brick slots,
`src/far/far-build.wgsl` samples a slab straight from the world SDF on the GPU and
takes slots for the bricks it finds occupied, `src/far/reduce.ts` reduces bricks from
chunk data for regions an edit has changed (in a worker, `src/far/brick-job.ts`,
scheduled by `src/far/edits.ts`), `src/far/far.wgsl` marches level by level, lit and fogged by the near
field's own `src/render/shading.wgsl`, `src/far/coverage.ts` keeps the chunks the near
field is drawing so the march can leave them to it, and `src/far/far-field.ts` owns the
buffers and composites the result behind the near field. `?far=on|steps|bricks|levels|blocks|height` turns it on and picks a debug view, `?farLevels`,
`?farFirst`, `?farBricks` and `?farSlabs` size the clipmap, `?farScale` sets the march
resolution and `?farBeam=0` turns the beam pre-pass off, `?farCheck` compares the
sampled bricks against the chunk reduction, and F queues every level again.

The march costs 1.2 to 1.7 ms p50 over the flyover bench at 1080p and 1.0 over the grove
(2026-09-15, "An axes word per brick" under phase 5), with the beam pre-pass at 0.066 and
slab sampling at 0.5. It is on by default; the level count is trimmed to the world's fog
horizon at startup, and the adaptive controller (`?farAdapt=1`) can move it further, off
by default because what it moves is visible while the camera is still.

## Approach

- **Brickmap clipmap.** Levels k = 1..L, each a camera-centered B^3 grid of bricks
  with cell size 2^k voxels. Indirection is a `u32` storage buffer per level with
  toroidal addressing, so camera movement only rewrites the slab of bricks that
  scrolls in. Bricks live in one shared pool buffer.
- **Traversal in compute.** One invocation per pixel of the far-field target (8x8
  workgroups). Build the ray in render space, start at the near-field boundary, DDA
  over the indirection grid of the finest level containing the ray, skip empty
  bricks whole, DDA over the 512 bits inside an occupied brick, and step up a level
  when leaving the current level's extent. Hard iteration cap
  ([gotchas.md](gotchas.md) "Unbounded loops can reset the GPU").
- **Beam pre-pass.** A coarse pass (one ray per tile) finds a conservative start
  distance per tile; the full pass starts from it. Laine and Karras's beam
  optimization; cuts empty-space steps for all pixels in a tile.
- **Composite.** The march reads the opaque depth with `textureLoad` and skips pixels
  covered by near geometry. It writes color and fog into an `rgba16float` storage
  texture that a render pass composites onto the frame
  ([gotchas.md](gotchas.md) "Canvas format").
- **Ray start.** The march begins where the ray exits the region of meshed chunks,
  not at the camera. Starting at the camera would let coarse level-1 cells show
  through gaps the near field correctly left open (windows, overhangs).
- **Brick building in workers.** A chunk produces its level-1 cells by 2x2x2
  reduction; level k+1 reduces level k. Rebuilt lazily on edit events, budgeted.
- **Reduced resolution.** The target can be half resolution with a depth-aware
  upsample. Far-field detail is under a pixel by construction.

Rationale for brickmap over SVO, SVDAG, and LOD meshes:
[research-voxel-rendering.md](research-voxel-rendering.md) "Far field".

## Testing methodology

- **Reference comparison.** A test region rendered twice: once rasterized at full
  resolution, once ray-marched at level 1 from the same camera. Silhouettes and depth
  should agree within one level-1 cell. Used after every traversal change.
- `deno test` for the reduction rules, toroidal index math, and a TS port of the DDA
  run against brute-force ray/voxel intersection on random bricks.
- Bench: far-pass GPU time per resolution scale, with and without the beam pre-pass;
  frame p99 during fast flight (slab updates are the risk); upload bytes per frame.
- Visual checks: seam at the near/far boundary, popping at level transitions,
  shimmer during camera motion.

## Phases

### Phase 1: single-level prototype

- [x] Brick pool and one indirection level built on the CPU from a fixed region
- [x] Compute march with two-level DDA, flat shading from the step axis, composite
- [x] Debug views: step-count heatmap, level index

**Verify:** met. With the near field hidden, the marched terrain has the same
silhouettes, hills and snow line as the rasterized frame from the same camera,
coarser by a 2-voxel cell. The step heatmap is low over open sky and over ground the
ray meets quickly, and high in a band at the horizon, where a grazing ray crosses the
whole grid: the shape empty-space skipping is supposed to produce, and the case the
phase 5 beam pre-pass is for.

Result. One level (k = 1, 2-voxel cells, 16-voxel bricks), a 32^3 grid covering 512
voxels, built on demand from the chunk store rather than per frame. 12,877 bricks over
the loaded region, 7.4 MiB of pool. The grid is plain rather than toroidal and the
pool holds every brick the grid can address, so a build never has to drop one; both
are phase 3's job to do properly.

Cost: the far pass is 0.542 ms at 1920x1080, full resolution, at ground level
(`cave.20260912T141824Z`), against a 1.96 ms GPU frame. Resolution scaling and the
beam pre-pass are phase 5, and the heatmap says where they will pay.

**The test that mattered was not the one planned.** The methodology called for the DDA
port to be checked against "brute-force ray/voxel intersection", and the first
version sampled the ray at a fixed step and took the first solid cell. It reported the
march hitting cells that were not on the ray. The march was right: a ray can clip the
corner of a cell over an interval far shorter than any sampling step, and the sampler
walks straight past it. The reference is now an exact single-level DDA over cells with
no brick level at all, which is both exact and independent of the thing under test,
since the brick skipping is what has the bugs.

Three bugs that only the browser found, all of them about order rather than
traversal:

- The inner DDA clamped the entry cell into the brick. On a ray that only grazes a
  brick's corner that invents a cell the ray never reaches, and the march reports a
  hit in mid-air. It now steps a hair past the entry and rejects the brick if the cell
  lands outside.
- The blit binds its own group 0, and the sky, grid and gizmo after it expect the
  frame's. A pass keeps whatever was set last, so the sky drew with the far field's
  bind group and the whole command buffer failed validation.
- The blit drew before the sky, which has the same depth state and covers the same
  pixels, so the sky painted over it. It now draws after the sky and the preview, and
  before the grid.

### Phase 2: brick builder

- [x] Bricks sampled from the world SDF on the GPU, with no chunks and no readback
      (`src/far/far-build.wgsl`, [plan-sdf-generation.md](plan-sdf-generation.md)
      phase 4), field brushes folded in
- [x] Level-1 reduction from chunk containers in workers (uniform chunks reduce
      to uniform bricks without touching voxels), used for edited regions
- [x] Level k+1 from level k
- [x] Color per cell from the block registry's far-field color

**Verify:** met. `?farCheck` compares the sampled bricks against the same grid reduced
from resident chunk data, over the 26,624 bricks whose chunk was resident (6,144 were
not): of 4,057,620 solid cells, 97.35% are solid in both, **0 are solid only in the
sampled bricks**, and 2.65% only in the chunk reduction. That is the expected
direction and the reason to state the two rules apart:

- the GPU takes the sign of the field at the cell's centre, with `sample_footprint`
  set to the cell size, so worlds drop octaves finer than a cell;
- the CPU calls a cell solid when any voxel in it is, which no centre sample can see.

So the sampled bricks are a subset: they lose sub-cell features (a one-voxel spike in
a two-voxel cell), never invent them. Colors differ on 60,419 of the 3.95M shared
cells (1.5%), at material boundaries, where the centre's material and the first opaque
voxel's are not the same block.

Cost. GPU sampling: a whole 32^3 grid (32,768 bricks, 16.8M cells) is 21.5 ms of GPU
time, spread over 8 frames at the default 4 brick rows per frame, 2.69 ms p50 per
building frame (`gpu.far.build`, 1600x900, terrain). That is 5.2 us per chunk-sized
piece of the grid. CPU reduction (`deno task bench`, `src/far/reduce_bench.ts`): 124
us per chunk at level 1 (eight bricks, "hills"), 87 us at level 2, and 64 ns for a
uniform chunk, which reduces without reading a voxel. Sampling the field is about 24x
cheaper than reducing voxels and needs nothing resident, which is why it is the
default and the reduction is only for chunks an edit has changed.

Edits reach the far field: an edit marks its chunk, one worker job per chunk reduces
it, and each brick is uploaded on its own (the slot is the grid index, so nothing
moves). A whole-grid rebuild samples the field again and then re-reduces every edited
chunk in the new grid over the top, so an edit is not lost to a rebuild; measured with
a radius-14 sphere: 352 bricks patched over 44 chunks, 0 stale, and the sphere is
there in the marched image after F.

Two things phase 3 has to fix that this phase made visible:

- A rebuild costs 2.69 ms on each of 8 frames. That is a whole-grid rebuild, which
  phase 3 replaces with slab scrolling; only the slab that scrolls in is sampled.
- `stats.bricks` is the count from the last whole-grid build. Patches are counted
  separately (`patched`), because the CPU grid's occupancy no longer mirrors the GPU's
  after a sampled build.

### Phase 3: clipmap levels and scrolling

- [x] L levels with toroidal indirection, slab updates on camera cell crossings
- [x] Brick pool allocator with eviction when bricks leave all levels
- [x] Upload budget shared with the near-field arenas

**Verify:** met.

- Fast flight (`?bench=flyover` at 1080p with the far field on,
  `flyover.20260912T151053Z`): CPU frame 0.785 ms p50, 3.145 p99, against 0.900 /
  3.920 for the same scene without the far field (`flyover.20260912T135934Z`). Slab
  sampling is 0.459 ms p50 and 2.359 ms max (`gpu.far.build`), bounded by the two
  slabs a frame the budget allows. No spikes: the clipmap's work per frame is what
  scrolled in, and a level that has to catch up is rate limited rather than done at
  once.
- Teleport: a 36,000-voxel jump queues all 160 slabs (5 levels x 32) and the clipmap
  is whole again 1.11 s later. Nothing stale is shown in the meantime: a level that
  jumps a whole window is zeroed on the spot, and a slab that scrolls in has its cells
  zeroed when it is queued, so the ring that came into the window reads as empty until
  it is sampled.

Shape. Five levels, k = 1..5, each a 32^3 grid of bricks: 2-voxel cells at the
near/far boundary out to a 4096-voxel reach. `?farFirst=2` shifts the whole stack one
level coarser, which doubles the reach for slightly less GPU time (7.21 ms against
8.59 ms over open terrain at 1600x900) because a level costs about the same however
coarse it is and the finest one marches ground the near field already meshes; it also
makes the cells at the boundary 4 voxels, which reads as blocky next to the raster
pass. The finer default stays until phase 4 has looked at the seam.

The pool holds 37,533 bricks (21 MiB) over five levels of terrain, out of 49,152
slots. That is only possible because a brick that is solid throughout with one block
id is the indirection entry itself and costs no slot: without that shorthand the same
five levels wanted 77,000 bricks and the pool dropped 28,235 of them, because
underground every brick is solid stone and there are far more of those than there are
bricks holding a surface.

Three things this phase had to get right, each of which showed up as a bug first:

- **A brick's slot is the GPU's to choose.** Only the sample knows which bricks are
  occupied, so the CPU hands a dispatch a list of free slots, each occupied brick
  takes the next one with an atomic, and the entries come back in a small report
  (one 4 KiB copy per slab) that the CPU mirrors. The mirror is what lets a scrolled
  out brick give its slot back and an edited chunk find the brick to patch.
- **Testing a slab for conflicts cell by cell cost more than everything else.** The
  first version scanned a candidate slab's 1024 pending flags for every slab in the
  queue, which during a catch-up is 160 candidates a frame: CPU frame p50 went from
  0.90 ms to 1.53 ms and the flyover missed 219 frames. Two slabs of one level overlap
  only if they are not parallel planes, which is three comparisons, and the same
  bench then missed 7.
- **A report takes frames to map, so the ring is the throughput.** With 8 slots a
  full rebuild took 4.0 s; with 16 it takes 1.11 s, at the same two slabs a frame.

### Phase 4: composite with near field

- [x] Depth-covered early exit
- [x] The near field's geometry takes precedence, through a coarse per-chunk mask the
      main thread updates as chunks are meshed and evicted (`src/far/coverage.ts`)
- [x] Fog and lighting matched to the near-field shader
- [x] Translucent blocks are solid to the far field, so a sea does not end at the
      near field's edge

**Verify:** met, after the composite turned up two artifacts that the plan's "no seam"
line is exactly about.

- Gaps: with `?streamRadius=4` the near field covers 128 voxels and the far field
  fills everything beyond it, with no hole at the boundary and no wait.
- Poking through: nothing does, and the measurement from phase 2 says why. The sampled
  bricks are a strict subset of the voxels (0 cells solid in the field that are air in
  the chunk), so unedited terrain cannot be solid in the far field where the near field
  says air. What the mask is for is the rest: an edit, in the frames before its
  reduction lands, and any region where the two disagree.

How the mask is used is not what the plan assumed. Rather than compute a start distance
per ray, the march tests the chunk when it hits a cell, and stops the ray there if the
near field is drawing that chunk: the pixel is the raster pass's to answer. Stopping
rather than skipping matters. Skipping walks the ray on *inside* solid ground, and it
surfaces again at the edge of the meshed region, which draws a line of side faces along
that whole edge.

**The line at every level boundary was a shading bug, not a geometry one.** A hard dark
line ran along the clipmap's level transitions, clearest over water, where a flat
surface makes the quantization visible. Reading the pixels under it against the level
debug view put it exactly at the level 0 to level 1 boundary. The cause: levels
quantize a surface to their own cell size, so a ray can enter the next level already
inside solid ground, and the cell walk reported the hit with its initial axis, X. An X
face is lit by ambient alone, about a third of an up face, so every such pixel came out
dark. The walk now starts from the face the ray actually crossed to enter the brick,
and the line is gone (the luminance dip across the transition went from 53 to 0 at the
sampled column; what is left at 19 is the near field's own deep water).

Water. The far field has no blending, so a sea used to render as its own bed: the near
field showed water and the far field showed sand, meeting at the shore. Every block but
air is solid to the far field now (`BLOCK_FAR_SOLID`), and water carries a far color
that is roughly what the near field shows (water blended over a middling bottom) rather
than its own, so the two meet without a step.

Cost. The early exit hands the covered pixels to the raster pass before any marching:
measured back to back at one camera, the march is 15.7 ms with the near field hidden
and 11.1 ms with it drawn, so the near field takes about 30% of the frame's pixels off
it. Only back-to-back numbers are worth anything here: the same camera and build
measured 7.4 to 12.3 ms across page loads on this machine, so compare within a run, not
across one.

The march is still the problem whichever sample you take. `?bench=flyover` at 1080p
with the far field on gives `gpu.far` 9.7 ms p50 and a frame that misses 120 Hz
(interval p50 16.665); at the spawn it holds between 57 and 80 fps. That is what phase
5 is for, and why the far field is off unless `?far=` asks for it.

### Phase 5: beam pre-pass, resolution scaling, edits

- [x] Beam pre-pass with per-tile start distance
- [x] A scaled march target with an upsample that ignores unmarched texels. Half
      resolution was the default and is no longer: see "Half resolution eats the thin
      face" below
- [x] Edit events rebuild affected bricks at every level, budgeted and coalesced

**Verify:** met. Far-pass GPU time at a horizon view, 1920x1080, measured back to back
in one page load by switching at runtime (`?farScale`, `?farBeam`):

| Configuration      | march   | beam    | total   |
| ------------------ | ------- | ------- | ------- |
| full res, no beam  | 4.78 ms | -       | 4.78 ms |
| full res + beam    | 2.16 ms | 0.13 ms | 2.29 ms |
| half res, no beam  | 2.23 ms | -       | 2.23 ms |
| half res + beam    | 0.85 ms | 0.13 ms | 0.98 ms |

Over the flyover bench at 1080p (`flyover.20260912T162228Z` against
`flyover.20260912T154747Z`): `gpu.far` 9.699 ms p50 to **0.59 ms p50** (p99 1.311,
max 1.573), `gpu.far.beam` 0.066 p50, and the frame holds 120 Hz (interval p50 8.335,
p99 8.34, against p50 16.665 before). CPU frame 0.775 p50.

An edit reaches every level. A radius-20 sphere at the camera: 18 chunks reduced to 162
bricks at levels k = 1 and 2, and 26 coarse bricks rebuilt from the level under them.
Reading the clipmap back, the cell at the sphere's centre is air after a carve and solid
with the placed block's id after a fill, at every level from 2-voxel cells to 32-voxel
ones.

**The beam is conservative by margin, not by construction, and the margin was measured.**
One ray per 8x8 tile walks bricks only and reports where the full march can start. A
tile's other rays diverge from the centre one, so the start backs off from the first
non-empty brick. Backing off one brick left a visible error: 42 pixels of 3.57M differed
from the no-beam image, all of them one 4x11 sliver where a feature sat beside the
centre ray. Two bricks (32 voxels at the finest level, more at every other) brings that
to zero pixels differing by more than 8/255, and costs nothing measurable. The check is
worth repeating after any traversal change: render the same frame with `?farBeam=0` and
diff.

A scaled march needs the blit to do the upsample, and a plain bilinear filter is wrong
here: a texel whose whole footprint the near field covered was never marched, and
letting it into the blend bleeds holes along the near field's silhouette. The blit
weights by alpha, which drops those texels instead. The march's own depth test reads the
four corners of its footprint and only skips when all of them are covered.

**Half resolution eats the thin face.** It shipped as the default on the strength of the
table above, which measured GPU time and not what the frame looked like. Terrain is
terraced, and seen from anywhere but straight down a terrace's top face is foreshortened
to one or two screen pixels: at half resolution that is half a texel, so runs of it fall
between samples and the contour lines across distant terrain break up, double, and bleed
into the rows beside them. Full resolution draws the same lines cleanly. The march is
about three times the cost (1.0 ms against 3.1 at a horizon view with no near field in
front of it), which is why the default only moved once the adaptive controller existed
to pay for it by giving up levels that fog has already taken. `?farScale=0.5` is the
A/B, and the difference is in the contour lines, not in the fog.

**An axes word per brick skips the cell walk a grazing ray would waste.** Measured before
touching anything, at the terrain spawn looking at the horizon (`?far=steps`): rays that
hit something were 86% of all steps, at 73 brick steps and 86 cell steps each, and the
cell steps were mostly air rows inside surface bricks, walked one cell at a time by a ray
skimming just above the ground. Each brick now carries one word after its colours, bit
`x`, `8 + y` and `16 + z` for every solid cell (design-formats.md "Brick and clipmap"),
and a ray whose run of rows through the brick is empty on any axis skips the walk
(`brick_can_hit` in far.wgsl, `sh_brick_can_hit` in shadow.wgsl). Same camera, switched
at runtime: hit rays 159 to 146 steps, sky rays 43 to 9, the march 3.0 ms p50 against
4.3 to 6.0 over three alternating rounds, and 0 of 2,253,375 pixels differ. The march
also stops at the fog horizon (`far.eye.w`) rather than the last window's edge, worth a
few percent there. The TypeScript port in `march_test.ts` carries the same test and is
held to the finely sampled reference.

Coarse bricks are rebuilt from the level under them on the GPU (`reduce_bricks` in
far-build.wgsl), not from chunk data: a coarse brick spans more than a chunk, and the
chunks around an edit are on the GPU only. One dispatch per level, lowest first, so a
level is rebuilt before the one above reads it. The same pass would let a coarse level's
slabs be reduced from the finer level instead of sampled from the SDF, which is most of
the build cost; it is not wired up that way yet.

## Open questions

- **Reduction rule.** Settled for phase 2: "any solid" on the CPU, the centre's sign
  on the GPU, which is a subset of it (see the phase 2 result). Whether the sampled
  rule loses features that matter is a question for the phase 4 seam check, not for
  the numbers: a thin feature that vanishes reads as a hole, and the fix if it does is
  to sample the cell's corners rather than its centre.
- **Per-cell material storage.** Settled: per-cell `u8` block id at every level, plus
  one id for a brick that is solid throughout. A clipmap keeps the angular size of a
  cell roughly constant (a cell of level k is first seen at about 128 * 2^k voxels,
  so about 1/128 rad whatever k is), so a coarse level's cells are as visible as a
  fine level's and there is nothing to save by dropping their colors. The color itself
  is the registry's far color, averaged from the block's top texture.
- **Level parameters.** B = 32, L = 5 from k = 1, which reaches 4096 voxels. B sets
  the worst-case cell size on screen: a ray steps up a level at about 4B * 2^k voxels,
  where the next level's cells are 2^(k+1), so cells subtend about 1/(2B) rad wherever
  a level changes, 16 pixels at 1080p with B = 32. The 32k-voxel view-distance target
  needs L = 7 from k = 2, which the march cannot afford until phase 5.
- **Brick pool sizing.** 49,152 slots (27 MiB) holds five levels of terrain with
  12,000 to spare; `?farBricks` moves it. A pool that runs short drops bricks rather
  than failing: the build reports which ones, and the overlay counts them. What the
  right number is for a world with more caves than this one is unmeasured.
- **Temporal reprojection.** Would let the pass march fewer pixels per frame. Not
  needed: half resolution and the beam brought the march to 0.59 ms p50 at 1080p.
- **The boundary between two levels.** Open, and one thing ruled out. Each level's window is a camera-centred
  box, so the distance at which a ray gives up one level for the next was the same for
  every pixel, and that is a circle drawn on the world: a step in blockiness in terrain,
  and in the forest a ring where a footprint-gated feature stops existing
  ([gotchas.md](gotchas.md) "A footprint gate deletes a feature from the far field").
  Dithering it was tried and taken out: the two levels do not hold the same world, so
  inside the band the level a ray did not pick shows through the gaps in the one it did,
  and moving, the band sweeps and the far field boils
  ([gotchas.md](gotchas.md) "Dithering a level boundary shows both levels at once"). The
  hard boundary is coherent, which beats soft when the two sides disagree about what is
  there. Blending would work and means marching both levels near the boundary, which is
  the cost the level walk exists to avoid; whether it is worth paying near the boundary
  only is the open part.

- **Block light.** Settled, approximately. The near field bakes a light level per quad
  corner in the mesh job; the far field has no mesh, so it had no block light at all and a
  glowing mushroom past the near field lit nothing around it, which is a ring in
  brightness at the seam in a world whose lights are most of what lights anything.
  `gathered_light()` in `src/far/far.wgsl` asks the twenty-six cells touching the hit for
  their block's light level (carried in the far colour table's spare slot, see
  [design-formats.md](design-formats.md)) and falls off by the distance *in voxels*, so
  the same emitter reads as a bright neighbour at two-voxel cells and as nothing at all at
  thirty-two, which is the right answer at both ends. It runs at the hit, not per step, so
  it costs nothing on a ray that finds nothing. Three ways it is not the near field's
  answer: its reach is one cell rather than `LIGHT_MAX` voxels, it does not flood so light
  passes through a thin wall, and it has no ambient occlusion to sit under. It is close
  enough that the seam stops showing.

- **How far to reach.** Settled twice over. First as a constant: eight levels from
  k = 1, reaching 32,768 voxels, which is CLAUDE.md's far-field view distance. Measured
  against five levels at one camera (1920x1080, horizon view): the march goes 0.79 ms to
  1.44, the pool 37,537 bricks to 39,564 (21.7 MiB), the reach 4,096 voxels to 32,768.
  The coarse levels are nearly free in *memory*, because underground almost every brick
  is solid throughout and costs no pool slot, but not in march time: eight levels march
  in nearly twice what five do.

  Then as a ceiling the world's own fog sets, which is the part that needs no controller
  at all. `apply_fog()` mixes toward `sky_color(dir)`, and that is exactly what the sky
  pass puts behind a miss, so a hit whose extinction is 99.5% differs from drawing nothing
  by about one value in 8-bit. Everything the clipmap reaches past that is marched for a
  result nobody can see. `fogHorizonVoxels()` (`src/render/sky.ts`) is
  `ln(200) / FOG_DENSITY`: 15,134 voxels for `day`, 10,594 for `night`, 37,875 for the
  clear `desert`. `levelsForReach()` turns that into a level count, and the allocated
  count is the world's own trimmed to it, so terrain and forest allocate seven levels
  rather than eight. Measured back to back at a horizon camera: 5.37 ms p50 at eight
  levels, 5.11 at seven, and 256 slabs a rebuild down to 224. `?farLevels=n` still
  overrides it outright, because a measurement wants the setting it asked for.

  Then as a controller, which is what neither of those can be: eight levels is right
  for this GPU and a guess anywhere else. `src/far/adapt.ts` watches what the march and
  the brick sampling cost, once a second, and moves two things to fit the budget. The
  order matters and is the whole design:

  1. **`slabsPerFrame`**, how much of the clipmap is sampled per frame. It changes
     nothing about what the far field looks like once it has caught up, only how long
     catching up takes, and it costs nothing at all while the queue is empty. Always the
     first spent and the first taken back.
  2. **`levels`**, the reach. Fog has already taken most of what the outer levels buy:
     at the default density a surface 6,600 voxels out is nine parts fog to one part
     world, and the outer levels reach far past that.
  3. **`scale`**, the fraction of the frame the march runs at. Last to go, because it is
     the one a viewer sees everywhere rather than only at the horizon (see "Half
     resolution eats the thin face" above), and first to come back.

  Two things it has to know that are not obvious. A pass is only sampled on the frames
  it is encoded, so a clipmap that has caught up leaves the build's ring holding its last
  expensive frame forever; the controller counts the frames the build actually ran and
  scales by that duty cycle, or it gives up the whole reach to pay for work that stopped
  (it did exactly that, in the first version, walking 8 levels down to 3 with a 0.2 ms
  march). And a level that has just been switched on rebuilds itself, so the burst that
  follows would read as "still too expensive" and drop it straight back; the controller
  sits out three windows after any level change.

  Behaviour on the dev machine, forest world: it holds 8 levels and 4 slabs standing
  still; under a teleport every 3 s it walks down to 5 levels and 1 slab; it is back at
  8 and 4 about four seconds after the jumping stops. In terrain from a high camera,
  where the far field fills much more of the frame, it settles at 5 levels and full
  resolution against a 4.0 ms budget, which is the tradeoff the order above is there to
  make: keep the sharpness, spend the reach that fog is covering anyway. `?farAdapt=0` pins it, and a bench
  run pins it automatically, because a reach that moves under the measurement makes two
  results incomparable.

  **The budget is the frame's leftover, not a constant.** `farBudgetMs()` is the display's
  period, less what every other timed pass costs, less slack for presenting and the main
  thread; floored so a machine whose near field has eaten the frame still has some far
  field, and capped at half the frame so a cheap frame does not hand the whole thing to
  the distance. On this machine at 120 Hz that lands between 2.3 and 4.1 ms depending on
  what the near field is doing, which is about where the old 2.8 ms constant was; a
  60 Hz display has twice the frame and the same near field, so it gets more reach for
  free, which is the point.

  Two traps in deriving it. The period is *not* the mean or median interval: a run that
  misses every other vsync has a median of two periods, and reading that as "the frames
  are long, there is room for more" is exactly backwards. Dropped frames land on
  multiples of the period, so the short end of the distribution is the period itself, and
  a low percentile finds it without picking up a jittery outlier. And the far field's own
  passes are excluded from "what every other pass costs": subtracting them would make the
  reference move with the thing being controlled, so shrinking the far field would grow
  the leftover and grow it straight back.
- **Stopping at the near field's coverage was wrong at silhouettes.** The march used to
  stop dead at the first cell inside a chunk the near field draws. Coverage is per
  32-voxel chunk, so along a silhouette a ray grazes a covered chunk the raster pass never
  filled, and stopping there left the sky showing through in a staircase down the edge.
  It now marches past such cells: the pass's depth test has already found the pixel empty,
  so the near field has nothing on this ray. The old reasoning, that marching past would
  surface the ray again at the edge of the meshed region as a line of side faces, did not
  happen: 1,200 pixels changed in the whole frame, all at silhouettes, and the terrain
  world's near/far boundary is unchanged ([gotchas.md](gotchas.md) "The near field's
  coverage is a chunk, not a pixel").
- **Coarse levels from finer ones, rather than sampled.** Rejected. Sampling every level
  from the SDF does cost eight times the field evaluations, and `reduce_bricks` can
  build a brick from the eight under it, but not the bricks that need building: a slab
  scrolls in at the *edge* of its level's window, and the level below covers only the
  inner half of it, so the children are not there. It would only help the inner half of
  a whole-grid rebuild.
