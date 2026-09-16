// Near-field mesh drawing by vertex pulling (plan-rendering phases 1-3, 5).
// Requires camera.wgsl, sky-color.wgsl, and shading.wgsl. No vertex buffers: quads, cluster descriptors, and chunk
// origins are read from storage buffers. Layouts owned by
// agent_docs/design-formats.md ("Packed quad", "Cluster descriptor", "Chunk
// table"); the decode mirrors decodeQuad(), quadCorners(), and QUAD_TRIANGLES in
// src/mesh/quad.ts.
//
// One instance per visible cluster: the cull pass (cull.wgsl) wrote the cluster
// indices to `visible` and the instance count to the indirect arguments.
// vertex_index / 6 is the quad within the cluster; quads past its count (padding)
// collapse to a degenerate point.
//
// Shading (plan-rendering phase 5): baked AO from word1 bits 16-23, two bits per
// corner (ao.ts), interpolated across the quad. The diagonal follows the AO so the
// gradient doesn't depend on the triangulation (gotchas.md "AO anisotropy").
// `AO_ENABLED` is off for the `?ao=0` A/B, which also meshes without AO. Light and
// fog come from shading.wgsl, so meshes, the SDF preview, and the far field agree.
//
// Textures: one layer of a `texture_2d_array` per block face (`block_faces`, from
// blockFaceTable()), addressed in voxel units so the sampler's repeat mode tiles one
// tile per voxel whatever a greedy quad's size. `textureSampleGrad` with the
// interpolated coordinates' own derivatives, rather than `textureSample`, so the
// tiling stays independent of how the coordinates are formed: a later change that
// wraps them by hand would otherwise pick a mip from the wrap, not the surface.
// `TEXTURED` is off for the `?tex=0` A/B.


@group(1) @binding(0) var<storage, read> quads: array<vec2u>;
@group(1) @binding(1) var<storage, read> clusters: array<vec4u>;
@group(1) @binding(2) var<storage, read> chunks: array<vec4i>;
// Two vec4f per block (design-formats.md "Block table"): color and coverage, then
// emission and sway.
@group(1) @binding(3) var<storage, read> block_colors: array<vec4f>;
@group(1) @binding(4) var<storage, read> visible: array<u32>;
@group(1) @binding(5) var<storage, read> block_faces: array<u32>; // texture layer, id * 6 + face
@group(1) @binding(6) var block_textures: texture_2d_array<f32>;
@group(1) @binding(7) var block_sampler: sampler;

const FACE_FLIP_MASK = 0x25u; // faces 0, 2, 5: U x V points against the normal
const MAX_BLOCK_TYPES = 256u;

override AO_ENABLED: bool = true;
override TEXTURED: bool = true;
override EMISSIVE: bool = true;
override ANIMATED: bool = true;
// Block light baked per quad corner (plan-living-world phase 4); ?light=0 is the A/B,
// and it also meshes without filling the light grid.
override BLOCK_LIT: bool = true;
// Shadow rays marched against the far field's clipmap (src/far/shadow.wgsl); ?shadow=0
// is the A/B, and it is off whenever the far field is, because there is no clipmap to
// march then.
override SHADOWS: bool = true;

// Wind (plan-living-world.md phase 2). The displacement is a pure function of the world
// voxel and the clock, so two chunks meeting at a boundary move their shared face by
// the same amount and no crack opens between them. It is computed from integer world
// coordinates reduced modulo WIND_WRAP, which keeps it exact however far from the
// origin the camera is (CLAUDE.md "Invariants") and, because every wavelength divides
// the wrap, seamless across it.
const TAU = 6.2831855;
const WIND_WRAP: i32 = 256;
// Cycles per WIND_WRAP voxels, and per WIND_PERIOD seconds (camera-uniform.ts). Whole
// numbers, or the wrap would show as a seam in space or a jump in time.
//
// Long wavelengths on purpose: 85 and 128 voxels, not the 13 and 5 the first version
// had. Greedy meshing leaves T-junctions everywhere (a long quad beside two short
// ones), and a displacement that varies *within* a quad pulls its straight edge off the
// short quads' vertices, which opens hairlines all over a canopy. The deviation grows
// with the square of the wave number, so a wavelength several quads long makes it
// sub-pixel. It also looks more like wind: a gust moves a whole tree rather than each
// leaf on its own.
const WIND_SPACE_A = vec3f(3.0, 0.0, 2.0);
const WIND_SPACE_B = vec3f(7.0, 1.0, -5.0);
const WIND_TIME_A = 1.0;
const WIND_TIME_B = 4.0;

fn wind_phase(world: vec3i, cycles: vec3f) -> f32 {
  let w = vec3f(world & vec3i(WIND_WRAP - 1));
  return dot(w, cycles) * (TAU / f32(WIND_WRAP));
}

// How far a block's face is blown, in voxels. `amount` is the block's sway.
fn wind_offset(world: vec3i, amount: f32) -> vec3f {
  if (amount <= 0.0) {
    return vec3f(0.0);
  }
  let t = camera.time.x * (TAU / 8.0); // WIND_PERIOD
  let a = sin(wind_phase(world, WIND_SPACE_A) + t * WIND_TIME_A);
  let b = sin(wind_phase(world, WIND_SPACE_B) + t * WIND_TIME_B);
  let s = a * 0.75 + b * 0.25;
  // Along the wind and slightly down: foliage that bends also sags.
  return vec3f(s, -abs(s) * 0.25, s * 0.6) * amount;
}
// Darkening at full occlusion (level 3). Lower is subtler.
const AO_STRENGTH = 0.6;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) id_face: u32, // block id << 3 | face
  @location(1) ao: f32, // occlusion level 0..3, interpolated across the quad
  @location(2) view: vec3f, // eye to fragment in render space, for fog
  @location(3) uv: vec2f, // position across the quad in voxels, one tile each
  @location(4) light: f32, // block-light level 0..15, interpolated across the quad
}

fn degenerate() -> VsOut {
  var out: VsOut;
  out.position = vec4f(0.0, 0.0, 0.0, 1.0);
  out.id_face = 0u;
  out.ao = 0.0;
  out.view = vec3f(0.0, 0.0, 1.0);
  out.uv = vec2f(0.0);
  out.light = 0.0;
  return out;
}

// Corner (0 min, 1 +U, 2 +U+V, 3 +V) of vertex k (0..5) of a quad's two triangles:
// QUAD_TRIANGLES [0 1 2, 0 2 3], or flipped [0 2 1, 0 3 2]. Computed rather than
// looked up, so no runtime-indexed value arrays. `first` starts the fan at that
// corner: 0 splits along corners 0-2, 1 along 1-3 (the AO flip), and the winding
// is the same either way.
fn corner_of(face: u32, k: u32, first: u32) -> u32 {
  let tri = k / 3u;
  let j = k % 3u;
  var c = 0u;
  if (j != 0u) {
    if (((FACE_FLIP_MASK >> face) & 1u) != 0u) {
      c = 3u - j + tri;
    } else {
      c = j + tri;
    }
  }
  return (c + first) & 3u;
}

// Block-light level (0..15 + 3) of corner c: the quad's base level in word0 bits 28-31
// plus the corner's step above it in word1 (design-formats.md "Packed quad").
fn light_level(w0: u32, w1: u32, c: u32) -> f32 {
  return f32(w0 >> 28u) + f32((w1 >> (24u + 2u * c)) & 3u);
}

// Occlusion level (0..3) of corner c, from the quad's AO byte.
fn ao_level(w1: u32, c: u32) -> f32 {
  return f32((w1 >> (16u + 2u * c)) & 3u);
}

// Greedy meshing puts a long quad beside two short ones everywhere, and the short
// quads' shared vertex lies on the long quad's edge without being one of its vertices.
// The rasteriser snaps each vertex to its sub-pixel grid on its own, so that edge can
// miss that vertex by a fraction of a pixel, and where a pixel centre falls in the gap
// nothing draws it: a hairline of far field or sky across a flat floor, one pixel here
// and there along the seam. Every quad is grown EXPAND_PX outward in its own plane,
// sized to the pixel at the corner's depth, so neighbours overlap by that much whatever
// the distance, under a pixel, and the gap closes. In the plane rather than on the
// screen, because a screen-space push can turn a quad seen nearly edge-on inside out
// and flip its winding; a bigger rectangle in its own plane cannot. Coplanar overlaps
// draw the same surface; where two blocks meet, the contested pixels are the boundary's
// own, which alias anyway (gotchas.md "Greedy quads create T-junctions"). A corner off
// the screen stays put, so a cluster the frustum test dropped has no fringe reaching an
// edge pixel that the unculled check draw would show.
const EXPAND_PX: f32 = 0.35;

// Takes the corner's clip position and returns it grown; the growth is a render-space
// vector, so it projects with the same matrix and adds in clip space.
fn expand_corner(clip: vec4f, u: u32, v: u32, su: f32, sv: f32) -> vec4f {
  if (clip.w <= 0.0) {
    return clip; // behind the eye: clipped anyway
  }
  if (any(abs(clip.xy / clip.w) > vec2f(1.0))) {
    return clip;
  }
  // One pixel at this depth, in render-space units: 2 / height in NDC, over the
  // projection's y scale, times the view depth.
  let eps = EXPAND_PX * 2.0 * clip.w * camera.viewport.w / camera.offset.w;
  var grow = vec3f(0.0);
  grow[u] = su * eps;
  grow[v] = sv * eps;
  return clip + camera.view_proj * vec4f(grow, 0.0);
}

fn quad_vertex(w0: u32, w1: u32, k: u32, slot: u32) -> VsOut {
  let face = (w0 >> 25u) & 7u;
  var p = vec3i(i32(w0 & 31u), i32((w0 >> 5u) & 31u), i32((w0 >> 10u) & 31u));
  let w = i32((w0 >> 15u) & 31u) + 1;
  let h = i32((w0 >> 20u) & 31u) + 1;
  let axis = face >> 1u;
  if ((face & 1u) == 0u) {
    p[axis] += 1; // positive faces sit on the far side of the voxel
  }
  let u = select(0u, 2u, face < 2u); // FACE_U: X faces use z, others x
  let v = select(1u, 2u, face == 2u || face == 3u); // FACE_V: Y faces use z, others y
  var first = 0u;
  var ao = 0.0;
  if (AO_ENABLED) {
    // Split along the darker diagonal, so the two triangles agree on the gradient.
    let a0 = ao_level(w1, 0u);
    let a1 = ao_level(w1, 1u);
    let a2 = ao_level(w1, 2u);
    let a3 = ao_level(w1, 3u);
    first = select(0u, 1u, a0 + a2 > a1 + a3);
  }
  let c = corner_of(face, k, first);
  if (AO_ENABLED) {
    ao = ao_level(w1, c);
  }
  var light = 0.0;
  if (BLOCK_LIT) {
    light = light_level(w0, w1, c);
  }
  // Which way this corner faces out of the quad along u and v, for the expansion.
  let su = select(-1.0, 1.0, c == 1u || c == 2u);
  let sv = select(-1.0, 1.0, c >= 2u);
  if (c == 1u || c == 2u) {
    p[u] += w;
  }
  if (c >= 2u) {
    p[v] += h;
  }
  // Integer math relative to the camera chunk, f32 last (CLAUDE.md "Invariants").
  let rel = (chunks[slot].xyz - camera.chunk.xyz) * 32 + p;
  let id = w1 & 0xffffu;
  var at = vec3f(rel);
  if (ANIMATED) {
    // The world voxel, not the render-space one: the wind stands still while the camera
    // moves through it.
    at += wind_offset(chunks[slot].xyz * 32 + p, block_colors[min(id, MAX_BLOCK_TYPES - 1u) * 3u + 1u].w);
  }
  var out: VsOut;
  out.position = expand_corner(camera.view_proj * vec4f(at, 1.0), u, v, su, sv);
  out.id_face = (id << 3u) | face;
  out.ao = ao;
  out.light = light;
  out.view = at - camera.offset.xyz;
  out.uv = vec2f(f32(select(0, w, c == 1u || c == 2u)), f32(select(0, h, c >= 2u)));
  return out;
}

@vertex
fn vs_cluster(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VsOut {
  let cl = clusters[visible[instance]];
  let q = vertex / 6u;
  if (q >= (cl.y >> 24u)) {
    return degenerate();
  }
  let quad = quads[cl.x + q];
  return quad_vertex(quad.x, quad.y, vertex % 6u, cl.y & 0xfffffu);
}

// What the fragment shader works out: the shaded, fogged colour, and separately the
// fogged emission, for the bloom pass when it is on (`fs_bloom`).
struct Shaded {
  color: vec4f,
  glow: vec3f,
}

// Two entry points over one shading function, because a fragment output at a location
// with no colour target is a pipeline error: the plain pipeline gets `fs`, and the one
// built with `?bloom=1` gets `fs_bloom` and a second attachment to write the glow into.
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return shade(in).color;
}

struct BloomOut {
  @location(0) color: vec4f,
  @location(1) glow: vec4f,
}

@fragment
fn fs_bloom(in: VsOut) -> BloomOut {
  let shaded = shade(in);
  return BloomOut(shaded.color, vec4f(shaded.glow, 1.0));
}

fn shade(in: VsOut) -> Shaded {
  let id = in.id_face >> 3u;
  let face = in.id_face & 7u;
  // Ids past the color table render as id 0, as blockColorTable() documents.
  let known = select(0u, id, id < MAX_BLOCK_TYPES);
  let entry = block_colors[known * 3u];
  let glow = block_colors[known * 3u + 1u];
  var base = entry.rgb;
  if (TEXTURED) {
    let layer = block_faces[known * 6u + face];
    // A block with `flow` scrolls its texture down its faces instead of standing still.
    // Water going over a drop is the case it is for: the sway in the vertex stage moves
    // the faces themselves, which pushes a sheet of water into the blocks around it and
    // reads as a flicker, and scrolling the texture is the same motion with none of that
    // (gotchas.md "Animate flowing water with the texture, not the geometry"). The
    // gradients are of the unscrolled uv, so the mip choice does not move with it.
    var uv = in.uv;
    let flow = block_colors[known * 3u + 2u].x;
    if (ANIMATED && flow != 0.0) {
      // Down the face for a side, and along it for a top or a bottom, so the top of a
      // fall runs the same way the fall does.
      uv.y += select(camera.time.x, -camera.time.x, (face >> 1u) == 1u) * flow;
    }
    base = textureSampleGrad(block_textures, block_sampler, uv, layer, dpdx(in.uv), dpdy(in.uv)).rgb;
  }
  // The face normal: axis face >> 1, pointing along +axis for even faces.
  let axis = face >> 1u;
  var n = vec3f(0.0);
  n[axis] = select(-1.0, 1.0, (face & 1u) == 0u);
  var shade = 1.0;
  if (AO_ENABLED) {
    shade = 1.0 - AO_STRENGTH * (in.ao * (1.0 / 3.0));
  }
  let dist = length(in.view);
  // Emission is added to the lit surface and fogged with it: a glowing block is its own
  // color whatever the sun is doing, and still fades into the distance like everything
  // else (plan-living-world.md phase 1).
  // Shadow the direct term only: the sky's ambient reaches a surface whatever stands
  // between it and the moon, and shadowing that as well turns every overhang black.
  var sun = 1.0;
  if (SHADOWS) {
    let to_light = normalize(LIGHT_DIR);
    // A face turned away from the light has no direct term to shadow, so it needs no
    // ray. That is about half of every surface in the scene and the cheapest half of
    // the cost to give back.
    if (dot(n, to_light) > 0.0) {
      sun = light_shadow(in.view + camera.offset.xyz, n, to_light);
    }
  }
  var lit = base * shade * surface_light_shadowed(n, sun);
  if (BLOCK_LIT) {
    // Occluded as the sun is: a corner the geometry hides is dark whatever is lighting
    // it, and without this the light pools flat over a crevice.
    lit += base * shade * block_light(in.light);
  }
  var emitted = vec3f(0.0);
  if (EMISSIVE) {
    emitted = glow.rgb * base;
    lit += emitted;
  }
  let color = apply_fog(lit, in.view / dist, dist);
  // The emission as the fog leaves it, for bloom: `apply_fog` keeps exp(-dist * density)
  // of a surface's own colour, so this is the part of the glow that reached the eye. A
  // cap far out blooms as faintly as it is drawn, and past the fog not at all.
  let glow_seen = emitted * exp(-dist * FOG_DENSITY);
  // Alpha is 1 for opaque blocks, so the opaque pipeline (no blending) ignores it.
  return Shaded(vec4f(color, entry.a), glow_seen);
}
