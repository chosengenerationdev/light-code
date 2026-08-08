import { z } from 'zod'

/**
 * The standard `mcpServers` shape, so a config pasted from another MCP client works
 * unmodified (CLAUDE.md §11). Transport is inferred rather than declared: an entry with
 * `command` is stdio, one with `url` is Streamable HTTP — that is how other clients'
 * configs are written, and requiring an explicit `type` would break pasting.
 */
export const stdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /**
   * Values may reference a stored secret as `${secret:NAME}` — resolved at spawn time
   * from `SecretStore`, never written to the config file (§15).
   */
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  /** Per-server kill switch. Absent means enabled. */
  disabled: z.boolean().optional(),
  /** Tool names disabled individually within this server. */
  disabledTools: z.array(z.string()).optional(),
})

export const httpServerSchema = z.object({
  url: z.string().min(1).url(),
  headers: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
  disabledTools: z.array(z.string()).optional(),
})

export const mcpServerSchema = z.union([stdioServerSchema, httpServerSchema])
export const mcpServersSchema = z.record(z.string(), mcpServerSchema)

export type StdioServerConfig = z.infer<typeof stdioServerSchema>
export type HttpServerConfig = z.infer<typeof httpServerSchema>
export type McpServerConfig = z.infer<typeof mcpServerSchema>
export type McpServersConfig = z.infer<typeof mcpServersSchema>

export function isStdioServer(config: McpServerConfig): config is StdioServerConfig {
  return 'command' in config
}

export type McpServerStatus = 'idle' | 'connecting' | 'ready' | 'failed' | 'disabled'

export interface McpServerState {
  name: string
  status: McpServerStatus
  /** Tool names as advertised by the server, before namespacing. */
  toolNames: string[]
  error?: string
}

/**
 * Namespaced so two servers exposing the same tool name can coexist — collisions across
 * servers are inevitable (§11). Double underscore because a single one is common inside
 * tool names themselves.
 */
export function namespacedToolName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`
}

export function parseNamespacedToolName(name: string): { serverName: string; toolName: string } | undefined {
  const index = name.indexOf('__')
  if (index <= 0) return undefined
  return { serverName: name.slice(0, index), toolName: name.slice(index + 2) }
}

/**
 * Package runners fetch from the network on machinery Light Code chose, so they sit
 * awkwardly on the §3 security boundary and are treated as ours to warn about.
 */
const PACKAGE_RUNNERS = new Set(['npx', 'npx.cmd', 'pnpm', 'pnpm.cmd', 'pnpx', 'bunx', 'uvx', 'yarn', 'yarn.cmd'])

export function isPackageRunnerCommand(command: string): boolean {
  const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return PACKAGE_RUNNERS.has(base)
}
