import { hash32 } from "../util/random.ts";
import { BLOCK_OPAQUE } from "../world/blocks.ts";
import { ChunkData } from "../world/chunk.ts";
import { CHUNK_VOLUME } from "../world/coords.ts";
import { columnsFromRows, RowReader, transpose32 } from "./rows.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

Deno.test("transpose32 swaps bit j of row i with bit i of row j", () => {
  for (let seed = 0; seed < 20; seed++) {
    const a = new Uint32Array(32);
    for (let i = 0; i < 32; i++) a[i] = hash32(seed * 97 + i);
    const before = a.slice();
    transpose32(a);
    for (let i = 0; i < 32; i++) {
      for (let j = 0; j < 32; j++) {
        assert(((a[i] >>> j) & 1) === ((before[j] >>> i) & 1), `seed ${seed}: (${i}, ${j})`);
      }
    }
  }
});

// Chunks at every index width: n distinct ids, half of them opaque.
function chunkWithIds(n: number, seed: number): { chunk: ChunkData; ids: Uint16Array } {
  const ids = new Uint16Array(CHUNK_VOLUME);
  for (let i = 0; i < CHUNK_VOLUME; i++) ids[i] = (hash32(i * 31 + seed) % n) * 2 + (i % 2 === 0 ? 0 : 1);
  ids[0] = 0; // air present
  return { chunk: ChunkData.fromDense(ids), ids };
}

Deno.test("rows and single voxels match the chunk at every index width", () => {
  const reader = new RowReader();
  for (const n of [1, 2, 3, 8, 100, 1000]) {
    const { chunk, ids } = chunkWithIds(n, n);
    const width = chunk.bitsPerVoxel;
    reader.beginOpaque(chunk);
    for (let r = 0; r < 1024; r++) {
      const row = reader.row(r);
      for (let x = 0; x < 32; x++) {
        const want = BLOCK_OPAQUE[ids[r * 32 + x]];
        assert(((row >>> x) & 1) === want, `width ${width}: row ${r} bit ${x}`);
        assert(reader.voxel(r * 32 + x) === want, `width ${width}: voxel ${r * 32 + x}`);
      }
    }
    const id = ids[5];
    reader.beginId(chunk, id);
    for (let i = 0; i < CHUNK_VOLUME; i += 7) {
      assert(((reader.row(i >>> 5) >>> (i & 31)) & 1) === (ids[i] === id ? 1 : 0), `width ${width}: id row ${i}`);
    }
  }
  reader.beginOpaque(ChunkData.uniform(1));
  assert(reader.row(3) === -1 && reader.voxel(9) === 1, "uniform opaque");
  reader.beginOpaque(ChunkData.uniform(0));
  assert(reader.row(3) === 0 && reader.voxel(9) === 0, "uniform air");
});

Deno.test("columnsFromRows: Y and Z columns hold the same voxels as the X columns", () => {
  const cx = new Uint32Array(1024), cy = new Uint32Array(1024), cz = new Uint32Array(1024);
  for (let i = 0; i < 1024; i++) cx[i] = hash32(i + 5);
  columnsFromRows(cx, cy, cz);
  for (let y = 0; y < 32; y++) {
    for (let z = 0; z < 32; z++) {
      for (let x = 0; x < 32; x++) {
        const v = (cx[z + 32 * y] >>> x) & 1;
        assert(((cy[x + 32 * z] >>> y) & 1) === v, `y column at (${x}, ${y}, ${z})`);
        assert(((cz[x + 32 * y] >>> z) & 1) === v, `z column at (${x}, ${y}, ${z})`);
      }
    }
  }
});

Deno.test("the mesher matches the reference on 8- and 16-bit chunks", async () => {
  const { BinaryMesher } = await import("./binary.ts");
  const { coverage, diffCoverage } = await import("./coverage.ts");
  const { meshReference } = await import("./reference.ts");
  const { neighborSetups } = await import("./testchunks.ts");
  const mesher = new BinaryMesher();
  for (const n of [100, 1000]) {
    const { chunk, ids } = chunkWithIds(n, n + 1);
    // Mostly air so faces exist, with the many-id palette kept.
    const sparse = ids.map((id, i) => (hash32(i) % 3 === 0 ? id : 0));
    const c = ChunkData.fromDense(sparse);
    assert(c.bitsPerVoxel === chunk.bitsPerVoxel, `width ${c.bitsPerVoxel}`);
    for (const s of neighborSetups()) {
      const want = coverage(meshReference(sparse, s.planes)).map;
      const diff = diffCoverage(want, coverage(mesher.mesh(c, s.planes)).map);
      assert(diff === null, `${c.bitsPerVoxel} bits, ${s.name}: ${diff}`);
    }
  }
});

Deno.test("setPlane from packed rows matches per-voxel get() at every width and face", async () => {
  const { newPlanes, setPlane } = await import("./planes.ts");
  const { FACE_AXIS, FACE_SIGN, FACE_U, FACE_V } = await import("./quad.ts");
  const { voxelIndex } = await import("../world/coords.ts");
  const planes = newPlanes();
  for (const n of [1, 2, 8, 100, 1000]) {
    const { chunk } = chunkWithIds(n, n + 7);
    for (let face = 0; face < 6; face++) {
      setPlane(planes, face, chunk);
      const p = [0, 0, 0];
      p[FACE_AXIS[face]] = FACE_SIGN[face] > 0 ? 0 : 31;
      for (let v = 0; v < 32; v++) {
        for (let u = 0; u < 32; u++) {
          p[FACE_U[face]] = u;
          p[FACE_V[face]] = v;
          const want = BLOCK_OPAQUE[chunk.get(voxelIndex(p[0], p[1], p[2]))];
          assert(((planes[face * 32 + v] >>> u) & 1) === want, `width ${chunk.bitsPerVoxel}, face ${face} (${u}, ${v})`);
        }
      }
    }
  }
});
