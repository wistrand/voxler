// The forest's footprint gates decide which consumer of the world sees which feature, and
// the numbers they are compared against live somewhere else entirely: the voxelizer sets
// `sample_footprint` to 1, and the far field sets it to the clipmap cell's size in voxels.
// A gate that drifts to the wrong side of either is silent. Undergrowth vanishing from the
// meshes is a bare forest floor; undergrowth appearing in the bricks is a brick build
// paying for ferns nobody can see, which is what it was doing
// (gotchas.md "A bound is paid for everywhere").

import { DEFAULT_CLIPMAP_OPTIONS } from "../far/clipmap.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const SOURCE = Deno.readTextFileSync("src/worlds/forest.wgsl");

// `const NAME = <number>;` or `const NAME = <number> * S;`, with S read from the file.
function constant(name: string): number {
  const m = SOURCE.match(new RegExp(`const\\s+${name}\\s*=\\s*(-?[0-9.]+)\\s*(\\*\\s*S)?\\s*;`));
  assert(m !== null, `forest.wgsl no longer declares ${name}; this test is stale`);
  const scale = m![2] ? constant("S") : 1;
  return Number(m![1]) * scale;
}

// What the voxelizer passes (src/sdf/voxelize.wgsl) and what the far field's finest level
// passes (src/far/far-build.wgsl, the cell size of level `firstLevel`).
const VOXEL_FOOTPRINT = 1;
const FINEST_CELL = 2 ** DEFAULT_CLIPMAP_OPTIONS.firstLevel;

Deno.test("undergrowth is in the meshes and in no brick", () => {
  const gate = constant("UNDERGROWTH_FOOTPRINT");
  assert(gate >= VOXEL_FOOTPRINT, `undergrowth is gated at ${gate}, under the voxelizer's ${VOXEL_FOOTPRINT}: the wood would have a bare floor`);
  assert(gate < FINEST_CELL, `undergrowth is gated at ${gate}, at or over the finest clipmap cell's ${FINEST_CELL}: the brick build pays for ferns behind the near field`);
});

Deno.test("the far field keeps the features that are broad enough to survive it", () => {
  // The other side of the same rule: a canopy is broad and continuous, so it has to reach
  // past the finest level or the wood ends in a line
  // (gotchas.md "A footprint gate deletes a feature from the far field").
  assert(constant("TREE_FAR_FOOTPRINT") > FINEST_CELL, "trees must survive past the finest clipmap level");
  assert(constant("TREE_FOOTPRINT") > FINEST_CELL, "a tree keeps its detail at the finest level");
});

Deno.test("the forest's growing lines are in the order the mountain puts them", () => {
  // Ground level upward: the scrub takes over before the wood gives out, fungus stops
  // above that, the alpine growth above that, and the snow over everything.
  const scrub = constant("SCRUB_LINE");
  const tree = constant("TREE_LINE");
  const shroom = constant("SHROOM_LINE");
  const alpine = constant("ALPINE_LINE");
  const snow = constant("SNOW_LINE");
  assert(scrub < tree, `scrub starts at ${scrub}, over the tree line at ${tree}`);
  assert(tree < shroom, "fungus climbs past the wood");
  assert(shroom < alpine, "the alpine growth is the last of it");
  assert(alpine < snow, `the growth reaches ${alpine}, into the snow at ${snow}`);
});

Deno.test("a fern stands closer to the water than anything else in the undergrowth", () => {
  const fern = constant("FERN_DRY");
  const under = constant("UNDER_DRY");
  assert(fern < under, `a fern needs ${fern} of dry ground and a mushroom ${under}`);
  assert(constant("FERN_WET_DENSITY") > 0, "a fern is thicker by the water, not thinner");
  // The bound is built for the biggest a fern could be, so this is paid for on every
  // sample near one, everywhere, and not only on the bank where it shows.
  assert(constant("FERN_WET_SIZE") <= 0.3, "a wet fern's extra reach inflates every fern's bound");
});
