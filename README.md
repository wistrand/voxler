# Voxler

A voxel engine for the browser, built on WebGPU, aimed at very large worlds at high
frame rates.

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
baked light from glowing blocks, and cast shadows from the sun or moon. Voxels can be
edited and the edits survive the chunk being regenerated. A ray-traced preview of the
same world is one key away, though for a heavy world it takes a while to compile the
first time.

Four worlds ship: a showcase of the SDF primitives, a terrain world, a fantasy forest at
night with glowing fungus, lakes, waterfalls and mountains, and a desert of Monument
Valley buttes. Pressing K starts a flyover that follows whatever is under the camera,
which over a river follows the river.

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
- **Light**: one sun or moon, sky ambient and fog, shared by every surface path so the
  meshed world, the preview and the ray-marched distance agree. Glowing blocks flood
  light through the voxels around them, baked per quad corner in the mesher, and
  shadows are rays marched against the same brickmap the far field uses, so there is
  no shadow map and no second draw of the scene.

Design notes and plans live in [agent_docs/](agent_docs/).

## License

Not yet chosen.
