# docs/

The GitHub Pages site: `index.html` plus the screenshots in `media/`. Committed, because
it is content.

`start.html` is the get-started page, and it is the one page here that is not only prose:
it imports `play/voxler.js`, the engine bundle the build emits, and runs two worlds whose
WGSL it reads out of the `<code>` blocks it displays. The source shown and the source
compiled are the same string, so the page cannot drift from what it claims. It is also the
first consumer of the packaging API (`Voxler.create`), which makes it the check that the
API works from outside this repository rather than only inside it
([plan-packaging.md](../agent_docs/plan-packaging.md)).

`CNAME` is what makes all of that answer at `https://voxler.dev/`: GitHub Pages reads it
at the site root to know which domain this deploy owns. The workflow copies it there with
the rest of `docs/`, and `src/release_test.ts` holds it against the host in `SITE`
(`src/version.ts`), which is where the install URL comes from.

The npm tarball is published here too. `deno task pack` builds it and the workflow copies
`dist-npm/*.tgz` to the site root, so `npm install https://voxler.dev/voxler-<version>.tgz`
works without a registry. The version in `start.html` is checked against the one the build
produces by `src/release_test.ts`.

The playable build is not committed. `.github/workflows/pages.yml` runs `deno task build`
and copies `dist/` into `play/` of the published site, so the links on the page are
`play/?world=forest` and `play/voxler.js`. Nothing under `dist/` ever lands in the repo.

`deno task docs` builds and serves both halves the way Pages will: the site at `/`, the
demo at `play/`, and no COOP/COEP. It reads `docs/` and `dist/` off disk rather than
copying them, so an edit here shows on reload.

Two things to know before changing either half:

- **Pages cannot set headers**, so the site is not cross-origin isolated and
  `SharedArrayBuffer` is unavailable there. The engine already has that path: the payload
  arena falls back to a plain `ArrayBuffer` and mesh jobs copy instead of sharing
  (`allocShared()` in `src/workers/buffers.ts`). Checked by serving `dist/` with no
  COOP/COEP (`deno task docs`): the forest streams and draws exactly as it does behind
  `serve.ts`.
- **The app has to work from a subpath.** A project site lives at
  `https://<user>.github.io/<repo>/`, so every path in `index.html` and every
  `new Worker(new URL(...))` stays relative. Don't make any of them absolute. Nothing here
  is today; `BASE=voxler deno task docs` serves under the subpath if you want to prove it,
  since an absolute path works at the root and only breaks once deployed.

`?bench=` works on the deployed site, and its numbers are worth nothing. The run itself is
fine: the scene drives, the overlay reports it. Saving does not happen at all. Only
`serve.ts --dev` answers the save route, so a published page could never do anything but
fail against whatever host it was loaded from, and rather than leave that to fail it is
compiled out: `build.ts` defines `__BENCH_SAVE__` false for a release build and the
`fetch` in `src/bench/save.ts` goes with it, route string included. The published bundle
contains no POST. The overlay says `not saved` and the result stays in the console.
More to the point, the site is not cross-origin isolated, so the workers are on the copy
path and the numbers are not comparable to anything in the repo, on top of being from a
stranger's hardware. Nothing published here should ever be quoted as a measurement.

Screenshots are taken from the running engine at the viewport size in `.mcp.json`, with
`?gizmo=0` for the axis cross and the on-screen panel hidden
(`document.getElementById("hud").style.display = "none"`). Shot at 1600x900 CSS pixels,
which is 2000x1125 at the dev machine's device pixel ratio, then resized to the 1600x900
the page declares. Keep them under a few hundred KB each; they are in git forever.

Both forest shots are from one place, so the day and the night are the same valley. It is
where the forest now opens (`start` in `src/worlds/index.ts`), so the night shot needs no
switches beyond the screenshot ones:

    ?world=forest&gizmo=0
    ?world=forest&sky=day&gizmo=0

The shots in the repo were taken a little off that aim, at yaw -17.0 and pitch 1.2
(`voxler.camera.setOrientation`), which puts the moon in the upper right rather than out
of frame.

The birds in them are wherever the flock happened to be. They cannot be put in front of the
moon from here, whatever you wait for: the eye is at y 267 and the flock flies between 200
and 265, so every bird is below the horizon (elevation -17.7 to -0.4 degrees over a
20-second sample) and the moon is 24.9 degrees above it. Measured, not guessed: 44,548 bird
readings, closest approach 26.7 degrees. A shot with a bird crossing the moon needs an eye
under the flock, and the ground here is at y 179.
