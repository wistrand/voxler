import { fogHorizonVoxels, SKIES } from "./sky.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

Deno.test("the fog horizon is where a surface stops differing from the sky", () => {
  // exp(-dist * density) = 0.005 at the horizon, so a hit there is within half a percent
  // of what the sky pass already drew behind it.
  for (const sky of Object.values(SKIES)) {
    const d = fogHorizonVoxels(sky);
    const left = Math.exp(-d * sky.fogDensity);
    assert(Math.abs(left - 0.005) < 1e-6, `${sky.name}: ${left} of the surface left at ${d}`);
  }
});

Deno.test("clear air carries further than thick", () => {
  assert(
    fogHorizonVoxels(SKIES.desert) > fogHorizonVoxels(SKIES.day),
    "the desert is the clear one",
  );
  assert(
    fogHorizonVoxels(SKIES.day) > fogHorizonVoxels(SKIES.night),
    "the night wood is the thick one",
  );
});

Deno.test("no fog is no horizon", () => {
  assert(!Number.isFinite(fogHorizonVoxels({ ...SKIES.day, fogDensity: 0 })), "0 density");
  assert(!Number.isFinite(fogHorizonVoxels({ ...SKIES.day, fogDensity: -1 })), "nonsense density");
});
