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
/**
 * The property every tool gains, so a call can say what it is for.
 *
 * ## Why it is added here rather than to each tool
 *
 * The transcript showed a bare tool name and nothing else, because most models emit no assistant
 * text alongside a tool call — so "reading config.json" was all anyone saw, with no clue what was
 * being looked for. Asking the model to explain itself in prose beforehand is unreliable in
 * exactly the cases where it matters. Making the reason part of the call means it is always there.
 *
 * Added in one place so every tool gets it identically: built-ins, MCP, Python, and whatever
 * comes next. It is **stripped before the tool runs**, which is what makes it safe to add to an
 * MCP server's own schema — the server never sees a property it did not declare.
 *
 * Optional, always. A model that omits it still works; the UI simply shows what it always did.
 */
export const WHY_PARAMETER = 'why'

const WHY_SCHEMA = {
  type: 'string',
  description:
    'One short sentence, for the person watching: why you are making this call and what you ' +
    'expect to learn or change. Not a restatement of the tool name.',
} as const

/**
 * Adds `why` to a JSON Schema without disturbing anything else in it.
 *
 * Deliberately conservative: it touches a plain object schema with a `properties` map and leaves
 * anything else exactly as it was. An MCP server may send a schema shaped in ways this does not
 * anticipate, and section 11 is explicit that silently rewriting a server's schema is how tool
 * calls fail for reasons nobody can trace. Not adding the field costs a line of UI; corrupting a
 * schema costs the tool.
 */
function withWhy(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema
  const record = schema as Record<string, unknown>
  if (record.type !== 'object') return schema

  const properties = record.properties
  if (properties !== undefined && (typeof properties !== 'object' || properties === null)) return schema
  // A tool that already has a `why` of its own keeps it; ours is the fallback, not an override.
  if (properties !== undefined && WHY_PARAMETER in (properties as Record<string, unknown>)) return schema

  return {
    ...record,
    properties: { ...((properties as Record<string, unknown>) ?? {}), [WHY_PARAMETER]: WHY_SCHEMA },
  }
}

/** Splits a call's arguments into the reason and everything the tool actually receives. */
export function takeWhy(args: Record<string, unknown>): { why?: string; rest: Record<string, unknown> } {
  const { [WHY_PARAMETER]: why, ...rest } = args
  if (typeof why !== 'string' || why.trim().length === 0) return { rest }
  return { why: why.trim(), rest }
}

export function toToolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // An MCP server's own schema wins over a zod round-trip — see `rawJsonSchema`.
    parameters: withWhy(tool.rawJsonSchema ?? toJSONSchema(tool.parametersSchema)),
  }))
}
