# Plan: Monument Valley

> Status: in progress. The world is in (`src/worlds/monument.wgsl`, `?world=monument`),
> its blocks, relief, bedding and sky preset are in, and what is open is the contour lines
> relief leaves on broad faces (see "Relief costs contour lines"). Depends on nothing new:
> it is a world program under the contract in
> [design-formats.md](design-formats.md) "World program".

## Goal

The buttes of Monument Valley, on the Arizona/Utah border, as a world program. It is here
for two reasons beyond looking like the place. It is the first world whose subject is
*distance*: the monuments stand a kilometre apart and a few hundred voxels tall, so most
of what is on screen is always far field, which makes it the world to judge the far field
and its adaptive reach on. And its field is cheap (`WORLD_LIPSCHITZ` 4.0 against the
forest's 5), so it separates "the far field is slow" from "this world is expensive".

## The source model

The silhouette is not invented. It is the stratigraphy, and getting the layer order and
their erosional behaviour right is most of why it reads as the place:

| Layer                  | Erodes to | In the world                                  |
|------------------------|-----------|-----------------------------------------------|
| Shinarump conglomerate | hard cap  | `caprock`, a thin dark slab standing proud     |
| Moenkopi formation     | thin, red | `organrock` again, just under the cap          |
| de Chelly sandstone    | **cliff** | `sandstone`, vertical, most of the height      |
| Organ Rock shale       | **slope** | `organrock`, the skirt flaring out at the foot |
| Cutler red siltstone   | the floor | `redsand` over `organrock`                     |

Cliff over slope is the whole thing: a vertical wall that stops dead and turns into a
talus cone. Get that wrong and it reads as a rock, not as Monument Valley. The de Chelly
is wind-blown and cross-bedded, which is why its texture is banded; the red is iron oxide
and the dark cap is manganese oxide.

Scale: the largest buttes stand about 1,000 ft (300 m) over the valley floor, so the
world is written at one voxel to the metre and a butte is 110 to 300 voxels tall.

Three shapes, not one shape at three sizes: a **mesa** is broad and low, a **butte** is
taller than it is wide, and a **spire** is a splinter (the Totem Pole is over a hundred
metres of sandstone a few metres across). A Mitten is a butte with a **thumb**: a
separate, slender stack standing clear of the main mass, which only reads if the two do
not merge.

Sources:

- [Rocks of Famous Monuments, Guillermo Rocha](https://academic.brooklyn.cuny.edu/geology/grocha/monument/monument.html):
  the layer order, the floor's Cutler siltstone, iron oxide for the red and manganese
  oxide for the blue-grey, and the 1,000 ft figure.
- [Organ Rock Formation](https://en.wikipedia.org/wiki/Organ_Rock_Formation): dark
  red-brown siltstone, forms slopes not cliffs, "angled skirts of Organ Rock, at base of
  De Chelly Sandstone vertical massive cliffs".
- [West and East Mitten Buttes](https://en.wikipedia.org/wiki/West_and_East_Mitten_Buttes):
  the main mass and the thumb, and the three principal layers.
- [Exploring the Unique Geology of Monument Valley](https://www.goldensoftware.com/monument-valley-geology/):
  differential erosion, the de Chelly as the resistant cliff former.
- [Shinarump Conglomerate](https://en.wikipedia.org/wiki/Shinarump_Conglomerate): the
  thin hard caprock.

## What is in

- [x] `src/worlds/monument.wgsl`: desert floor with dunes, monuments on a jittered
      lattice that clusters, the five-layer profile, thumbs, and vertical desert varnish
- [x] Blocks: `redsand`, `organrock`, `sandstone`, `caprock`, `sage`, with cross-bedded
      textures for the two that make walls
- [x] A `desert` sky preset: clear air (a fifth of `day`'s fog, so the far field carries
      to the horizon) and a harder, warmer light
- [x] Vertical relief, so a monument is not an extrusion: `relief()` samples in three
      dimensions, so the profile changes with height and the rock has brows, undercuts
      and overhangs. The layer boundaries and the summit wander with it, and some buttes
      carry pinnacles standing past their own summit
- [x] Tiered summits. A top carries on upward as one or two smaller stacks, each standing
      on the one under it and each running the same layer profile, so a tier brings its
      own cap and its own banding rather than being a lump glued on. `CREST_RELIEF` breaks
      the summit itself at a few tens of voxels
- [x] Whether a monument still carries its cap is not a coin flip any more, it is how far
      down the section that one has been eroded (see "One layer cake" below). The cap is
      what keeps a butte standing, so an uncapped one is the one being eaten away, and its
      summit is bare Moenkopi or bare de Chelly that neither stands proud nor reads dark
- [x] One layer cake at shared elevations, accordant summits, and a floor flat enough not
      to draw contour lines across itself
- [x] Fewer monuments, sampled finer: half the hit rate over a wider lattice, and a
      clipmap of six wide levels instead of eight narrow ones

## A wall at an angle the grid does not like

**Open.** Reported as dark hairlines down an otherwise flat cliff, and as "a mesh
creation bug when many voxels line up orderly", which is the right instinct about the
cause even though the mesher turned out not to be at fault.

What the investigation ruled out, each with a measurement rather than an argument:

- **Not culling.** `?cullCheck` ran 119 comparisons of the drawn frame against an
  unculled draw: 0 failures, 0 max difference, 0 missing.
- **Not baked AO.** The lines survive `?ao=0`, which flattens the wall's shading
  entirely.
- **Not the march resolution.** Half against full resolution differs in 0.3% of pixels
  here.
- **Not greedy meshing's T-junctions.** Growing every quad by 0.004 voxels along its own
  plane, the mitigation [gotchas.md](gotchas.md) names, changed the count by 2 pixels in
  1,400.

What it *is*, at least in part, measured from the voxel data rather than the picture: a
butte wall at an arbitrary angle staircases. Reading the chunk store across 40 voxels of
one wall found the surface stepping by exactly one voxel **19 times**, and each of those
steps has a side face which, seen near head-on, rasterizes as a one-pixel dark line; the
mesher then merges consecutive side faces into long quads, which is why they read as
ruled lines rather than as per-voxel stipple. Putting the plan's faces on exact multiples
of 45 degrees took the same wall from 19 steps to **1**, and moving the vertical fluting
from geometry to colour (desert varnish, which is what actually streaks these walls) took
it to essentially flat.

Hairlines remain after all of that, fewer and shorter, and they are a property of stepped
voxel rock rather than a defect.

**The report that started this was a different bug, and it is fixed.** "The sky color
seems to appear on the borders of the pillars" was exactly right and I spent a long time
measuring the wrong feature. It was the near/far composite stopping the march at a
per-chunk coverage mask; see [gotchas.md](gotchas.md) "The near field's coverage is a
chunk, not a pixel". 560 sky pixels on one ramp to 0.

## Relief costs contour lines, and the exchange rate is its gradient

Vertical relief is what makes a butte rock rather than a prism, and it is also the thing
that draws contour lines across a flat face, for the reason in
[gotchas.md](gotchas.md) "A wall at an angle the grid does not like": a shallow slope in a
voxel world is a staircase of one-voxel steps, and their side faces are lines.

The lever is the relief's *gradient*, not its amplitude. Smooth relief (9 voxels over a
64-voxel wavelength, three octaves) put a step every seven voxels and drew dense contours
over every wall. Steeper relief (16 voxels over 32, two octaves) steps several voxels at a
time, which reads as ledges and broken rock; the towers seen at a grazing angle look
right, and what is left of the contours is on the broad faces seen head-on, where the
relief still has room to be shallow.

A horizontal surface is the worst case for this, because a gently sloped top *is* a
contour map; `CREST_RELIEF` is the dial there and it is set steep for the same reason.

`RELIEF_WALL` and the noise lattice in `relief()` are the two numbers to turn, and
`WORLD_LIPSCHITZ` has to go up with them or region skipping deletes rock. What would
remove the rest rather than trade it is relief quantised to the voxel grid, which a
Lipschitz field cannot express directly; the shape of that is an open question.

## One layer cake, and the summits are accordant

**Landed.** Reported as "the sediment layers in monuments must all be on the same height",
which is exactly right and is the single change that most made the valley read as one
place rather than as a field of separate rocks.

The beds are regional and flat-lying. The de Chelly is a fossil dune field, the Organ Rock
under it a floodplain, the Moenkopi above it tidal redbeds and the Shinarump a sheet of
braided-river gravel, and each was laid down across the whole area before the next. What
is here now is what is left after the rest was carried off, so every monument in a view is
a remnant of the same cake and a contact stands at the same elevation on all of them. The
world had the layer tops as a fraction of each butte's own height, which put the scree
line and the cap at a different height on every one.

They are absolute elevations now (`ORGAN_TOP` and the rest in `src/worlds/monument.wgsl`),
from the measured section in the park at one voxel to the metre: Organ Rock 300 ft of
exposed slope, de Chelly 400 ft of cliff, a thin Moenkopi remnant, Shinarump 50 ft of cap,
Chinle above that on the few highest remnants. `butte_body()` takes an absolute elevation
and a summit rather than a height and a total, which means every body in the world runs
the same beds: a tier, a thumb and a pinnacle all band at the same heights as the mass
they stand on, because there is only one cake and they are all cut from it.

What varies between monuments is *how far down* the cake each has been eroded, and that is
not uniform either. Erosion strips a soft bed and stalls on the hard one under it, so
summits gather at the resistant contacts: the whole section, or the top of the Moenkopi
with the cap gone, or the bench at the top of the cliff, or somewhere in the wall for one
being eaten into. That is why real monuments in one view top out level with each other,
and a few metres of wander is all that separates them. Width decides which is likely: a
wide remnant shelters its own cap and keeps everything, a splinter lost it long ago.

The contacts still wander by a few metres, because a dead level line round a butte is the
one thing that never happens in rock. The wander is sampled from the world point rather
than from anything a butte owns, so neighbours wander together instead of each having a
private idea of where the beds are.

Sources for the section, beyond the ones above: the park's measured thicknesses in
[Permianland: The rocks of Monument Valley](https://nmgs.nmt.edu/publications/guidebooks/downloads/24/24_p0068_p0071.pdf)
(NMGS) and the
[road log of Monument Valley Navajo Tribal Park](http://www.jetsetenterprises.com/cruise/images/CanyonlandsRT/MonumentValleyFeatureMap.pdf),
which give the de Chelly at 400 ft in the park, the upper half of a 600 ft Organ Rock
exposed at the base, a Moenkopi under 200 ft, and a Shinarump averaging 50 ft.

## The floor is the worst case for contour lines

**Landed.** Reported as "this looks very broken", with a screenshot of the desert floor in
even parallel ribs from the bottom of the frame to the middle distance.

They were real geometry and they were the terracing in
"Relief costs contour lines" below, at its worst: a shallow ramp in a voxel world *is* a
contour map, and the floor is the shallowest thing in the world. The dunes ran 9 voxels
over a 512-voxel lattice, which is a slope of about 0.035, which puts a one-voxel step
every twenty-six voxels. Each step has a side face that faces away from a high sun and
picks up ambient only, so it reads as a black rule across a bright plain, and the mesher
merges consecutive ones into long quads so they read as ruled rather than stippled.

Two fixes were tried. Adding a fine ripple to break the terrace edges up made it *worse*:
ragged edges instead of straight ones, but four times as many of them, and the count is
what the eye picks up. What worked is the slope itself. The floor is a 7-voxel basin over
an 8,192-voxel lattice plus a 4-voxel swell over a 2,048-voxel one, a slope near 0.005,
which puts a terrace edge every couple of hundred voxels and reads as a bench in the sand.
The rule to carry: on a near-level surface, spend the relief budget on *wavelength*, not
on amplitude and not on extra octaves.

## Fewer monuments, sampled finer

**Landed.** Asked for as "we can have fewer pillars but increase lod", and the two halves
pay for each other.

Fewer: the lattice went from 920 to 1,150 voxels, and the hit rate from a flat 37% of
cells to `0.15 + 0.85 * group_density(id)`, so the empty desert is nearly empty and a
group is nearly full. That is what stops the horizon reading as a picket fence, and each
monument that is not there is far-field march and brick pool spent on one that is.

The rate has been re-tuned once since, and the numbers here are the tuned ones. The first
tuning was done against a placement bug: the 3x3 neighbour loop offset the sample point by
a whole cell and then called `wp_repeat`, which is periodic and ate the offset, so every
cell drew nine monuments around its own centre, each clipped at the boundary it crossed
([gotchas.md](gotchas.md) "Domain repetition loses the neighbour offset"). `wp_repeat_near`
fixed it and divided every population in the world by nine, so every acceptance rate here
and in the forest had to be set again from scratch. **A rate tuned by eye is tuned against
whatever the placement was doing at the time.**

Finer: a world can now override the clipmap for itself (`far` in `src/worlds/index.ts`,
`?farSize=n` to try one), and the monument valley asks for six levels of 64^3 bricks
instead of the default eight of 32^3. Doubling a level's width halves the cell size at a
given distance, which is the whole point, and it is affordable here because the valley is
mostly empty air and an empty brick costs no pool slot: 30,382 bricks against 8,101, in a
pool sized for it.

Measured at 1080p standing on the floor looking down the valley, which is the worst case
in this world because the air is clear and every ray runs to the end of the clipmap:

| Clipmap        | Reach  | March p50 | Bricks | Holds 120 Hz |
|----------------|--------|-----------|--------|--------------|
| 32^3, 8 levels | 32,768 | 7.27 ms   | 8,101  | no           |
| 64^3, 7 levels | 32,768 | 8.32 ms   | 32,696 | no           |
| 64^3, 6 levels | 16,384 | 3.47 ms   | 31,280 | yes          |
| 64^3, 5 levels | 8,192  | 2.75 ms   | 31,280 | yes          |

Six wide levels are both finer and cheaper than eight narrow ones, because a ray crosses
fewer levels to get out of the clipmap. What they cost is reach, which is why the desert
haze is twice as thick as it was: the fog has to have taken the view before the last level
ends at 16,384 voxels. Clear desert air and a clipmap are not compatible, and the fog is
the cheaper of the two to fake.

## Still to do

- Two small dark squares stand in the sky at some cameras. Not near-field chunk data (a
  probe of the store found no solid voxel above y = 41 within 520 voxels of the camera)
  and not the far field (`?far=0` keeps them). Unexplained.


- A bench scene. The valley is the natural one for far-field work, and the existing
  scenes are all forest or terrain.
- The contour lines above, on broad faces seen head-on.
- Mesas are currently the same prism as buttes with different numbers. Real mesas are
  wide enough that their tops should carry their own relief.
- Too many of the monuments read as narrow towers at a distance. The three kinds differ in
  width and in which contact they are eroded to, but not yet in plan: a mesa wants a
  longer, less round footprint than a butte.
- Nothing uses the thumb's shape beyond a second prism; the Mittens' thumbs are tapered.
