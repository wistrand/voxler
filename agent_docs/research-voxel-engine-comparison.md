# Research: voxel engine comparison

> Snapshot: 2026-09-13. External projects change; re-check their documentation
> before relying on implementation or support details.

## Conclusion

Voxler compares well as a specialized rendering architecture, but it is not yet a
complete game engine. Its distinguishing feature is the combination of a GPU-authored
procedural world, detailed block meshes nearby, and ray-marched clipmaps at distance
in a browser. Worlds can choose different clipmap shapes, their default reach is trimmed
to the distance their fog leaves visible, and an experimental runtime controller can
adjust build rate, reach, and march resolution when explicitly enabled.

Direct performance rankings are not justified. Voxler has measurements from one Intel
Arc B390 system, while the projects below publish different workloads or no comparable
benchmark.

| System | Main representation | Distant terrain | Main advantage over Voxler | Voxler's advantage |
| ------ | ------------------- | --------------- | -------------------------- | ------------------ |
| Minecraft and Sodium-style renderers | Stored chunk blocks converted to meshes | More chunks, fog, or a separate LOD system | Mature content, block models, simulation, ecosystem | GPU SDF generation, GPU Hi-Z culling, world-specific integrated far field |
| Godot Voxel Tools | Streamed voxel blocks and chunk meshes | Transvoxel LOD for smooth terrain | Physics, instancing, editor integration, smooth terrain | Greedy block meshing and working blocky far-field LOD |
| Voxelize | Server-authoritative stored voxel world | Conventional streamed chunks | Multiplayer, entities, physics, persistence | More specialized GPU rendering and an SDF-derived far field |
| Divine Voxel Engine | Minecraft-like voxel data and models | Conventional streaming | Models, state systems, fluids, power, PBR | Purpose-built WebGPU pipeline, clipmaps, SDF worlds |
| Voxel Plugin 2 | Procedural volume and height stamps | Nanite terrain | Unreal tools, materials, PCG, smooth terrain | Cubic block terrain and browser deployment |
| GPU binary-greedy engines | Chunk voxels and compact quads | Chunk ring buffers | Native APIs and fewer browser constraints | SDF generation, Hi-Z occlusion, clipmaps, clipmap-sourced near-field shadows |
| SVO and GVDB renderers | Sparse hierarchical voxels | The same hierarchy at coarser levels | Arbitrary volume detail and fully ray-cast scenes | Better fit for textured block surfaces and core WebGPU |

## Conventional block engines

Most block engines retain chunk voxel data as the authoritative world, mesh those
chunks, and submit render sections. Sodium, for example, maintains render-section
storage, asynchronous visibility work, chunk build jobs, and render lists.

Voxler instead evaluates a procedural world program on the GPU, moves per-frame cluster
visibility to compute, and generates indirect draw arguments on the GPU. Nearby chunks
are still stored and meshed so that exact block geometry, editing, collision queries,
and conventional surface shading remain possible.

Distant Horizons extends Minecraft by rendering simplified chunks beyond the normal
render distance. Voxler derives its distant representation directly from the world SDF
and stores it in a scrolling brickmap clipmap instead.

The Voxler approach provides one procedural source for near and far terrain and avoids
keeping full-resolution chunks to the horizon. Conventional engines support much more
block state, entity, gameplay, persistence, and authored-content machinery.

Sources:

- [Sodium render section manager](https://github.com/CaffeineMC/sodium/blob/dev/common/src/main/java/net/caffeinemc/mods/sodium/client/render/chunk/RenderSectionManager.java)
- [Distant Horizons](https://gitlab.com/distant-horizons-team/distant-horizons)
- [Voxler rendering plan](plan-rendering.md)
- [Voxler far-field plan](plan-far-field.md)

## Godot Voxel Tools

Godot Voxel Tools is broader than Voxler. It provides editable volumetric terrain,
paging, physics integration, instancing, blocky materials, and smooth Transvoxel LOD.
Its blocky mesher supports arbitrary voxel models but does not use greedy meshing.
Blocky LOD is listed as an area of interest rather than an established feature.

Voxler is narrower and more specialized for full cubes:

- Binary greedy meshing
- Eight bytes per quad
- GPU cluster culling
- Two-phase Hi-Z occlusion
- Camera-relative large coordinates
- A world-specific procedural view distance, with 32,768 available by override

Godot Voxel Tools is a better base for a conventional game because it brings the Godot
editor, physics, scene, asset, and scripting systems. Voxler has the more specialized
block-terrain renderer.

Sources:

- [Godot Voxel Tools](https://github.com/Zylann/godot_voxel)
- [Godot Voxel Tools blocky terrain](https://github.com/Zylann/godot_voxel/blob/master/doc/source/blocky_terrain.md)
- [Voxler format design](design-formats.md)

## Browser voxel engines

### Voxelize

Voxelize combines a Rust authoritative server, a TypeScript and Three.js client,
WebAssembly meshing, multiplayer, entities, physics, custom block geometry, and a
persistent production world.

Voxler is more specialized on the rendering side:

- Native WebGPU rather than a Three.js rendering abstraction
- GPU SDF voxelization
- GPU-generated indirect draws
- Two-phase Hi-Z occlusion
- Ray-marched far-field clipmaps
- Shadows marched through the far-field clipmap
- Approximate block light at far-field hits
- Optional runtime adaptation of far-field build rate, reach, and resolution

Voxelize is much further along as a multiplayer game platform. Voxler does not yet
provide equivalent server authority, networking, entities, physics, persistence, or
general block-model support.

Source: [Voxelize](https://github.com/voxelize/voxelize)

### Divine Voxel Engine

Divine Voxel Engine provides multithreaded world simulation, lighting, flow, power,
model-defined voxel geometry, archiving, and Babylon.js classic and PBR rendering. Its
WebGPU renderer is described as a development package.

Voxler has a deeper purpose-built WebGPU terrain path. Divine Voxel Engine has broader
voxel types, simulation systems, renderer integration, and content facilities.

Source: [Divine Voxel Engine](https://github.com/Divine-Star-Software/DivineVoxelEngine)

## Voxel Plugin 2

Voxel Plugin 2 focuses on interactive smooth terrain. Worlds are assembled from
procedural or static height and volume stamps, rendered primarily through Nanite, with
Unreal's material and PCG systems. Its documentation says cubic terrain is not
currently supported.

The products therefore solve different problems:

- Voxel Plugin targets production smooth-terrain authoring inside Unreal.
- Voxler targets exact cubic block worlds rendered directly in a browser.

Voxel Plugin has stronger tools, materials, physics integration, foliage integration,
and production workflow. Voxler is smaller, browser-native, and specialized for
block-scale procedural worlds.

Sources:

- [Voxel Plugin overview](https://docs.voxelplugin.com/getting-started/working-with-voxel-plugin/)
- [Voxel Plugin runtime edits and sculpting](https://docs.voxelplugin.com/2.0p7/knowledgebase/blueprints/runtime-edits-and-sculpting)

## Native GPU-driven block engines

The open-source C++ `VoxelEngine` is a close match to part of Voxler's near-field
architecture. It uses binary greedy meshing, eight-byte quads, a VRAM cache, compute
frustum culling, indirect rendering, and a three-dimensional chunk ring buffer.

The native engine can use OpenGL 4.6 facilities such as persistent mapped buffers and
multi-draw indirect. Voxler deliberately avoids multi-draw indirect and unsafe browser
features, using core WebGPU instead. Voxler adds GPU SDF generation, two-phase Hi-Z,
the far-field clipmap, near-field shadow rays through that clipmap, and a measured-cost
controller for far-field quality that is available as an experiment. The native engine currently supports
smaller chunk formats and does not document an equivalent far-field representation.

Source: [C++ GPU-driven VoxelEngine](https://github.com/omar-owis/VoxelEngine)

## Full sparse-volume ray casting

Sparse voxel octrees and systems such as NVIDIA GVDB ray-cast the volume itself. Laine
and Karras demonstrated compact octrees, contour data, per-voxel attributes, beam
optimization, and fully GPU-ray-cast geometry. GVDB provides dynamic sparse GPU
topology, resampling, volume computation, and ray tracing, but targets NVIDIA CUDA
rather than portable browser WebGPU.

Voxler makes a different trade:

- Rasterization handles detailed nearby block surfaces.
- Ray marching handles coarse distant terrain and shadows.
- There is no globally editable sparse octree to maintain.
- Far-field cells lose features below their current level's resolution.
- Textured blocks and translucent near geometry use a conventional surface pipeline.

This gives up arbitrary volumetric detail in exchange for a simpler representation
suited to editable block terrain and commodity WebGPU implementations.

Sources:

- [Efficient Sparse Voxel Octrees](https://research.nvidia.com/publication/2010-02_efficient-sparse-voxel-octrees)
- [NVIDIA GVDB Voxels](https://github.com/NVIDIA/gvdb-voxels)

## Far-field policy and optional adaptation

Far-field configuration is no longer one global preset. The terrain and forest start
from a 32-brick-wide, eight-level ceiling, but startup trims levels beyond the world's
fog horizon. They therefore allocate seven levels and reach 16,384 voxels by default.
The monument world uses six 64-brick-wide levels and also reaches 16,384 voxels. Its
wider levels retain finer cells at a given distance and suit a sparse, clear-air desert.
`?farLevels=` can override the fog-derived count; eight narrow levels reach 32,768
voxels.

The default is fixed after startup. An experimental controller is available through
`?farAdapt=1`, but is off because changing reach or resolution while the camera is still
causes a visible pop. When enabled, it evaluates the display period and GPU pass timings
about once per second. It changes three controls in this order when over budget:

1. Reduce brick slabs sampled per frame, increasing catch-up time without changing the
   settled image.
2. Remove outer clipmap levels, reducing reach where fog already dominates the image.
3. Reduce march resolution, which affects visible detail throughout the far field.

When headroom returns, it restores slab throughput first, then resolution, then reach.
The controller's configured range is three to eight levels, corresponding to about 512
to 32,768 voxels of reach for a 32-brick-wide clipmap with the default finest level, and
march scales from half to full resolution. Hysteresis and a settling delay after level
changes prevent oscillation on rebuild cost.

Fog-derived and per-world configuration are part of the normal renderer. Adaptive
quality is not yet part of the portability claim because users must opt into it. Bench
runs disable adaptation so their settings remain comparable.

Sources:

- [Adaptive controller](../src/far/adapt.ts)
- [Far-field plan](plan-far-field.md)
- [Monument Valley plan](plan-monument-valley.md)

## Far-field lighting limits

The near field bakes ambient occlusion and block light per quad corner. The far field
has no mesh, so it approximates block light at a hit by gathering the twenty-six
neighbouring cells and applying distance falloff. This removes the obvious lighting seam
around distant glowing blocks, but it is not the same solution: it reaches only one
coarse cell, does not flood around occluders, and has no ambient occlusion.

Near-field surfaces cast shadow rays through the clipmap, avoiding a shadow map and a
second scene draw. Far-field and preview surfaces remain unshadowed. The current claim
is therefore "the near field receives clipmap shadows", not "the whole world is
shadowed".

Sources:

- [Far-field block light](plan-far-field.md)
- [Living-world lighting and shadows](plan-living-world.md)

## Scale and performance evidence

The latest recorded grove benchmark, from before the subsequent far-field lighting and
default-resolution changes, records:

- 11,492 resident chunks, representing 376,569,856 full-resolution voxel positions
- 4,243,367 real near-field quads and 4,435,520 after cluster padding
- 12,052 visible clusters in the recorded final state
- Zero streaming holes
- A pinned far-field configuration, because adaptation is disabled in benchmarks

That forest run reached a 60 Hz-class p99 on the measured machine but did not hold 120
Hz continuously. Far-field slab sampling of the forest's expensive SDF was the main
intermittent cost. It should not be presented as current forest performance until the
grove is rerun with the later far-field changes.

The newest terrain flyover records 11,583 resident chunks, 2,196,563 real quads, zero
streaming holes, a 1.36 ms CPU-frame p50, a 2.10 ms near opaque p50, a 3.08 ms far-march
p50, and a 0.59 ms far-build p50. It missed 46 of 1,151 frames and its interval p99 was
16.67 ms, so the current full-resolution far field does not sustain 120 Hz throughout
that run. This supersedes the earlier blanket statement that all terrain scenes hold
120 Hz; the full suite has not yet been rerun in the new state.

These figures establish that Voxler's architecture works at its intended scale on the
development machine. They do not establish superiority over another engine because
there is no shared world, hardware matrix, renderer configuration, or benchmark path.

Sources:

- [Project performance table](../AGENTS.md#performance-targets)
- [Latest recorded grove benchmark](../bench/results/grove.20260912T182939Z.chrome-152-on-linux.json)
- [Latest recorded terrain flyover](../bench/results/flyover.20260912T201507Z.chrome-152-on-linux.json)

## What is worth borrowing

The comparison above is about position. This section is about technique: what the systems
named here do that the far field does not, ranked by what it would buy against what it
would cost. Nothing here is measured except where a number is given.

| Borrow | From | Buys | Cost |
| ------ | ---- | ---- | ---- |
| Reach derived from fog density | conventional engines, where fog and render distance are one setting | **landed**: one level of terrain and forest, about 5% of the march and 12% of the slabs, for no visible change | a few lines |
| ~~Skip a brick the near field wholly covers~~ | nothing external, it is the coverage mask used at brick granularity | **tried and reverted**: measured no faster at all, twice | the reason it fails is worth knowing, below |
| Normals reconstructed from the occupancy bitmask | Laine and Karras, contours | distant rock stops reading as a staircase of 64-voxel cubes | a gradient per hit, plus a judgement about style |
| Shadows in the far field | nothing external, `shadow.wgsl` already exists | the ring where cast shadows stop is currently visible | a second march per hit pixel: expensive |
| Blending across a level boundary | Distant Horizons, which dithers its LOD transitions | the level rings stop being hard edges | shading two candidates near a window edge |
| Empty-run skipping inside a brick | NanoVDB and GVDB bitmask hierarchies | fewer of the up-to-24 cell steps in an occupied brick | a row-mask test in the inner loop |
| A coarse-to-fine beam pre-pass | Laine and Karras, beam optimization | grazing rays, which is where the march is worst | a second beam pass |

### Reach derived from fog density

`apply_fog()` mixes toward `sky_color(dir)`, which is exactly what the sky pass draws
behind a miss. A hit whose extinction is 99.5% therefore differs from drawing nothing by
half a percent of the difference between the surface and the sky, which is about one
value in 8-bit. Everything the clipmap reaches past that point is work whose result is
not visible.

The distance is `ln(200) / FOG_DENSITY`: 15,134 voxels for `day`, 10,594 for `night`,
37,875 for `desert`. The configured eight-level ceiling reaches 32,768, so `terrain` and
`forest` would march one level and most of another that fog has already closed without
the startup trim. Measured on terrain,
looking at the horizon at 1080p: 2.36 ms p50 at eight levels, 2.16 at seven (a reach of
16,384, still past the fog horizon), 1.90 at six (8,192, which does cut visibly: 94%
extinction leaves 6% of the surface showing).

Landed: the allocated level count is the world's own, trimmed to its fog horizon
(`fogHorizonVoxels()` in `src/render/sky.ts`, `levelsForReach()` in
`src/far/clipmap.ts`). Terrain and forest now allocate seven levels instead of eight and
reach 16,384 voxels; the monument valley still gets the six it asks for, because clear
desert air closes at 37,875 and the cap never binds. `?farLevels=n` overrides it outright,
because a measurement wants the setting it asked for.

It is a small win and it is free: 5.37 ms p50 at eight levels against 5.11 at seven,
back to back on a throttled machine, and 2.36 against 2.16 in an earlier unthrottled one.
The slab count per rebuild goes from 256 to 224. Nothing visible changes, which is the
point.

### Skipping bricks the near field covers: tried, measured, reverted

The argument was that `march_brick()` tests `near_covers()` per cell, up to twenty-four
times a brick, and that the near field's 512-voxel radius is exactly levels 0 and 1 at
32^3, so two of eight levels are walked cell by cell inside ground the raster pass owns. A
brick at a fine level lands inside one chunk, so one mask lookup should stand in for all
of them.

Built it, measured it back to back against the same build with the hunk removed, at the
same camera: 5.37 ms p50 without, 5.37 to 5.44 with. No difference, and the same result in
an earlier unthrottled state (2.36 against 2.23). Reverted.

The argument is wrong because of what runs before the march. `march_far()` skips every
pixel the near field already drew, so a ray that reaches the march is one the near field
drew nothing along. Along such a ray the inner levels are almost entirely *empty* bricks,
which cost one indirection read each and no cell walk at all, because a brick with
geometry in it is a brick the raster pass would have drawn. The covered-cell path exists
for silhouettes ([gotchas.md](gotchas.md) "The near field's coverage is a chunk, not a
pixel"), and a silhouette is a sliver of the frame.

**Takeaway:** the cost is in the outer levels, where rays are long and bricks are
occupied, not in the inner ones. Optimisations aimed at the near/far boundary are aimed
at the cheap end.

### Normals from the occupancy bitmask

The far field shades with one of six axis-aligned normals, taken from the face the ray
crossed. At a coarse level a cell is 64 voxels, so a butte 8,000 voxels out is shaded as
a staircase of 64-voxel cubes, which is the main thing that makes the far field look
unlike the near field rather than merely coarser than it.

Laine and Karras solve the same problem with contours: a plane stored per node, so a
coarse node shades like the slanted surface it stands for. A brick here already carries a
512-bit occupancy mask, so the cheap version of the same idea is a gradient over the 3x3x3
cell neighbourhood at the hit, blended with the face normal. It is a handful of bit tests,
once per hit rather than per step.

The judgement to make first is style: blending all the way would make the far field
*smoother* than the blocky near field, which is the wrong kind of inconsistency. Scaling
the blend by the level's cell size, so the finest levels stay hard and only the coarse
ones round off, is the version worth trying.

## Assessment

Voxler's position is:

- **Rendering architecture:** unusually advanced for an independent browser voxel
  project.
- **Large procedural block worlds:** differentiated by one source feeding near meshes,
  far clipmaps, edits, and near-field shadows, with per-world far-field configuration
  and optional measured-cost adaptation.
- **General engine capability:** behind Godot Voxel Tools, Voxelize, Divine Voxel
  Engine, and Unreal-based systems.
- **Production validation:** limited to the recorded Chrome and Linux development
  machine; the target hardware matrix remains unmeasured.
- **Originality:** the component algorithms are established, but their integration in
  a core-WebGPU editable SDF-to-block renderer is uncommon.

Voxler is best described as a focused WebGPU terrain-rendering engine whose renderer is
more mature than its surrounding game platform. It should not yet be presented as the
largest or fastest voxel engine without a controlled cross-engine benchmark.
