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

const MAX_LOG_LINES = 200

interface DiscoveredTool {
  descriptor: McpToolDescriptor
  tool: Tool
}

/**
 * Owns connections, their lifecycle, and the tools they expose. Connects lazily — a
 * configured-but-unused server should not cost a process at startup (§11).
 */
/**
 * The parts of a server entry that decide *how* we connect to it.
 *
 * Compared instead of the whole entry, because the whole entry also carries **policy** —
 * `disabledTools` and `disabled` — and a change to policy is not a reason to tear down a
 * running process.
 *
 * This was a real bug, and an ugly one: setting a tool to Always or Never wrote
 * `disabledTools` into the entry, the naive whole-entry comparison saw a difference, and the
 * server was disconnected mid-session. It stayed down until the next turn or panel open, so
 * from the outside changing a permission simply killed the server. `disabled` is excluded for
 * the same reason and is handled deliberately below, where it disconnects *on purpose*.
 *
 * Omitting rather than listing the connection fields on purpose. A new transport field added
 * later is then compared by default and correctly forces a reconnect; forgetting to add a new
 * *policy* field here merely reconnects when it need not, which is the safe direction to fail.
 */
export function connectionSignature(config: McpServerConfig | undefined): string {
  if (config === undefined) return ''
  const connection: Record<string, unknown> = { ...config }
  delete connection.disabledTools
  delete connection.disabled
  return JSON.stringify(connection)
}

export class McpRegistry {
  private readonly connections = new Map<string, McpConnection>()
  private readonly statuses = new Map<string, McpServerStatus>()
  private readonly errors = new Map<string, string>()
  private readonly toolsByServer = new Map<string, DiscoveredTool[]>()
  private readonly logs = new Map<string, string[]>()
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

    /*
     * Reconnected immediately rather than left idle. A server whose command or URL was just
     * edited was running a moment ago and the user expects it to still be running — leaving it
     * down until the next turn is why editing one appeared to stop it.
     *
     * Only servers that were *already* connected are restarted, so this never spawns a process
     * the user had not already started (§11: nothing spawns at VS Code startup).
     */
    const reconnect: string[] = []
    for (const name of this.connections.keys()) {
      const after = servers[name]
      if (after === undefined || connectionSignature(previous[name]) !== connectionSignature(after)) {
        reconnect.push(name)
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

    for (const name of reconnect) {
      const config = servers[name]
      // Fire-and-forget: a slow server must not hold up the save that triggered this.
      if (config !== undefined && config.disabled !== true) {
        void this.connect(name, config).catch(() => {
          // Already recorded as an error on the server's own state by `connect`.
        })
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

  /**
   * Connects one server on demand. Lazy connect (§11) is about not spawning processes at
   * startup — it should never mean the user cannot find out whether a config is valid
   * until something happens to trigger it. This backs the UI's explicit Connect action
   * and the automatic verification after a config save.
   */
  async connectServer(name: string): Promise<void> {
    if (this.connections.has(name)) return
    const config = this.servers[name]
    if (config === undefined || config.disabled === true) return
    await this.connect(name, config)
  }

  /** Connects every enabled server that is not connected yet. Failures are per-server. */
  async ensureConnected(): Promise<void> {
    await Promise.all(
      Object.entries(this.servers)
        .filter(([name, config]) => config.disabled !== true && !this.connections.has(name))
        .map(([name, config]) => this.connect(name, config)),
    )
  }

  /** Bounded so a chatty server cannot grow this without limit over a long session. */
  private appendLog(name: string, line: string): void {
    const existing = this.logs.get(name) ?? []
    existing.push(line)
    if (existing.length > MAX_LOG_LINES) existing.splice(0, existing.length - MAX_LOG_LINES)
    this.logs.set(name, existing)
    this.events.onStateChanged()
  }

  private async connect(name: string, config: McpServerConfig): Promise<void> {
    this.statuses.set(name, 'connecting')
    this.errors.delete(name)
    this.appendLog(name, `Starting ${isStdioServer(config) ? config.command : config.url}…`)
    this.events.onStateChanged()

    const connection = new McpConnection(
      name,
      config,
      this.secrets,
      () => {
        void this.refreshTools(name)
      },
      (line) => {
        this.logger?.debug(`[mcp:${name}] ${line}`)
        this.appendLog(name, line)
      },
    )

    try {
      await connection.connect()
      this.connections.set(name, connection)
      this.appendLog(name, 'Connected.')
      await this.refreshTools(name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.warn(`MCP server "${name}" failed to connect: ${message}`)
      // One server failing must not affect the others — state is per-server.
      this.statuses.set(name, 'failed')
      this.errors.set(name, message)
      this.appendLog(name, `Failed: ${message}`)
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
      this.appendLog(name, `Discovered ${descriptors.length} tool(s).`)
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
        logs: this.logs.get(name) ?? [],
        ...(error !== undefined ? { error } : {}),
      }
    })
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)))
  }
}
