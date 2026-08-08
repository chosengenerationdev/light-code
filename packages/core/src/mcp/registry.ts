import { z } from 'zod'
import type { Logger } from '../logging/logger.js'
import type { SecretStore } from '../platform/secrets.js'
import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import { McpConnection } from './client.js'
import {
  isPackageRunnerCommand,
  isStdioServer,
  namespacedToolName,
  type McpServerConfig,
  type McpServersConfig,
  type McpServerState,
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

/**
 * Owns connections, their lifecycle, and the tools they expose. Connects lazily — a
 * configured-but-unused server should not cost a process at startup (§11).
 */
export class McpRegistry {
  private readonly connections = new Map<string, McpConnection>()
  private readonly states = new Map<string, McpServerState>()
  private readonly toolsByServer = new Map<string, Tool[]>()
  private servers: McpServersConfig = {}

  constructor(
    private readonly secrets: SecretStore,
    private readonly events: McpRegistryEvents,
    private readonly logger?: Logger,
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
        this.states.set(name, { name, status: 'disabled', toolNames: [] })
      } else if (!this.states.has(name) || this.states.get(name)?.status === 'disabled') {
        this.states.set(name, { name, status: 'idle', toolNames: [] })
      }
    }
    for (const name of [...this.states.keys()]) {
      if (servers[name] === undefined) this.states.delete(name)
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
    this.states.set(name, { name, status: 'connecting', toolNames: [] })
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
      this.states.set(name, { name, status: 'failed', toolNames: [], error: message })
      this.events.onStateChanged()
    }
  }

  private async refreshTools(name: string): Promise<void> {
    const connection = this.connections.get(name)
    if (connection === undefined) return

    try {
      const descriptors = await connection.listTools()
      const tools = descriptors.map((descriptor) =>
        adaptTool(name, descriptor.name, descriptor.description, descriptor.inputSchema, (args) =>
          connection.callTool(descriptor.name, args),
        ),
      )
      this.toolsByServer.set(name, tools)
      this.states.set(name, { name, status: 'ready', toolNames: descriptors.map((d) => d.name) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.states.set(name, { name, status: 'failed', toolNames: [], error: message })
    }
    this.events.onStateChanged()
  }

  async disconnect(name: string): Promise<void> {
    await this.connections.get(name)?.close()
    this.connections.delete(name)
    this.toolsByServer.delete(name)
    if (this.servers[name] !== undefined) {
      this.states.set(name, { name, status: 'idle', toolNames: [] })
    }
    this.events.onStateChanged()
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
    for (const [name, tools] of this.toolsByServer) {
      const config = this.servers[name]
      if (config === undefined || config.disabled === true) continue
      const disabledTools = new Set(config.disabledTools ?? [])
      for (const tool of tools) {
        const bare = tool.name.slice(name.length + 2)
        if (!disabledTools.has(bare)) out.push(tool)
      }
    }
    return out
  }

  states_(): McpServerState[] {
    return [...this.states.values()]
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)))
  }
}
