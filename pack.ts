// Builds an npm-installable tarball without publishing anything.
//
// An npm package is a gzipped tar whose every entry sits under `package/`, and `npm
// install <url>` will take one straight off HTTPS. So there is no registry in the loop:
// the workflow builds this, drops it next to the site, and a consumer installs it from
// there.
//
//   npm install https://wistrand.github.io/voxler/voxler-<version>.tgz
//
// What goes in is the bundle and nothing else: `voxler.js` with the WGSL inlined,
// `workers/voxel.worker.js` beside it (the default worker factory resolves against
// `import.meta.url`, so the two have to stay neighbours), a generated `package.json`, the
// licence, and a README written for someone who has installed it rather than for someone
// reading this repository.
//
// No types yet. Deno emits no `.d.ts`, and generating them needs a tool this repo does not
// have; a hand-written declaration file for a surface this size would drift from the code
// within a week, which is worse than none. TypeScript callers get `any` until phase 3 of
// [plan-packaging.md](agent_docs/plan-packaging.md) settles it. Said plainly in the
// package README rather than left to be discovered.
//
// Run with `deno task pack`.

import { buildRelease } from "./build.ts";
import { tarballName, VERSION } from "./src/version.ts";

// The version lives in `src/version.ts`, not here: the repo is a Deno project and the npm
// package is an artefact of it, so there is no package.json to read it from, and keeping
// it out of this file lets the test that checks it against the docs run without pulling
// esbuild in through `build.ts`.
export { VERSION };

const ROOT = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const DIST = `${ROOT}/dist`;
const OUT = `${ROOT}/dist-npm`;
const STAGE = `${OUT}/package`;
export const TARBALL = tarballName();

// Exactly what a consumer gets. Anything not listed here is not in the tarball, which is
// the point of listing it rather than globbing `dist/`: the demo's `main.js` and
// `index.html` live there too and have no business in a package.
const FILES: readonly { from: string; to: string }[] = [
  { from: `${DIST}/voxler.js`, to: `${STAGE}/voxler.js` },
  { from: `${DIST}/workers/voxel.worker.js`, to: `${STAGE}/workers/voxel.worker.js` },
  { from: `${ROOT}/LICENSE`, to: `${STAGE}/LICENSE` },
];

function packageJson(): string {
  return JSON.stringify(
    {
      name: "voxler",
      version: VERSION,
      description:
        "A WebGPU voxel engine. Worlds are WGSL functions evaluated on the GPU rather than stored voxel data.",
      license: "Apache-2.0",
      author: "Erik Wistrand",
      homepage: "https://wistrand.github.io/voxler/",
      repository: { type: "git", url: "git+https://github.com/wistrand/voxler.git" },
      keywords: ["webgpu", "voxel", "renderer", "wgsl", "sdf", "engine"],
      type: "module",
      // `main` and `module` for tooling that predates `exports`; `exports` for everything
      // since. The worker is reachable by path so a host that wants to build its own
      // factory can point at it.
      main: "./voxler.js",
      module: "./voxler.js",
      exports: {
        ".": "./voxler.js",
        "./workers/voxel.worker.js": "./workers/voxel.worker.js",
        "./package.json": "./package.json",
      },
      files: ["voxler.js", "workers/", "README.md", "LICENSE"],
      // The bundle runs in a browser with WebGPU. The engine number is for the tooling
      // that reads it; nothing here runs under Node.
      engines: { node: ">=18" },
      // Deliberately not `false`. The bundle applies side effects at module scope, and a
      // bundler told there are none is free to drop them.
      sideEffects: true,
    },
    null,
    2,
  ) + "\n";
}

function readme(): string {
  return `# voxler

A WebGPU voxel engine for the browser. A world is generated on the GPU from a WGSL
function rather than stored as voxel data, so there is no level to load.

- Demo and documentation: https://wistrand.github.io/voxler/
- Get started, with worlds you can read and run: https://wistrand.github.io/voxler/start.html
- Source: https://github.com/wistrand/voxler

## Install

Not on the npm registry. Install the tarball over HTTPS:

\`\`\`
npm install https://wistrand.github.io/voxler/${TARBALL}
\`\`\`

Pin the version in the URL. npm caches a tarball by its URL, so a moving filename is a
moving dependency.

## Use

\`\`\`js
import { Voxler } from "voxler";

const voxler = await Voxler.create(canvas, { world: { code: myWorldWgsl } });
voxler.start();
\`\`\`

\`myWorldWgsl\` is WGSL defining \`WORLD_LIPSCHITZ\`, \`world_sdf\` and \`world_material\`.
The get-started page above has two complete ones.

## Editing a running world

A CSG brush is a bounded primitive folded into the world's field on the GPU, so it appears
in the meshed near field, the ray-marched far field and the preview alike:

\`\`\`js
import { BLEND_SUBTRACT } from "voxler";

const id = voxler.edit.csgSphere(120, 64, -40, 12);            // a sphere of stone
voxler.edit.csgSphere(120, 58, -40, 9, 0, BLEND_SUBTRACT);     // a cave carved out of it
voxler.brushes.remove(id);
\`\`\`

Voxel edits write block ids instead (\`setVoxel\`, \`fillBox\`, \`fillSphere\`), through a
journal. Both survive a chunk being evicted and regenerated, because a chunk is the field
stage followed by a replay of that journal. Neither survives a reload: nothing is written
to disk, and saving \`voxler.brushes.records\` and \`.ops\` is left to you.

## Requirements

WebGPU, so Chrome or Edge on desktop, Safari 26 on macOS 26 or iOS 26, or Firefox on
Windows or Apple Silicon. There is no WebGL fallback.

Cross-origin isolation (\`COOP\`/\`COEP\`) is optional but worth having: with it the chunk
arena is a \`SharedArrayBuffer\` and mesh jobs read it in place, without it they copy.

## Workers

\`voxler.js\` loads \`workers/voxel.worker.js\` from beside itself, written as
\`new Worker(new URL("./workers/voxel.worker.js", import.meta.url), { type: "module" })\`
so a bundler that recognises the pattern emits the worker as an asset. If yours does not,
supply the worker yourself:

\`\`\`js
await Voxler.create(canvas, {
  world,
  workers: { factory: (i) => new Worker(myWorkerUrl, { type: "module", name: \`voxel-\${i}\` }) },
});
\`\`\`

## No TypeScript declarations yet

This build ships no \`.d.ts\`. TypeScript callers get \`any\` from the import until that is
sorted out; the API is documented on the get-started page.

## Licence

Apache-2.0. Copyright 2026 Erik Wistrand.
`;
}

async function copy(from: string, to: string): Promise<void> {
  await Deno.mkdir(to.slice(0, to.lastIndexOf("/")), { recursive: true });
  await Deno.copyFile(from, to);
}

// `tar` rather than a tar written here: the format has enough corners (checksums, the
// ustar prefix split, modes) that a subtle mistake shows up as an install failure on
// someone else's machine and nowhere else. Staged under a directory literally called
// `package`, because that is the prefix npm requires and archiving the directory gives it
// without any flag that differs between GNU and BSD tar.
async function tarball(): Promise<void> {
  const cmd = new Deno.Command("tar", {
    args: ["-czf", TARBALL, "package"],
    cwd: OUT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`tar exited ${code}`);
}

export async function pack(): Promise<boolean> {
  if (!(await buildRelease())) {
    console.error("build failed; not packing");
    return false;
  }
  try {
    await Deno.remove(OUT, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.mkdir(STAGE, { recursive: true });
  for (const { from, to } of FILES) await copy(from, to);
  await Deno.writeTextFile(`${STAGE}/package.json`, packageJson());
  await Deno.writeTextFile(`${STAGE}/README.md`, readme());
  await tarball();

  const size = (await Deno.stat(`${OUT}/${TARBALL}`)).size;
  console.log(`\ndist-npm/${TARBALL}  ${(size / 1024).toFixed(0)} KiB`);
  console.log(`  npm install https://wistrand.github.io/voxler/${TARBALL}`);
  return true;
}

if (import.meta.main) {
  if (!(await pack())) Deno.exit(1);
}
