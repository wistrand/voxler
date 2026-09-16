# Voxler

A voxel engine for the browser, built on WebGPU. A world is generated on the GPU from a
WGSL function rather than stored as voxel data, so there is no level to load.

It runs at [voxler.dev](https://voxler.dev/) if your browser has WebGPU.

## What "very large" means here

What you write is the function, and it is a few hundred lines. The voxels it describes are
never stored, so no part of a world's extent is a file size. What bounds it instead is the
coordinate system:

| | |
| --- | --- |
| Horizontally | 33.5 million voxels each way from the origin (`±2^20` chunks) |
| Vertically | 32,768 voxels each way |
| Across | 67 million voxels, which at a voxel to the metre is about 1.7 times the Earth's circumference |
| Resident | a radius around the camera, 512 voxels by default |
| Visible | as far as the fog, 16,384 voxels in the worlds that ship |

The last two rows are the ones that cost anything. Memory follows the resident radius and
frame time follows what is on screen; neither grows as you fly.

**Where it gives out.** The horizontal figure is a real edge, not a slogan. A chunk is
addressed by a key packing its coordinates into one 53-bit number (`src/world/keys.ts`),
21 bits per horizontal axis and 11 vertical, and every path that takes a chunk coordinate
calls `chunkInRange` first. Past it chunks stop being streamed and meshed, so what is left
is the ray-marched far field over nothing. Read off the code, not flown to.

Inside the range the engine holds up because it never puts an absolute position in an
`f32`: positions are an integer voxel coordinate plus a fraction, shaders subtract the
camera's chunk in integers and convert last, and noise is sampled through integer lattices.
Measured, terrain a million voxels out is smooth to a sixty-fourth of a voxel.

What gives out first is usually the world program rather than the engine. A world that
turns its position into a plain vector with `wp_f32(p)` inherits float32 spacing, about
0.06 voxels at a million and coarser after that, which is enough for geometry to jitter.
The helpers that stay exact at any distance are `wp_lattice` for noise, `wp_repeat_near`
for scatter and `wp_local(p, anchor)` for anything placed
([agent_docs/design-formats.md](agent_docs/design-formats.md) "World program").

Voxler splits the world by distance. Close to the camera, 32-voxel chunks are meshed
in background workers with binary greedy meshing, which turns occupancy into bit
columns so face culling and merging are a few integer operations per row. The
resulting quads are 8 bytes each. The GPU decides what is visible: a compute pass
culls small clusters of quads against the view frustum and a depth pyramid, and the
whole near field is drawn with a single indirect draw. Farther out, where a voxel face
is smaller than a pixel, the engine stops drawing triangles and ray-marches a
multi-level brickmap in a compute shader, so view distance costs a fixed amount of
GPU time per pixel rather than growing with the number of voxels.

## Status

Working, and fast enough to be worth looking at. Worlds voxelize on the GPU into
compressed chunk storage, are meshed in workers, culled and drawn as greedy quads by
vertex pulling, and continue past the meshed radius as a ray-marched brickmap that
reaches as far as the fog lets the eye see. Surfaces carry baked ambient occlusion and
baked light from glowing blocks, and cast shadows from the sun or moon; a world can ask
for bloom over its glowing blocks, and the forest does. Voxels can be
edited and the edits survive the chunk being regenerated. A ray-traced preview of the
same world is one key away, though for a heavy world it takes a while to compile the
first time.

Four worlds ship: a showcase of the SDF primitives, a terrain world, a fantasy forest at
night with glowing fungus, lakes, waterfalls, mountains and flocks of birds over it, and a
desert of Monument Valley buttes. Pressing K starts a flyover that follows whatever is under the camera,
which over a river follows the river. It flies on a phone too: one finger looks, two fly.
One world is not a landscape at all: [voxler.dev/sweden-2026.html](https://voxler.dev/sweden-2026.html)
is the 2026 Riksdag election as a map, the country in low relief at a kilometre a voxel,
each municipality washed in the colour of the party that won it and raised with the
votes cast there, the borders inked on, and
a stack of bubbles over each municipality, one per party from the biggest share at the
bottom up, each sized by the votes that party got there rather than by the land. The
numbers are Valmyndigheten's preliminary count, fetched and rasterised into the world
program by `deno task sweden`; the page builds the world through the same API a host
would use, and a click on a stack or the ground opens that municipality's numbers.

## Requirements

A browser with WebGPU: Chrome or Edge on desktop, Safari 26 on macOS 26 or iOS 26,
or Firefox on Windows or Apple Silicon Macs. On Linux, Chrome enables WebGPU by
default on recent Intel and NVIDIA GPUs; check `chrome://gpu`. There is no WebGL
fallback.

[Deno](https://deno.com) for development.

## Quick start

```bash
deno task dev      # then open the printed URL
```

`deno task docs` serves the landing page and a fresh build of the demo the way GitHub
Pages serves them, which is without the cross-origin isolation headers the dev server
sends. That is the difference worth checking: without them there is no `SharedArrayBuffer`
and mesh jobs copy their payloads instead of sharing them.

## How it works

- **Worlds as code**: a world is a WGSL signed distance function plus a material
  function. The GPU samples it at whatever resolution is needed: full voxels near the
  camera, coarse cells far away, and a direct ray-traced preview while writing it.
- **World data**: chunks are stored as a single value when uniform (open air, deep
  rock) and palette-compressed otherwise.
- **Near field**: binary greedy meshing in workers; GPU culling per quad cluster
  (frustum, face direction, two-phase occlusion); one indirect draw with vertex
  pulling from storage buffers.
- **Far field**: a camera-centered clipmap of 8^3 bricks at doubling cell sizes,
  ray-marched in compute and composited behind the near field.
- **Editing**: two kinds, which behave differently. A CSG brush is a bounded primitive
  folded into the world's own field on the GPU, so it shows up in the meshed near field,
  the ray-marched far field and the preview alike, and terrain closes around it. A voxel
  edit writes block ids into a journal instead. Both survive their chunk being thrown away
  and regenerated, because a chunk is the field stage followed by a replay of the journal,
  always in that order. Nothing is written to disk: surviving regeneration is not the same
  as surviving a reload, and saving the brush records is left to the host.
- **Light**: one sun or moon, sky ambient and fog, shared by every surface path so the
  meshed world, the preview and the ray-marched distance agree. Glowing blocks flood
  light through the voxels around them, baked per quad corner in the mesher, and
  shadows are rays marched against the same brickmap the far field uses, so there is
  no shadow map and no second draw of the scene. Bloom, where a world wants it, blurs
  only the emission the fog let through, screened over the frame so it cannot clip.

Design notes and plans live in [agent_docs/](agent_docs/).

## License

Apache License 2.0; see [LICENSE](LICENSE).

Copyright 2026 Erik Wistrand.
