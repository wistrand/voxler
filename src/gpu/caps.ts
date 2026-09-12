// Startup probe of adapter, features, and limits. All later code reads `Caps`;
// nothing else inspects adapter.features or adapter.limits.

// Optional features requested when the adapter has them. Each has a path without it.
export const WANTED_FEATURES = [
  "timestamp-query",
  "subgroups",
  "shader-f16",
] as const satisfies readonly GPUFeatureName[];

// Limits requested at the adapter's maximum. Everything else stays at the spec default.
export const RAISED_LIMITS = [
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxUniformBufferBindingSize",
  "maxStorageBuffersPerShaderStage",
  "maxStorageTexturesPerShaderStage",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension",
  "maxTextureDimension2D",
  "maxTextureDimension3D",
  "maxTextureArrayLayers",
] as const satisfies readonly (keyof GPUSupportedLimits)[];

export type LimitName = typeof RAISED_LIMITS[number];

// The engine must run at these. They are the core WebGPU spec defaults, so any
// conformant core adapter meets them; the check guards against one that doesn't.
const MIN_LIMITS: Readonly<Partial<Record<LimitName, number>>> = {
  maxBufferSize: 268435456,
  maxStorageBufferBindingSize: 134217728,
  maxStorageBuffersPerShaderStage: 8,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxTextureDimension2D: 8192,
};

export interface Caps {
  readonly browser: string;
  readonly adapter: string;
  readonly format: GPUTextureFormat;
  readonly crossOriginIsolated: boolean;
  readonly features: ReadonlySet<GPUFeatureName>;
  readonly timestampQuery: boolean;
  readonly subgroups: boolean;
  readonly shaderF16: boolean;
  readonly limits: Readonly<Record<LimitName, number>>;
}

// Limits below the engine minimum, as readable lines. Empty when the adapter is fine.
export function limitShortfalls(limits: GPUSupportedLimits): string[] {
  const out: string[] = [];
  for (const name of RAISED_LIMITS) {
    const min = MIN_LIMITS[name];
    if (min !== undefined && limits[name] < min) out.push(`${name} ${limits[name]} (needs ${min})`);
  }
  return out;
}

export function requiredFeatures(adapter: GPUAdapter): GPUFeatureName[] {
  return WANTED_FEATURES.filter((f) => adapter.features.has(f));
}

export function requiredLimits(adapter: GPUAdapter): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of RAISED_LIMITS) out[name] = adapter.limits[name];
  return out;
}

// Checked in order; the first match wins. Edge's UA also contains "Chrome/".
const BROWSERS: readonly [RegExp, string][] = [
  [/Edg\/(\d+)/, "Edge"],
  [/CriOS\/(\d+)/, "Chrome"],
  [/FxiOS\/(\d+)/, "Firefox"],
  [/Firefox\/(\d+)/, "Firefox"],
  [/Chrome\/(\d+)/, "Chrome"],
  [/Version\/(\d+)[\d.]* .*Safari/, "Safari"],
];

// Checked in order, not by position in the UA: Android UAs start with "Linux;" and
// iPhone UAs contain "Mac OS X".
const PLATFORMS: readonly [string, string][] = [
  ["Android", "Android"],
  ["iPhone", "iOS"],
  ["iPad", "iPadOS"],
  ["CrOS", "ChromeOS"],
  ["Windows", "Windows"],
  ["Mac OS X", "macOS"],
  ["Linux", "Linux"],
];

function platformName(ua: string): string {
  for (const [token, name] of PLATFORMS) {
    if (!ua.includes(token)) continue;
    // iPadOS Safari sends a desktop macOS UA; a touch screen gives it away.
    if (name === "macOS" && navigator.maxTouchPoints > 1) return "iPadOS";
    return name;
  }
  return "unknown OS";
}

// "Firefox 155 on Linux". Good enough to tell overlay pastes and bench results apart.
function browserName(ua: string): string {
  const platform = platformName(ua);
  for (const [re, name] of BROWSERS) {
    const m = ua.match(re);
    if (m) return `${name} ${m[1]} on ${platform}`;
  }
  return ua;
}

export function buildCaps(adapter: GPUAdapter, device: GPUDevice, format: GPUTextureFormat): Caps {
  const info = adapter.info;
  // Firefox (and privacy modes elsewhere) return empty strings here.
  const adapterName = [info?.vendor, info?.architecture, info?.device, info?.description]
    .filter((s) => s)
    .join(" / ") || "not exposed by browser";
  const features = new Set<GPUFeatureName>(WANTED_FEATURES.filter((f) => device.features.has(f)));
  const limits = {} as Record<LimitName, number>;
  for (const name of RAISED_LIMITS) limits[name] = device.limits[name];
  return Object.freeze({
    browser: browserName(navigator.userAgent),
    adapter: adapterName,
    format,
    crossOriginIsolated,
    features,
    timestampQuery: features.has("timestamp-query"),
    subgroups: features.has("subgroups"),
    shaderF16: features.has("shader-f16"),
    limits: Object.freeze(limits),
  });
}

const MIB = 1024 * 1024;

// Browsers report sizes like 2 GiB - 4 (2147483644); show those as approximate MiB.
function formatLimit(value: number): string {
  if (value < MIB) return String(value);
  if (value % MIB === 0) return `${value / MIB} MiB`;
  return `~${Math.round(value / MIB)} MiB (${value})`;
}

export function formatCaps(caps: Caps): string {
  const lines = [
    `browser   ${caps.browser}`,
    `adapter   ${caps.adapter}`,
    `format    ${caps.format}`,
    `isolated  ${caps.crossOriginIsolated ? "yes" : "no (SharedArrayBuffer unavailable)"}`,
    `features  ${WANTED_FEATURES.map((f) => (caps.features.has(f) ? f : `-${f}`)).join(" ")}`,
    "limits",
  ];
  const width = Math.max(...RAISED_LIMITS.map((n) => n.length));
  for (const name of RAISED_LIMITS) {
    lines.push(`  ${name.padEnd(width)}  ${formatLimit(caps.limits[name])}`);
  }
  return lines.join("\n");
}
