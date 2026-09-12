import {
  codeSign,
  codeSource,
  INVERSE,
  INVERSE_CODES,
  invertCode,
  ORIENTATION_CODES,
  ORIENTATION_COUNT,
  rotate,
  rotateBounds,
} from "./orientation.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// The 3x3 matrix a code stands for: m[r][a].
function matrixOf(code: number): number[][] {
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) m[r][codeSource(code, r)] = codeSign(code, r);
  return m;
}

function determinant(m: number[][]): number {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

Deno.test("the 24 orientations are distinct rotations, identity first", () => {
  const seen = new Set<number>();
  for (let o = 0; o < ORIENTATION_COUNT; o++) {
    const code = ORIENTATION_CODES[o];
    assert(!seen.has(code), `orientation ${o} repeats code ${code}`);
    seen.add(code);
    const m = matrixOf(code);
    assert(determinant(m) === 1, `orientation ${o} has determinant ${determinant(m)}, not a rotation`);
    // Exactly one nonzero per row and per column, magnitude 1.
    for (let r = 0; r < 3; r++) {
      let row = 0;
      let col = 0;
      for (let a = 0; a < 3; a++) {
        row += Math.abs(m[r][a]);
        col += Math.abs(m[a][r]);
      }
      assert(row === 1 && col === 1, `orientation ${o} is not a signed permutation`);
    }
  }
  assert(seen.size === ORIENTATION_COUNT, `${seen.size} distinct codes`);
  const out = new Float64Array(3);
  rotate(ORIENTATION_CODES[0], 1, 2, 3, out);
  assert(out[0] === 1 && out[1] === 2 && out[2] === 3, `orientation 0 is ${out}, not the identity`);
});

Deno.test("every orientation's inverse is one of the 24 and undoes it", () => {
  const v = new Float64Array(3);
  const w = new Float64Array(3);
  for (let o = 0; o < ORIENTATION_COUNT; o++) {
    assert(INVERSE[o] < ORIENTATION_COUNT, `inverse of ${o} is ${INVERSE[o]}`);
    assert(
      ORIENTATION_CODES[INVERSE[o]] === INVERSE_CODES[o],
      `orientation ${o}: inverse code does not match the inverse index`,
    );
    assert(INVERSE[INVERSE[o]] === o, `inverse of the inverse of ${o} is ${INVERSE[INVERSE[o]]}`);
    for (const [x, y, z] of [[1, 2, 3], [-4, 5, -6], [7, -8, 9]]) {
      rotate(ORIENTATION_CODES[o], x, y, z, v);
      rotate(INVERSE_CODES[o], v[0], v[1], v[2], w);
      assert(w[0] === x && w[1] === y && w[2] === z, `orientation ${o} does not round-trip (${x}, ${y}, ${z})`);
    }
  }
});

Deno.test("rotate matches a matrix multiply, on every orientation", () => {
  const out = new Float64Array(3);
  for (let o = 0; o < ORIENTATION_COUNT; o++) {
    const m = matrixOf(ORIENTATION_CODES[o]);
    for (let t = 0; t < 8; t++) {
      const v = [t * 3 - 7, t * t - 5, 11 - t * 2];
      rotate(ORIENTATION_CODES[o], v[0], v[1], v[2], out);
      for (let r = 0; r < 3; r++) {
        const want = m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2];
        assert(out[r] === want, `orientation ${o}, axis ${r}: ${out[r]} want ${want}`);
      }
    }
  }
});

Deno.test("rotateBounds equals the box around the eight rotated corners", () => {
  const min = [-3, -1, -7];
  const max = [2, 5, 4];
  const outMin = new Float64Array(3);
  const outMax = new Float64Array(3);
  const corner = new Float64Array(3);
  for (let o = 0; o < ORIENTATION_COUNT; o++) {
    const code = ORIENTATION_CODES[o];
    rotateBounds(code, min, max, outMin, outMax);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = [c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]];
      rotate(code, p[0], p[1], p[2], corner);
      for (let r = 0; r < 3; r++) {
        lo[r] = Math.min(lo[r], corner[r]);
        hi[r] = Math.max(hi[r], corner[r]);
      }
    }
    for (let r = 0; r < 3; r++) {
      assert(outMin[r] === lo[r] && outMax[r] === hi[r], `orientation ${o}, axis ${r}: box does not match corners`);
    }
  }
});

Deno.test("invertCode matches the table, for every orientation", () => {
  for (let o = 0; o < ORIENTATION_COUNT; o++) {
    const got = invertCode(ORIENTATION_CODES[o]);
    assert(got === INVERSE_CODES[o], `orientation ${o}: invertCode gave ${got}, table has ${INVERSE_CODES[o]}`);
    assert(invertCode(got) === ORIENTATION_CODES[o], `orientation ${o}: inverting twice does not return`);
  }
});
