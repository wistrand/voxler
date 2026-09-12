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

Early. Worlds voxelize on the GPU into compressed chunk storage, are meshed in
workers, and are drawn as greedy quads by vertex pulling; culling and shading are
next. A ray-traced SDF preview of the same world is one key away.

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

Design notes and plans live in [agent_docs/](agent_docs/).

## License

Not yet chosen.
