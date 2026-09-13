// The brick and clipmap layout has one owner (design-formats.md "Brick and clipmap")
// and three hand-written WGSL readers: the march, the shadow rays and the GPU builder.
// Nothing in the type system connects them. `BRICK_WORDS` is a number in TypeScript and
// the literal `144u` in each shader, and widening the layout while missing one of them
// is silent: the same shape of mistake put the sky through the terrain when the block
// table grew and `far-build.wgsl` kept the old stride
// (gotchas.md "A table with one owner and four hand-written readers").
//
// So this reads the shaders and checks the numbers.

import {
  BRICK_CELLS,
  BRICK_COLOR_WORDS,
  BRICK_OCCUPANCY_WORDS,
  BRICK_WORDS,
  ENTRY_SOLID,
} from "./reduce.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// Every shader that decodes a brick, and what each of its constants has to equal. A
// shader that does not declare one of these is not checked for it; a shader that does
// must agree.
const READERS: readonly { path: string; constants: Readonly<Record<string, number>> }[] = [
  {
    path: "src/far/far.wgsl",
    constants: {
      BRICK_CELLS,
      BRICK_WORDS,
      OCCUPANCY_WORDS: BRICK_OCCUPANCY_WORDS,
      ENTRY_SOLID,
    },
  },
  {
    path: "src/far/shadow.wgsl",
    constants: {
      SH_BRICK_CELLS: BRICK_CELLS,
      SH_BRICK_WORDS: BRICK_WORDS,
      SH_ENTRY_SOLID: ENTRY_SOLID,
    },
  },
  {
    path: "src/far/far-build.wgsl",
    constants: {
      BRICK_CELLS,
      BRICK_WORDS,
      OCCUPANCY_WORDS: BRICK_OCCUPANCY_WORDS,
      COLOR_WORDS: BRICK_COLOR_WORDS,
      ENTRY_SOLID,
    },
  },
];

// `const NAME: u32 = 144u;` or `= 0x80000000u;`, in either integer type.
function wgslConst(src: string, name: string): number | null {
  const m = src.match(new RegExp(`const\\s+${name}\\s*:\\s*[iu]32\\s*=\\s*(0[xX][0-9a-fA-F]+|\\d+)u?\\s*;`));
  return m === null ? null : Number(m[1]);
}

Deno.test("every shader that decodes a brick agrees with the brick layout", () => {
  assert(BRICK_WORDS === BRICK_OCCUPANCY_WORDS + BRICK_COLOR_WORDS, "the stride is its own parts");
  let checked = 0;
  for (const reader of READERS) {
    const src = Deno.readTextFileSync(reader.path);
    for (const [name, want] of Object.entries(reader.constants)) {
      const got = wgslConst(src, name);
      assert(got !== null, `${reader.path} no longer declares ${name}; this test is stale`);
      assert(got === want, `${reader.path} has ${name} = ${got}, but the layout says ${want}`);
      checked++;
    }
  }
  assert(checked === 12, `expected to check 12 constants, checked ${checked}`);
});
