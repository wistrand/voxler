# docs/

The GitHub Pages site: `index.html` plus the screenshots in `media/`. Committed, because
it is content.

The playable build is not committed. `.github/workflows/pages.yml` runs `deno task build`
and copies `dist/` into `play/` of the published site, so the link on the page is
`play/?world=forest`. Nothing under `dist/` ever lands in the repo.

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
the on-screen panel hidden (`document.getElementById("hud").style.display = "none"`).
Keep them under a few hundred KB each; they are in git forever.
