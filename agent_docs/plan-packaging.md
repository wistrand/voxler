# Plan: packaging

> Status: phase 1 part done. The options layer is in and `main.ts` no longer reads the
> URL; the façade class is not lifted out yet. The decisions in "What was decided" are
> settled; nothing is published yet. Depends on nothing new: every subsystem it exposes already exists and is
> already a class with an options object. What it depends on *not* changing is the world
> program contract in [design-formats.md](design-formats.md) "World program", which is the
> API this is built around.

## Goal

A developer writes a WGSL world and gets a running renderer, in their own page, with their
own bundler, without reading this repository.

```js
import { Voxler } from "voxler";

const voxler = await Voxler.create(canvas, { world: { code: myWorldWgsl } });
voxler.start();
```

That is the whole 80% path. Everything else in this plan exists to make those three lines
true without lying about what they cost.

## Where this starts from

Better than it looks. The engine is already library-shaped and was not written to be:

- 86 source files, and every subsystem is an exported class with an explicit constructor
  and an options object: `Gpu`, `Renderer`, `ChunkStore`, `ChunkStreamer`,
  `MeshScheduler`, `WorkerPool`, `FlyCamera`, `FlyControls`, `Follow`, `BrushStore`,
  `EditTool`, `Clipmap`, `FarField`.
- `WorkerPool` already takes a worker *factory*, which is the thing consumers have to
  override and the thing libraries usually hardcode.
- Four `document.` references in the entire codebase, all in `src/main.ts`.
- The hot kernels are pure functions over typed arrays with no DOM or GPU access, because
  they had to run in `deno test`. That is also what makes them safe to export.
- Worlds are already data: a WGSL string plus a spawn, a sky name and clipmap overrides.

The coupling is concentrated in one file. `src/main.ts` was 1357 lines and it is a
*script*, not a module: module-scope singletons, `document.getElementById("view")`,
`requestAnimationFrame(frame)` as the last statement, and **39 reads of
`location.search`** as the configuration mechanism. There is no way to construct the
engine twice, no way to configure it except through the URL, and no way to take it down.

Phase 1 has since taken the third of those away: the reads are 0 and the configuration is
an object. The other three are still true.

So this is mostly an extraction, not a rewrite.

## What was decided

| Decision            | Choice                                    | Why                                                                                  |
|---------------------|-------------------------------------------|--------------------------------------------------------------------------------------|
| Distribution        | npm, prebuilt bundle                      | 27 WGSL files are imported with `with { type: "text" }`. Shipping source makes every consumer install a bundler plugin; shipping a build makes the problem ours, once. |
| Lead use case       | write a world, get a viewer               | It is the thing voxler has that other engines do not. The façade is shaped around a world, and the subsystems stay public underneath it. |
| Shape               | façade plus parts                         | `Voxler.create()` for the common case; every class it composes stays exported for anyone who wants to drive their own loop. |

## The four real problems

Everything below is downstream of these. None of them is about API aesthetics.

**1. Configuration is the URL.** Not a layering mistake: it was the right call for a
single-page demo where every switch had to be shareable as a link. But `params.get("far")`
read at module scope in 39 places is not something a host application can set. The fix is
an options object with defaults, and a separate `optionsFromSearch()` that the demo uses,
so every existing `?switch=` keeps working and none of them is the API.

**2. Workers.** `new Worker(new URL("./workers/voxel.worker.js", import.meta.url))` is
correct for this repo's `dist/` layout and wrong everywhere else. The package must ship
the worker as its own file and let the host override the factory, because no default
resolves under every bundler.

**3. WGSL text imports.** `import near from "./near.wgsl" with { type: "text" }` is fine
in Deno and in this repo's esbuild build, and is a plugin requirement for everyone else.
Answered by shipping a build with the WGSL inlined; the source tree does not change.

**4. Blocks, textures and skies are module-level registries.** `BLOCKS`
(`src/world/blocks.ts`), `TEXTURES` (`src/render/textures.ts`) and `SKIES`
(`src/render/sky.ts`) are frozen arrays, and `BLOCK_LIGHT`, `BLOCK_OPAQUE`,
`BLOCK_FAR_SOLID` and `BLOCK_TRANSLUCENT` are derived from `BLOCKS` by IIFEs at module
load. A developer who writes a world will want their own blocks about ten minutes later,
and today they cannot have them. This is the deepest change here and it is phase 4, on its
own, because it touches a format with four readers
([design-formats.md](design-formats.md) "Chunk table", `src/world/block-table_test.ts`).

`Sky` is the exception and is nearly free: `skyConstantsWgsl()` already takes a `Sky`
value and `SKIES` is only a name lookup, so a custom sky object works the day the option
exists.

## The surface

Sketch, not a signature. What it has to get right is that the required option is a world
and everything else has a defensible default.

```ts
const voxler = await Voxler.create(canvas, {
  world: { code: myWgsl, spawn: [0, 100, 0], sky: "night" },
  seed: 1,

  // Every one of these is optional and every default is what the demo runs today.
  camera:  { at: [0, 100, 0], yaw: 0, pitch: -0.25 },
  workers: { count: navigator.hardwareConcurrency, factory: (i) => new Worker(...) },
  stream:  { radius: 16, height: 6, arenaBytes: 128 << 20 },   // or false
  mesh:    { ao: true, blockLight: true, clusterQuads: 32 },   // or false
  far:     { levels: 8, size: 32, firstLevel: 1, shadows: true }, // or false
  render:  { size: "auto", textures: true, glow: true, wind: true },
  controls: true,
  onError: (message) => { ... },
});
```

```ts
voxler.start();            // owns requestAnimationFrame
voxler.stop();
voxler.frame(now);         // or the host drives it from its own loop
voxler.resize(w, h);
voxler.dispose();          // the thing that does not exist today

voxler.camera;             // FlyCamera
voxler.renderer;           // Renderer | null, null across a device loss
voxler.store;              // ChunkStore
voxler.stats;              // Stats
voxler.edit;               // setVoxel, fillBox, fillSphere, csgSphere
voxler.pick(x, y);         // what is under a client-space point
voxler.on("ready" | "error" | "deviceLost" | "frame", handler);
```

Three entry points, so the debug and benchmark surfaces are not in everyone's bundle:

| Entry           | Holds                                                                 |
|-----------------|-----------------------------------------------------------------------|
| `voxler`        | the façade, the subsystem classes, the world and block types           |
| `voxler/worlds` | the four worlds that ship: forest, terrain, monument, showcase        |
| `voxler/debug`  | `Overlay`, `Hud`, the `describe*` formatters                          |

The benchmark harness is not published. It measures this repo's machines against this
repo's history, and a number from someone else's page compared against `bench/results/`
would be worse than no number.

### What `dispose()` has to do, and why it is phase 2 and not an afterthought

Nothing in the engine has a teardown path today, because a page that ends is a page that
unloads. The only `destroy()` calls are `depthTexture.destroy()` on resize and
`device.destroy()` in the device-loss test. An embedded engine has to give it all back:
terminate the worker pool, destroy the device, disconnect the `ResizeObserver`, remove the
pointer and key listeners, cancel the pending `requestAnimationFrame`, and drop the
in-flight readbacks (`CounterReadback`, the voxelizer's mapped buffers) without resolving
their callbacks into a renderer that is gone. The device-loss path already does a version
of this — `generation` in `main.ts` exists so a stale `device.lost` handler does not
resurrect a replaced renderer — and `dispose()` is that idea finished.

## Phases

### Phase 1: a composition root

Split `src/main.ts` along the seam that is already there. No behaviour changes and no new
API; the demo must run exactly as it does now, every URL switch included.

- [x] `src/options.ts`: `VoxlerOptions`, `ResolvedOptions`, the defaults and
      `resolveOptions()`. Pure, so the defaults are a test and not a claim
      (`src/options_test.ts`, 10 tests). Two types on purpose: what a caller writes is
      forgiving and mostly optional, what the engine reads has every field present and
      every number clamped, so no frame-path code asks "was that set?".
- [x] `src/app/search-options.ts`: `optionsFromSearch()`, `worldFromSearch()` and
      `appSwitches()`. Every `?switch=` is mapped here and nothing else in the engine
      knows a URL exists. It takes the params rather than reading `location`, so it is
      testable and a host can feed it a query string of its own.
- [x] `src/main.ts` reads the resolved options instead of the URL: **39 reads of
      `params` down to 0**, and the helpers that went with them (`intParam`,
      `numberParam`, `selectWorld`, `fixedSize`, `streamOptions`, `voxelSlots`,
      `previewScale`, `workerCount`) are gone.
- [x] `src/voxler.ts`: the `Voxler` class. Takes a canvas and `VoxlerOptions`, builds the
      GPU, renderer, store, streamer, mesher, pool, brushes and far edits, owns the frame
      loop and the device-loss restart, and has `start`, `stop`, `frame`, `resize` and
      `dispose`. The seam to a host is five callbacks (`VoxlerHooks`): `onError`,
      `onUnsupported`, `onCompiling`, `onReady`, `update`, `afterFrame`.
- [x] `voxler` is its own build entry, so `dist/voxler.js` is the engine with the WGSL
      inlined and no demo in it. 409 KiB.
- [x] `FlyControls.dispose()`, which did not exist: two of its listeners are on the window
      rather than the canvas, so an engine torn down without it kept steering a camera
      nobody could see.
- [ ] `src/main.ts` uses `Voxler` instead of composing the engine a second time.
      **Not done, and it is the next thing.** The risk stopped being hypothetical: the
      first extraction dropped four callbacks (`pool.on("chunk.compress")`, the two
      `MESH_JOB` handlers, `streamer.listener`, `streamer.voxelStage`), so the chunk store
      stayed empty and the near field never ran. The far field drew the world anyway and it
      looked correct, which is how it survived being screenshotted for the documentation
      ([gotchas.md](gotchas.md) "A missing callback rendered a world with no chunks in
      it"). Fixed, and the fix is four field assignments no compiler was ever going to ask
      for. Two compositions is what allowed it.
- [ ] `src/main.ts` shrinks to the demo shell: DOM, overlay, HUD, key bindings, bench,
      the `voxler` console handle, bird picking and the chase camera.
- [ ] A test that builds a `Voxler` against the headless adapter and runs a frame, so the
      façade is covered by `deno task test` rather than only by opening a page.

**Verify:** every URL switch in `CONTROLS_HELP` still does what it did; a grove bench run
matches the last one within a few percent; `deno task check`, `test` and `build` clean.

**The API has a consumer, and it is the published site.** `docs/start.html` imports
`play/voxler.js` and calls `Voxler.create()` with a world written on the page, which makes
it the first thing to use the engine from outside its own repository rather than inside it.
It runs two worlds: a twenty-line heightfield, and one with ridged mountains under a mask, a
sea and a scatter of boulders, which is there because scatter is where a world goes wrong
and three of its four rules are gotchas this repo hit first. The WGSL is read out of the
`<code>` block the page displays, so what is shown and what is compiled are one string.

Building that found two things worth having: the page wanted `render: { gizmo: false }`,
because the debug axis cross is not something an embedded viewer should have to accept, and
it wanted `dispose()` to actually work, which is how `FlyControls.dispose()` came to exist.
Checked in a browser: a second engine builds on the same canvas after a dispose, in 2.8 s
against the first one's 4.6, with the JS heap flat at about 60 MiB across the cycle.

**Verified so far:** 284 tests pass, check and build clean, and the switches were driven
through a real browser rather than only through the unit tests. `?world=forest` opens at
-108, 267, 293 with pitch -14.3, 15 workers, the night sky, birds on and a 7-level 32-brick
clipmap at 2 slabs a frame, which is what it did before any of this.
`?farLevels=4&farSlabs=1&arenaMB=64&workers=3&streamRadius=8&streamHeight=3&nearMB=32&clusterQuads=16&farScale=0.5&gizmo=0&cull=3`
arrives as 4 levels, 1 slab, 64 MiB of chunk arena, 3 workers, radius 8, height 3, a
32 MiB quad arena, 16-quad clusters, a 50% march, no axis cross and cull mask 3.
`?ao=0&light=0&far=0&seed=7` turns off baked AO and block light, takes the shadows with
the far field, and seeds at 7. No overlay errors in any of them.

**One bug this caught, in the options layer and before it shipped.** `?regen=n` is a soak
test that regenerates n random resident chunks a frame, and `StreamOptions.regenPerFrame`
is how many chunks an *edit* has changed the streamer puts back through the voxelizer. They
share a word and they are not the same thing, and the first version of `resolveOptions()`
mapped the switch onto the option, which would have quietly dropped the streamer's budget
from 8 to 0 and stopped edited chunks being regenerated. The soak now lives in
`AppSwitches` where it belongs, `StreamingOptions` deliberately does not expose
`regenPerFrame`, and `src/options_test.ts` pins both.

### Phase 2: lifecycle

- [ ] `start()`, `stop()`, `frame(now)`, `dispose()`, and a `Voxler` that can be
      constructed twice on one page without the two interfering.
- [ ] Teardown for everything in "What `dispose()` has to do".
- [ ] `autoResize: false` for a host that owns sizing, and `size` for the fixed-size path
      the letterbox already handles.

**Verify:** a test page that mounts, disposes and remounts ten times with no growth in
`performance.memory` and no console errors; the pool's workers gone after dispose.

### Phase 3: the package

No registry. `npm install <https url>` takes a tarball directly, so the site is the
distribution: CI builds the tarball and drops it at the site root, and the install line is

    npm install https://voxler.dev/voxler-<version>.tgz

- [x] `pack.ts` and `deno task pack`: builds the release, stages `voxler.js`,
      `workers/voxel.worker.js`, a generated `package.json`, a package README and the
      licence under `package/`, and tars it. 151 KiB.
- [x] `tar` rather than a tar written here. The format has enough corners (checksums, the
      ustar prefix split, modes) that a mistake shows up as an install failure on someone
      else's machine and nowhere else.
- [x] The version lives in `src/version.ts`, read by `pack.ts`, printed by
      `docs/start.html` and exported from the bundle. `src/release_test.ts` checks the
      first two against each other, because a bump that updates one publishes a page
      pointing at a file the build no longer produces.
- [x] CI builds it and copies it into `_site/`, and asserts the install URL exists rather
      than letting the page point at a 404.
- [ ] Types. Deno emits none for npm, so this needs a decision: `dnt`, or `tsc
      --emitDeclarationOnly` as a dev dependency. **Open, and it needs asking before it
      lands** (CLAUDE.md: never add a dependency without asking). Hand-written `.d.ts` is
      the third option and is a maintenance trap. Until then the package says plainly that
      a TypeScript caller gets `any`.
- [ ] A consumer smoke test in CI: a scratch Vite project that installs the tarball,
      imports `Voxler`, and builds. Catches the worker resolution and the entry points,
      which are exactly what a local `deno task build` cannot catch.

**Verified so far:** the tarball's entries are all under `package/`, and Node's own
resolver (given the tarball extracted into `node_modules/`, no npm involved) resolves
`voxler` to `voxler.js`, `voxler/workers/voxel.worker.js` to the worker, and refuses
`voxler/voxler.js` with `ERR_PACKAGE_PATH_NOT_EXPORTED`, so the `exports` map is doing
what it says.

**The worker default had to change shape for this.** Bundlers detect
`new Worker(new URL("...", import.meta.url), { type: "module" })` as one literal
expression and emit the worker as an asset; the default factory had the `new URL` behind a
function call, which defeats that and leaves a path resolving to nothing. It is written
out literally now, with a comment saying why it must stay that way.

### Phase 4: a world brings its own blocks

The one that makes "write a world" true rather than nearly true.

- [ ] `BLOCKS` becomes a registry a world can extend, and the four derived tables are
      built from it rather than at module load.
- [ ] `TEXTURES` likewise; a consumer block needs a face texture or the coarse colour.
- [ ] `sky` accepts a `Sky` object as well as a name (nearly free, see above).
- [ ] `src/world/block-table_test.ts` follows: the block table has four readers and this
      changes when the table is built, not what is in it.

**Verify:** a world in the test suite that declares its own block and its own sky, and
draws it in the near field, the preview and the far field with the same colour.

## Open questions

- **Does the façade own input?** `FlyControls` and `Follow` are good defaults and wrong
  for a host with its own camera. Current answer: `controls: true` by default because the
  demo needs it, off in one line, and both classes stay exported. Worth revisiting once
  someone actually embeds it.
- **Bird picking.** `renderer.pickBird()` is engine and the chase camera is app, and the
  line between them is currently a hundred lines of `main.ts` that does both.
- **Versioning against the world contract.** A world is WGSL text compiled against
  `lib.wgsl` and the generated block constants, so a change to either can break a
  consumer's world with no type error anywhere. The contract needs a version, and
  `design-formats.md` "World program" is where it is written down.
- **`MAX_BLOCK_TYPES` is 256** and the id is a `u16` in chunk storage. Phase 4 should say
  whether a consumer gets ids out of the same 256 or a reserved range.
