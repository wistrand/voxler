import { BLOCK_LIGHT, BLOCKS, LIGHT_MAX } from "../world/blocks.ts";
import { ChunkData } from "../world/chunk.ts";
import { voxelIndex } from "../world/coords.ts";
import { faceLight, hasLight, LIGHT_REACH, LightFill, type LightSource } from "./light.ts";
import { decodeQuad, encodeWord0, encodeWord1, FACE_NEG_Y, FACE_POS_Y, newQuad } from "./quad.ts";
import { BinaryMesher } from "./binary.ts";
import { newPlanes } from "./planes.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

function assertEquals(got: number | boolean, want: number | boolean, what = ""): void {
  if (got !== want) throw new Error(`${what ? what + ": " : ""}got ${got}, want ${want}`);
}

const GLOW = BLOCKS.find((b) => b.light)!.id;
const STONE = 1;

// A chunk of air with the given voxels set.
function chunkWith(set: (c: ChunkData) => void): ChunkData {
  const ids = new Uint16Array(32768);
  ids[0] = 1; // force a palette so set() has somewhere to write
  const chunk = ChunkData.fromDense(ids);
  chunk.set(0, 0);
  set(chunk);
  return chunk;
}

const AIR = ChunkData.uniform(0);

function fillOne(chunk: ChunkData): LightFill {
  const fill = new LightFill();
  const sources: LightSource[] = [{ dx: 0, dy: 0, dz: 0, chunk }];
  fill.fill(sources, 1, (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x > 31 || y > 31 || z > 31) return 0;
    return chunk.get(voxelIndex(x, y, z));
  });
  return fill;
}

Deno.test("a light's level falls by one per voxel and reaches its whole radius", () => {
  const chunk = chunkWith((c) => c.set(voxelIndex(16, 16, 16), GLOW));
  const fill = fillOne(chunk);
  const at = (x: number, y: number, z: number) =>
    fill.levels[x + LIGHT_REACH + (z + LIGHT_REACH) * (32 + 2 * LIGHT_REACH) +
      (y + LIGHT_REACH) * (32 + 2 * LIGHT_REACH) ** 2];
  const level = BLOCK_LIGHT[GLOW];
  assertEquals(at(16, 16, 16), level);
  assertEquals(at(17, 16, 16), level - 1);
  assertEquals(at(16 + level - 1, 16, 16), 1);
  assertEquals(at(16 + level, 16, 16), 0); // past its reach
  // Diagonals fall by the Manhattan distance: the fill walks the six face steps.
  assertEquals(at(18, 17, 16), level - 3);
});

Deno.test("light reaches out of the chunk it is in, as far as the padding goes", () => {
  const chunk = chunkWith((c) => c.set(voxelIndex(0, 0, 0), GLOW));
  const fill = fillOne(chunk);
  const pad = 32 + 2 * LIGHT_REACH;
  const at = (x: number, y: number, z: number) =>
    fill.levels[x + LIGHT_REACH + (z + LIGHT_REACH) * pad + (y + LIGHT_REACH) * pad * pad];
  assertEquals(at(-1, 0, 0), BLOCK_LIGHT[GLOW] - 1);
  assertEquals(at(0, -2, 0), BLOCK_LIGHT[GLOW] - 2);
});

Deno.test("opaque blocks stop the light but still have a lit face", () => {
  // A glowing block under a stone slab at y = 17: the cell above the slab is dark, the
  // cell under it (which is what the slab's -Y face reads) is not.
  const chunk = chunkWith((c) => {
    c.set(voxelIndex(16, 16, 16), GLOW);
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) c.set(voxelIndex(x, 17, z), STONE);
  });
  const fill = fillOne(chunk);
  const pad = 32 + 2 * LIGHT_REACH;
  const at = (x: number, y: number, z: number) =>
    fill.levels[x + LIGHT_REACH + (z + LIGHT_REACH) * pad + (y + LIGHT_REACH) * pad * pad];
  assertEquals(at(16, 18, 16), 0);
  assert(at(16, 16, 16) > 0, "the light itself should be lit");
  // The slab's bottom face reads the cell below it, which the light did reach.
  const packed = faceLight(fill.levels, 16, 17, 16, FACE_NEG_Y);
  assert((packed & 15) > 0, "the lit underside should not be dark");
  // Its top face reads the cell above, which the slab shadowed.
  assertEquals(faceLight(fill.levels, 16, 17, 16, FACE_POS_Y), 0);
});

Deno.test("a chunk with no glowing block in its palette needs no fill", () => {
  assertEquals(hasLight(null), false);
  assertEquals(hasLight(AIR), false);
  assertEquals(hasLight(ChunkData.uniform(STONE)), false);
  assertEquals(hasLight(chunkWith((c) => c.set(voxelIndex(1, 2, 3), GLOW))), true);
});

Deno.test("packed light survives the quad round trip", () => {
  const q = newQuad();
  // base 11, corner offsets 0, 1, 2, 3.
  const light = 11 | (0 << 4) | (1 << 6) | (2 << 8) | (3 << 10);
  decodeQuad(encodeWord0(1, 2, 3, 4, 5, FACE_POS_Y, light), encodeWord1(GLOW, 0xa5, light), q);
  assertEquals(q.light, light);
  assertEquals(q.id, GLOW);
  assertEquals(q.ao, 0xa5);
  assertEquals(q.x, 1);
  assertEquals(q.h, 5);
  // A quad with no light packs as zero in both words' light bits.
  decodeQuad(encodeWord0(1, 2, 3, 4, 5, FACE_POS_Y), encodeWord1(GLOW, 0), q);
  assertEquals(q.light, 0);
});

Deno.test("no block lights beyond what the four bits of base can carry", () => {
  for (const b of BLOCKS) {
    if (!b.light) continue;
    assert(b.light <= LIGHT_MAX, `${b.name} lights at ${b.light}, past LIGHT_MAX`);
  }
});

Deno.test("the mesher bakes the light into the quads around a glowing block", () => {
  // A floor of stone with one glowing block standing on it.
  const ids = new Uint16Array(32768);
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) ids[voxelIndex(x, 8, z)] = STONE;
  ids[voxelIndex(16, 9, 16)] = GLOW;
  const chunk = ChunkData.fromDense(ids);
  const fill = fillOne(chunk);
  const mesher = new BinaryMesher();
  const mesh = mesher.mesh(chunk, newPlanes(), { light: fill.levels });
  const q = newQuad();
  let underGlow = -1;
  let farCorner = -1;
  for (let i = 0; i < mesh.count; i++) {
    decodeQuad(mesh.quads[i * 2], mesh.quads[i * 2 + 1], q);
    if (q.face !== FACE_POS_Y || q.id !== STONE) continue;
    // The floor's top faces: 1x1 near the light (light joins the merge key), merged
    // into big runs out where every corner is dark.
    if (q.x === 17 && q.z === 16 && q.y === 8) underGlow = q.light & 15;
    if (q.x === 0 && q.z === 0 && q.y === 8) farCorner = q.light & 15;
  }
  assert(underGlow > 0, `the floor beside the light should be lit, got ${underGlow}`);
  assertEquals(farCorner, 0, "the far corner of the floor is out of the light's reach");
  // The glowing block's own faces stay unlit: its emission already draws it.
  for (let i = 0; i < mesh.count; i++) {
    decodeQuad(mesh.quads[i * 2], mesh.quads[i * 2 + 1], q);
    if (q.id === GLOW) assertEquals(q.light, 0, "a light's own face carries no baked light");
  }
});
