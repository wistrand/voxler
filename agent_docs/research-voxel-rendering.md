# Research: voxel rendering options under WebGPU

Options weighed for each major decision, and why the current choice won. Citations
are from prior knowledge and were not re-checked when this was written; verify
specifics before relying on them. When a spike or benchmark settles an open item,
record the result here with the numbers.

## Contents
- Platform
- Overall shape: hybrid
- Near-field meshing
- Ambient occlusion
- Vertex format and draw submission
- Culling
- Far field
- SDF world generation
- Language and threading
- Rejected or deferred
- References

## Platform

WebGPU is the only target. What it gives over WebGL2, and what the design uses:

| Capability                  | Used for                                            |
|-----------------------------|-----------------------------------------------------|
| Compute shaders             | GPU culling, Hi-Z pyramid, far-field ray march      |
| Storage buffers             | quad arena, cluster table, chunk table, brick pool  |
| Atomics in storage buffers  | visible-cluster append, indirect argument counts    |
| `drawIndirect`              | one GPU-built draw for the whole near field         |
| [0, 1] depth range          | reversed-Z with `depth32float`                      |
| Explicit async readback     | stats only; no sync stalls exist in the API         |

Still missing or optional, and what it costs us:

| Missing or optional                     | Consequence                                                  |
|-----------------------------------------|--------------------------------------------------------------|
| 64-bit integers, f64 in WGSL            | Bit structures use `u32`; positions are camera-relative f32. |
| Multi-draw indirect (not in the spec)   | Near field is drawn as one cluster-list draw instead.        |
| `timestamp-query` (optional, quantized) | GPU timing is coarse and may be absent.                      |
| `subgroups` (Chrome only)               | Compaction and prefix sums need a non-subgroup path.         |
| Compatibility mode                      | No vertex-stage storage buffers; core feature level required. |
| Browser and OS coverage                 | See [research-webgpu-support.md](research-webgpu-support.md). |

Design rule that follows: per-frame CPU work scales with changes (new meshes, edits,
clipmap slabs), never with the number of resident chunks or clusters. Everything
that touches every resident item per frame runs in compute.

## Overall shape: hybrid

| Option                          | Strength                                    | Weakness                                             |
|---------------------------------|---------------------------------------------|------------------------------------------------------|
| Meshes only (with LOD meshes)   | One pipeline, cheap per pixel               | Memory and remesh cost grow with distance squared    |
| Ray-march only                  | Fixed cost per pixel, huge extents          | Full-res near field is ALU-bound; edits costly      |
| Hybrid (chosen)                 | Raster where detail is dense, march where sparse | Two pipelines, a composite seam to get right    |

Rasterized greedy quads are the cheapest way to draw the near field, where every
voxel face covers several pixels and edits are frequent. Beyond a few hundred voxels
a quad covers under a pixel, mesh memory dominates, and marching a coarse structure
costs less per pixel than drawing the triangles.

## Near-field meshing

| Option                           | Notes                                                                          |
|----------------------------------|--------------------------------------------------------------------------------|
| Naive culled faces               | One quad per exposed face. Simple; kept as the test oracle.                   |
| Greedy (Lysenko)                 | Merges coplanar faces of equal type. Per-voxel loops, branchy.                |
| Binary greedy, CPU workers (chosen) | Occupancy as bit columns; culling and merging are bit ops.                 |
| Binary greedy, GPU compute       | Parallel per column. Needs voxel data resident on the GPU and output compaction. |
| Marching cubes / dual contouring | Smooth surfaces. Out of scope: blocky engine.                                  |

CPU meshing won because voxel data lives on the CPU for edits and raycasts anyway
(generation runs on the GPU and is read back, plan-sdf-generation); worker cores are
otherwise idle; and a GPU mesher would need a second copy of every near-field chunk
in GPU memory plus a compaction pass. Revisit if readback plus CPU meshing proves
slower than meshing on the GPU right after voxelization. Revisit if
worker meshing becomes the bottleneck during fast flight.

Binary greedy meshing as popularized (cgerikj/binary-greedy-meshing, C, 64-bit
columns on 62-voxel chunks plus padding) does not port directly: neither JS nor WGSL
has cheap `u64`. This project uses 32-voxel chunks with `u32` columns and passes the
neighbor boundary bit separately instead of padding. See
[plan-meshing.md](plan-meshing.md).

Decided (plan-meshing phase 7): TypeScript, no WASM for now. After working on packed
palette indices and bit transposes, the whole mesh job for a surface chunk runs in
about 60 us in a fast bench run (about 150 us scaled to the slowest run seen), far
under the 0.5 ms target, and one worker outpaces the voxelizer several times over.
Revisit only if meshing shows up as a limit in the browser.

## Ambient occlusion

| Option                        | Notes                                                                     |
|-------------------------------|---------------------------------------------------------------------------|
| Baked per-vertex (chosen)     | Lysenko's four-corner AO in the quad, computed in the mesher from a 34^3 shell. |
| Shader AO from occupancy bits | Per-chunk bitset on the GPU, eight reads per fragment. Merging stays maximal. |
| Screen-space AO               | A post pass. Halos and temporal noise on hard voxel edges; no voxel truth. |
| Precomputed light propagation | Deferred with flood-fill lighting ("Rejected or deferred").                |

Decided (plan-rendering phase 5, both halves measured): baked AO. The cost is paid
where it can be culled away instead of per fragment: AO joins the merge key, which
costs 1.8x the quads, 1.6x the clusters, and 14 MiB of extra arena at radius 16, and
the mesh job needs all 26 neighbors instead of 6. Shader AO keeps merging maximal,
but a probe of its fragment work (real addresses and access pattern, no uploads)
came out worse at ground level and only even from above, before counting the 4 KB
per chunk it would upload, the 17 MiB it would hold, and the chunk-border lookup it
would still need. Numbers and the probe's method in
[plan-rendering.md](plan-rendering.md) phase 5; mesher-side costs in
[plan-meshing.md](plan-meshing.md) phase 5. Revisit if the near field becomes
vertex-bound at a larger radius, or if the quad arena becomes the constraint.

## Vertex format and draw submission

Quads are 8 bytes in a storage-buffer arena and are expanded by vertex pulling. The
open choice is how draws are issued:

| Option                                              | CPU per frame       | Notes                                               |
|-----------------------------------------------------|---------------------|-----------------------------------------------------|
| Direct draw per chunk face group                    | O(visible chunks)   | Simple; CPU culling; thousands of draw calls        |
| Render bundle of per-slot `drawIndirect`, GPU writes counts | flat        | Bundle rebuilt when slots change; many tiny draws   |
| Multi-draw indirect                                 | flat                | Not in the spec; Chrome experimental flag only      |
| Cluster list + one `drawIndirect` (chosen)          | flat                | GPU culling per cluster; padding waste per cluster  |

Cluster rendering: the mesher splits each face group into clusters of up to a fixed
number of quads and records each cluster's AABB. A compute pass culls clusters and
appends visible cluster ids to a list, then writes the instance count of one
`drawIndirect`. The vertex shader maps `instance_index` to a visible cluster and
`vertex_index` to a quad and corner within it. Short clusters are padded with
degenerate quads, which cost vertex work only.

This needs only core WebGPU. The cluster size trades padding waste against culling
granularity; set from the phase 1 spike in [plan-rendering.md](plan-rendering.md).

Phase 1 spike results (`?bench=spin` on terrain, Chrome 152, Linux, Arc B390,
1920x1080; every run drew the same 2,463 chunk meshes, 1,391,738 quads, no culling):

| Setup              | Clusters | Padded quads | Padding | Vertices   | gpu.near p50 / p99 | cpu.render p50 | Draws  |
|--------------------|----------|--------------|---------|------------|--------------------|----------------|--------|
| clusters of 32     | 50,627   | 1,620,064    | 14.1%   | 9.7 M      | 2.35 / 4.51 ms     | 0.27 ms        | 1      |
| clusters of 64     | 29,206   | 1,869,184    | 25.5%   | 11.2 M     | 2.44 / 2.95 ms, 4.34 / 5.41 ms (two runs) | 0.28-0.31 ms | 1 |
| clusters of 128    | 18,811   | 2,407,808    | 42.2%   | 14.4 M     | 2.44 / 3.84 ms     | 0.28 ms        | 1      |
| direct, per group  | n/a      | 1,391,738    | 0%      | 8.4 M      | 1.40 / 4.52 ms     | 0.91 ms        | 13,819 |

Cluster quad order: the mesher's own (`ORDER_EMISSION`). With two-phase culling
running, Morton-ordered clusters drew 2% more per frame on the same flyover and
hid about as many, at 3x the clustering cost (plan-rendering phase 4).

Chosen: 32 quads per cluster (`CLUSTER_QUADS`). The padding and vertex counts are
exact; the GPU times are not: two runs of the identical 64 setup gave 2.44 and
4.34 ms p50, so differences under about 2x are noise here. Within that noise,
smaller clusters cost nothing measurable and save padding (memory and vertex
work), and they cull at a finer grain once culling exists. Revisit with culling
on (plan-rendering phases 3-4).

Direct per-group draws were the fastest on the GPU in its run (fewest vertices,
no descriptor fetch) but cost 13,819 draw calls and 0.9 ms of main-thread time
for 2,463 chunks, growing with the resident count, and they can't use GPU
culling. The cluster path stays. Worth trying later: an index buffer over 4
vertices per quad (drawIndexedIndirect), so shared corners run the vertex shader
once instead of twice, 33% fewer invocations on either path.

## Culling

| Technique                   | Where   | Chosen   | Notes                                                  |
|-----------------------------|---------|----------|--------------------------------------------------------|
| Frustum, cluster AABB       | compute | yes      | First test in the cull pass.                           |
| Face direction, per cluster | compute | yes      | Clusters belong to one face group; skips about half.   |
| Hi-Z occlusion, two-phase   | compute | yes      | Previous-frame visible set, pyramid, retest the rest.  |
| Cave culling (Checchi)      | CPU     | deferred | Hi-Z covers most of its benefit without a CPU walk.    |
| Hardware occlusion queries  | GPU     | no       | Per-object results need readback; Hi-Z does it better. |

Two-phase occlusion: draw clusters visible last frame, build the depth pyramid,
test all remaining clusters against it, draw the newly visible ones. This avoids
the one-frame holes that single-phase reprojection shows during fast turns.

## Far field

| Option                         | Edits           | Memory           | Traversal                                          |
|--------------------------------|-----------------|------------------|----------------------------------------------------|
| LOD meshes (Distant Horizons)  | remesh          | grows with range | normal raster                                      |
| 3D texture + mip DDA           | cheap           | dense, large     | simple                                             |
| SVO / ESVO (Laine, Karras)     | moderate        | compact          | pointer chasing in storage buffers                 |
| SVDAG (Kämpe et al.), SSVDAG   | expensive       | very compact     | as SVO, worse for edits                            |
| HashDAG (Careil et al.)        | supported       | compact          | hash lookups in shader, complex                    |
| Brickmap clipmap (chosen)      | rewrite a brick | fixed per level  | two-level: indirection entry, then brick bits      |

Brickmap (van Wingerden) won because traversal is shallow, memory per level is fixed
and known up front, edits rewrite a handful of bricks, and a camera-centered clipmap
with toroidal addressing updates only the slabs that scroll in. Storage buffers make
SVDAG practical under WebGPU, so it stays on the list for a possible static-scene
mode where compression matters more than edits.

The march runs in a compute shader into a storage texture. That enables a beam
pre-pass (ESVO): march coarse tiles first to find a conservative start distance per
tile, then march full pixels from there.

## SDF world generation

Worlds are defined by a signed distance function plus a material function, so any
consumer can sample them at its own resolution. Where that code runs:

| Option                              | Speed          | Author experience              | Determinism          |
| ----------------------------------- | -------------- | ------------------------------ | -------------------- |
| TypeScript in workers               | slowest        | TS; GLSL hand-translated        | identical everywhere |
| Node tree compiled to TS and WGSL   | fast on GPU    | only the provided nodes         | GPU per machine      |
| WGSL on the GPU (chosen)            | fastest        | shader code; GLSL ports easily  | per machine          |

WGSL won because the GPU evaluates the SDF billions of times per second, far-field
bricks can be filled on the GPU with no readback at all, and world code reads like
the shader code it is ported from. Near-field chunks do need a readback to reach the
CPU meshers; at 64 KiB per mixed chunk and with uniform chunks returning only a
flag, that is well within async readback bandwidth (to be measured in
plan-sdf-generation phase 2). This reverses the earlier "GPU generation: deferred"
decision, which assumed every chunk had to be generated at full resolution and read
back; with an SDF, most chunks are classified uniform from one sample and the far
field never reads back.

Cost accepted: f32 results can differ slightly between GPU vendors, so voxels at
surfaces may differ between machines. Generation stays deterministic per machine.

## Language and threading

- **TypeScript first.** Hot CPU kernels are pure functions over typed arrays, which
  V8 compiles well and which port directly to WASM if profiling demands it.
- **WGSL** for all GPU code.
- **Workers for all CPU voxel work.** Generation, meshing, and brick building run in
  a module-worker pool.
- **SharedArrayBuffer when available.** Requires cross-origin isolation. Fallback is
  copy-on-dispatch.
- **Render in a worker.** WebGPU works in workers with `OffscreenCanvas`. Deferred
  until main-thread cost is measured; see [plan-foundation.md](plan-foundation.md).

## Rejected or deferred

- **WebGL2 fallback.** Deferred. The GPU-driven near field and compute far field have
  no WebGL2 equivalent; a fallback would be a second renderer, not a backend switch.
- **CPU noise terrain generator.** Superseded by SDF world generation on the GPU
  (below and [plan-sdf-generation.md](plan-sdf-generation.md)).
- **Smooth voxels.** Out of scope.
- **LOD meshes for a mid field.** Deferred. If the gap between near raster and level-1
  far field shows popping, a 2x downsampled mesh ring is the fallback.
- **Flood-fill voxel lighting.** Deferred; AO plus directional light first.

## References

- Mikola Lysenko, "Meshing in a Minecraft Game" (0fps.net), greedy meshing.
- Mikola Lysenko, "Ambient occlusion for Minecraft-like worlds" (0fps.net).
- cgerikj, binary-greedy-meshing (GitHub), bitwise greedy meshing.
- Tommaso Checchi, "Advanced Cave Culling Algorithm", chunk connectivity culling.
- Amanatides and Woo, "A Fast Voxel Traversal Algorithm for Ray Tracing", 1987.
- Laine and Karras, "Efficient Sparse Voxel Octrees", 2010 (beam optimization).
- Kämpe, Sintorn, Assarsson, "High Resolution Sparse Voxel DAGs", 2013.
- Villanueva, Marton, Gobbetti, "Symmetry-aware Sparse Voxel DAGs", 2016.
- Careil, Billeter, Eisemann, "Interactively Modifying Compressed Sparse Voxel
  Representations" (HashDAG), 2020.
- Thijs van Wingerden, "Real-time Ray Tracing and Editing of Large Voxel Scenes"
  (brickmap), thesis.
- Two-phase occlusion culling as used in GPU-driven pipelines (Haar and Aaltonen,
  "GPU-Driven Rendering Pipelines", SIGGRAPH 2015 course).
- Distant Horizons (Minecraft mod): LOD meshes for far terrain.
