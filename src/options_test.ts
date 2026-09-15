// The options layer is a translation, and the thing that would make it worth nothing is
// translating into different numbers than the ones the engine has been running on. So the
// values below are not "sensible defaults": they are what `src/main.ts` computed from an
// empty query string before any of this existed, written down so a refactor that quietly
// halves the stream radius fails here instead of in a bench result three days later.
//
// The second half checks the switches still mean what they meant, because they are what
// every A/B in `bench/results/` was run with and a result that names `?ao=0` has to keep
// meaning the same run.

import { appSwitches, BENCH_DEFAULT_SIZE, optionsFromSearch } from "./app/search-options.ts";
import { DEFAULT_ARENA_BYTES, DEFAULT_START_PITCH, resolveOptions, type VoxlerOptions } from "./options.ts";
import { CLUSTER_QUADS, ORDER_EMISSION, ORDER_MORTON } from "./mesh/cluster.ts";
import { CULL_ALL } from "./render/near-field.ts";
import { SKIES } from "./render/sky.ts";
import { WORLDS } from "./worlds/index.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const from = (search: string) => resolveOptions(optionsFromSearch(new URLSearchParams(search)));

Deno.test("an empty query string resolves to what the demo has been running", () => {
  const o = from("");

  // The default world, and the seed a bench result assumes.
  eq(o.world.code, WORLDS.showcase.code, "default world is the showcase");
  eq(o.world.seed, 1, "default seed");
  eq(o.world.spawn, WORLDS.showcase.spawn, "spawn comes from the world");
  eq(o.world.sky, SKIES.day, "showcase has no sky of its own, so DEFAULT_SKY");
  eq(o.world.birds, false, "birds are opt-in per world");

  // Streaming and meshing on, which is what makes the near field exist at all.
  assert(o.streaming, "streaming on by default");
  assert(o.meshing, "meshing on by default");
  eq(o.stream.radius, 16, "stream radius");
  eq(o.stream.height, 6, "stream height");
  eq(o.stream.regenPerFrame, 8, "the streamer's own budget for edited chunks, untouched");
  eq(o.arenaBytes, DEFAULT_ARENA_BYTES, "chunk arena is 128 MiB");
  eq(o.voxelSlots, 8, "voxelizer readback slots");

  eq(o.mesh.clusterQuads, CLUSTER_QUADS, "cluster size");
  eq(o.mesh.clusterOrder, ORDER_EMISSION, "cluster order");
  assert(o.mesh.ao, "baked AO on");
  assert(o.mesh.blockLight, "block light on");

  assert(o.farOn, "far field on by default");
  eq(o.far.clipmap.size, 32, "bricks per level side");
  eq(o.far.clipmap.firstLevel, 1, "finest cell is 2 voxels");
  eq(o.far.slabsPerFrame, 2, "slab budget");
  eq(o.far.scale, 1, "march at full resolution");
  assert(o.far.beam, "beam pre-pass on");
  assert(!o.far.adapt, "the adaptive reach is off unless asked");
  assert(o.shadows, "shadows on");

  eq(o.render.size, null, "size follows the window");
  eq(o.render.previewScale, 0.5, "preview at half resolution");
  assert(!o.render.preview, "the preview starts off while meshes are drawn");
  assert(o.render.textures && o.render.glow && o.render.wind, "textures, emission and wind on");
  eq(o.render.cull, CULL_ALL, "every cull stage");
  assert(o.render.gizmo, "the axis cross is on");
  assert(!o.render.grid, "the chunk grid is off");

  eq(o.camera.at, WORLDS.showcase.spawn, "camera starts at the world's own start");
  eq(o.camera.yaw, 0, "looking along -Z");
  eq(o.camera.pitch, DEFAULT_START_PITCH, "and a little down");
  assert(o.controls && o.autoResize, "the demo's input and resizing are on");
});

Deno.test("the levels a world gets are trimmed to the distance its fog closes the view at", () => {
  // Not the clipmap's own default of 8: a level past the fog horizon marches for a result
  // the sky pass already drew (CLAUDE.md, `levelsForReach`). An explicit count is taken as
  // written instead, because a measurement wants the setting it asked for.
  const trimmed = from("?world=forest").far.clipmap.levels;
  const asked = from("?world=forest&farLevels=8").far.clipmap.levels;
  assert(trimmed <= 8, `trimmed to ${trimmed}`);
  eq(asked, 8, "?farLevels= overrides the trim");
  assert(trimmed !== asked, "the trim actually did something, or this test proves nothing");
});

Deno.test("a world carries its own sky, spawn, start and clipmap", () => {
  const o = from("?world=forest");
  eq(o.world.sky, SKIES.night, "the forest is a night wood");
  eq(o.world.spawn, WORLDS.forest.spawn, "the spawn is the bench anchor");
  eq(o.world.start, WORLDS.forest.start, "and the camera opens somewhere else");
  eq(o.camera.at, WORLDS.forest.start, "which is where the camera goes");
  assert(o.world.birds, "the forest has birds");
  // Monument Valley sets its own clipmap: wider levels over an empty floor.
  eq(from("?world=monument").far.clipmap.size, WORLDS.monument.far?.size, "the world's own clipmap wins");
});

Deno.test("every switch still means what the bench results assume", () => {
  assert(!from("?stream=0").streaming, "?stream=0");
  assert(!from("?stream=0").meshing, "no chunks to mesh means no meshing, whatever ?mesh says");
  assert(!from("?mesh=0").meshing, "?mesh=0");
  assert(!from("?ao=0").mesh.ao, "?ao=0");
  assert(!from("?light=0").mesh.blockLight, "?light=0");
  assert(!from("?tex=0").render.textures, "?tex=0");
  assert(!from("?glow=0").render.glow, "?glow=0");
  assert(!from("?wind=0").render.wind, "?wind=0");
  assert(!from("?gizmo=0").render.gizmo, "?gizmo=0");
  assert(!from("?shadow=0").shadows, "?shadow=0");
  assert(!from("?far=0").farOn, "?far=0");
  assert(!from("?farBeam=0").far.beam, "?farBeam=0");
  assert(from("?farAdapt=1").far.adapt, "?farAdapt=1");
  assert(from("?preview=1").render.preview, "?preview=1 forces the preview on");
  assert(!from("?preview=0").render.preview, "?preview=0 forces it off");
  eq(from("?clusterOrder=morton").mesh.clusterOrder, ORDER_MORTON, "?clusterOrder=morton");
  eq(from("?cull=3").render.cull, 3, "?cull=3 skips the Hi-Z test");
  eq(from("?size=1280x720").render.size, [1280, 720], "?size=WxH");
  eq(from("?streamRadius=8&streamHeight=3").stream.radius, 8, "?streamRadius");
  eq(from("?streamRadius=8&streamHeight=3").stream.height, 3, "?streamHeight");
  eq(from("?arenaMB=64").arenaBytes, 64 * 1048576, "?arenaMB is megabytes");
  eq(from("?farScale=0.5").far.scale, 0.5, "?farScale");
  eq(from("?seed=7").world.seed, 7, "?seed");
  eq(from("?sky=night").world.sky, SKIES.night, "?sky overrides the world's own");
});

Deno.test("shadows need the clipmap they march, so ?far=0 takes them with it", () => {
  assert(!from("?far=0").shadows, "no far field, no shadows, whatever ?shadow says");
  assert(!from("?far=0&shadow=1").shadows, "and asking for them does not conjure the clipmap");
});

Deno.test("a benchmark renders at a fixed size even when none was asked for", () => {
  // Two runs in two window shapes are not comparable, so the harness pins the size.
  eq(from("?bench=spin").render.size, BENCH_DEFAULT_SIZE, "the bench default is 1080p");
  eq(from("?bench=spin&size=800x600").render.size, [800, 600], "an explicit size still wins");
});

Deno.test("nonsense in the query string falls back instead of poisoning a field", () => {
  // `Number("banana")` is NaN, and a NaN that reaches the engine is a clamp to the
  // minimum or a buffer sized zero. Absent and unparsable have to mean the same thing.
  eq(from("?seed=banana").world.seed, 1, "unparsable seed");
  eq(from("?streamRadius=banana").stream.radius, 16, "unparsable radius");
  eq(from("?farScale=banana").far.scale, 1, "unparsable scale");
  eq(from("?size=wide").render.size, null, "unparsable size");
  eq(from("?streamRadius=9999").stream.radius, 64, "out of range is clamped, not dropped");
  eq(from("?farScale=0").far.scale, 0.1, "and clamped at the bottom too");
});

Deno.test("an unknown world or sky is reported, not thrown", () => {
  const problems: { message: string }[] = [];
  const o = resolveOptions(optionsFromSearch(new URLSearchParams("?world=atlantis&sky=dusk"), problems));
  eq(problems.length, 2, "both were noticed");
  eq(o.world.code, WORLDS.showcase.code, "and both fell back");
  eq(o.world.sky, SKIES.day, "to something that runs");
});

Deno.test("a world is all a caller has to pass", () => {
  // The claim the package makes. If this needs a second field, the claim is wrong.
  const o = resolveOptions({ world: { code: "// not compiled here" } } satisfies VoxlerOptions);
  eq(o.world.seed, 1, "seed");
  eq(o.world.sky, SKIES.day, "sky");
  assert(o.streaming && o.meshing && o.farOn, "the whole renderer is on");
  eq(o.camera.at, o.world.spawn, "and the camera is somewhere");
});

Deno.test("the app-only switches are kept out of the engine's options", () => {
  const s = appSwitches(new URLSearchParams("?bench=grove&runs=3&at=1,2,3&workerTest"));
  eq(s.bench, "grove", "bench scene");
  eq(s.runs, 3, "runs");
  eq(appSwitches(new URLSearchParams("?regen=4")).regen, 4, "?regen= is a soak switch, not a stream option");
  eq(from("?regen=4").stream.regenPerFrame, 8, "and it does not touch the streamer's budget");
  eq(s.at, [1, 2, 3], "?at=");
  assert(s.workerTest, "worker self-test");
  eq(appSwitches(new URLSearchParams("?at=1,2")).at, null, "a malformed ?at= is no ?at=");
});

Deno.test("bloom is the world's default unless the query says otherwise", () => {
  assert(from("world=forest").render.bloom === true, "the forest should bloom by default");
  assert(from("world=forest&bloom=0").render.bloom === false, "?bloom=0 should switch it off in the forest");
  assert(from("world=terrain").render.bloom === false, "the terrain has nothing to bloom and should not");
  assert(from("world=terrain&bloom=1").render.bloom === true, "?bloom=1 should switch it on anywhere");
});
