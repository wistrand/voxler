// Shader and pipeline creation with readable diagnostics. WebGPU reports these
// failures asynchronously, not as exceptions at the call site; these helpers turn
// them into messages for the overlay and a null result.

export type Report = (message: string) => void;

// One file of a shader module. WGSL has no includes, so shared declarations
// (camera.wgsl) are concatenated ahead of the file that uses them.
export interface ShaderSource {
  readonly name: string;
  readonly code: string;
}

function withNewline(code: string): string {
  return code.endsWith("\n") ? code : code + "\n";
}

// Maps a line in the concatenated module back to the source file and line.
export function formatCompilationMessage(
  label: string,
  sources: readonly ShaderSource[],
  m: GPUCompilationMessage,
): string {
  let line = m.lineNum;
  if (line >= 1) {
    for (const source of sources) {
      const lines = withNewline(source.code).split("\n");
      const count = lines.length - 1;
      if (line <= count) {
        const caret = " ".repeat(Math.max(0, m.linePos - 1)) + "^";
        return `${source.name}:${line}:${m.linePos} ${m.type}: ${m.message}\n  ${lines[line - 1]}\n  ${caret}`;
      }
      line -= count;
    }
  }
  return `${label}: ${m.type}: ${m.message}`;
}

// Compiles a WGSL module from one or more sources. Warnings and errors go to
// `report`; null on any error.
export async function compileShader(
  device: GPUDevice,
  label: string,
  sources: readonly ShaderSource[],
  report: Report,
): Promise<GPUShaderModule | null> {
  const code = sources.map((s) => withNewline(s.code)).join("");
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo();
  let ok = true;
  for (const m of info.messages) {
    if (m.type === "info") continue;
    if (m.type === "error") ok = false;
    report(formatCompilationMessage(label, sources, m));
  }
  return ok ? module : null;
}

export async function createRenderPipeline(
  device: GPUDevice,
  descriptor: GPURenderPipelineDescriptor,
  report: Report,
): Promise<GPURenderPipeline | null> {
  try {
    return await device.createRenderPipelineAsync(descriptor);
  } catch (err) {
    report(`${descriptor.label ?? "render pipeline"}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
