// Chunk table lookups at the planned resident count (plan-voxel-data phase 2
// verify). Near field: 33 x 33 columns x 8 chunks tall is about 8700 chunks;
// benched at 16k and 64k resident. Run with `deno task bench`.

import { ChunkTable } from "./chunk-table.ts";
import { chunkKey } from "./keys.ts";

function filled(n: number): { table: ChunkTable; keys: Float64Array; misses: Float64Array } {
  const table = new ChunkTable(n);
  const keys = new Float64Array(n);
  const side = Math.ceil(Math.sqrt(n / 8));
  let i = 0;
  for (let y = 0; y < 8 && i < n; y++) {
    for (let z = 0; z < side && i < n; z++) {
      for (let x = 0; x < side && i < n; x++) {
        keys[i] = chunkKey(x - side / 2, y - 3, z - side / 2);
        table.set(keys[i], i);
        i++;
      }
    }
  }
  const misses = new Float64Array(n);
  for (let j = 0; j < n; j++) misses[j] = chunkKey(10_000 + j, 0, 0);
  return { table, keys, misses };
}

for (const n of [16_384, 65_536]) {
  const { table, keys, misses } = filled(n);
  Deno.bench(`get, hit, ${n} resident (x${n} per iteration)`, () => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += table.get(keys[i]);
    if (sum < 0) throw new Error("unreachable");
  });
  Deno.bench(`get, miss, ${n} resident (x${n} per iteration)`, () => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += table.get(misses[i]);
    if (sum > 0) throw new Error("unreachable");
  });
}
