// Bundles the browser app into dist/.
// `deno task build` runs a release build; serve.ts imports watch() for `deno task dev`.

import * as esbuild from "esbuild";

const ROOT = import.meta.dirname ?? Deno.cwd();
const OUT_DIR = "dist";
const WORKER_DIR = "src/workers";

// Every src/workers/<name>.worker.ts becomes dist/workers/<name>.worker.js.
// Main-thread code must reference the output path:
//   new Worker(new URL("./workers/<name>.worker.js", import.meta.url), { type: "module" })
// Watch mode picks up new worker files only after a restart.
async function workerEntries(): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  try {
    for await (const entry of Deno.readDir(`${ROOT}/${WORKER_DIR}`)) {
      if (entry.isFile && entry.name.endsWith(".worker.ts")) {
        const name = entry.name.slice(0, -".ts".length);
        entries[`workers/${name}`] = `${WORKER_DIR}/${entry.name}`;
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return entries;
}

// Shaders are imported as `import src from "./x.wgsl" with { type: "text" }`, which
// `deno check` accepts. esbuild 0.25 rejects the "text" import attribute on its own,
// so this plugin loads .wgsl files before that check runs.
const wgslText: esbuild.Plugin = {
  name: "wgsl-text",
  setup(build) {
    build.onLoad({ filter: /\.wgsl$/ }, async (args) => ({
      contents: await Deno.readTextFile(args.path),
      loader: "text",
      watchFiles: [args.path],
    }));
  },
};

async function options(dev: boolean): Promise<esbuild.BuildOptions> {
  return {
    absWorkingDir: ROOT,
    entryPoints: {
      index: "index.html",
      main: "src/main.ts",
      // The engine on its own, with the WGSL inlined: what a page that is not this demo
      // imports (`import { Voxler } from "./voxler.js"`), and what the published package
      // will be built from (plan-packaging.md). Its own entry rather than something dug
      // out of `main.js`, so that what a host gets is a bundle nobody's demo is in.
      voxler: "src/voxler.ts",
      ...(await workerEntries()),
    },
    outdir: OUT_DIR,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    loader: { ".html": "copy" },
    plugins: [wgslText],
    // Saving a benchmark result POSTs to the dev server, and only `serve.ts --dev`
    // answers that route. A build that is not the dev build is a build nobody can save
    // from, so the save is compiled out rather than left to fail: the released bundle
    // contains no POST at all (src/bench/save.ts). Checked by grepping dist/main.js for
    // the route.
    define: { __BENCH_SAVE__: dev ? "true" : "false" },
    sourcemap: dev ? "linked" : false,
    minify: !dev,
    logLevel: "info",
  };
}

// Release build into a clean dist/. Returns false on any error or warning.
export async function buildRelease(): Promise<boolean> {
  try {
    await Deno.remove(`${ROOT}/${OUT_DIR}`, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  try {
    const result = await esbuild.build(await options(false));
    return result.warnings.length === 0;
  } catch {
    return false; // esbuild has already printed the errors
  }
}

// Dev build that rebuilds on change. Runs until the process exits.
export async function watch(): Promise<void> {
  const ctx = await esbuild.context(await options(true));
  await ctx.watch();
}

if (import.meta.main) {
  const ok = await buildRelease();
  await esbuild.stop();
  if (!ok) {
    console.error("build failed: see errors or warnings above");
    Deno.exit(1);
  }
}
