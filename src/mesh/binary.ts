// Binary mesher on u32 occupancy columns (plan-meshing phases 2-6). Pure: runs in
// workers, tests, and benches.
//
// Columns: for each axis a, 1024 u32 indexed by the tangent coordinates (u, v) of
// the faces along a (index u + v*32, same (u, v) as the neighbor planes), bit i =
// set at position i along a. X columns are indexed by (z, y), Y by (x, z), Z by
// (x, y) (FACE_U/FACE_V in quad.ts).
//
// Culling, per source column c, occluder column o, and neighbor-plane bit nb:
//   +a faces: c & ~((o >>> 1) | (nb << 31))
//   -a faces: c & ~((o << 1) | nb)
// JS bit ops are int32; results are read through `>>> 0` or bit tricks that don't
// care about sign (gotchas.md "Bitwise ops are int32").
//
// Opaque pass: source and occluder are the opaque columns, nb the opacity planes.
// Translucent pass, once per translucent id t in the chunk (phase 6 rules): source
// is t's columns, occluder is opaque | t, nb is the opacity plane | (border id ==
// t). So opaque and same-id neighbors hide a translucent face, a different
// translucent id doesn't, and translucent voxels never hide opaque faces (they
// aren't in the opaque occluder). Translucent quads go to their own mesh.
//
// Emission: mesh() merges greedily (phase 3); `merge: false` emits one 1x1 quad
// per visible face (phase 2, kept for tests and benches).
//
// Greedy merge, per face direction: visible-face bits are transposed into slices
// (slice d = position along the axis; row v, bit u), then each slice is merged
// row by row: take the lowest set bit, extend the width along the run of set bits
// with the same block id, extend the height while the following rows contain the
// whole run with the same ids, clear, emit. Ids are compared per cell only when a
// pass can hold several ids (the opaque pass of a non-uniform chunk), and then as
// palette indices read from the packed words (palette ids are distinct, so equal
// index means equal id). The plan's "group faces by key first" is done inline by
// these checks instead; same result.
//
// Columns come straight from the packed indices (rows.ts, phase 7): X columns are
// the rows, Y and Z columns their 32 x 32 bit transposes. No dense expansion.
//
// Baked AO (phase 5, opaque pass only): given a padded shell (ao.ts), each visible
// face gets its AO byte during the transpose, and merging also requires equal AO
// bytes. Without a shell every AO byte is 0 (unoccluded).
//
// Baked block light (plan-living-world phase 4) works the same way from a padded level
// grid (light.ts), and joins the merge key beside AO: a quad is one light value, so a
// pool of light under a mushroom breaks the merge into steps. That is the cost of
// baking it, and why the job only fills the grid where a light is.

import { BLOCK_LIGHT, BLOCK_OPAQUE, BLOCK_TRANSLUCENT } from "../world/blocks.ts";
import type { ChunkData } from "../world/chunk.ts";
import { CHUNK_VOLUME } from "../world/coords.ts";
import { faceAo, PAD_VOLUME, padIndex } from "./ao.ts";
import { faceLight } from "./light.ts";
import { MeshBuilder } from "./builder.ts";
import { BORDER_IDS, PLANE_WORDS } from "./planes.ts";
import { columnsFromRows, RowReader } from "./rows.ts";
import { encodeWord0, encodeWord1, FACE_AXIS, FACE_COUNT, FACE_SIGN, type Mesh } from "./quad.ts";

const COLUMNS = 1024;

// Voxel-index strides (x 1, z 32, y 1024) for (axis position, u, v) per axis:
// X faces are (x; z, y), Y faces (y; x, z), Z faces (z; x, y).
const STRIDE_AXIS: readonly number[] = [1, 1024, 32];
const STRIDE_U: readonly number[] = [32, 1, 1];
const STRIDE_V: readonly number[] = [1024, 32, 1024];

export interface MeshOptions {
  // Greedy merge (default true); false emits 1x1 quads.
  merge?: boolean;
  // Padded AO shell (ao.ts); bakes AO into opaque quads. Its interior is ignored.
  // Must agree with the planes (shellFromPlanes).
  shell?: Uint8Array | null;
  // Neighbor border ids (planes.ts setBorder); needed only for chunks with
  // translucent voxels. null reads every neighbor voxel as a different id.
  borders?: Uint16Array | null;
  // Padded block-light levels (light.ts); bakes light into opaque quads the same way
  // the shell bakes AO. null leaves every quad unlit, which is what a chunk with no
  // light near it gets.
  light?: Uint8Array | null;
}

const DEFAULT_OPTIONS: MeshOptions = {};
export const NO_MERGE: MeshOptions = { merge: false };

// True when the chunk's palette holds a translucent id (then the mesher needs
// border ids for exact translucent culling).
export function hasTranslucent(chunk: ChunkData): boolean {
  if (chunk.isUniform) return BLOCK_TRANSLUCENT[chunk.uniformId] === 1;
  for (let i = 0; i < chunk.paletteLength; i++) if (BLOCK_TRANSLUCENT[chunk.paletteAt(i)]) return true;
  return false;
}

// Column sets: one Uint32Array per axis.
function columnSet(): Uint32Array[] {
  return [new Uint32Array(COLUMNS), new Uint32Array(COLUMNS), new Uint32Array(COLUMNS)];
}

export class BinaryMesher {
  readonly out = new MeshBuilder(); // opaque quads
  readonly translucent = new MeshBuilder(); // translucent quads, same grouping
  // The chunk being meshed and how to read a voxel's palette index from its words.
  private chunk: ChunkData | null = null;
  private words: Uint32Array | null = null;
  private bits = 0;
  private perWordLog = 0;
  private perWordMask = 0;
  private indexMask = 0;
  private readonly rows = new RowReader();
  // Opaque occupancy columns per axis: [x, y, z].
  private readonly cols: readonly Uint32Array[] = columnSet();
  // Visible faces of one face direction by slice: [d * 32 + v], bit u.
  private readonly slices = new Uint32Array(32 * 32);
  private uniformId = -1; // the chunk's id when uniform, else -1
  // Baked AO: padded opacity (ao.ts) and the AO byte of each visible face of the
  // current direction, [d << 10 | v << 5 | u].
  private readonly padded = new Uint8Array(PAD_VOLUME);
  private readonly aoFaces = new Uint8Array(CHUNK_VOLUME);
  // Baked block light: the padded levels the job filled, and the packed light of each
  // visible face of the current direction, indexed like aoFaces.
  private lightLevels: Uint8Array | null = null;
  private readonly lightFaces = new Uint16Array(CHUNK_VOLUME);
  // Translucent ids in the chunk, their source and occluder columns, and planes.
  private readonly tIds: number[] = [];
  private readonly tSource: Uint32Array[][] = [];
  private readonly tOccluder: Uint32Array[][] = [];
  private readonly tPlanes: Uint32Array[] = [];

  // Meshes a chunk against its neighbor planes (planes.ts). Returns the opaque mesh
  // (this.out); translucent quads are in this.translucent. Both valid until the
  // next call.
  mesh(chunk: ChunkData, planes: Uint32Array, options: MeshOptions = DEFAULT_OPTIONS): Mesh {
    const out = this.out;
    const merge = options.merge ?? true;
    const shell = options.shell ?? null;
    this.lightLevels = options.light ?? null;
    out.reset();
    this.translucent.reset();
    const opaque = this.buildColumns(chunk);
    if (opaque) {
      if (shell !== null) this.fillPadded(shell);
      const id = this.uniformId;
      for (let face = 0; face < FACE_COUNT; face++) {
        out.beginGroup(face);
        const cols = this.cols[FACE_AXIS[face]];
        if (merge) this.emitMerged(face, cols, cols, planes, id, shell !== null, out);
        else this.emitUnmerged(face, cols, cols, planes, id, shell !== null, out);
      }
    }
    out.finish();
    const nt = this.findTranslucent(chunk);
    if (nt > 0) this.meshTranslucent(chunk, planes, options.borders ?? null, merge, nt);
    this.translucent.finish();
    return out;
  }

  // Fills the opaque occupancy columns. False when nothing in the chunk is opaque.
  buildColumns(chunk: ChunkData): boolean {
    const cx = this.cols[0], cy = this.cols[1], cz = this.cols[2];
    this.chunk = chunk;
    if (chunk.isUniform) {
      const id = chunk.uniformId;
      this.uniformId = id;
      this.words = null;
      if (!BLOCK_OPAQUE[id]) return false;
      cx.fill(0xffffffff);
      cy.fill(0xffffffff);
      cz.fill(0xffffffff);
      return true;
    }
    this.uniformId = -1;
    const bits = chunk.bitsPerVoxel;
    this.words = chunk.indexWords();
    this.bits = bits;
    this.perWordLog = 5 - Math.log2(bits);
    this.perWordMask = (32 / bits) - 1;
    this.indexMask = (1 << bits) - 1;
    const rows = this.rows;
    rows.beginOpaque(chunk);
    let any = 0;
    for (let r = 0; r < COLUMNS; r++) {
      const m = rows.row(r); // row (z, y) is X column z | y << 5
      cx[r] = m;
      any |= m;
    }
    if (any === 0) {
      cy.fill(0); // the translucent pass still reads them as occluders
      cz.fill(0);
      return false;
    }
    columnsFromRows(cx, cy, cz);
    return true;
  }

  // Palette index of voxel `cell` (non-uniform chunk).
  private indexAt(cell: number): number {
    return (this.words![cell >>> this.perWordLog] >>> ((cell & this.perWordMask) * this.bits)) & this.indexMask;
  }

  // Copies the shell and writes the chunk's opacity into the padded interior, from
  // the X columns (bit x of column (z, y)).
  private fillPadded(shell: Uint8Array): void {
    const p = this.padded;
    const cx = this.cols[0];
    p.set(shell);
    for (let y = 0; y < 32; y++) {
      for (let z = 0; z < 32; z++) {
        const bits = cx[z | (y << 5)];
        const base = padIndex(0, y, z);
        for (let x = 0; x < 32; x++) p[base + x] = (bits >>> x) & 1;
      }
    }
  }

  // Collects the chunk's translucent ids from its palette into tIds.
  private findTranslucent(chunk: ChunkData): number {
    const t = this.tIds;
    t.length = 0;
    if (chunk.isUniform) {
      if (BLOCK_TRANSLUCENT[chunk.uniformId]) t.push(chunk.uniformId);
    } else {
      for (let i = 0; i < chunk.paletteLength; i++) {
        const id = chunk.paletteAt(i);
        if (BLOCK_TRANSLUCENT[id]) t.push(id);
      }
    }
    return t.length;
  }

  private meshTranslucent(
    chunk: ChunkData,
    planes: Uint32Array,
    borders: Uint16Array | null,
    merge: boolean,
    nt: number,
  ): void {
    while (this.tSource.length < nt) {
      this.tSource.push(columnSet());
      this.tOccluder.push(columnSet());
      this.tPlanes.push(new Uint32Array(FACE_COUNT * PLANE_WORDS));
    }
    // A uniform translucent chunk has no opaque columns built; they are all zero.
    const uniform = chunk.isUniform;
    for (let k = 0; k < nt; k++) {
      const id = this.tIds[k];
      const src = this.tSource[k];
      if (uniform) {
        for (let a = 0; a < 3; a++) {
          src[a].fill(0xffffffff);
          this.tOccluder[k][a].fill(0xffffffff);
        }
      } else {
        this.buildIdColumns(chunk, id, src);
        for (let a = 0; a < 3; a++) {
          const occ = this.tOccluder[k][a];
          const s = src[a];
          const o = this.cols[a];
          for (let i = 0; i < COLUMNS; i++) occ[i] = o[i] | s[i];
        }
      }
      // Planes: opaque neighbor or the same id across the border.
      const tp = this.tPlanes[k];
      for (let face = 0; face < FACE_COUNT; face++) {
        for (let v = 0; v < 32; v++) {
          let bits = planes[face * PLANE_WORDS + v];
          if (borders !== null) {
            const row = face * BORDER_IDS + v * 32;
            for (let u = 0; u < 32; u++) if (borders[row + u] === id) bits |= 1 << u;
          }
          tp[face * PLANE_WORDS + v] = bits;
        }
      }
    }
    const out = this.translucent;
    for (let face = 0; face < FACE_COUNT; face++) {
      out.beginGroup(face);
      const axis = FACE_AXIS[face];
      for (let k = 0; k < nt; k++) {
        const src = this.tSource[k][axis];
        const occ = this.tOccluder[k][axis];
        if (merge) this.emitMerged(face, src, occ, this.tPlanes[k], this.tIds[k], false, out);
        else this.emitUnmerged(face, src, occ, this.tPlanes[k], this.tIds[k], false, out);
      }
    }
  }

  // Columns of the voxels with block id `id` (non-uniform chunk).
  private buildIdColumns(chunk: ChunkData, id: number, set: Uint32Array[]): void {
    const cx = set[0];
    const rows = this.rows;
    rows.beginId(chunk, id);
    for (let r = 0; r < COLUMNS; r++) cx[r] = rows.row(r);
    columnsFromRows(cx, set[1], set[2]);
  }

  // Greedy quads for one face direction (see the header comment). `id` >= 0: every
  // face has that block id; -1: palette index per cell (indexAt).
  private emitMerged(
    face: number,
    cols: Uint32Array,
    occ: Uint32Array,
    planes: Uint32Array,
    id: number,
    bake: boolean,
    out: MeshBuilder,
  ): void {
    const axis = FACE_AXIS[face];
    const positive = FACE_SIGN[face] > 0;
    const planeBase = face * PLANE_WORDS;
    const slices = this.slices;
    slices.fill(0);
    let used = 0; // bit d set when slice d has faces
    const padded = this.padded;
    const aoFaces = this.aoFaces;
    const levels = this.lightLevels;
    const lightFaces = this.lightFaces;

    // Cull and transpose: column (u, v) bit d -> slice d row v bit u.
    for (let v = 0; v < 32; v++) {
      const plane = planes[planeBase + v];
      for (let u = 0; u < 32; u++) {
        const c = cols[u | (v << 5)];
        if (c === 0) continue;
        const o = occ[u | (v << 5)];
        const nb = (plane >>> u) & 1;
        let faces = positive ? c & ~((o >>> 1) | (nb << 31)) : c & ~((o << 1) | nb);
        used |= faces;
        const uBit = 1 << u;
        while (faces !== 0) {
          const d = 31 - Math.clz32(faces & -faces);
          faces &= faces - 1;
          slices[(d << 5) | v] |= uBit;
          if (bake) {
            aoFaces[(d << 10) | (v << 5) | u] = axis === 0
              ? faceAo(padded, d, v, u, face)
              : axis === 1
              ? faceAo(padded, u, d, v, face)
              : faceAo(padded, u, v, d, face);
          }
          if (levels !== null) {
            lightFaces[(d << 10) | (v << 5) | u] = axis === 0
              ? faceLight(levels, d, v, u, face)
              : axis === 1
              ? faceLight(levels, u, d, v, face)
              : faceLight(levels, u, v, d, face);
          }
        }
      }
    }

    const single = id >= 0; // one id for the whole pass
    const plain = single && !bake && levels === null; // every face has the same merge key
    const sa = STRIDE_AXIS[axis], su = STRIDE_U[axis], sv = STRIDE_V[axis];
    while (used !== 0) {
      const d = 31 - Math.clz32(used & -used);
      used &= used - 1;
      const base = d << 5;
      const sliceOffset = d * sa;
      for (let v = 0; v < 32; v++) {
        let row = slices[base + v];
        while (row !== 0) {
          const u0 = 31 - Math.clz32(row & -row);
          const cell = sliceOffset + u0 * su + v * sv;
          const key = single ? id : this.indexAt(cell); // id, or palette index
          const qid = single ? id : this.chunk!.paletteAt(key);
          const aoRow = (d << 10) | (v << 5);
          const ao = bake ? aoFaces[aoRow | u0] : 0;
          // A light's own faces are left unlit: they already carry the block's emission,
          // and adding the light it is casting on top blows the colour out to white.
          const light = levels !== null && BLOCK_LIGHT[qid] === 0 ? lightFaces[aoRow | u0] : 0;
          // Width: consecutive set bits from u0 with the same id, AO and light.
          let w = 1;
          while (
            u0 + w < 32 && ((row >>> (u0 + w)) & 1) !== 0 &&
            (plain ||
              ((single || this.indexAt(cell + w * su) === key) && (!bake || aoFaces[aoRow | (u0 + w)] === ao) &&
                (levels === null || lightFaces[aoRow | (u0 + w)] === light)))
          ) w++;
          const mask = (w >= 32 ? -1 : (1 << w) - 1) << u0;
          // Height: following rows that contain the whole run, with the same keys.
          let h = 1;
          while (v + h < 32 && (slices[base + v + h] & mask) === mask) {
            if (!plain) {
              const rowCell = cell + h * sv;
              const rowAo = aoRow + (h << 5) + u0;
              let same = true;
              for (let k = 0; k < w; k++) {
                if (
                  (!single && this.indexAt(rowCell + k * su) !== key) || (bake && aoFaces[rowAo + k] !== ao) ||
                  (levels !== null && lightFaces[rowAo + k] !== light)
                ) {
                  same = false;
                  break;
                }
              }
              if (!same) break;
            }
            h++;
          }
          for (let k = 0; k < h; k++) slices[base + v + k] &= ~mask;
          row = slices[base + v];
          // Voxel coordinates of the quad's min corner from (d, u0, v).
          let x: number, y: number, z: number;
          if (axis === 0) {
            x = d;
            z = u0;
            y = v;
          } else if (axis === 1) {
            y = d;
            x = u0;
            z = v;
          } else {
            z = d;
            x = u0;
            y = v;
          }
          out.push(encodeWord0(x, y, z, w, h, face, light), encodeWord1(qid, ao, light));
        }
      }
    }
  }

  // One 1x1 quad per visible face of `face`; arguments as emitMerged().
  private emitUnmerged(
    face: number,
    cols: Uint32Array,
    occ: Uint32Array,
    planes: Uint32Array,
    id: number,
    bake: boolean,
    out: MeshBuilder,
  ): void {
    const axis = FACE_AXIS[face];
    const positive = FACE_SIGN[face] > 0;
    const planeBase = face * PLANE_WORDS;
    for (let v = 0; v < 32; v++) {
      const plane = planes[planeBase + v];
      for (let u = 0; u < 32; u++) {
        const c = cols[u | (v << 5)];
        if (c === 0) continue;
        const o = occ[u | (v << 5)];
        const nb = (plane >>> u) & 1;
        let faces = positive ? c & ~((o >>> 1) | (nb << 31)) : c & ~((o << 1) | nb);
        while (faces !== 0) {
          const bit = 31 - Math.clz32(faces & -faces);
          faces &= faces - 1;
          // Voxel coordinates from (axis position, u, v).
          let x: number, y: number, z: number;
          if (axis === 0) {
            x = bit;
            z = u;
            y = v;
          } else if (axis === 1) {
            y = bit;
            x = u;
            z = v;
          } else {
            z = bit;
            x = u;
            y = v;
          }
          const qid = id >= 0 ? id : this.chunk!.paletteAt(this.indexAt(x | (z << 5) | (y << 10)));
          const ao = bake ? faceAo(this.padded, x, y, z, face) : 0;
          const light = this.lightLevels !== null && BLOCK_LIGHT[qid] === 0
            ? faceLight(this.lightLevels, x, y, z, face)
            : 0;
          out.push(encodeWord0(x, y, z, 1, 1, face, light), encodeWord1(qid, ao, light));
        }
      }
    }
  }
}
