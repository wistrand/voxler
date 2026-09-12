// WGSL sources for any shader that evaluates a world program, in concatenation
// order: generated block constants, the SDF library, the world file. The world
// file is named after the world so compile errors point at it.
// Contract: agent_docs/design-formats.md "World program".

import type { ShaderSource } from "../gpu/shader.ts";
import { blockConstantsWgsl } from "../world/blocks.ts";
import type { WorldProgram } from "../worlds/index.ts";
import libWgsl from "./lib.wgsl" with { type: "text" };

export function worldSources(world: WorldProgram): ShaderSource[] {
  return [
    { name: "blocks.wgsl (generated)", code: blockConstantsWgsl() },
    { name: "sdf/lib.wgsl", code: libWgsl },
    { name: `worlds/${world.name}.wgsl`, code: world.code },
  ];
}
