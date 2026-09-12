// Adapter and device creation, canvas configuration, and uncaptured-error routing.
// Called again after device loss: a new adapter is required each time because an
// adapter is consumed by requestDevice.

import { buildCaps, type Caps, limitShortfalls, requiredFeatures, requiredLimits } from "./caps.ts";

export interface Gpu {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  readonly caps: Caps;
}

export type GpuResult = { gpu: Gpu } | { error: string };

const MSG_NO_WEBGPU = "This browser does not expose WebGPU. Voxler runs in Chrome or Edge on desktop, " +
  "Safari 26 on macOS 26 or iOS 26, and Firefox on Windows or Apple Silicon Macs.";

const MSG_NO_ADAPTER = "WebGPU is present but no suitable GPU adapter was found. On Linux, Chrome " +
  "enables WebGPU by default only on recent Intel and NVIDIA GPUs; see chrome://gpu.";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function createGpu(canvas: HTMLCanvasElement, report: (message: string) => void): Promise<GpuResult> {
  if (!navigator.gpu) return { error: MSG_NO_WEBGPU };

  // No featureLevel option: the default is "core". Compatibility mode can't run
  // vertex pulling (no storage buffers in the vertex stage).
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { error: MSG_NO_ADAPTER };

  const shortfalls = limitShortfalls(adapter.limits);
  if (shortfalls.length > 0) {
    return { error: `This GPU's WebGPU limits are below what Voxler needs: ${shortfalls.join(", ")}.` };
  }

  // `?defaultLimits` keeps every limit at the spec default, to test the invariant
  // that the engine runs there (iOS and Firefox resist-fingerprinting grant only these).
  const raiseLimits = !new URLSearchParams(location.search).has("defaultLimits");

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      label: "voxler",
      requiredFeatures: requiredFeatures(adapter),
      requiredLimits: raiseLimits ? requiredLimits(adapter) : {},
    });
  } catch (err) {
    return { error: `Creating the WebGPU device failed: ${errorText(err)}` };
  }

  device.onuncapturederror = (event) => {
    report(`uncaptured ${event.error.constructor.name}: ${event.error.message}`);
  };

  // The DOM lib's getContext overloads don't list "webgpu" yet.
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) {
    device.destroy();
    return { error: "The canvas could not provide a WebGPU context." };
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  // TEXTURE_BINDING as well: the cull check (`?cullCheck`) compares the drawn
  // frame against an unculled reference.
  context.configure({
    device,
    format,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });

  return { gpu: { device, context, format, caps: buildCaps(adapter, device, format) } };
}
