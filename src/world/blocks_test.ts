import { SKIES } from "../render/sky.ts";
import {
  BLOCK_TABLE_FLOATS,
  BLOCK_TABLE_STRIDE,
  BLOCKS,
  blockColorTable,
  MAX_BLOCK_TYPES,
} from "./blocks.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

Deno.test("the block table carries color and coverage, then emission and sway", () => {
  const table = new Float32Array(BLOCK_TABLE_FLOATS);
  blockColorTable(table, 0);
  for (const b of BLOCKS) {
    const i = b.id * BLOCK_TABLE_STRIDE;
    for (let c = 0; c < 3; c++) {
      assert(
        Math.abs(table[i + c] - b.color[c]) < 1e-6,
        `${b.name} color ${c}: ${table[i + c]} against ${b.color[c]}`,
      );
    }
    const coverage = b.opaque ? 1 : b.alpha ?? 1;
    assert(
      Math.abs(table[i + 3] - coverage) < 1e-6,
      `${b.name} coverage ${table[i + 3]}, expected ${coverage}`,
    );
    const e = b.emission ?? [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      assert(
        Math.abs(table[i + 4 + c] - e[c]) < 1e-6,
        `${b.name} emission ${c}: ${table[i + 4 + c]} against ${e[c]}`,
      );
    }
    const sway = b.sway ?? 0;
    assert(Math.abs(table[i + 7] - sway) < 1e-6, `${b.name} sway ${table[i + 7]}, expected ${sway}`);
  }
});

Deno.test("unregistered ids read as air, and nothing is written past the table", () => {
  const table = new Float32Array(BLOCK_TABLE_FLOATS + 4).fill(-1);
  blockColorTable(table, 0);
  const ids = new Set(BLOCKS.map((b) => b.id));
  for (let id = 0; id < MAX_BLOCK_TYPES; id++) {
    if (ids.has(id)) continue;
    for (let c = 0; c < BLOCK_TABLE_STRIDE; c++) {
      assert(table[id * BLOCK_TABLE_STRIDE + c] === 0, `id ${id} float ${c} is not zero`);
    }
  }
  for (let c = 0; c < 4; c++) {
    assert(table[BLOCK_TABLE_FLOATS + c] === -1, "the table wrote past its own floats");
  }
});

Deno.test("emission never pushes a lit surface past what the canvas can show", () => {
  // There is no tonemapping: emission plus the lit albedo has to stay under 1 or the
  // block clips to white and loses its color (plan-living-world phase 1).
  // The brightest sky any world uses, on an up-facing surface with no direct light.
  const AMBIENT = Math.max(...Object.values(SKIES).map((s) => s.ambient + s.ambientSky));
  for (const b of BLOCKS) {
    if (b.emission === undefined) continue;
    for (let c = 0; c < 3; c++) {
      const lit = b.color[c] * (AMBIENT + b.emission[c]);
      assert(lit <= 1.0, `${b.name} channel ${c} reaches ${lit.toFixed(2)} in ambient light alone`);
    }
  }
});
