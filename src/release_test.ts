// The package version exists twice: in `pack.ts`, which names the tarball, and in
// `docs/start.html`, which tells people the URL to install from. A version bump that
// updates one of them publishes a page pointing at a file the build no longer produces,
// and the failure lands on a stranger running `npm install` rather than on anyone here.
//
// It lives under `src/` because that is where `deno task test` looks, and it reads the
// version from `src/version.ts` rather than from `pack.ts`, which would drag esbuild in
// through `build.ts` and need `--allow-env` to import at all.

import { tarballName, VERSION } from "./version.ts";

const TARBALL = tarballName();

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const START = Deno.readTextFileSync("docs/start.html");

Deno.test("the version is a version", () => {
  assert(/^\d+\.\d+\.\d+$/.test(VERSION), `"${VERSION}" is not a semver triple, and npm will refuse it`);
  assert(TARBALL === `voxler-${VERSION}.tgz`, `tarball is ${TARBALL}`);
});

Deno.test("the install URL on the get-started page is the tarball the build makes", () => {
  const urls = [...START.matchAll(/https:\/\/wistrand\.github\.io\/voxler\/(voxler-[^"<\s]+\.tgz)/g)]
    .map((m) => m[1]);
  assert(urls.length > 0, "docs/start.html no longer shows an install URL; this test is stale");
  for (const named of urls) {
    assert(named === TARBALL, `the page installs ${named}, the build produces ${TARBALL}`);
  }
});

Deno.test("the page pins a version rather than a moving filename", () => {
  // npm caches a tarball by its URL. A stable name like `voxler-latest.tgz` would mean a
  // dependency that changes without the lockfile noticing, so the URL has to carry the
  // version even though that is what makes the check above necessary.
  assert(!START.includes("voxler-latest.tgz"), "the install URL must name a version");
});
