import { z } from 'zod'
import type { Logger } from '../logging/logger.js'
import type { SecretStore } from '../platform/secrets.js'
import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import { McpConnection, type McpToolDescriptor } from './client.js'
import {
  isPackageRunnerCommand,
  isStdioServer,
  namespacedToolName,
  resolveToolPermission,
  type McpServerConfig,
  type McpServersConfig,
  type McpServerState,
  type McpServerStatus,
  type McpToolPermission,
} from './types.js'

/**
 * MCP tools are adapted into the same `Tool` interface as built-ins, so the agent loop,
 * the approval gate, and mode filtering treat them identically — an MCP tool is gated
 * exactly like `execute_command` is, with no special-casing anywhere upstream.
 */
function adaptTool(
  serverName: string,
  toolName: string,
  description: string,
  inputSchema: unknown,
  call: (args: Record<string, unknown>) => Promise<string>,
): Tool {
  return {
    name: namespacedToolName(serverName, toolName),
    group: 'mcp',
    description,
    // Permissive locally — the server's own schema (below) is authoritative and the
    // server validates properly on its side. Re-deriving it here would risk rejecting
    // valid calls over a translation difference.
    parametersSchema: z.record(z.string(), z.unknown()),
    // Passed through untouched: §11 names schema translation as a silent-failure source.
    rawJsonSchema: inputSchema,
    async execute(params): Promise<ToolResult> {
      try {
        return { content: await call(params) }
      } catch (error) {
        return {
          content: `MCP tool "${toolName}" on server "${serverName}" failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        }
      }
    },
    async preview(params): Promise<ToolPreview> {
      return { kind: 'text', text: `${serverName} → ${toolName}\n${JSON.stringify(params, null, 2)}` }
    },
  }
}

export interface McpRegistryEvents {
  onStateChanged(): void
}

interface DiscoveredTool {
  descriptor: McpToolDescriptor
  tool: Tool
}

/**
 * Owns connections, their lifecycle, and the tools they expose. Connects lazily — a
 * configured-but-unused server should not cost a process at startup (§11).
 */
export class McpRegistry {
  private readonly connections = new Map<string, McpConnection>()
  private readonly statuses = new Map<string, McpServerStatus>()
  private readonly errors = new Map<string, string>()
  private readonly toolsByServer = new Map<string, DiscoveredTool[]>()
  private servers: McpServersConfig = {}

  constructor(
    private readonly secrets: SecretStore,
    private readonly events: McpRegistryEvents,
    private readonly logger?: Logger,
    /** Namespaced tool names the workspace always allows — see `WorkspaceApprovals`. */
    private readonly getAlwaysAllowed: () => readonly string[] = () => [],
  ) {}

  /** Replaces the configured server set, closing any that disappeared or changed. */
  async configure(servers: McpServersConfig): Promise<void> {
    const previous = this.servers
    this.servers = servers

    for (const name of this.connections.keys()) {
      const before = previous[name]
      const after = servers[name]
      if (after === undefined || JSON.stringify(before) !== JSON.stringify(after)) {
        await this.disconnect(name)
      }
    }

    for (const [name, config] of Object.entries(servers)) {
      if (config.disabled === true) {
        this.statuses.set(name, 'disabled')
        this.toolsByServer.delete(name)
        await this.disconnect(name, { silent: true })
      } else if (!this.statuses.has(name) || this.statuses.get(name) === 'disabled') {
        this.statuses.set(name, 'idle')
      }
    }
    for (const name of [...this.statuses.keys()]) {
      if (servers[name] === undefined) {
        this.statuses.delete(name)
        this.errors.delete(name)
        this.toolsByServer.delete(name)
      }
    }

    this.events.onStateChanged()
  }

  /** Warnings the UI should surface before a server is started, e.g. package runners. */
  warningsFor(name: string): string[] {
    const config = this.servers[name]
    if (config === undefined || !isStdioServer(config)) return []
    if (!isPackageRunnerCommand(config.command)) return []
    return [
      `"${name}" runs via ${config.command}, which downloads the server from the network on first use. ` +
        'Light Code makes no other network connection you have not configured.',
    ]
  }

  /** Connects every enabled server that is not connected yet. Failures are per-server. */
  async ensureConnected(): Promise<void> {
    await Promise.all(
      Object.entries(this.servers)
        .filter(([name, config]) => config.disabled !== true && !this.connections.has(name))
        .map(([name, config]) => this.connect(name, config)),
    )
  }

  private async connect(name: string, config: McpServerConfig): Promise<void> {
    this.statuses.set(name, 'connecting')
    this.errors.delete(name)
    this.events.onStateChanged()

    const connection = new McpConnection(name, config, this.secrets, () => {
      void this.refreshTools(name)
    })

    try {
      await connection.connect()
      this.connections.set(name, connection)
      await this.refreshTools(name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.warn(`MCP server "${name}" failed to connect: ${message}`)
      // One server failing must not affect the others — state is per-server.
      this.statuses.set(name, 'failed')
      this.errors.set(name, message)
      this.events.onStateChanged()
    }
  }

  private async refreshTools(name: string): Promise<void> {
    const connection = this.connections.get(name)
    if (connection === undefined) return

    try {
      const descriptors = await connection.listTools()
      this.toolsByServer.set(
        name,
        descriptors.map((descriptor) => ({
          descriptor,
          tool: adaptTool(name, descriptor.name, descriptor.description, descriptor.inputSchema, (args) =>
            connection.callTool(descriptor.name, args),
          ),
        })),
      )
      this.statuses.set(name, 'ready')
      this.errors.delete(name)
    } catch (error) {
      this.statuses.set(name, 'failed')
      this.errors.set(name, error instanceof Error ? error.message : String(error))
    }
    this.events.onStateChanged()
  }

  async disconnect(name: string, options: { silent?: boolean } = {}): Promise<void> {
    await this.connections.get(name)?.close()
    this.connections.delete(name)
    this.toolsByServer.delete(name)
    if (this.servers[name] !== undefined && this.servers[name]?.disabled !== true) {
      this.statuses.set(name, 'idle')
    }
    if (options.silent !== true) this.events.onStateChanged()
  }

  async restart(name: string): Promise<void> {
    await this.disconnect(name)
    const config = this.servers[name]
    if (config !== undefined && config.disabled !== true) await this.connect(name, config)
  }

  /**
   * Enabled tools only. A disabled server or tool is absent from the system prompt
   * entirely, not merely refused at call time (§11) — the same rule as mode filtering.
   */
  enabledTools(): Tool[] {
    const out: Tool[] = []
    for (const [name, discovered] of this.toolsByServer) {
      const config = this.servers[name]
      if (config === undefined || config.disabled === true) continue
      const disabledTools = new Set(config.disabledTools ?? [])
      for (const { descriptor, tool } of discovered) {
        if (!disabledTools.has(descriptor.name)) out.push(tool)
      }
    }
    return out
  }

  /**
   * Composed from the two stores that already exist rather than a third — see
   * `resolveToolPermission` for why `never` takes precedence over `always`.
   */
  private permissionFor(serverName: string, toolName: string): McpToolPermission {
    return resolveToolPermission(
      toolName,
      namespacedToolName(serverName, toolName),
      this.servers[serverName]?.disabledTools,
      this.getAlwaysAllowed(),
    )
  }

  states_(): McpServerState[] {
    return Object.entries(this.servers).map(([name, config]) => {
      const discovered = this.toolsByServer.get(name) ?? []
      const error = this.errors.get(name)
      return {
        name,
        status: this.statuses.get(name) ?? 'idle',
        enabled: config.disabled !== true,
        tools: discovered.map(({ descriptor }) => ({
          name: descriptor.name,
          namespacedName: namespacedToolName(name, descriptor.name),
          description: descriptor.description,
          permission: this.permissionFor(name, descriptor.name),
        })),
        ...(error !== undefined ? { error } : {}),
      }
    })
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)))
  }
}
