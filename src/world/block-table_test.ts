// The block table has one owner (design-formats.md "Block table") and four readers in
// WGSL, and nothing in the type system connects them: the stride is a number in
// TypeScript and a multiplier written out by hand in each shader. Widening the table and
// missing one reader is silent, and what it looks like is not a compile error but a world
// with most of its terrain gone, because the reader that was missed is the one that
// decides whether a far-field cell is solid
// (gotchas.md "A table with one owner and four hand-written readers").
//
// So this reads the shaders and checks the arithmetic.

import { BLOCK_TABLE_STRIDE, MAX_BLOCK_TYPES } from "./blocks.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// Every shader that indexes the block table, and the name it gives the array.
const READERS = [
  { path: "src/render/near.wgsl", array: "block_colors" },
  { path: "src/far/far.wgsl", array: "block_colors.color" },
  { path: "src/far/far-build.wgsl", array: "far_colors.color" },
  { path: "src/sdf/preview.wgsl", array: "world.colors" },
] as const;

const VEC4S = BLOCK_TABLE_STRIDE / 4;

Deno.test("every shader indexes the block table by its stride", () => {
  assert(Number.isInteger(VEC4S), `stride ${BLOCK_TABLE_STRIDE} is not whole vec4fs`);
  for (const reader of READERS) {
    const src = Deno.readTextFileSync(reader.path);
    const name = reader.array.replace(/[.]/g, "\\.");
    // `<array>[<anything> * Nu` — the index into one block's entry.
    const uses = [...src.matchAll(new RegExp(`${name}\\[[^\\]]*?\\*\\s*(\\d+)u`, "g"))];
    assert(uses.length > 0, `${reader.path} does not index ${reader.array} at all`);
    for (const use of uses) {
      assert(
        Number(use[1]) === VEC4S,
        `${reader.path} indexes ${reader.array} by ${use[1]}, but the table is ${VEC4S} vec4f per block`,
      );
    }
  }
});

Deno.test("every shader declares the block table at its full size", () => {
  for (const reader of READERS) {
    const src = Deno.readTextFileSync(reader.path);
    // Only the three that declare a fixed-size uniform array; near.wgsl binds a storage
    // array with no length, which needs no check.
    const decl = src.match(/array<vec4f,\s*(\d+)>/);
    if (decl === null) continue;
    assert(
      Number(decl[1]) === MAX_BLOCK_TYPES * VEC4S,
      `${reader.path} declares array<vec4f, ${decl[1]}>, but the table is ${MAX_BLOCK_TYPES * VEC4S}`,
    );
  }
});
