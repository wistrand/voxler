# Plan: living world (emissive materials, motion, a forest)

> Status: done (phases 1-5 landed and tested). Depends on the renderer being done: the near field
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
- [x] The SDF preview doe not sway, and says why: it traces the field, and the field
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
- [x] `src/worlds/forest.wgsl`: terraced ground over hills and ridged mountains, lakes
      in the valleys, a stream that cascades down it, three species of tree, mushrooms
      small and giant, ferns and boulders, all SDF composition under one
      `WORLD_LIPSCHITZ` (5.0, raised from 4 when the mountains arrived)
- [x] A spawn in the wood, and the `grove` bench scene that walks under the canopy
- [x] Nothing rooted grows below the waterline: trees and giants need 1.5 * S of dry
      ground under them and undergrowth 0.5 * S, which leaves a band of bare shore
      between the wood and the water. Boulders are exempt; a rock in a stream belongs
      there

**Verify:** met. The preview shows no holes, so `WORLD_LIPSCHITZ` holds; the `grove`
bench at 1080p held 120 Hz (interval p50 and p99 both 8.34) with `stream.holes` 0 and
CPU frame 0.40 p50. That run was underground; see below.

**The grove bench was measuring solid rock.** Scene paths are offsets from the world's
spawn, and the forest spawn stayed at y = 70 after the ground grew mountains and lakes
under it. The floor near the origin is 94, so the walk ran 44 voxels inside the hill and
every number it produced was for a frame with nothing in it. The spawn now stands at 120,
over a canopy that tops out near 112, and the scene's -20 drops under it. The walk is
slower (8 voxels a second, not 14) so it stays in one stretch of wood; the ground along it
runs from 95 down to 71, which a fixed height cannot hug.

On the real path the grove does not hold 120 Hz: `gpu.far.build` is 6.6 ms p50 and 24 p99,
and 102 frames of about 1400 are missed (`grove.20260912T180812Z`). `?farSlabs=1` halves
the p99 (10.5) for a slower catch-up. This is the first honest measurement of the scene
rather than a regression against the underground one.

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

**Three species, and a bound that has to cover the crown.** One canopy shape reads as a
repeat however well the lattice is hidden, so a cell picks broadleaf, conifer or ancient,
biased by height: conifers take over as the ground climbs to the tree line. The crowns had
flat faces cut down their sides, which was the bounding cylinder: at 7.5 * S it was
smaller than the canopy it was supposed to enclose, so the cheap early-out was clipping
the tree instead of skipping it. `tree_crown()` now names each species' reach and rise and
the bound is built from those, which also caps how far a tree may be jittered: jitter plus
crown has to stay inside one cell or the 3x3 neighbourhood would miss it.

**A crown built from one blob stays a blob.** Lobes sunk into a large ellipsoid read as a
smooth dome however many are added. The core is now small and six lobes hang off it, and
then `canopy_bites()` subtracts spheres out near the rim: `max` of two fields is still a
distance field, and the bites are what give the canopy gaps and a ragged edge.

**Reusing the gate's random for the jitter puts everything back on the grid.** A cell has
a plant when `r.x` is under the density, and the jitter was `(r.x - 0.5) * cell`: every
accepted plant landed on the same side of its cell, so the lattice showed through however
wide the jitter was. `cell_jitter()` draws from its own salt. The second half is
`patch_density()`: a fixed hit rate per cell spreads plants evenly over the floor, which
is a pattern as much as a grid is, so mushrooms, ferns and boulders now clump the way the
trees already did.

**The far field is what a rich world costs.** Sampling this SDF is an order dearer than
sampling terrain's noise, and the far field does it eight times over, once per clipmap
level: `gpu.far.build` was 5.57 ms p50 in the grove with the vegetation surviving to a
16-voxel footprint. Cutting the undergrowth to the finest level and the trees to an
8-voxel footprint brings it to 4.33 (interval max 83 ms to 42). The rest is inherent;
`?farSlabs=1` halves the per-frame build for a slower catch-up.

### Phase 4: light from glowing blocks

- [x] Block light flood fill in the mesh job, baked per quad corner beside AO
- [x] Light reaches across chunk boundaries without seams (the 26 neighbours carry it)
- [ ] The far field approximates it: not done. Past the near field a glowing mushroom is
      sub-cell, and the light it casts is a fraction of a cell, so the far field draws the
      block's own emission and nothing else. A forest of them does not tint the distance.

**Verify:** met for the near field. `src/mesh/light_test.ts` checks the fall-off (one
level a voxel, in every direction, out to the block's `light` value), that the light
crosses out of its own chunk, that an opaque block stops it while its own lit face still
reads the cell in front of it, and that the mesher puts the level on the quads around a
glowing block and zero on the far corner of the same floor. In the forest, `?light=0`
against the default changes 57% of the frame's pixels, and where it changes them it adds
[5.8, 14.1, 6.2] of colour: a green-tinted pool, not a wash.

**Where the twelve bits came from.** The packed quad had four spare bits in word0 and
eight in word1 and no twelve together, so the level is split: the quad's lowest corner
level (0-15) in word0, each corner's step above it (0-3) in word1. Two bits a corner on
their own would have banded; sixteen levels with a three-level spread per quad
interpolates as smoothly as the AO does. Corners average the four cells that meet at
them, which is what turns a staircase of levels into a ramp.

**The cost is the seed scan, not the fill.** The fill only touches cells light reaches,
which is nothing in most of a world; finding the lights means reading every voxel of
every chunk that has one. Two things keep it off the bill: `hasLight()` answers from the
chunk's palette, so a chunk that never saw a glowing block costs a handful of comparisons,
and the scan itself compares packed palette indices instead of going through the palette
per voxel. In the forest, where most chunks do have a mushroom near them, mesh latency
went from 1.56 to 1.84 ms and the quad count from 3.49M to 3.94M (+13%, the merge key).

**A light does not light itself.** The first cut added the pool on top of the block's own
emission and every cap went white. A light's own faces now bake to zero: the emission is
already how it is drawn.

**One colour for every light.** The baked level is a number, not a colour, so
`BLOCK_LIGHT_COLOR` in `src/render/shading.wgsl` is shared by every light in the world. A
forest of glowing fungus is what it is tuned for. Three channels would need three fills
and three times the bits, and is the thing to do if a world ever wants a red lamp beside a
blue one.

### Phase 5: night, and shadows

- [x] Sky and lighting are a per-world preset (`src/render/sky.ts`), generated into WGSL
      and prepended to every shader that lights or fogs a surface; `?sky=` overrides it
- [x] A night preset for the forest: a low moon with a drawn disc and halo, stars, and
      enough of the sky's light taken away that a glowing mushroom is the brightest thing
      in the frame
- [x] Mushrooms that read as mushrooms: a stem two to three times the cap's radius, a
      dome cut under its equator, and a lip that overhangs the stem
- [x] Shadows from the light, marched against the far field's clipmap
      (`src/far/shadow.wgsl`) in the near field's fragment stage

**Verify:** met. In daylight a giant mushroom's cap throws a shadow across the ground
beside it; at night the moon picks out trunks and the glowing caps light what is around
them. The four cap colours each carry their own emission, and `?shadow=0`, `?light=0`,
`?glow=0` and `?sky=day` are the A/Bs.

**The preset is the lighting model, not a second one.** `surface_light()` and
`apply_fog()` are unchanged in shape; what a world picks is the numbers they read.
Everything that lights a surface (the near field, the SDF preview, the far-field march
and the sky pass) gets the same generated constants, so the preview and the far field
cannot drift into a different time of day from the near field.

**A mushroom is proportions, not detail.** The first caps were flat discs on stubs, and
no amount of voxels fixed that: the cap radius was *larger* than the stem height. What
reads as a mushroom is a stem two to three times the cap's radius, a dome cut off under
its equator so it is a cap and not a ball on a stick, and a thin lip a little wider than
the dome. Small ones come up in clumps of one to three around a spot, sharing the cell's
species colour; the first clumps of three everywhere carpeted the floor, so the lattice
went from 30 voxels to 44 and the hit rate from 67% to 22%.

**Shadows reuse the clipmap rather than a shadow map.** The far field already keeps a
brickmap of the world around the camera with empty-space skipping, so a shadow ray is a
DDA over data that is already there: no light-space camera, no cascade, no second draw of
the scene, and nothing added to the mesh job or the packed quad. The one thing the shadow
marcher must not share with the far field's own march is the coverage mask: the far field
marches *past* a cell the near field is drawing, and a shadow ray has to be stopped by it,
or every tree would stop casting a shadow the moment it was meshed.

**Cost: about 1.2 ms of the near-field draw at 1080p.** Back to back over the flyover,
`gpu.near.a` is 0.72 ms p50 with `?shadow=0` and 1.90 without it
(`flyover.20260912T184002Z` against `flyover.20260912T183537Z`); the grove is 0.72
against 2.03. Skipping the ray on faces turned away from the light took the grove from
2.36 to 2.03: under a canopy most surfaces face up, so it saves less than the half it
looks like. The shadow is near-field only: the far field and the preview light their
surfaces unshadowed, which past 512 voxels the fog covers.

## Open questions

Settled, kept here because the reasoning is the answer: **how far light travels** is 15
voxels, flood filled in the mesh job over a padded grid the 26 neighbour chunks already
supply, with the seed scan skipped for any chunk whose palette holds no light. A coarse
light volume the shader samples was the alternative and was not needed.

Still open:

- **Shadows in the far field.** The march has the clipmap in its own bind group already,
  so a shadow ray there is a few lines; whether the cost is worth it past 512 voxels of
  fog is the open part.
- **Fog over emission.** Physically fog scatters glow like anything else, and fogging
  emission keeps the far field consistent; artistically a glowing thing that fades into
  the mist at 200 voxels may look wrong. Decide on a screenshot.
- **How much the sway is.** Leaves are at 0.2 voxels, which reads on a canopy without
  the leaves leaving the branch. Whether ferns and grass want more, and whether a plant
  should bend more at its top than its base (which needs the plant's base, and a voxel
  does not know where its plant starts), is the forest's call.
- **Whether the far field needs emission at all.** A glowing mushroom is sub-cell past
  the near field; what matters is whether a *forest* of them tints the distance.
- **One colour for every block light.** The baked level is a number, so a red lamp and a
  blue one light their surroundings the same. Three channels would need three fills and
  three times the quad bits; the forest does not need it and another world might.
- **Whether the grove bench should follow the ground.** Scene poses are fixed offsets
  from the spawn, and the forest's ground now runs from 95 down to 71 along the grove's
  path, so no single height hugs it. A terrain-following pose would need the world SDF on
  the CPU, which nothing else wants.
