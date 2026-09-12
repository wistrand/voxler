# Plan: living world (emissive materials, motion, a forest)

> Status: in progress (phases 1-3 done and tested; phase 4, light from glowing blocks,
> is the remaining one). Depends on the renderer being done: the near field
> ([plan-rendering.md](plan-rendering.md)), the far field
> ([plan-far-field.md](plan-far-field.md)), and the world contract in
> [plan-sdf-generation.md](plan-sdf-generation.md). Block table and camera uniform
> layouts are owned by [design-formats.md](design-formats.md).

## Goal

A fantasy forest that is worth standing in: glowing plants that light what is around
them, foliage that moves, and a world program that grows it. Every plan before this one
was about how fast the engine draws; this one is about what it draws.

The renderer has never needed either feature. Light is one directional sun plus sky
ambient (`src/render/shading.wgsl`), and nothing in the frame changes unless the camera
or the voxels do. Both are engine features, and the forest is what proves them.

## Approach

- **Emission belongs to the block, not the world program.** The block registry already
  owns colour, opacity, textures and the far-field colour; emission is one more column,
  and all three surface paths (near field, SDF preview, far-field march) read it from
  the same table. A glowing block is drawn at its emission colour whatever the sun is
  doing.
- **Motion is a vertex-stage displacement, not new geometry.** A swaying block keeps its
  voxels; the near field's vertex stage offsets its quads by a wind function of world
  position and time. The function has to be world-space and pure, or two chunks will
  disagree along their shared edge and open a crack. The far field ignores it: at that
  distance the displacement is well under a pixel.
- **Light from glowing blocks is a voxel flood fill, baked like AO.** The mesher already
  gathers a 26-neighbour shell for ambient occlusion and bakes a level per quad corner.
  Block light is the same shape of problem with a longer reach, which is what makes it
  the expensive phase rather than the first one.
- **The forest is a world program.** Trees, mushrooms and ferns are SDF composition over
  a deterministic lattice, the same way terrain is noise: no per-instance data, no
  placement pass, and edits and the far field keep working because nothing changes about
  how a world is sampled.

## Testing methodology

- `deno test` for the registry tables (a block's emission and sway survive the round
  trip into the packed table) and for any pure placement maths the world program mirrors
  on the CPU.
- Screenshots at a fixed camera, compared before and after: this is a look feature, and
  the pixel-diff tooling from [plan-far-field.md](plan-far-field.md) phase 5 already
  distinguishes "changed nothing" from "changed everything".
- Bench: `?bench=flyover` and `?bench=cave` for the frame cost of emission and sway, and
  a forest-specific scene once the world exists. Cracks from the sway function are a
  visual check at a chunk boundary, then a screenshot diff between two camera positions
  that put the boundary in different places.
- The far field and the preview have to agree with the near field on emission, or the
  transition shows it. `?far=0` and P are the A/B.

## Phases

### Phase 1: emissive materials

- [x] `BlockType` gains an emission colour; the packed block table carries two `vec4f`
      per block (colour and coverage, then emission and sway)
- [x] Near field, SDF preview and far-field march all add emission the same way
- [x] A glowing block type to test with (`glowcap`), and `?glow=0` for the A/B

**Verify:** met. A sphere of `glowcap` beside a sphere of stone: the glowing one is as
bright on the side facing away from the sun as on the side facing it, which is the
signature of emission rather than a pale paint, and its baked AO still reads in the
crevices. The same block placed as a field brush glows in the SDF preview, the same way.
Cost: the near-field opaque draw is 0.79 ms p50 at 1920x1080 with emission and 0.79
without, so it is under what the timer can resolve; it is one buffer read and a
multiply-add per fragment.

**Emission has to fit under 1.** There is no tonemapping. The first `glowcap` emitted
1.1 to 1.8 and every pixel of it clipped to white: a glowing block that has lost its
colour reads as a hole in the scene, not a light. At 0.15 to 0.7 it keeps its hue and
still reads as lit from within. A unit test now checks that every emissive block plus
ambient light stays under 1, which is the real constraint until something tonemaps.

**A bug this turned up.** The preview painted every hill in the terrain world blue. It
asked `world_material` at the traced hit point, which is a hair outside the surface,
where terrain's sea rule says "solid above the ground is water". It now asks half a
voxel along the negative normal, on the solid side. The far field and the voxelizer
never had it: both sample at voxel centres. It arrived with the sea in plan-rendering
phase 5 and nobody had looked at the preview since.

### Phase 2: motion

- [x] Time in the camera uniform, and a sway amplitude per block in the table
- [x] Wind displacement in the near field's vertex stage, a pure function of world
      position and time
- [x] The SDF preview does not sway, and says why: it traces the field, and the field
      does not move. The displacement happens when the near field draws its quads, so
      the preview, the voxelizer and the far field all see the same still world

**Verify:** met.

- A wall of leaves straddling the chunk boundary at x = 32, seen face on: zero
  background-coloured pixels inside it at two frozen times, so nothing tore. The wind is
  a function of the world voxel and the clock, with no camera term, so two chunks cannot
  disagree about a shared face; the wall is what shows it.
- It moves: 26% of the frame's pixels differ between t = 0 s and t = 2 s.
- The phase wraps every 256 voxels, and every wavelength is a whole number of cycles
  over that, so the wrap is seamless. Checked on a wall across x = 256: zero background
  pixels, and the mean luminance of the thirteen columns at the wrap is flat (58.6 to
  59.4).
- Cost: flyover `gpu.near.a` 0.59-0.66 ms p50 with wind and 0.66 without, CPU frame 0.68
  against 0.82 (`flyover.20260912T165456Z` against `flyover.20260912T165524Z`): under the
  noise either way. The terrain world has no swaying blocks, so this measures the added
  per-vertex table read and branch, not the two sines a swaying block pays. A canopy's
  worth of those is the forest's measurement to make.

**The wavelength is set by the mesher, not by taste.** The first version used 13- and
5-voxel wavelengths and sprayed hairlines over the canopy: greedy meshing leaves
T-junctions everywhere, and a displacement that varies within a quad pulls its straight
edge off the short quads' shared vertices. Counting bright slivers in one grove: 68 with
the wind off, 312 with the short wavelengths, 72 at 85 and 128 voxels, which is the same
scene's noise. The deviation grows with the square of the wave number, so the wavelength
has to be several quads long. It also reads better: a gust moves a whole tree rather than
each leaf on its own. Motion at those wavelengths still changes 21% of the canopy's
pixels between t = 0 s and t = 2 s.

Detail worth keeping: the displacement is computed from integer world coordinates
reduced modulo 256, not from a float world position. The invariant against absolute f32
world coordinates is what forces it, and it also makes the wave exact however far out
the camera is.

### Phase 3: the forest world

- [x] Block types for the forest: bark, four glowing caps, mushroom stem, fern, moss
- [x] `src/worlds/forest.wgsl`: terraced ground, a stream that cascades down it, trees
      with trunks, branches and ragged canopies, mushrooms small and giant, ferns and
      boulders, all SDF composition under one `WORLD_LIPSCHITZ`
- [x] A spawn in the wood, and the `grove` bench scene that walks under the canopy

**Verify:** met. The preview shows no holes, so `WORLD_LIPSCHITZ = 4` holds; the `grove`
bench at 1080p holds 120 Hz (interval p50 and p99 both 8.34) with `stream.holes` 0 and
CPU frame 0.40 p50.

Everything is a pure function of position, so there is no placement pass and no
per-instance data: the voxelizer, the preview and the far field see the same wood, and
an edit to it survives regeneration like any other chunk. Trees, mushrooms, ferns and
boulders each sit on their own lattice, jittered within the cell and looked up over the
3x3 neighbourhood so one can overhang into the next; each starts with a bounding
cylinder, which is a safe underestimate when the sample is far from it and saves
evaluating branches and canopy for the eight cells that are not the near one.

**Scale is resolution.** The first cut was built at human scale: trees 9 to 22 voxels
tall, caps one or two voxels across. It read as chunky lumps, because a tree that is a
dozen voxels tall has no room for bark, branches or a ragged edge. Everything is now
written against one constant, `S = 2.75`, so the whole wood can be made finer or coarser
in one place; at 2.75 a tree is 25 to 60 voxels and its trunk, branches and canopy are
all distinguishable. What it costs is voxels: dense chunks went from 1,721 to 2,900 over
the same region, and voxelizer latency from 6.6 ms to about 10.

**Two things merged into sheets and had to be pulled apart.** Canopies at a 19-voxel
lattice with a 72% hit rate closed over the whole wood: one green lid with no trees
under it. At 27 voxels and 55% (74 after the scale change) there are gaps to stand in.
Giant mushrooms, as a rare variant of the small ones on their shared lattice, did the
same thing in pink: neighbouring caps overlapped into a plateau with stems poking
through it. They now stand on their own 146-voxel lattice, far enough apart that two
caps never meet.

**The far field is what a rich world costs.** Sampling this SDF is an order dearer than
sampling terrain's noise, and the far field does it eight times over, once per clipmap
level: `gpu.far.build` was 5.57 ms p50 in the grove with the vegetation surviving to a
16-voxel footprint. Cutting the undergrowth to the finest level and the trees to an
8-voxel footprint brings it to 4.33 (interval max 83 ms to 42). The rest is inherent;
`?farSlabs=1` halves the per-frame build for a slower catch-up.

### Phase 4: light from glowing blocks

- [ ] Block light flood fill in the mesh job, baked per quad corner beside AO
- [ ] Light reaches across chunk boundaries without seams (the shell has to carry it)
- [ ] The far field approximates it, or glowing regions dim at the boundary

**Verify:** a glowing mushroom lights the ground around it, and the pool of light is
continuous across a chunk boundary; mesh job time stays under the 0.5 ms target.

## Open questions

- **How far light travels.** A 12-voxel reach needs a padded region bigger than the AO
  shell, which changes what a mesh job reads. Whether that is a wider shell, a separate
  light pass over a region of chunks, or a coarse light volume the shader samples, is
  the phase 4 decision and it is worth prototyping before committing.
- **Fog over emission.** Physically fog scatters glow like anything else, and fogging
  emission keeps the far field consistent; artistically a glowing thing that fades into
  the mist at 200 voxels may look wrong. Decide on a screenshot.
- **How much the sway is.** Leaves are at 0.2 voxels, which reads on a canopy without
  the leaves leaving the branch. Whether ferns and grass want more, and whether a plant
  should bend more at its top than its base (which needs the plant's base, and a voxel
  does not know where its plant starts), is the forest's call.
- **Whether the far field needs emission at all.** A glowing mushroom is sub-cell past
  the near field; what matters is whether a *forest* of them tints the distance.
