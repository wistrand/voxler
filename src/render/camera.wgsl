// Per-frame camera data, bound at group 0 for every pipeline. Layout owned by
// agent_docs/design-formats.md "Camera uniform"; written by CameraUniform in
// camera-uniform.ts. Prepended to other shader sources at compile time.
//
// Render space: world minus the camera chunk's min corner. Geometry reaches render
// space with integer math, (chunk - camera.chunk) * 32 + local, converted to f32 last.

struct Camera {
  view: mat4x4f,
  view_proj: mat4x4f,
  inv_view_proj: mat4x4f,
  chunk: vec4i,    // camera chunk coordinate; w unused
  offset: vec4f,   // eye position in render space, each component in [0, 32); w unused
  viewport: vec4f, // width, height, 1 / width, 1 / height in pixels
  time: vec4f, // x: seconds, wrapped into WIND_PERIOD; yzw unused
}

@group(0) @binding(0) var<uniform> camera: Camera;
