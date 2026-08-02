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
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toJSONSchema(tool.parametersSchema),
    }))
  }
}
