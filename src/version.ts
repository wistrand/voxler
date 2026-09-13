// The engine's version, in one place.
//
// It is read by three things that must not disagree: `pack.ts`, which names the tarball;
// `docs/start.html`, which prints the URL to install it from; and the bundle itself, so a
// consumer can ask what they have. `src/release_test.ts` checks the first two against
// each other, and it lives here rather than in `pack.ts` so that check does not have to
// drag esbuild in to run.
export const VERSION = "0.1.0";

// What the tarball is called. Versioned on purpose: npm caches a tarball by its URL, so a
// stable filename would be a dependency that changes without a lockfile noticing.
export function tarballName(version: string = VERSION): string {
  return `voxler-${version}.tgz`;
}

// Where the site lives. The custom domain is declared to GitHub by `docs/CNAME`, which the
// workflow copies to the site root; `src/release_test.ts` holds the two against each other,
// because a host that disagrees with the file that claims it is a 404 for everyone who
// followed the install line.
//
// No trailing slash: everything below appends a path.
export const SITE = "https://voxler.dev";

export function tarballUrl(version: string = VERSION): string {
  return `${SITE}/${tarballName(version)}`;
}
