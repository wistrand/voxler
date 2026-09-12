// Type declarations for WebGPU flag namespaces. Every browser with WebGPU defines
// these globals, but the DOM lib bundled with Deno 2.9 (TypeScript 6.0) doesn't
// declare them. Types only: the runtime values come from the browser.
// Import this module (side effect only) from any file that uses the flags.

declare global {
  var GPUBufferUsage: {
    readonly MAP_READ: number;
    readonly MAP_WRITE: number;
    readonly COPY_SRC: number;
    readonly COPY_DST: number;
    readonly INDEX: number;
    readonly VERTEX: number;
    readonly UNIFORM: number;
    readonly STORAGE: number;
    readonly INDIRECT: number;
    readonly QUERY_RESOLVE: number;
  };
  var GPUTextureUsage: {
    readonly COPY_SRC: number;
    readonly COPY_DST: number;
    readonly TEXTURE_BINDING: number;
    readonly STORAGE_BINDING: number;
    readonly RENDER_ATTACHMENT: number;
  };
  var GPUShaderStage: {
    readonly VERTEX: number;
    readonly FRAGMENT: number;
    readonly COMPUTE: number;
  };
  var GPUMapMode: {
    readonly READ: number;
    readonly WRITE: number;
  };
}

export {};
