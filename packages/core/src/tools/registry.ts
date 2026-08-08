import { toJSONSchema } from 'zod'
import type { ToolDefinition } from '../providers/types.js'
import type { Tool } from './types.js'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  /** Namespaced per §11 for MCP tools; built-in tools use their bare name. */
  toToolDefinitions(): ToolDefinition[] {
    return toToolDefinitions(this.list())
  }
}

/**
 * Standalone so a mode-filtered subset can be turned into definitions without going
 * through the registry — an excluded tool must never reach the system prompt (§8).
 */
export function toToolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // An MCP server's own schema wins over a zod round-trip — see `rawJsonSchema`.
    parameters: tool.rawJsonSchema ?? toJSONSchema(tool.parametersSchema),
  }))
}
