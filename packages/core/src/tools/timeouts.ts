import type { McpServersConfig } from '../mcp/types.js'

/**
 * How long one tool call may take, resolved from most specific to least.
 *
 * ## Why the order is what it is
 *
 * A limit exists to notice a call that will never finish. So the closer a setting is to the
 * particular tool, the more it should be believed: someone who says "this one report takes ten
 * minutes" knows something the global setting cannot. The global one exists for the opposite
 * case — "everything on this machine is slow" is a property of the environment, not of any tool.
 *
 * ## Why MCP keeps its own store
 *
 * An MCP server's timeouts live inside its own entry, keyed by the bare tool name, because that
 * is where a config pasted from another client puts them and where they survive being pasted
 * again. Everything else lives in `tools.timeouts`, keyed by the name the model calls. The UI
 * hides the difference and writes to whichever is right, so there is one store per kind rather
 * than two stores for one fact.
 */
export interface TimeoutSources {
  /** `tools.timeouts` — any tool, keyed by the name the model calls. */
  perTool?: Record<string, number> | undefined
  /** `tools.timeoutSeconds` — the fallback for everything. */
  global?: number | undefined
  /** The configured MCP servers, whose entries carry their own per-server and per-tool limits. */
  mcpServers?: McpServersConfig | undefined
}

/** Splits `server__tool` into its parts, or undefined when the name is not namespaced. */
function splitNamespaced(name: string): { server: string; tool: string } | undefined {
  const separator = name.indexOf('__')
  if (separator <= 0) return undefined
  return { server: name.slice(0, separator), tool: name.slice(separator + 2) }
}

/**
 * Seconds this tool may take, or undefined to leave it to whatever runs it.
 *
 * Undefined is meaningful and not the same as a large number: it means "this kind of tool has its
 * own default and no one has said otherwise", which is the state almost everything is in.
 */
export function timeoutForTool(name: string, sources: TimeoutSources): number | undefined {
  const direct = sources.perTool?.[name]
  if (direct !== undefined) return direct

  const namespaced = splitNamespaced(name)
  if (namespaced !== undefined) {
    const server = sources.mcpServers?.[namespaced.server]
    if (server !== undefined) {
      // The server's own store, keyed by the bare name, as a pasted config would write it.
      const perTool = server.toolTimeouts?.[namespaced.tool]
      if (perTool !== undefined) return perTool
      if (server.timeout !== undefined) return server.timeout
    }
  }

  return sources.global
}

/**
 * Where a timeout for this tool should be *written*.
 *
 * The UI offers one box per tool and this decides which store it lands in, so a value set on an
 * MCP tool stays with its server — travelling with the config if it is exported or pasted — while
 * everything else goes to the universal store.
 */
export function timeoutTargetFor(
  name: string,
  mcpServers: McpServersConfig | undefined,
): { kind: 'mcp'; server: string; tool: string } | { kind: 'tools'; name: string } {
  const namespaced = splitNamespaced(name)
  if (namespaced !== undefined && mcpServers?.[namespaced.server] !== undefined) {
    return { kind: 'mcp', server: namespaced.server, tool: namespaced.tool }
  }
  return { kind: 'tools', name }
}
