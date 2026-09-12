// Brush instances and the chunk index over them (plan-world-modelling phase 1).
// Main thread, pure CPU: no DOM, no GPU. Records are kept in the layout the GPU
// wants (format.ts), so gathering a voxelize batch is a copy, not a conversion.
//
// Two ranges, and they are not the same. The *index* range is the brush box grown by
// `BRUSH_INDEX_PAD` plus the blend radius: leaving a brush out of a chunk's fold is
// only safe when it cannot hold a surface within the radius a skip test claims, and
// the widest such claim is a whole chunk, half a diagonal across. Leaving a union
// brush out lets the field claim empty space where the brush sits; leaving a subtract
// brush out lets it claim solid where it carves. Both delete geometry silently, so
// that pad is generous on purpose.
//
// The *dirty* range is the box grown by the blend radius and a voxel, because that is
// where a voxel can actually change: outside the box a union contributes a positive
// distance, which never turns air solid, and a subtract contributes a negative one,
// which never turns solid to air. Only a smooth union reaches further, by its blend
// radius. Using the index range here would regenerate about 27 chunks where 8 are
// needed, which is the difference between a brush that can be animated and one that
// cannot (plan-world-modelling "Open questions").
//
// Intersect and smax have no bounded dirty range at all: `max(acc, box distance)`
// turns solid into air anywhere in the world. They are useful inside a CSG op list,
// where they meet another op rather than the world, and are rejected as an
// instance's blend.

import { CHUNK_SIZE } from "../world/coords.ts";
import { ChunkTable } from "../world/chunk-table.ts";
import { chunkInRange, chunkKey } from "../world/keys.ts";
import { instanceBox } from "./field.ts";
import {
  BLEND_SMIN,
  BLEND_SUBTRACT,
  BLEND_UNION,
  BRUSH_CSG,
  BRUSH_SDF,
  BRUSH_VOXEL,
  csgBounds,
  INSTANCE_WORDS,
  type InstanceFields,
  readInstance,
  LIPSCHITZ_MAX,
  MAX_OPS_WORDS,
  newInstanceFields,
  voxelBounds,
  WordBuffer,
  writeInstance,
} from "./format.ts";

// Half a chunk's diagonal, rounded up: the widest radius a skip test can claim.
export const BRUSH_INDEX_PAD = Math.ceil(CHUNK_SIZE * 0.5 * Math.sqrt(3));

// Slack on the dirty range, in voxels, for the gap between box edges and centers.
export const BRUSH_DIRTY_PAD = 1;

// Blends an instance may fold into the world with. The others reach everywhere.
export const INSTANCE_BLENDS: readonly number[] = [BLEND_UNION, BLEND_SUBTRACT, BLEND_SMIN];

// A brush covering more chunks than this is a bug at the sizes this plan targets;
// the index would hold a node per chunk per brush.
export const MAX_CHUNKS_PER_BRUSH = 4096;

const NONE = -1;

function checkBlend(blend: number): void {
  if (!INSTANCE_BLENDS.includes(blend)) {
    throw new Error(
      `blend ${blend} reaches every chunk, so an instance cannot use it; ` +
        `intersect and smax belong inside a CSG op list`,
    );
  }
}

// Scratch for move(), so it can call update() without an object literal per call.
const CELL: [number, number, number] = [0, 0, 0];
const UPDATE: BrushUpdate = {};

export interface BrushDesc {
  kind: number;
  cell: readonly [number, number, number];
  orientation?: number; // 0..23, default 0 (identity)
  blend?: number; // how the instance folds into the world, default union
  blendK?: number; // blend radius for BLEND_SMIN and BLEND_SMAX
  material?: number; // default block id where the brush is the nearest surface
  scale?: number; // uniform; SDF and CSG only
  type?: number; // SDF brush type id
  ops?: Uint32Array; // packed CSG or voxel op words, copied into the pool
  // Anything here can also be changed later with update().
  // SDF brushes have no op list to measure, so they declare their own box and bound.
  localMin?: readonly [number, number, number];
  localMax?: readonly [number, number, number];
  lipschitz?: number;
}

// A partial change to an instance record. Every field is optional; the ones given
// replace what the record holds.
export interface BrushUpdate {
  cell?: readonly [number, number, number];
  orientation?: number;
  blend?: number;
  blendK?: number;
  material?: number;
  scale?: number;
  type?: number;
}

export class BrushStore {
  // Bumped by every change, so a consumer that caches a view of the store (the
  // preview's grid) knows to rebuild without being told what changed.
  version = 0;
  readonly records = new WordBuffer(64 * INSTANCE_WORDS);
  readonly ops = new WordBuffer(1024);

  private readonly index = new ChunkTable(4096);
  private nodeInstance = new Int32Array(4096).fill(NONE);
  private nodeNext = new Int32Array(4096).fill(NONE);
  private nodeFree = NONE;
  private nodeTop = 0;
  private live = new Uint8Array(64);
  private freeIds: number[] = [];
  private topId = 0;
  private liveCount = 0;
  private nextSeq = 1; // never reused, unlike instance ids
  // Op pool: a bump pointer plus free runs by exact size. Op lists are small and an
  // edit usually rewrites one with the same size, so exact-size reuse is enough.
  private opsTop = 0;
  private readonly opsFree = new Map<number, number[]>();
  private readonly dirtyIndex = new ChunkTable(1024);
  private dirtyKeys = new Float64Array(1024);
  private dirtyCount = 0;
  private readonly box = new Float64Array(6);
  private readonly bounds = new Float64Array(6);
  private readonly range = new Int32Array(6);
  private readonly fields: InstanceFields = newInstanceFields();

  get count(): number {
    return this.liveCount;
  }

  get dirty(): number {
    return this.dirtyCount;
  }

  has(id: number): boolean {
    return id >= 0 && id < this.topId && this.live[id] === 1;
  }

  // Word offset of an instance's record, for the field fold and for batch gathers.
  offsetOf(id: number): number {
    return id * INSTANCE_WORDS;
  }

  add(desc: BrushDesc): number {
    checkBlend(desc.blend ?? BLEND_UNION);
    this.version++;
    const id = this.freeIds.length > 0 ? this.freeIds.pop()! : this.topId++;
    if (id >= this.live.length) this.growInstances(id + 1);
    this.records.ensure((id + 1) * INSTANCE_WORDS);
    const f = this.fields;
    f.kind = desc.kind;
    f.blend = desc.blend ?? BLEND_UNION;
    f.blendK = desc.blendK ?? 0;
    f.orientation = desc.orientation ?? 0;
    f.material = desc.material ?? 0;
    f.scale = desc.scale ?? 1;
    f.type = desc.type ?? 0;
    f.cellX = desc.cell[0];
    f.cellY = desc.cell[1];
    f.cellZ = desc.cell[2];
    f.opsOffset = 0;
    f.opsCount = 0;
    f.lipschitz = 1;
    f.seq = this.nextSeq++;
    (f.localMin as number[])[0] = (f.localMin as number[])[1] = (f.localMin as number[])[2] = 0;
    (f.localMax as number[])[0] = (f.localMax as number[])[1] = (f.localMax as number[])[2] = 0;
    this.live[id] = 1;
    this.liveCount++;
    writeInstance(this.records, this.offsetOf(id), f);
    this.applyOps(id, desc.kind, desc.ops ?? null, desc);
    this.link(id);
    this.markRange(id, this.dirtyPad(id));
    return id;
  }

  remove(id: number): void {
    this.check(id);
    this.version++;
    this.markRange(id, this.dirtyPad(id));
    this.unlink(id);
    const at = this.offsetOf(id);
    const count = this.records.u32[at + 6] & 0xffff;
    if (count > 0) this.freeOps(this.records.u32[at + 5], count);
    this.live[id] = 0;
    this.liveCount--;
    this.freeIds.push(id);
  }

  // Moves and reorients an instance, dirtying the chunks it leaves and enters.
  move(id: number, x: number, y: number, z: number, orientation?: number): void {
    CELL[0] = x;
    CELL[1] = y;
    CELL[2] = z;
    UPDATE.cell = CELL;
    UPDATE.orientation = orientation;
    this.update(id, UPDATE);
    UPDATE.cell = undefined;
    UPDATE.orientation = undefined;
  }

  // Changes any of an instance's record fields, dirtying the chunks it leaves and
  // enters. This is the path animation takes: the field function stays a pure
  // function of position and the instance record is what moves over time.
  update(id: number, u: BrushUpdate): void {
    this.check(id);
    this.version++;
    if (u.blend !== undefined) checkBlend(u.blend);
    this.markRange(id, this.dirtyPad(id));
    this.unlink(id);
    this.applyUpdate(this.offsetOf(id), u);
    this.link(id);
    this.markRange(id, this.dirtyPad(id));
  }

  // Replaces an instance's op list; its box and Lipschitz bound follow from it.
  setOps(id: number, ops: Uint32Array): void {
    this.check(id);
    this.version++;
    this.markRange(id, this.dirtyPad(id));
    this.unlink(id);
    const at = this.offsetOf(id);
    const old = this.records.u32[at + 6] & 0xffff;
    if (old > 0) this.freeOps(this.records.u32[at + 5], old);
    this.applyOps(id, (this.records.u32[at + 3] >>> 18) & 3, ops, null);
    this.link(id);
    this.markRange(id, this.dirtyPad(id));
  }

  // Instance ids whose fold can reach `key`, oldest first, so every consumer folds
  // and replays them in one order. Sorted by sequence number and not by id, because
  // ids come from a free list and a reused one would reorder the fold. Returns the
  // count written into `out`.
  instancesIn(key: number, out: Int32Array): number {
    let n = 0;
    for (let node = this.index.get(key); node !== -1; node = this.nodeNext[node]) {
      if (n === out.length) throw new Error(`chunk ${key} holds more than ${out.length} brushes`);
      const id = this.nodeInstance[node];
      const seq = this.seqOf(id);
      let i = n++;
      for (; i > 0 && this.seqOf(out[i - 1]) > seq; i--) out[i] = out[i - 1];
      out[i] = id;
    }
    return n;
  }

  // Creation order of an instance; strictly increasing and never reused.
  seqOf(id: number): number {
    return this.records.u32[this.offsetOf(id) + 15];
  }

  // The kind of an instance (format.ts BRUSH_*).
  kindOf(id: number): number {
    return (this.records.u32[this.offsetOf(id) + 3] >>> 18) & 3;
  }

  // Word offset and count of an instance's op list in `ops`.
  opsOffsetOf(id: number): number {
    return this.records.u32[this.offsetOf(id) + 5];
  }

  opsCountOf(id: number): number {
    return this.records.u32[this.offsetOf(id) + 6] & 0xffff;
  }

  // Packed forward rotation of an instance, and its anchor into out[0..2].
  rotationOf(id: number): number {
    return (this.records.u32[this.offsetOf(id) + 3] >>> 9) & 0x1ff;
  }

  cellOf(id: number, out: Int32Array): void {
    const at = this.offsetOf(id);
    for (let i = 0; i < 3; i++) out[i] = this.records.i32[at + i];
  }

  // Largest |gradient| bound among the brushes reaching `key`, or 0 when there are
  // none. The caller takes the max with the world's own WORLD_LIPSCHITZ.
  lipschitzIn(key: number): number {
    let max = 0;
    for (let node = this.index.get(key); node !== -1; node = this.nodeNext[node]) {
      const at = this.offsetOf(this.nodeInstance[node]);
      max = Math.max(max, (this.records.u32[at + 6] >>> 16) / 256);
    }
    return max;
  }

  // World-space box of an instance: min into out[0..2], max into out[3..5].
  boxOf(id: number, out: Float64Array): void {
    this.check(id);
    instanceBox(this.records, this.offsetOf(id), out);
  }

  // Drains the chunks touched since the last call into `out`, returning the count.
  // `out` must hold `dirty` entries.
  takeDirty(out: Float64Array): number {
    const n = this.dirtyCount;
    if (out.length < n) throw new Error(`takeDirty needs ${n} entries, got ${out.length}`);
    for (let i = 0; i < n; i++) {
      out[i] = this.dirtyKeys[i];
      this.dirtyIndex.delete(this.dirtyKeys[i]);
    }
    this.dirtyCount = 0;
    return n;
  }

  private check(id: number): void {
    if (!this.has(id)) throw new Error(`brush ${id} is not live`);
  }

  // Reads a record, overwrites the named fields, and writes it back. Lipschitz and
  // the local box round-trip through their stored precision, so this is stable.
  private applyUpdate(at: number, u: BrushUpdate): void {
    const f = readInstance(this.records, at, this.fields);
    if (u.cell !== undefined) {
      f.cellX = u.cell[0];
      f.cellY = u.cell[1];
      f.cellZ = u.cell[2];
    }
    if (u.orientation !== undefined) f.orientation = u.orientation;
    if (u.blend !== undefined) f.blend = u.blend;
    if (u.blendK !== undefined) f.blendK = u.blendK;
    if (u.material !== undefined) f.material = u.material;
    if (u.scale !== undefined) f.scale = u.scale;
    if (u.type !== undefined) f.type = u.type;
    writeInstance(this.records, at, f);
  }

  // Voxels can only change inside the box, plus a smooth blend's reach and a voxel.
  private dirtyPad(id: number): number {
    return BRUSH_DIRTY_PAD + this.records.f32[this.offsetOf(id) + 14];
  }

  // Copies an op list into the pool and derives the record's box and bound from it.
  // An SDF brush has no list to measure and declares both itself.
  private applyOps(id: number, kind: number, src: Uint32Array | null, desc: BrushDesc | null): void {
    const at = this.offsetOf(id);
    let offset = 0;
    let count = 0;
    if (src !== null && src.length > 0) {
      if (src.length > MAX_OPS_WORDS) throw new Error(`op list of ${src.length} words exceeds ${MAX_OPS_WORDS}`);
      count = src.length;
      offset = this.allocOps(count);
      this.ops.u32.set(src, offset);
    }
    const b = this.bounds;
    let lipschitz = 1;
    if (kind === BRUSH_CSG) {
      lipschitz = csgBounds(this.ops, offset, count, b);
    } else if (kind === BRUSH_VOXEL) {
      voxelBounds(this.ops, offset, count, b);
    } else if (kind === BRUSH_SDF) {
      const min = desc?.localMin;
      const max = desc?.localMax;
      if (!min || !max) throw new Error("an SDF brush must declare localMin and localMax");
      for (let i = 0; i < 3; i++) {
        b[i] = min[i];
        b[3 + i] = max[i];
      }
      lipschitz = desc?.lipschitz ?? 1;
    } else {
      throw new Error(`unknown brush kind ${kind}`);
    }
    if (!(lipschitz >= 1)) throw new Error(`brush ${id} declares a Lipschitz bound of ${lipschitz}, must be >= 1`);
    const u32 = this.records.u32;
    const f32 = this.records.f32;
    u32[at + 5] = offset;
    u32[at + 6] = (count & 0xffff) | (Math.min(0xffff, Math.round(Math.min(lipschitz, LIPSCHITZ_MAX) * 256)) << 16);
    for (let i = 0; i < 3; i++) {
      f32[at + 8 + i] = b[i];
      f32[at + 11 + i] = b[3 + i];
    }
  }

  private allocOps(words: number): number {
    const free = this.opsFree.get(words);
    if (free !== undefined && free.length > 0) return free.pop()!;
    const offset = this.opsTop;
    this.opsTop += words;
    this.ops.ensure(this.opsTop);
    return offset;
  }

  private freeOps(offset: number, words: number): void {
    let free = this.opsFree.get(words);
    if (free === undefined) {
      free = [];
      this.opsFree.set(words, free);
    }
    free.push(offset);
  }

  // Chunk range an instance's box reaches once grown by `pad`.
  private chunkRange(id: number, pad: number): void {
    instanceBox(this.records, this.offsetOf(id), this.box);
    const r = this.range;
    for (let i = 0; i < 3; i++) {
      r[i] = Math.floor((this.box[i] - pad) / CHUNK_SIZE);
      r[3 + i] = Math.floor((this.box[3 + i] + pad) / CHUNK_SIZE);
    }
    const chunks = (r[3] - r[0] + 1) * (r[4] - r[1] + 1) * (r[5] - r[2] + 1);
    if (chunks > MAX_CHUNKS_PER_BRUSH) {
      throw new Error(`brush ${id} covers ${chunks} chunks, over ${MAX_CHUNKS_PER_BRUSH}`);
    }
  }

  private link(id: number): void {
    this.chunkRange(id, this.indexPad(id));
    const r = this.range;
    for (let y = r[1]; y <= r[4]; y++) {
      for (let z = r[2]; z <= r[5]; z++) {
        for (let x = r[0]; x <= r[3]; x++) {
          if (!chunkInRange(x, y, z)) continue;
          const key = chunkKey(x, y, z);
          const node = this.allocNode();
          this.nodeInstance[node] = id;
          this.nodeNext[node] = this.index.get(key);
          this.index.set(key, node);
        }
      }
    }
  }

  private unlink(id: number): void {
    this.chunkRange(id, this.indexPad(id));
    const r = this.range;
    for (let y = r[1]; y <= r[4]; y++) {
      for (let z = r[2]; z <= r[5]; z++) {
        for (let x = r[0]; x <= r[3]; x++) {
          if (!chunkInRange(x, y, z)) continue;
          const key = chunkKey(x, y, z);
          let node = this.index.get(key);
          let prev = NONE;
          while (node !== -1 && this.nodeInstance[node] !== id) {
            prev = node;
            node = this.nodeNext[node];
          }
          if (node === -1) continue;
          if (prev === NONE) {
            const next = this.nodeNext[node];
            if (next === NONE) this.index.delete(key);
            else this.index.set(key, next);
          } else {
            this.nodeNext[prev] = this.nodeNext[node];
          }
          this.freeNode(node);
        }
      }
    }
  }

  private indexPad(id: number): number {
    return BRUSH_INDEX_PAD + this.records.f32[this.offsetOf(id) + 14];
  }

  private markRange(id: number, pad: number): void {
    this.chunkRange(id, pad);
    const r = this.range;
    for (let y = r[1]; y <= r[4]; y++) {
      for (let z = r[2]; z <= r[5]; z++) {
        for (let x = r[0]; x <= r[3]; x++) {
          if (!chunkInRange(x, y, z)) continue;
          const key = chunkKey(x, y, z);
          if (this.dirtyIndex.get(key) !== -1) continue;
          this.dirtyIndex.set(key, 1);
          if (this.dirtyCount === this.dirtyKeys.length) {
            const grown = new Float64Array(this.dirtyKeys.length * 2);
            grown.set(this.dirtyKeys);
            this.dirtyKeys = grown;
          }
          this.dirtyKeys[this.dirtyCount++] = key;
        }
      }
    }
  }

  private allocNode(): number {
    if (this.nodeFree !== NONE) {
      const node = this.nodeFree;
      this.nodeFree = this.nodeNext[node];
      return node;
    }
    if (this.nodeTop === this.nodeInstance.length) {
      const size = this.nodeInstance.length * 2;
      const instance = new Int32Array(size).fill(NONE);
      const next = new Int32Array(size).fill(NONE);
      instance.set(this.nodeInstance);
      next.set(this.nodeNext);
      this.nodeInstance = instance;
      this.nodeNext = next;
    }
    return this.nodeTop++;
  }

  private freeNode(node: number): void {
    this.nodeInstance[node] = NONE;
    this.nodeNext[node] = this.nodeFree;
    this.nodeFree = node;
  }

  private growInstances(need: number): void {
    let size = this.live.length;
    while (size < need) size *= 2;
    const live = new Uint8Array(size);
    live.set(this.live);
    this.live = live;
  }
}
