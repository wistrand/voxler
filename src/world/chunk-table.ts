// Open-addressing hash table from chunk key (keys.ts) to an int32 value (a slot
// index). Linear probing, power-of-two capacity, tombstones on delete, rehash when
// live + tombstones exceed half the capacity. get/set/delete allocate nothing.
//
// Rehashing is O(capacity). Call reserve() with the planned resident count at
// startup so growth never happens in the frame path; automatic growth is a safety
// net and is counted in `rehashes`.

import { hashKey } from "./keys.ts";

const EMPTY = -1;
const TOMBSTONE = -2;
const MAX_LOAD = 0.5;
const MIN_CAPACITY = 16;

function capacityFor(entries: number): number {
  let cap = MIN_CAPACITY;
  while (cap * MAX_LOAD < entries) cap *= 2;
  return cap;
}

export class ChunkTable {
  rehashes = 0;
  private keys: Float64Array;
  private values: Int32Array;
  private mask: number;
  private live = 0;
  private tombstones = 0;

  constructor(expectedEntries = 1024) {
    const cap = capacityFor(expectedEntries);
    this.keys = new Float64Array(cap).fill(EMPTY);
    this.values = new Int32Array(cap);
    this.mask = cap - 1;
  }

  get size(): number {
    return this.live;
  }

  get capacity(): number {
    return this.mask + 1;
  }

  // Value for a key, or -1 when absent.
  get(key: number): number {
    const keys = this.keys;
    for (let i = hashKey(key) & this.mask;; i = (i + 1) & this.mask) {
      const k = keys[i];
      if (k === key) return this.values[i];
      if (k === EMPTY) return -1;
    }
  }

  has(key: number): boolean {
    return this.indexOf(key) !== -1;
  }

  set(key: number, value: number): void {
    const keys = this.keys;
    let tomb = -1;
    let i = hashKey(key) & this.mask;
    for (;; i = (i + 1) & this.mask) {
      const k = keys[i];
      if (k === key) {
        this.values[i] = value;
        return;
      }
      if (k === EMPTY) break;
      if (k === TOMBSTONE && tomb === -1) tomb = i;
    }
    if (tomb !== -1) {
      i = tomb;
      this.tombstones--;
    }
    keys[i] = key;
    this.values[i] = value;
    this.live++;
    if (this.live + this.tombstones > this.capacity * MAX_LOAD) {
      // Grow when mostly live; otherwise rehash in place to clear tombstones.
      this.rehash(this.live > this.capacity * MAX_LOAD * 0.5 ? this.capacity * 2 : this.capacity);
    }
  }

  // Removes a key. False when absent.
  delete(key: number): boolean {
    const i = this.indexOf(key);
    if (i === -1) return false;
    this.keys[i] = TOMBSTONE;
    this.live--;
    this.tombstones++;
    return true;
  }

  // Grows so `entries` live keys fit without another rehash.
  reserve(entries: number): void {
    const cap = capacityFor(entries);
    if (cap > this.capacity) this.rehash(cap);
  }

  // Calls fn for every live entry. Not for the frame path (closure per call).
  forEach(fn: (key: number, value: number) => void): void {
    const keys = this.keys;
    for (let i = 0; i < keys.length; i++) if (keys[i] >= 0) fn(keys[i], this.values[i]);
  }

  private indexOf(key: number): number {
    const keys = this.keys;
    for (let i = hashKey(key) & this.mask;; i = (i + 1) & this.mask) {
      const k = keys[i];
      if (k === key) return i;
      if (k === EMPTY) return -1;
    }
  }

  private rehash(capacity: number): void {
    const oldKeys = this.keys;
    const oldValues = this.values;
    this.keys = new Float64Array(capacity).fill(EMPTY);
    this.values = new Int32Array(capacity);
    this.mask = capacity - 1;
    this.tombstones = 0;
    for (let j = 0; j < oldKeys.length; j++) {
      const k = oldKeys[j];
      if (k < 0) continue;
      let i = hashKey(k) & this.mask;
      while (this.keys[i] !== EMPTY) i = (i + 1) & this.mask;
      this.keys[i] = k;
      this.values[i] = oldValues[j];
    }
    this.rehashes++;
  }
}
