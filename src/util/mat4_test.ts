import * as mat4 from "./mat4.ts";

function assertClose(actual: number, expected: number, eps: number, what: string): void {
  if (Math.abs(actual - expected) > eps) throw new Error(`${what}: ${actual} != ${expected}`);
}

function assertIdentity(m: mat4.Mat4, eps: number): void {
  for (let i = 0; i < 16; i++) assertClose(m[i], i % 5 === 0 ? 1 : 0, eps, `element ${i}`);
}

Deno.test("multiply by identity returns the input", () => {
  const a = mat4.create();
  for (let i = 0; i < 16; i++) a[i] = i * 0.5 - 3;
  const out = mat4.multiply(mat4.create(), a, mat4.create());
  for (let i = 0; i < 16; i++) assertClose(out[i], a[i], 0, `element ${i}`);
});

Deno.test("multiply handles out aliasing a or b", () => {
  const a = mat4.create();
  const b = mat4.create();
  for (let i = 0; i < 16; i++) {
    a[i] = Math.sin(i + 1);
    b[i] = Math.cos(i * 2 + 1);
  }
  const expected = mat4.multiply(mat4.create(), a, b);
  const a2 = a.slice();
  mat4.multiply(a2, a2, b);
  const b2 = b.slice();
  mat4.multiply(b2, a, b2);
  for (let i = 0; i < 16; i++) {
    assertClose(a2[i], expected[i], 1e-12, `alias a, element ${i}`);
    assertClose(b2[i], expected[i], 1e-12, `alias b, element ${i}`);
  }
});

Deno.test("invert of a view-projection matrix gives identity when multiplied back", () => {
  const basis = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, -1]);
  const view = mat4.view(mat4.create(), [3, 4, 5], basis);
  const proj = mat4.perspectiveReversedZ(mat4.create(), 1.2, 16 / 9, 0.05);
  const viewProj = mat4.multiply(mat4.create(), proj, view);
  const inv = mat4.create();
  if (!mat4.invert(inv, viewProj)) throw new Error("singular");
  assertIdentity(mat4.multiply(mat4.create(), viewProj, inv), 1e-9);
});

Deno.test("invert reports a singular matrix", () => {
  const zero = new Float64Array(16);
  if (mat4.invert(mat4.create(), zero)) throw new Error("expected false");
});

Deno.test("reversed-Z maps the near plane to depth 1 and far points toward 0", () => {
  const near = 0.05;
  const proj = mat4.perspectiveReversedZ(mat4.create(), 1.2, 1, near);
  const v = new Float64Array(4);
  mat4.transform(v, proj, 0, 0, -near, 1);
  assertClose(v[2] / v[3], 1, 1e-12, "near depth");
  mat4.transform(v, proj, 0, 0, -1000, 1);
  const far = v[2] / v[3];
  if (!(far > 0 && far < 1e-4)) throw new Error(`far depth ${far}`);
  mat4.transform(v, proj, 0, 0, -10, 1);
  if (!(v[2] / v[3] > far)) throw new Error("depth must decrease with distance");
});

Deno.test("view matrix moves the eye to the origin and forward to -Z", () => {
  const basis = new Float64Array([0, 0, -1, 0, 1, 0, 1, 0, 0]); // looking along +X
  const view = mat4.view(mat4.create(), [10, 2, -7], basis);
  const v = new Float64Array(4);
  mat4.transform(v, view, 10, 2, -7, 1);
  assertClose(v[0], 0, 1e-12, "eye x");
  assertClose(v[1], 0, 1e-12, "eye y");
  assertClose(v[2], 0, 1e-12, "eye z");
  mat4.transform(v, view, 15, 2, -7, 1); // 5 units ahead
  assertClose(v[2], -5, 1e-12, "ahead z");
});
