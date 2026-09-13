// The package version exists twice: in `pack.ts`, which names the tarball, and in
// `docs/start.html`, which tells people the URL to install from. A version bump that
// updates one of them publishes a page pointing at a file the build no longer produces,
// and the failure lands on a stranger running `npm install` rather than on anyone here.
//
// It lives under `src/` because that is where `deno task test` looks, and it reads the
// version from `src/version.ts` rather than from `pack.ts`, which would drag esbuild in
// through `build.ts` and need `--allow-env` to import at all.

import { SITE, tarballName, tarballUrl, VERSION } from "./version.ts";

const TARBALL = tarballName();
const HOST = new URL(SITE).host;

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const START = Deno.readTextFileSync("docs/start.html");

Deno.test("the version is a version", () => {
  assert(/^\d+\.\d+\.\d+$/.test(VERSION), `"${VERSION}" is not a semver triple, and npm will refuse it`);
  assert(TARBALL === `voxler-${VERSION}.tgz`, `tarball is ${TARBALL}`);
});

Deno.test("the install URL on the get-started page is the tarball the build makes", () => {
  const urls = [...START.matchAll(/https:\/\/[^"'<\s]*?\/(voxler-[^"<\s]+\.tgz)/g)];
  assert(urls.length > 0, "docs/start.html no longer shows an install URL; this test is stale");
  for (const m of urls) {
    assert(m[1] === TARBALL, `the page installs ${m[1]}, the build produces ${TARBALL}`);
    assert(m[0] === tarballUrl(), `the page installs from ${m[0]}, the build says ${tarballUrl()}`);
  }
});

Deno.test("the site the install URL names is the domain the deploy claims", () => {
  // `docs/CNAME` is what tells GitHub Pages which domain this site answers on, and the
  // workflow copies it to the site root. A host in one and not the other is a 404 for
  // everyone who followed the install line, and nothing here would notice.
  const cname = Deno.readTextFileSync("docs/CNAME").trim();
  assert(cname === HOST, `docs/CNAME claims ${cname}, the install URL points at ${HOST}`);
  assert(!cname.includes("/") && !cname.includes(":"), `docs/CNAME must be a bare host, not ${cname}`);
});

Deno.test("the page pins a version rather than a moving filename", () => {
  // npm caches a tarball by its URL. A stable name like `voxler-latest.tgz` would mean a
  // dependency that changes without the lockfile noticing, so the URL has to carry the
  // version even though that is what makes the check above necessary.
  assert(!START.includes("voxler-latest.tgz"), "the install URL must name a version");
});
