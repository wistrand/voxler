// The probe buffers are written in WGSL and read in TypeScript, which is a binary format
// with two owners unless something holds them together (CLAUDE.md "Binary formats have
// one owner"). This reads the shaders and checks that every word the decoder reads is a
// word the shader writes, and that the sizes agree.

import {
  PROBE_WORDS,
  RAY_WORD,
  WORLD_PROBE_HEADER,
  WORLD_PROBE_SAMPLES,
  WORLD_PROBE_WORDS,
} from "./probe.ts";

const far = Deno.readTextFileSync("src/far/far.wgsl");
const build = Deno.readTextFileSync("src/far/far-build.wgsl");

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function constant(source: string, name: string): number {
  const m = source.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)u?;`));
  assert(m !== null, `${name} is not declared in the shader any more`);
  return Number(m![1]);
}

Deno.test("the ray probe's size is the same on both sides", () => {
  assert(
    constant(far, "PROBE_WORDS") === PROBE_WORDS,
    `far.wgsl has PROBE_WORDS ${constant(far, "PROBE_WORDS")}, probe.ts has ${PROBE_WORDS}`,
  );
});

Deno.test("every word the ray decoder reads is one the shader writes", () => {
  const written = new Set<number>();
  for (const m of far.matchAll(/probe\[(\d+)\]\s*=/g)) written.add(Number(m[1]));
  assert(written.size > 0, "probe_far no longer writes any words; this test is stale");
  for (const [name, word] of Object.entries(RAY_WORD)) {
    if (name === "ndcX" || name === "ndcY") continue; // the CPU writes those
    assert(written.has(word), `the decoder reads word ${word} (${name}) and the shader never writes it`);
    assert(word < PROBE_WORDS, `word ${word} (${name}) is past the buffer`);
  }
});

Deno.test("the world probe's size and header are the same on both sides", () => {
  assert(constant(build, "WORLD_PROBE_SAMPLES") === WORLD_PROBE_SAMPLES, "sample count differs");
  assert(constant(build, "WORLD_PROBE_HEADER") === WORLD_PROBE_HEADER, "header size differs");
  assert(
    WORLD_PROBE_WORDS === WORLD_PROBE_HEADER + WORLD_PROBE_SAMPLES * 4,
    "the TypeScript size is not header plus four words a sample",
  );
  // The shader writes four words per sample from the header on: same arithmetic.
  assert(
    /WORLD_PROBE_HEADER \+ sample \* 4u/.test(build),
    "probe_world no longer strides four words a sample; the decoder still does",
  );
  assert(
    /@workgroup_size\(WORLD_PROBE_THREADS\)/.test(build),
    "probe_world is no longer one thread a sample and footprint",
  );
});
