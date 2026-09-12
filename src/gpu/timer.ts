// GPU pass timing with timestamp queries. Each recorded frame resolves the query
// set and copies it into one of a few readback buffers; the buffer is mapped
// asynchronously and read frames later. When every buffer is still in flight, or
// `timestamp-query` wasn't granted, frames go untimed.
//
// Chrome quantizes timestamps to 100 µs (gotchas.md "Timestamp queries are
// optional and coarse"): treat results as trends.
//
// A pass that doesn't run in a frame is simply not timed: only passes whose
// descriptor received passWrites() this frame are read back.

import "./globals.ts";
import { RingBuffer } from "../util/ring.ts";

const READBACK_SLOTS = 4;
const TWO_POW_32 = 4294967296;

type TimestampWrites = NonNullable<GPURenderPassDescriptor["timestampWrites"]>;

interface Slot {
  readonly buffer: GPUBuffer;
  pending: boolean;
  passMask: number; // bit i set when pass i was timed in this slot's frame
  // Bound once so mapping a slot doesn't create closures per frame.
  readonly onMapped: () => void;
  readonly onFailed: () => void;
}

export class GpuTimer {
  readonly passNames: readonly string[];
  readonly enabled: boolean;
  // Milliseconds per pass, one ring per entry in passNames.
  readonly rings: readonly RingBuffer[];
  // Also called with every sample, e.g. by a benchmark run. Set once, not per frame.
  onSample: ((pass: number, ms: number) => void) | null = null;
  private readonly querySet: GPUQuerySet | null = null;
  private readonly resolveBuffer: GPUBuffer | null = null;
  private readonly byteSize: number;
  private readonly slots: Slot[] = [];
  private readonly writes: TimestampWrites[] = [];
  private current = -1; // slot recording this frame, or -1
  private next = 0;

  constructor(device: GPUDevice, enabled: boolean, passNames: readonly string[], window: number) {
    this.passNames = passNames;
    this.enabled = enabled;
    this.rings = passNames.map(() => new RingBuffer(window));
    const queryCount = passNames.length * 2;
    this.byteSize = queryCount * 8;
    if (!enabled) return;

    const querySet = device.createQuerySet({ label: "pass timestamps", type: "timestamp", count: queryCount });
    this.querySet = querySet;
    this.resolveBuffer = device.createBuffer({
      label: "timestamp resolve",
      size: this.byteSize,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let i = 0; i < READBACK_SLOTS; i++) {
      const slot: Slot = {
        buffer: device.createBuffer({
          label: `timestamp readback ${i}`,
          size: this.byteSize,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        pending: false,
        passMask: 0,
        onMapped: () => this.collect(slot),
        onFailed: () => {
          slot.pending = false; // device lost or destroyed; nothing to read
        },
      };
      this.slots.push(slot);
    }
    for (let p = 0; p < passNames.length; p++) {
      this.writes.push({ querySet, beginningOfPassWriteIndex: 2 * p, endOfPassWriteIndex: 2 * p + 1 });
    }
  }

  // Call once at the start of a frame. Picks a free readback slot if there is one.
  beginFrame(): void {
    this.current = -1;
    if (!this.enabled) return;
    for (let i = 0; i < READBACK_SLOTS; i++) {
      const s = (this.next + i) % READBACK_SLOTS;
      if (!this.slots[s].pending) {
        this.current = s;
        this.next = (s + 1) % READBACK_SLOTS;
        this.slots[s].passMask = 0;
        return;
      }
    }
  }

  // Value for a pass descriptor's `timestampWrites`; undefined on untimed frames.
  // Call it only for passes that will actually be encoded this frame.
  passWrites(pass: number): TimestampWrites | undefined {
    if (this.current < 0) return undefined;
    this.slots[this.current].passMask |= 1 << pass;
    return this.writes[pass];
  }

  // After the last timed pass, before encoder.finish().
  resolve(encoder: GPUCommandEncoder): void {
    if (this.current < 0 || !this.querySet || !this.resolveBuffer) return;
    encoder.resolveQuerySet(this.querySet, 0, this.passNames.length * 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.slots[this.current].buffer, 0, this.byteSize);
  }

  // After queue.submit().
  afterSubmit(): void {
    if (this.current < 0) return;
    const slot = this.slots[this.current];
    slot.pending = true;
    // mapAsync returns a new promise every call; that allocation is inherent to the API.
    slot.buffer.mapAsync(GPUMapMode.READ).then(slot.onMapped, slot.onFailed);
  }

  private collect(slot: Slot): void {
    const words = new Uint32Array(slot.buffer.getMappedRange());
    for (let p = 0; p < this.passNames.length; p++) {
      if ((slot.passMask & (1 << p)) === 0) continue; // pass didn't run that frame
      const begin = words[4 * p] + words[4 * p + 1] * TWO_POW_32;
      const end = words[4 * p + 2] + words[4 * p + 3] * TWO_POW_32;
      if (begin === 0 && end === 0) continue; // never written
      if (end < begin) continue;
      const ms = (end - begin) / 1e6;
      this.rings[p].push(ms);
      this.onSample?.(p, ms);
    }
    slot.buffer.unmap();
    slot.pending = false;
  }
}
