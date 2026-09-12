# Research: WebGPU browser support

Snapshot of WebGPU availability, checked on 2026-09-11 against caniuse data, MDN
browser-compat-data, and the Chromium, Dawn, WebKit, and Firefox source trees.
Browser support changes every release: re-check before relying on a version number,
and update this file (and the date) when you do. Entries marked UNCONFIRMED could
not be verified from a primary source.

Current stable versions at the snapshot: Chrome 153, Firefox 155; Firefox ESR 140
has no WebGPU.

## Contents
- Verdict
- Support by browser and OS
- Optional features
- Limits
- Workers and OffscreenCanvas
- Consequences for this design
- Development setup on Linux
- Observed devices
- Sources

## Verdict

WebGPU-only is feasible for a desktop-first engine targeting Chrome/Edge (Windows,
macOS, ChromeOS, Linux on allowlisted GPUs) and Safari 26 on macOS 26 and iOS 26,
with Firefox on Windows and Apple Silicon macOS as a secondary target.

Excluded without a fallback renderer:
- Firefox on Linux, Android, and Intel Macs; Firefox ESR 140.
- Safari on macOS 14/15 and iOS before 26.
- Chrome on Linux with AMD GPUs, pre-Gen12 Intel, or NVIDIA on X11 or old drivers,
  unless the user sets flags.
- Android devices outside the supported GPU vendors, or older than Android 12.
- GPUs without Vulkan, Metal, or D3D12 (only compatibility mode, which this design
  can't use; see "Consequences for this design").

caniuse reports roughly 85-87% global coverage. That overstates reach: it counts all
Chrome desktop from 113 and all Chrome for Android as supported, though both depend
on GPU and driver.

## Support by browser and OS

| Browser       | Platform                     | Status                                                                   |
|---------------|------------------------------|--------------------------------------------------------------------------|
| Chrome / Edge | Windows x64, macOS, ChromeOS | default on since 113                                                     |
| Chrome / Edge | Windows ARM64                | Qualcomm Adreno X1 enabled on Chromium main; first release UNCONFIRMED   |
| Chrome        | Linux, Intel Gen12+          | default on since 144 (Mesa 22.0 or newer), via Vulkan                    |
| Chrome        | Linux, NVIDIA on Wayland     | default on since 147 (driver 535.183.01 or newer)                        |
| Chrome        | Linux, AMD and others        | off; needs flags                                                         |
| Chrome        | Android 12+                  | ARM, Qualcomm, Intel GPUs since 121; Imagination on Android 16+ since 139 |
| Safari        | macOS 26, iOS/iPadOS 26, visionOS 26 | default on since Safari 26.0                                     |
| Safari        | macOS 14/15                  | not available                                                            |
| Firefox       | Windows                      | default on since 141                                                     |
| Firefox       | macOS, Apple Silicon         | 145 on macOS 26; 147 on all macOS versions                               |
| Firefox       | macOS, Intel                 | not shipped                                                              |
| Firefox       | Linux                        | not shipped (Nightly only); blocked on the GPU process for X11 and Wayland |
| Firefox       | Android                      | behind a flag                                                            |

## Optional features

Exposed per adapter when the hardware supports them.

| Feature                  | Chrome | Safari 26                          | Firefox                          | Use here                         |
|--------------------------|--------|------------------------------------|----------------------------------|----------------------------------|
| `timestamp-query`        | 121    | yes, not on Intel Macs             | yes (scale bug fixed in 151)     | GPU pass timing, optional        |
| `subgroups`              | 134    | no (in WebKit trunk; ship UNCONFIRMED) | no                           | append compaction, optional      |
| `indirect-first-instance`| 113    | yes                                | yes                              | not needed by the cluster draw   |
| `shader-f16`             | 120    | yes                                | yes (render bug fixed in 157)    | possible far-field color math    |
| `bgra8unorm-storage`     | 113    | yes                                | yes                              | could skip the composite copy    |
| `clip-distances`         | 131    | Safari 27 beta                     | no                               | not needed                       |
| multi-draw indirect      | experimental, behind `enable-unsafe-webgpu` | no      | no                               | not used; not in the spec        |

Chrome rounds timestamp results to 100 µs; `chrome://flags/#enable-webgpu-developer-features`
removes the rounding. Whether Safari and Firefox quantize is UNCONFIRMED.

## Limits

- Spec defaults: `maxStorageBufferBindingSize` 128 MiB, `maxBufferSize` 256 MiB,
  `maxStorageBuffersPerShaderStage` 8. A device gets these unless higher values are
  passed in `requiredLimits`.
- Chrome reports adapter limits in fixed tiers (storage binding up to 4 GiB, buffer
  up to 4 GiB, storage buffers per stage up to 16 since 146).
- Firefox reports real adapter limits capped at 2 GiB for buffers and bindings;
  with resist-fingerprinting on, it clamps everything to the defaults.
- Safari derives limits from Metal. macOS usually allows around 1 GiB; iOS reports
  between 256 MiB and 1 GiB, and often 256 MiB.

## Workers and OffscreenCanvas

WebGPU in dedicated workers with `OffscreenCanvas` works in Chrome (113 desktop,
121 Android), Safari 26, and Firefox 141. Rendering from a worker is a viable option
on every target browser.

## Consequences for this design

- **Core feature level only.** Compatibility mode (OpenGL ES 3.1, D3D11) allows no
  storage buffers in the vertex stage, and vertex pulling depends on them. The engine
  requests the core feature level and shows an unsupported message otherwise. A
  compat path would need quads as instance vertex attributes; deferred.
- **No multi-draw indirect.** Confirms the single cluster-list `drawIndirect` in
  [research-voxel-rendering.md](research-voxel-rendering.md).
- **Subgroups are a Chrome-only fast path.** Every compute pass needs a
  non-subgroup version, which is the one Safari and Firefox run.
- **Design to the default storage binding size.** Each storage binding must work at
  128 MiB, and no single buffer may need more than 256 MiB (common on iOS). Arenas
  that need more are split across bindings, sized from granted limits.
- **Storage buffers per stage.** The default of 8 is the budget for any one shader.
  The near-field vertex shader needs 4 (arena, clusters, chunk table, visible list).
- **Readback latency varies.** Firefox detects GPU completion on a timer, so
  `mapAsync` results arrive later there. Stats readback must tolerate multi-frame lag.

## Development setup on Linux

- Chrome is default-on for Intel Gen12+ with Mesa 22.0 or newer and for NVIDIA
  535.183.01 or newer on Wayland. Check `chrome://gpu` for "WebGPU: Hardware
  accelerated".
- Other GPUs need `--enable-unsafe-webgpu --ozone-platform=x11 --use-angle=vulkan
  --enable-features=Vulkan,VulkanFromANGLE`.
- Keep the main test profile flag-free. `--enable-unsafe-webgpu` bypasses the
  blocklist and exposes experimental features, so code can work there and fail for
  users. Use a separate profile or Canary for flag experiments, and
  `--enable-webgpu-developer-features` for unquantized timestamps.
- On the primary dev machine (Intel Arc B390), `chrome://gpu` shows a Vulkan core
  adapter plus an OpenGL ES compatibility-mode adapter. That Chrome profile had
  `--enable-unsafe-webgpu` on, so default-on status without the flag is still
  unconfirmed for this GPU.
- Firefox Nightly on Linux has WebGPU on by default and is the only way to test
  Firefox's implementation from Linux. Release Safari and Firefox need macOS and
  Windows machines.
- Phones and other tailnet devices can load the dev server over HTTPS; see the
  server env notes in CLAUDE.md "Commands".

## Observed devices

Granted values from the engine's caps report (`?defaultLimits` off), so these are
what the engine actually gets, not adapter maximums. Add a column per new device.

| Item                                | Chrome 152, Linux | Firefox 154, Linux | Chrome 152, Android |
|-------------------------------------|-------------------|--------------------|---------------------|
| GPU                                 | Intel Arc B390    | Intel Arc B390     | Imagination         |
| Adapter info                        | intel / xe-3lpg   | empty              | img-tec             |
| Preferred canvas format             | `rgba8unorm`      | `bgra8unorm`       | `rgba8unorm`        |
| `timestamp-query`, `shader-f16`     | yes               | yes                | yes                 |
| `subgroups`                         | yes               | no                 | yes                 |
| `maxBufferSize`                     | 4 GiB - 4         | 2 GiB - 4          | 4 GiB - 4           |
| `maxStorageBufferBindingSize`       | 4 GiB - 4         | 2 GiB - 4          | 128 MiB (default)   |
| `maxUniformBufferBindingSize`       | 64 KiB (default)  | 1 GiB              | 64 KiB (default)    |
| `maxStorageBuffersPerShaderStage`   | 16                | 64                 | 16                  |
| `maxStorageTexturesPerShaderStage`  | 4 (default)       | 64                 | 8                   |
| `maxComputeWorkgroupStorageSize`    | 48 KiB            | 48 KiB             | 32 KiB              |
| `maxComputeInvocationsPerWorkgroup` | 1024              | 1024               | 1024                |
| `maxComputeWorkgroupSizeZ`          | 64 (default)      | 1024               | 64 (default)        |
| Texture 2D / 3D / array layers      | 16384/2048/2048   | 16384/2048/2048    | 16384/2048/2048     |

Notes:
- Chrome's tiers leave several limits at the spec default even when the hardware
  allows more.
- The Android phone grants 4 GiB buffers but only a 128 MiB storage binding. Arenas
  larger than 128 MiB must split across bindings, which is the rule in "Consequences
  for this design".
- Workgroup storage is 32 KiB on the phone versus 48 KiB on desktop; size shared
  memory in compute passes from `caps`, not from the desktop value.
- Firefox 154 ran WebGPU on Linux although release Firefox doesn't ship it there by
  default; whether that was a pref or a pre-release build wasn't recorded.
- The Android row was reported as "Linux" by the first version of the caps report
  (UA parsing bug, fixed); the platform was Android.

## Sources

- gpuweb implementation status: https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- caniuse: https://caniuse.com/webgpu
- MDN compat data, features: https://github.com/mdn/browser-compat-data (`api/GPUSupportedFeatures.json`)
- Chrome WebGPU release notes index: https://developer.chrome.com/docs/web-platform/webgpu/news
- Chrome Linux allowlist: `gpu/config/software_rendering_list.json` in the Chromium tree
- Dawn tiered limits: `src/dawn/native/Limits.cpp` in the Dawn tree
- WebKit, Safari 26.0 features: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- Firefox 141 WebGPU on Windows: https://mozillagfx.wordpress.com/2025/07/15/shipping-webgpu-on-windows-in-firefox-141/
- Firefox Linux release meta bug: https://bugzil.la/2006676
- WebGPU spec (feature list, compatibility mode limits): https://github.com/gpuweb/gpuweb (`spec/index.bs`)
