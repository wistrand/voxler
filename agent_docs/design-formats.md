# Design: formats and coordinate spaces

> Status: sections marked "Implemented" (chunk storage, payload arena, camera
> uniform, world program, voxelizer output, mesh job and output) are in code; the
> packed quad, cluster descriptor, and chunk table are implemented in TS and in the
> near-field vertex shader (`src/render/near.wgsl`, plan-rendering phase 1 spike);
> brick and clipmap are proposed.
> This file is the single owner of every
> binary layout shared between a worker (encoder) and a WGSL shader or another worker
> (decoder). Once code exists, the constants live in source and this file keeps the
> layout diagrams and the rationale; replace duplicated literals with pointers.

## Contents
- Coordinate spaces
- Voxel encoding
- Chunk storage
- Payload arena
- Packed quad
- Cluster descriptor
- Mesh job and output
- Chunk table
- Camera uniform
- World program
- Brush instance
- Brush ops
- Voxelizer output
- Brick and clipmap
- Changing a format

## Coordinate spaces

| Space        | Type               | Definition                                                      |
|--------------|--------------------|-----------------------------------------------------------------|
| World voxel  | int32 x, y, z      | One unit per voxel. Y is up. Right-handed.                      |
| Chunk        | int32 cx, cy, cz   | `world >> 5`. Arithmetic shift floors negatives correctly.      |
| Local        | 0..31 per axis     | `world & 31`. Correct for negatives in two's complement.        |
| Chunk key    | JS number, 53 bits | cx and cz 21 bits each, cy 11 bits, each offset to unsigned.    |
| Render space | f32                | World minus the camera's chunk origin.                          |
| Level cell   | int32 per level k  | `world >> k`. Far-field cell size is 2^k voxels.                |

Chunk key range: cx, cz in [-2^20, 2^20), cy in [-2^10, 2^10). That is about
33.5 million voxels horizontally and 32768 vertically each way. The key is a plain
number so it can index a typed-array hash table; never build string keys.

Render space exists because f32 loses sub-voxel precision far from the origin (see
[gotchas.md](gotchas.md) "Float32 precision"); WGSL has no f64. The camera is held
as an integer chunk coordinate plus a float64 offset inside it. Shaders receive the
camera chunk as `vec3<i32>` and the offset as `vec3<f32>`, do chunk subtraction in
integers, and convert to f32 last.

## Voxel encoding

A voxel is a `u16` block id. `0` is air. The id indexes the block registry, which
holds per-type properties: opaque or translucent, emissive, how far it sways, how
brightly it lights its neighbours, texture layer per face, far-field color. Properties
are never packed into the voxel itself; this keeps palettes small and lets properties
change without rewriting chunks.

The block table uploaded to shaders (`blockColorTable()`) is `BLOCK_TABLE_STRIDE`
floats per block, `MAX_BLOCK_TYPES` of them, three `vec4f` in WGSL: block `id`'s colour is
at `id * 3`, its emission at `id * 3 + 1` and its flow at `id * 3 + 2`.

| Floats | Field    | Notes                                                              |
|--------|----------|--------------------------------------------------------------------|
| 0-2    | colour   | display colour                                                     |
| 3      | coverage | 1 for opaque, the block's `alpha` for translucent; the translucent draw pass blends by it and the opaque one ignores it |
| 4-6    | emission | added to the lit surface, then fogged with it                       |
| 7      | sway     | how far the block's faces move in the wind, in voxels               |
| 8      | flow     | tiles a second the block's texture scrolls down its faces; for water going over a drop, which moves without its geometry moving |
| 9-11   | unused   | padding to three `vec4f`                                            |

Emission has no tonemapping behind it: a lit surface plus emission past 1 clips to
white and the block loses its colour, so emission stays small enough that the two
together fit (a unit test checks it). The far-field colour table (`farColorTable()`) has
the same stride and the same meaning with two differences: solidity in place of coverage,
and float 7 is the block's **light level** (0 to `LIGHT_MAX`) rather than its sway. The
far field has no mesh and so no baked light to read, so it works the light out at the hit
from the levels of the blocks in the cells around it, and needs them in the table to do
it. Nothing sways in the far field, which is what makes the slot free.

A block's `light` is not in this table. It is a level (0 to `LIGHT_MAX`) the mesh job
floods through the voxels around the block and bakes into the quads it touches
("Packed quad"), so nothing reads it at draw time; the shader reads `BLOCK_LIGHT_COLOR`
and the sky preset's strength instead (`src/render/shading.wgsl`). Emission is how a
block looks; light is what it does to its neighbours, and a block can have either
without the other.

"Solid" in this project means opaque. Face culling and far-field occupancy use
opacity. Opacity comes from `BLOCK_OPAQUE` (`src/world/blocks.ts`), indexed by any
u16 id: air and registered non-opaque blocks are not opaque, every other id
(registered or not) is. Translucent ids (`BLOCK_TRANSLUCENT`: registered, not air,
not opaque; water, glass) are meshed into separate clusters: a translucent face
is hidden by an opaque voxel or the same id across it, and translucent voxels
never hide opaque faces.

## Chunk storage

A chunk is 32 x 32 x 32 voxels. 32 matches a `u32` lane, so one occupancy column
along any axis is one `u32` and the mesher runs on native 32-bit bit operations
(no fast 64-bit integers in JS or WGSL; see [gotchas.md](gotchas.md) "Bitwise ops
are int32").

Three storage variants, chosen per chunk:

| Variant | Payload                                          | When                              |
|---------|--------------------------------------------------|-----------------------------------|
| Uniform | one block id, no array                           | all voxels equal (air, deep rock) |
| Palette | palette `Uint16Array` + bit-packed index array   | default                           |
| Dense   | `Uint16Array(32768)`                             | worker scratch only, never stored |

Palette index width is 1, 2, 4, 8, or 16 bits (power of two so an index never
straddles a `u32` word). Width grows when the palette overflows and shrinks on
compaction. Voxel order inside the index array is `x + z*32 + y*1024` (y-major
layers), so a horizontal slice is contiguous.

Implemented as `ChunkData` (`src/world/chunk.ts`; `voxelIndex()` in
`src/world/coords.ts`). Index i sits in word `i >> (5 - log2(bits))` at bit
`(i & (32/bits - 1)) * bits`. A uniform chunk is width 0 with a one-entry palette.
Between threads a chunk travels as `ChunkParts` (`bits`, trimmed `palette`,
`words` or null), whose buffers can be transferred. Payload sizes: uniform 2 B;
2 ids 4 KiB; 3-4 ids 8 KiB; 5-16 ids 16 KiB; 17-256 ids 32 KiB; more 64 KiB, each
plus the palette.

Uniform chunks carry the volume: most chunks of a terrain world are all air or all
rock, and the generator classifies them from column height bounds without evaluating
voxels. Treat uniform as the common case in every code path.

Chunk payloads live in a `SharedArrayBuffer` pool when `crossOriginIsolated` is
true, so mesh workers read a chunk and its neighbors without copies. Otherwise they
are copied to workers per job. Chunk voxels start on the GPU (voxelized from the
world SDF) and are read back once; the CPU copy is never uploaded again. Only quads
and far-field bricks go to the GPU. See "Payload arena" for the block layout.

## Payload arena

Implemented (`PayloadArena` in `src/world/arena.ts`, used by `ChunkStore` in
`src/world/store.ts`). One buffer (SharedArrayBuffer when `canShareMemory()`, else
ArrayBuffer) holds every non-uniform chunk's payload as one block. Uniform chunks
store only their id in the slot record and use no arena memory.

Block layout, at a 4-byte-aligned byte offset:

```
offset             field      type                      notes
0                  bits       u32                       0, 1, 2, 4, 8, 16
4                  palette    u32                       palette length
8                  words      u32                       index word count
12                 reserved   u32
16                 palette    u16 x palette length      padded to 4 bytes
16 + pad4(2 * n)   words      u32 x word count          as ChunkData
```

Blocks come from power-of-two size classes, 256 B to 256 KiB. `readParts(buffer,
offset)` gives views (no copy); workers use it on the shared buffer, or on a block
copied out to offset 0 on the copy path. Only the main thread allocates and writes
the arena. Workers produce blocks too, with `writeBlock()` at offset 0 of a pooled
output buffer (`chunk.compress` job); the main thread copies those bytes in with
`ChunkStore.putBlock()`.

Store handles: `generation * 2^22 + slot`, generation 31 bits, so handles stay
exact doubles. A handle kept past `remove()` reads as stale.

## Packed quad

One quad is 8 bytes: two `u32` words, one `vec2<u32>` element of the quad arena
storage buffer.

```
word0  bits 0-4    x      local voxel coordinate of the quad's min corner
       bits 5-9    y
       bits 10-14  z
       bits 15-19  w - 1  extent along the face's first tangent axis
       bits 20-24  h - 1  extent along the face's second tangent axis
       bits 25-27  face   0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z
       bits 28-31  light base, the quad's lowest corner level 0-15
word1  bits 0-15   block id
       bits 16-23  AO, 2 bits per corner, corner order fixed per face
       bits 24-31  light offsets, 2 bits per corner above the base
```

Coordinates are voxel positions, 0..31. For positive faces the shader adds 1 along
the normal, so a quad on the +X face of voxel 31 still fits in 5 bits.

Tangent axes per face: X faces use (z, y), Y faces use (x, z), Z faces use (x, y).
The mesher and the vertex shader must agree on this table and on the corner order
used by AO.

AO byte (baked AO won the phase 5 spike; `?ao=0` meshes without it): corner k at
bits 16 + 2k, corners in `quadCorners()` order (0 min,
1 +U, 2 +U+V, 3 +V), each the occlusion level 0 (none) to 3 (full). A mesh built
without AO has 0 everywhere and reads as unoccluded. Computed by `faceAo()` in
`src/mesh/ao.ts` from a padded 34^3 opacity grid (`padIndex()`, same axis order as
the voxel index) whose shell holds the 26 neighbors' touching voxels (`fillShell()`,
neighbors in `src/mesh/neighbors.ts` order). AO joins the merge key, so every voxel
under a quad has the quad's AO byte.

Block light (plan-living-world phase 4; `?light=0` meshes and draws without it) needs
twelve bits and neither word has twelve spare, so it is split: the quad's lowest corner
level in word0's four, and each corner's step above it (0 to 3) in word1's eight, corners
in the AO byte's order. A corner more than three levels above the base is clamped, which
is a one-level error at the foot of a light. Computed by `faceLight()` in
`src/mesh/light.ts` from a padded level grid (`lightIndex()`, 32 + 2 * `LIGHT_REACH` a
side) that the mesh job flood fills from the lights in the 27 chunks it holds. Light joins
the merge key beside AO, so a pool of light under a glowing block breaks its quads into
steps. A light's own faces carry zero: they already draw the block's emission.

A padding quad (to fill a short cluster) is all zero bits in both words with block
id 0; the vertex shader collapses it to a degenerate position.

TS side implemented: `encodeWord0/1`, `decodeQuad`, `quadCorners` and the face
tables in `src/mesh/quad.ts` (plan-meshing phase 1). The WGSL decode
(`quad_vertex()` in `src/render/near.wgsl`) matches `quadCorners()`: min corner,
plus one along the normal for positive faces, then `+ w*U`, `+ w*U + h*V`,
`+ h*V`. Triangles: corners `QUAD_TRIANGLES` (0 1 2, 0 2 3), or
`QUAD_TRIANGLES_FLIPPED` (0 2 1, 0 3 2) on faces 0, 2, 5 where U x V points against
the normal (`FACE_FLIP_MASK`), so every triangle is counter-clockwise seen from
outside. The vertex shader rotates that fan to start at corner 1 when
`ao[0] + ao[2] > ao[1] + ao[3]`, which splits the quad along the darker diagonal
without changing the winding ([gotchas.md](gotchas.md) "AO anisotropy"); pipelines cull back faces with `frontFace: "ccw"` (tested against the
camera matrices in `src/render/near_test.ts`).

Neighbor boundary planes (mesher input, `src/mesh/planes.ts`): 6 planes x 32 u32;
in plane f, bit u of word v is the opacity of the adjacent chunk's touching voxel at
(coordinate along U of f, coordinate along V of f).

## Cluster descriptor

The mesher splits each face group into clusters of up to `CLUSTER_QUADS` quads
(32, chosen by the plan-rendering phase 1 sweep). A cluster's quads are contiguous in
the arena and padded to `CLUSTER_QUADS`. One descriptor per cluster, 16 bytes,
`vec4<u32>` in the cluster table storage buffer:

```
x  bits 0-31   arena offset of the cluster's first quad (in quads)
y  bits 0-19   chunk slot index (into the chunk table)
   bits 20-22  face
   bit  23     translucent
   bits 24-31  quad count (actual, not padded)
z  bits 0-4    AABB min x     bits 15-19  AABB max x (inclusive)
   bits 5-9    AABB min y     bits 20-24  AABB max y (inclusive)
   bits 10-14  AABB min z     bits 25-29  AABB max z (inclusive)
w  reserved (flags, LOD)
```

AABB coordinates are local voxel positions; the cull shader adds the chunk origin
and extends positive faces by one along the normal.

TS side implemented (plan-meshing phase 4): `ClusterBuilder`, `decodeCluster`,
`encodeClusterY`, `encodeClusterAabb` in `src/mesh/cluster.ts`. The mesher writes
`x` relative to the chunk's first quad and leaves the slot field 0; the renderer
adds the arena base and fills the slot on upload. The 8-bit count caps
`CLUSTER_QUADS` at 255. The cull shader must mirror `decodeCluster()`.

## Mesh job and output

Implemented (plan-meshing phase 6). The "chunk.mesh" job (`src/mesh/job.ts`) takes
`refs`, 7 entries of 2 i32 (the chunk, then the neighbor across face 0..5):
`[state, offset]`, state >= 0 a uniform id, `REF_BLOCK` (-1) an arena block at
`offset` of the job's buffer, `REF_MISSING` (-2) outside the world (reads as air).
The blocks are in the shared arena, which each worker received once
(`WorkerPool.share()`, id `ARENA_SHARE_ID`) and the job names by `sharedId`; or,
on the copy path (`sharedId` -1), in a pooled `buffer` holding only those blocks
(transferred in and back). Built by `MeshScheduler.submit()`
(`src/world/mesh-scheduler.ts`).

With `input.ao` the job sends all 26 neighbors (`REF_ALL`), not just the six faces, for
the AO shell. `input.light` bakes block light from the same 26, and needs them: a light
up to `LIGHT_REACH` voxels outside the chunk still reaches into it.

Output, one buffer per chunk (`src/mesh/output.ts`, `writeMeshOutput` and
`readMeshOutput`):

```
offset      field           type                  notes
0           quadCount       u32                   padded: clusterCount x cluster size
4           clusterCount    u32
8           opaqueClusters  u32                   opaque first, then translucent
12          realQuads       u32                   quads excluding padding
16          quads           vec2<u32> x quadCount packed quads, cluster order
16 + 8q     clusters        vec4<u32> x clusters  cluster descriptors, offsets chunk-relative
```

Within each half, clusters are grouped by face 0..5. The renderer uploads quads and
descriptors as they are, adding the arena base to each descriptor's offset and
filling the slot field.

## Chunk table

One entry per resident chunk slot, 16 bytes, `vec4<i32>`:

```
x, y, z   chunk coordinate
w         flags: bit 0 resident; others reserved
```

The cull and vertex shaders compute `chunk - cameraChunk` in `i32`, multiply by 32,
add local coordinates, then convert to f32.

Used by the phase 1 spike (`NearField`, `src/render/near-field.ts`): slots are its
own, not the store's, and the cluster descriptor's slot field indexes this table.

## Camera uniform

Implemented. Written once per frame by `CameraUniform.write()` in
`src/render/camera-uniform.ts`; read as `struct Camera` in `src/render/camera.wgsl`,
bound at group 0, binding 0 for every pipeline:

```
offset  field          type       notes
0       view           mat4x4f    render space -> view space
64      view_proj      mat4x4f    render space -> clip, reversed-Z infinite
128     inv_view_proj  mat4x4f    clip -> render space; depth 0 unprojects to a direction
192     chunk          vec4<i32>  camera chunk coordinate; w unused
208     offset         vec4f      eye in render space, each in [0, 32); w unused
224     viewport       vec4f      width, height, 1 / width, 1 / height (pixels)
240     time           vec4f      x: seconds, wrapped into WIND_PERIOD; yzw unused
```

256 bytes. The clock wraps rather than running away, so f32 keeps its resolution; every
animation term's period divides `WIND_PERIOD` (`src/render/camera-uniform.ts`), which is
what makes the wrap invisible.

Matrices are computed in float64 (`src/util/mat4.ts`) and rounded to f32 only here.
They contain no large translations: render space puts the eye within one chunk of
the origin.

## World program

Implemented, and the same contract in all three consumers: the SDF preview, the GPU
voxelizer and the far field's brick builder. A world is a WGSL file in `src/worlds/`,
registered in `WORLDS` (`src/worlds/index.ts`) with a spawn point above its surface and
optionally the name of a sky and lighting preset (`SKIES` in `src/render/sky.ts`;
`DEFAULT_SKY` when unset), and selected with `?world=<name>`.
Shaders that evaluate a world concatenate, in order: the generated block constants
(`blockConstantsWgsl()` in `src/world/blocks.ts`), `src/sdf/lib.wgsl`, the world
file (`worldSources()` in `src/sdf/sources.ts`). A world defines:

```
const WORLD_LIPSCHITZ: f32                   // bound on |gradient of world_sdf|, >= 1
fn world_sdf(p: WorldPoint) -> f32           // signed distance in voxels, < 0 inside
fn world_material(p: WorldPoint) -> u32      // block id; only called where solid
```

`WorldPoint` (lib.wgsl) is `{ cell: vec3i, frac: vec3f }`: integer voxel coordinate
plus a fraction in [0, 1), exact at any distance. Worlds turn it into local
coordinates with `wp_local(p, anchor)` (exact near an integer anchor), `wp_repeat`
(exact domain repetition), or `wp_f32` (plain vec3f, coarse far away). Noise (`fbm2`,
`fbm3`, `ridged2`, `gnoise3`) samples power-of-two wavelength lattices through
`wp_lattice(p, k)`, so it doesn't band at any distance (checked: smooth to 1/64
voxel at x = 1e6).

Rules:
- Worlds use block ids only through the generated `BLOCK_<NAME>` constants.
- `world_seed` is a `var<private>` in lib.wgsl. Every entry point sets it from its
  uniform before evaluating the world; world code reads it, never writes it.
- `sample_footprint` (also `var<private>`, voxels) is the size one sample stands
  for: 1 when voxelizing, a pixel's width in the preview, a cell size for far-field
  bricks. Entry points set it; library noise skips octaves finer than it. A skipped
  octave reads as the noise mean (0 for fbm), so world features defined by zero
  crossings (caves) must check `sample_footprint` and drop out at coarse scales.
  Worlds may also use it for their own level of detail.
- `world_sdf` need not be an exact distance, but `WORLD_LIPSCHITZ` must bound its
  gradient. The preview steps by `d / WORLD_LIPSCHITZ`, so an underestimated bound
  shows up as holes or overshoot in the preview before it deletes voxels.
- Generation code must be a pure function of (world, seed, position): no time, no
  camera, no per-frame state.

World uniform (preview, group 1 binding 0; `SdfPreview` writes it once):

```
offset  field    type                 notes
0       seed     u32                  then 3 u32 padding
16      colors   array<vec4f, 256>    block display color by id (blockColorTable)
```

## Brush instance

Implemented for the CPU store (plan-world-modelling phase 1); the voxelize batch and
the WGSL fold use the same record (phase 5). Written by `writeInstance()` in
`src/brush/format.ts`, read there and by the field fold in `src/brush/field.ts`.

16 u32, 64 bytes, four vec4 loads:

```
word   field
0-2    cell            i32 x3   anchor, a world voxel coordinate
3      inverse rotation 0-8, rotation 9-17, kind 18-19, blend 20-22
4      SDF type 0-15, material 16-31
5      ops offset               word index into the op pool
6      ops count 0-15, Lipschitz bound 16-31 (8.8 fixed, at least 1)
7      scale           f32      uniform; 1 for voxel brushes
8-10   local box min   f32 x3
11-13  local box max   f32 x3
14     blend radius k  f32      BLEND_SMIN and BLEND_SMAX
15     spare
```

Kinds: 0 SDF (a WGSL function per type, parameters in the pool), 1 CSG (an
interpreted op list, still a field), 2 voxel (ordered voxel writes, not a field).
Blends: 0 union, 1 subtract, 2 intersect, 3 smin, 4 smax. An instance may only use
union, subtract and smin (`INSTANCE_BLENDS`): intersect and smax turn solid into air
everywhere outside the brush, so they have no bounded range and belong inside a CSG
op list, where they meet another op rather than the world.

Rotation is one of the 24 rotations of the cube, packed as a signed permutation: for
each output axis r, bits 3r..3r+1 hold the source axis and bit 3r+2 the sign (1 is
negative), so `out[r] = sign(r) * v[source(r)]`. Both the rotation and its inverse
are in the record, so a shader unpacks bits and never indexes a table.
`src/brush/orientation.ts` owns the 24 and their inverses; orientation 0 is the
identity.

Rules:
- The anchor is an integer voxel, never an f32 world position (CLAUDE.md
  "Invariants"). Local coordinates come from `wp_local(p, anchor)`.
- A brush's reported distance may be smaller in magnitude than the true distance to
  its surface, never larger. Outside its box a brush reports the distance to that
  box, and is still folded in: dropping a union brush claims empty space where it
  sits, and dropping a subtract brush claims solid where it carves.
- The Lipschitz bound covers the brush's own field. A chunk's bound is the max over
  the world's and every brush reaching it.
- A brush is indexed into every chunk within its box plus `BRUSH_INDEX_PAD` and its
  blend radius, but only chunks within its box plus the blend radius and a voxel can
  change a voxel. Never use the index range to decide what to regenerate.
- Animate by changing the record, never by reading a clock in a field function:
  generation is pure in (world, seed, brush set, position) at every instant.
- Scale is uniform. Non-uniform scale divides the usable bound by the smallest axis.

## Brush ops

One `u32` pool holds every op list, addressed by the instance record's offset and
count. Builders in `src/brush/build.ts`; bounds and word counts in
`src/brush/format.ts`.

CSG op, `CSG_HEADER_WORDS` + `PRIM_PARAMS[prim]` words:

```
word   field
0      blend 0-7, primitive 8-15, material 16-31
1      blend radius k               f32
2-4    local center                 f32 x3
5..    primitive parameters         f32, per PRIM_PARAMS
```

Primitives mirror `src/sdf/lib.wgsl`: 0 sphere (r), 1 box (half3), 2 round box
(half3, r), 3 torus (major, tube), 4 capsule (a3, b3, r), 5 cylinder (half height,
r), 6 ellipsoid (r3). Ops fold left to right, so the first op's blend is ignored and
the list needs no stack. A Bezier tube is not in the set yet.

Voxel op, `VOXEL_HEADER_WORDS` + `SHAPE_PARAMS[shape]` words:

```
word   field
0      mode 0-7, shape 8-15, block id 16-31
1      match block id 0-15          VOXEL_REPLACE only
2..    shape parameters             i32, local voxel coordinates
```

Modes: 0 set, 1 carve, 2 replace, 3 paint. Shapes: 0 voxel (p3), 1 box (min3, max3,
inclusive), 2 sphere (c3, r), 3 ellipsoid (c3, r3). Ops apply in order and the last
writer wins, so a voxel op list is a sequence, not a field. Bounds treat voxel
(lo..hi) as the half-open box [lo, hi + 1), so the field-stage box rules apply
unchanged.

A voxelize batch's field brushes (`BrushBatch` in `src/brush/batch.ts`, read by
`brush_fold` in `src/brush/brush.wgsl`) go to the GPU as three buffers: the instance
records, each chunk's run contiguous; the op words those records point at, with the
record's op offset rewritten to index them; and one `vec4u` per chunk holding
`(first record, record count, Lipschitz in 8.8 fixed, unused)`. Voxel brushes are not
in it.

Packed chunk ops (`packChunkOps` in `src/brush/voxel-ops.ts`, read by
`applyChunkOps` in the compress worker) carry one chunk's voxel brushes in sequence
order, self-contained so the worker needs no store:

```
word   field
0      instance count                   u32
per instance:
0-2    anchor cell                      i32 x3
3      rotation code                    u32
4      op word count                    u32
5..    op words
```

## Voxelizer output

Implemented (plan-sdf-generation phase 2). Written by `voxelize.wgsl`, read by
`Voxelizer` (`src/sdf/voxelizer.ts`). A batch holds up to `BATCH_SIZE` chunks.

Per chunk header, 16 bytes (`struct ChunkHeader`):

```
offset  field    type         notes
0       solid    atomic u32   voxels with a nonzero block id
4       min_id   atomic u32   over solid voxels; CPU initializes to 0xFFFFFFFF
8       max_id   atomic u32   over solid voxels; CPU initializes to 0
12      pad      u32
```

Chunk kind, computed identically by `chunkKind()` (TS) and `is_dense()` (WGSL):
air when `solid == 0`; uniform when `solid == 32768` and `min_id == max_id` (the
id is `min_id`); dense otherwise.

Dense payload: 32768 u16 block ids, two per u32 (lower x in the low half), voxel
order `x + z*32 + y*1024` as in "Chunk storage". `compact_dense` packs dense
payloads to the front of the compact buffer in batch order, so the CPU maps only
`dense_count * 64 KiB`. Readback is two async maps per batch: headers, then the
dense prefix. Block id 0 is air: a world whose `world_material` returns 0 for a
solid voxel produces air there.

## Brick and clipmap

The far field stores occupancy in bricks of 8 x 8 x 8 cells.

| Item          | Layout                                                                   |
|---------------|--------------------------------------------------------------------------|
| Occupancy     | 512 bits = 16 `u32` in the brick pool storage buffer                     |
| Cell order    | `x + y*8 + z*64`, bit `i & 31` of word `i >> 5`                          |
| Material      | one `u8` block id per cell, four per `u32`, after the occupancy words    |
| Indirection   | one `u32` storage buffer, L slices of B x B x B, toroidal (`brick mod B`) |
| Entry values  | `0` empty, high bit set: solid throughout, block id in the low byte, else `slot + 1` |

Level k has cell size 2^k voxels, so one brick covers 8 * 2^k voxels per side and
a level covers `B * 8 * 2^k`. Levels start at k = 1; level 0 is the rasterized near
field. B and the level count are tuning parameters owned by
[plan-far-field.md](plan-far-field.md).

A cell's `u8` names a block id, and the far field looks it up in the far color table
(`farColorTable` in `src/world/blocks.ts`), not the display color table the near field
draws with. Alpha in that table is 1 exactly where `BLOCK_FAR_SOLID` says the id is
solid, which is the one rule both brick builders apply (`src/far/reduce.ts` on the CPU,
`far-build.wgsl` on the GPU). Everything but air is solid there, translucent blocks
included: the far field has no blending, and a sea drawn as its own bed is worse than
one drawn as opaque water. A block may carry its own far color for this, which is what
water does. Ids at or above 256 clamp to 255.

The solid-throughout entry (`ENTRY_SOLID` in `src/far/reduce.ts`) carries its own
block id and costs no pool slot, which is what keeps the pool to the surface:
underground every brick is solid stone, and there are far more of those than there are
bricks holding a surface. A brick in the pool is at `slot * BRICK_WORDS`, and slots are
handed out by `src/far/pool.ts`; which slot a brick gets is decided by the GPU build
(it is the one that knows which bricks are occupied) and reported back, so the CPU can
free a slot when its brick scrolls out.

Level k's slice starts at `level * B^3`, and a brick's cell inside it is `brick mod B`
per axis, so scrolling the window rewrites one slab rather than moving every brick.
The march undoes that with the level origin it is given.

Two shaders read this layout: the far field's own march (`src/far/far.wgsl`) and the
shadow marcher the near field's fragment stage runs against the same buffers
(`src/far/shadow.wgsl`, bound at group 2 there). The shadow marcher keeps its own copies
of `brick_entry` and `cell_solid` because it is compiled into a different shader, so a
change here is a change in both files.

## Changing a format

- Bump a format version constant and update the encoder and decoder in the same
  change. A mesher and a shader that disagree produce plausible-looking garbage, not
  errors.
- Update the layout block here.
- WGSL struct layout has alignment rules (`vec3` aligns to 16 bytes). Prefer `vec4`
  and packed `u32` fields so the TS writer and the WGSL reader can't disagree on
  padding.
- Run the format round-trip tests (encode in TS, decode with a TS port of the shader
  decode) before looking at pixels.
