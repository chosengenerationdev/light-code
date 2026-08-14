import { toJSONSchema } from 'zod'
import type { ToolDefinition } from '../providers/types.js'
import type { Tool } from './types.js'

export interface RegisterOptions {
  /**
   * Keep this tool out of the prompt, reachable only through `call_tool`.
   *
   * The point is context cost: a handful of MCP servers can contribute forty tools each,
   * and their schemas sit at the front of every request. A dispatch-only tool is still
   * fully registered — the loop resolves it, the approval gate sees it, mode filtering
   * applies to it — it is simply not *advertised*, so the model finds it with `search_docs`
   * instead of being told about it up front.
   *
   * **This is not a security control.** It hides a tool from the prompt, not from the
   * model: anything dispatch-only remains callable by name. Withholding a *capability* is
   * what modes and the approval gate are for.
   */
  dispatchOnly?: boolean
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()
  private readonly dispatchOnly = new Set<string>()

  register(tool: Tool, options: RegisterOptions = {}): void {
    this.tools.set(tool.name, tool)
    // Re-registering under a different flag must not leave the old one behind.
    if (options.dispatchOnly === true) this.dispatchOnly.add(tool.name)
    else this.dispatchOnly.delete(tool.name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /** Everything registered, advertised or not. This is what `call_tool` resolves against. */
  list(): Tool[] {
    return [...this.tools.values()]
  }

  isDispatchOnly(name: string): boolean {
    return this.dispatchOnly.has(name)
  }

  /** Only the tools the model is told about. Mode filtering narrows this further. */
  promptList(): Tool[] {
    return this.list().filter((tool) => !this.dispatchOnly.has(tool.name))
  }

  /** Tools reachable only via `call_tool` — the corpus `search_docs` indexes. */
  dispatchOnlyList(): Tool[] {
    return this.list().filter((tool) => this.dispatchOnly.has(tool.name))
  }

  /** Namespaced per §11 for MCP tools; built-in tools use their bare name. */
  toToolDefinitions(): ToolDefinition[] {
    return toToolDefinitions(this.promptList())
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
