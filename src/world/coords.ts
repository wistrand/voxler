// Chunk geometry constants. Layout rationale: agent_docs/design-formats.md
// "Coordinate spaces" and "Chunk storage".

export const CHUNK_SHIFT = 5;
export const CHUNK_SIZE = 1 << CHUNK_SHIFT; // 32: one u32 occupancy column per axis
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; // 32768 voxels

// Index of a voxel inside a chunk: y-major layers, so a horizontal slice is
// contiguous. Local coordinates are 0..31.
export function voxelIndex(x: number, y: number, z: number): number {
  return x | (z << CHUNK_SHIFT) | (y << (2 * CHUNK_SHIFT));
}
