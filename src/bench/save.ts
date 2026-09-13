// Saves a benchmark result through the dev server (serve.ts --dev, POST
// /__bench/results), which writes bench/results/<scene>.<UTC timestamp>.<browser>.json.
// Returns the saved path, or a short "not saved" status.
//
// Only the dev build can do it. `serve.ts --dev` is the one server that answers that
// route, and the dev build is the only one it serves, so anywhere else the POST could
// only fail. Rather than let it fail against a stranger's host, build.ts defines
// `__BENCH_SAVE__` false for a release build and the fetch below is compiled out: the
// published bundle contains no POST at all. A run on the published site still measures
// and still reports; the JSON just stays in the console, which is the only place it
// could usefully go.

// esbuild replaces this identifier at build time. Running under Deno there is no define,
// so `typeof` keeps it from throwing and saving stays on.
declare const __BENCH_SAVE__: boolean;
const CAN_SAVE = typeof __BENCH_SAVE__ === "undefined" ? true : __BENCH_SAVE__;

export async function saveBenchResult(result: { scene: string; browser: string }): Promise<string> {
  if (!CAN_SAVE) return "not saved (this build has no dev server; the JSON is in the console)";
  // Inside the branch, so a release build drops the route with it: the published bundle
  // does not contain the string, let alone a request to it.
  const route = "/__bench/results";
  try {
    const res = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
    return res.ok ? (await res.json()).path : `not saved (HTTP ${res.status}; JSON is in the console)`;
  } catch (err) {
    return `not saved (${err instanceof Error ? err.message : String(err)}; JSON is in the console)`;
  }
}
