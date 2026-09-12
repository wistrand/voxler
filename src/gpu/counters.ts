// GPU counter readback ring (plan-rendering phase 3): copies a few u32 counters
// from a GPU buffer into one of a small set of mappable buffers each frame and
// reads them frames later, like GpuTimer does for timestamps. Never awaited in the
// frame path; a frame whose slots are all still mapping is simply not sampled.

import "./globals.ts";

const SLOTS = 4;
const FREE = 0;
const COPIED = 1; // copy encoded this frame, map after submit
const MAPPING = 2;

export class CounterReadback {
  readonly latest: Uint32Array; // the most recent sample
  samples = 0;
  private readonly buffers: GPUBuffer[] = [];
  private readonly state = new Uint8Array(SLOTS);
  private readonly bytes: number;
  private copied = -1;

  constructor(device: GPUDevice, label: string, words: number) {
    this.bytes = words * 4;
    this.latest = new Uint32Array(words);
    for (let i = 0; i < SLOTS; i++) {
      this.buffers.push(device.createBuffer({
        label: `${label} readback ${i}`,
        size: this.bytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }));
    }
  }

  // Encodes a copy of the first `words` u32 of `source` into a free slot, if any.
  copy(encoder: GPUCommandEncoder, source: GPUBuffer, offset = 0): void {
    this.copied = -1;
    for (let i = 0; i < SLOTS; i++) {
      if (this.state[i] !== FREE) continue;
      encoder.copyBufferToBuffer(source, offset, this.buffers[i], 0, this.bytes);
      this.state[i] = COPIED;
      this.copied = i;
      return;
    }
  }

  // Call after the frame's submit: starts mapping the slot copied this frame.
  afterSubmit(): void {
    const i = this.copied;
    if (i < 0) return;
    this.copied = -1;
    this.state[i] = MAPPING;
    const buffer = this.buffers[i];
    buffer.mapAsync(GPUMapMode.READ).then(() => {
      this.latest.set(new Uint32Array(buffer.getMappedRange(0, this.bytes)));
      buffer.unmap();
      this.samples++;
      this.state[i] = FREE;
    }, () => {
      this.state[i] = FREE; // device lost; the renderer is being replaced
    });
  }
}
