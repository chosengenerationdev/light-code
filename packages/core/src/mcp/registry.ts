import { z } from 'zod'
import type { Logger } from '../logging/logger.js'
import type { SecretStore } from '../platform/secrets.js'
import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import { McpConnection, type McpFetch, type McpToolDescriptor, type RawToolResult } from './client.js'
import { denyCheck } from './deny.js'
import type { McpToolCache, McpToolCacheEntry } from './toolCache.js'
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
  /** Tools a server marked for its own settings-tab buttons only: never offered to the model. */
  private readonly panelTools = new Map<string, Set<string>>()
  private readonly logs = new Map<string, string[]>()
  private servers: McpServersConfig = {}
  /**
   * Servers kept for Light Code's own use: their tools are never offered to the agent (not in the prompt, not through
   * call_tool), and only Light Code calls them (`callServerTool`). The web chat's Chrome server is one: the agent must
   * not be able to drive Chrome anywhere (`webchat/guard.ts`, rule 6).
   */
  private reserved = new Set<string>()

  constructor(
    private readonly secrets: SecretStore,
    private readonly events: McpRegistryEvents,
    private readonly logger?: Logger,
    /** Namespaced tool names the workspace always allows — see `WorkspaceApprovals`. */
    private readonly getAlwaysAllowed: () => readonly string[] = () => [],
    /**
     * The global tool timeout, when one is set — the last fallback before the SDK's own.
     *
     * A function rather than a value, so raising it applies to the next call rather than after a
     * restart: this registry outlives any one settings load.
     */
    private readonly defaultTimeout: (() => number | undefined) | undefined = undefined,
    /**
     * Whether a server was defined by the repository rather than the user. Asked afresh on every
     * connect, so it can never be stale, and such a server resolves no secret or environment
     * reference (see `InterpolationOptions.repositoryDefined`). Absent means none are.
     */
    private readonly isRepositoryServer: (name: string) => Promise<boolean> = async () => false,
    /** What servers offered when any session of this codebase last connected - see `toolCache.ts`. */
    private readonly toolCache: McpToolCache | undefined = undefined,
    /** How an HTTP server is reached (`InterpolationOptions.fetch`); asked on every connect, so a changed setting applies. */
    private readonly fetchFor: ((name: string, config: McpServerConfig) => Promise<McpFetch | undefined>) | undefined = undefined,
  ) {}

  /** Connections being opened, so two callers asking at once share one start rather than spawning two servers. */
  private readonly connecting = new Map<string, Promise<void>>()
  /** Servers whose tools are, for now, the remembered list rather than one the server gave this session. */
  private readonly fromCache = new Set<string>()

  /**
   * Offers the remembered tools of every enabled server that has not listed its own yet in this session,
   * when its connection settings are the ones the list was read under. A call to one waits for the server.
   */
  private async primeFromCache(): Promise<void> {
    if (this.toolCache === undefined) return
    let cached: Record<string, McpToolCacheEntry>
    try {
      cached = await this.toolCache.read()
    } catch {
      return
    }
    for (const [name, config] of Object.entries(this.servers)) {
      if (config.disabled === true || this.toolsByServer.has(name)) continue
      const entry = cached[name]
      if (entry === undefined || entry.signature !== connectionSignature(config)) continue
      this.setTools(name, entry.tools, async () => this.liveConnection(name))
      this.fromCache.add(name)
    }
  }

  /** The server's connection, started (or waited for) when it is not open yet. Throws with the reason it failed. */
  private async liveConnection(name: string): Promise<McpConnection> {
    const open = this.connections.get(name)
    if (open !== undefined) return open
    await this.connectServer(name)
    const connection = this.connections.get(name)
    if (connection === undefined) throw new Error(`the server did not start${this.errors.has(name) ? `: ${this.errors.get(name) ?? ''}` : ''}`)
    return connection
  }

  /** Records a server's tools - live or remembered - as tools the loop can call. */
  private setTools(name: string, listed: readonly McpToolDescriptor[], connectionFor: () => Promise<McpConnection>): void {
    /*
     * Panel-only tools are kept out of the tool list entirely - not hidden from the prompt but
     * callable, which `call_tool` would then reach. A button on the add-on's own tab is the only
     * way to them (`callPanelTool`), so an add-on can offer an action that changes something
     * (setting up a key on a server) without the model ever being able to ask for it.
     */
    this.panelTools.set(name, new Set(listed.filter((descriptor) => descriptor.panelOnly === true).map((descriptor) => descriptor.name)))
    const descriptors = listed.filter((descriptor) => descriptor.panelOnly !== true)
    this.toolsByServer.set(
      name,
      descriptors.map((descriptor) => ({
        descriptor,
        tool: adaptTool(name, descriptor.name, descriptor.description, descriptor.inputSchema, async (args) => {
          /*
           * Checked here, at the one place a call leaves for the server.
           *
           * Not in the loop and not in the approval gate: those can be auto-approved, and a
           * rule the user wrote to mean "never" must not be satisfiable by ticking a box. The
           * rules are read at call time so an edit applies to the next call rather than after
           * a restart — which is when somebody changes one, having just watched it not fire.
           */
          const decision = denyCheck(descriptor.name, args, this.servers[name]?.deny)
          if (decision.denied) {
            this.appendLog(name, decision.message ?? 'Refused by a deny rule.')
            throw new Error(decision.message ?? 'Refused by a deny rule.')
          }
          return (await connectionFor()).callTool(descriptor.name, args)
        }),
      })),
    )
  }

  /**
   * Starts every enabled server that is not connected yet and waits only for those this session has no
   * tools for: a server whose remembered list is offered keeps starting in the background, and a call to it
   * waits for it then. Waits at most `maxWaitMs` even for the others, so one server that never answers
   * cannot hold a reply - its tools join the turn after it does. Returns the servers still starting.
   */
  async ensureReady(maxWaitMs = 45_000): Promise<string[]> {
    const starting = Object.entries(this.servers)
      .filter(([name, config]) => config.disabled !== true && !this.connections.has(name))
      .map(([name]) => ({ name, done: this.connectServer(name).catch(() => undefined) }))
    const needed = starting.filter((entry) => !this.toolsByServer.has(entry.name))
    if (needed.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.all(needed.map((entry) => entry.done)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, maxWaitMs)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
    }
    return starting.filter((entry) => this.statuses.get(entry.name) === 'connecting').map((entry) => entry.name)
  }

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
        this.fromCache.delete(name)
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
        this.fromCache.delete(name)
      }
    }

    for (const name of reconnect) {
      const config = servers[name]
      // Fire-and-forget: a slow server must not hold up the save that triggered this.
      if (config !== undefined && config.disabled !== true) {
        void this.connectServer(name).catch(() => {
          // Already recorded as an error on the server's own state by `connect`.
        })
      }
    }

    await this.primeFromCache()
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
    const already = this.connecting.get(name)
    if (already !== undefined) return already
    const config = this.servers[name]
    if (config === undefined || config.disabled === true) return
    /*
     * Single-flight. The panel-open start and the first message's own check used to run together, and
     * each saw the server "not connected yet" and started it - two server processes for every server on
     * every session start, the second replacing the first.
     */
    const started = this.connect(name, config).finally(() => {
      if (this.connecting.get(name) === started) this.connecting.delete(name)
    })
    this.connecting.set(name, started)
    return started
  }

  /** Connects every enabled server that is not connected yet. Failures are per-server. */
  async ensureConnected(): Promise<void> {
    await Promise.all(
      Object.entries(this.servers)
        .filter(([name, config]) => config.disabled !== true && !this.connections.has(name))
        .map(([name]) => this.connectServer(name)),
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
      // Forwarded: without it a global timeout above the SDK's 60s default never applied to MCP.
      this.defaultTimeout,
      await (async () => {
        const fetch = isStdioServer(config) ? undefined : await this.fetchFor?.(name, config)
        return { repositoryDefined: await this.isRepositoryServer(name), ...(fetch !== undefined ? { fetch } : {}) }
      })(),
    )

    const startedAt = Date.now()
    try {
      await connection.connect()
      this.connections.set(name, connection)
      this.appendLog(name, 'Connected.')
      await this.refreshTools(name)
      // Named in the log when slow, so "the chat takes minutes to start" points at the server responsible.
      const seconds = (Date.now() - startedAt) / 1000
      if (seconds >= 2) this.logger?.info(`[startup] MCP server "${name}" took ${seconds.toFixed(1)}s to start and list its tools`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Remembered tools of a server that cannot start are withdrawn, so the next turn does not offer them.
      if (this.fromCache.delete(name)) this.toolsByServer.delete(name)
      this.logger?.warn(`MCP server "${name}" failed to connect after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${message}`)
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
      const listed = await connection.listTools()
      this.setTools(name, listed, async () => connection)
      this.fromCache.delete(name)
      const config = this.servers[name]
      if (config !== undefined && this.toolCache !== undefined) {
        void this.toolCache.write(name, { signature: connectionSignature(config), tools: listed, at: new Date().toISOString() })
      }
      this.statuses.set(name, 'ready')
      this.errors.delete(name)
      this.appendLog(name, `Discovered ${listed.filter((descriptor) => descriptor.panelOnly !== true).length} tool(s).`)
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
    this.fromCache.delete(name)
    if (this.servers[name] !== undefined && this.servers[name]?.disabled !== true) {
      this.statuses.set(name, 'idle')
    }
    if (options.silent !== true) this.events.onStateChanged()
  }

  /**
   * Calls one of a server's tools for a button the user pressed, returning the structured answer as
   * well as the text. Reaches a panel-only tool, and an ordinary one; deny rules still apply.
   */
  async callPanelTool(server: string, tool: string, args: Record<string, unknown>): Promise<RawToolResult> {
    const connection = this.connections.get(server)
    if (connection === undefined) throw new Error(`MCP server "${server}" is not running.`)
    const known = this.panelTools.get(server)?.has(tool) === true || (this.toolsByServer.get(server) ?? []).some((entry) => entry.descriptor.name === tool)
    if (!known) throw new Error(`"${server}" offers no tool "${tool}".`)
    const decision = denyCheck(tool, args, this.servers[server]?.deny)
    if (decision.denied) throw new Error(decision.message ?? 'Refused by a deny rule.')
    return connection.callToolRaw(tool, args)
  }

  /** Keeps these servers for Light Code's own use (see `reserved`); an empty list releases them. */
  reserve(servers: readonly string[]): void {
    this.reserved = new Set(servers)
  }

  isReserved(server: string): boolean {
    return this.reserved.has(server)
  }

  /** A connected server's tools by name, with their input schemas - reserved or not. */
  serverTools(server: string): { name: string; inputSchema?: Record<string, unknown> }[] {
    return (this.toolsByServer.get(server) ?? []).map(({ descriptor }) => ({
      name: descriptor.name,
      ...(descriptor.inputSchema !== undefined ? { inputSchema: descriptor.inputSchema as Record<string, unknown> } : {}),
    }))
  }

  /** The configuration of one server. */
  serverConfig(server: string): McpServerConfig | undefined {
    return this.servers[server]
  }

  /** Calls one tool of a connected server directly - Light Code's own call, never the agent's. */
  async callServerTool(server: string, tool: string, args: Record<string, unknown>): Promise<RawToolResult> {
    const connection = this.connections.get(server)
    if (connection === undefined) throw new Error(`MCP server "${server}" is not running.`)
    if (!(this.toolsByServer.get(server) ?? []).some((entry) => entry.descriptor.name === tool)) throw new Error(`"${server}" offers no tool "${tool}".`)
    return connection.callToolRaw(tool, args)
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
      if (config === undefined || config.disabled === true || this.reserved.has(name)) continue
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
          ...(config.toolTimeouts?.[descriptor.name] !== undefined
            ? { timeout: config.toolTimeouts[descriptor.name] }
            : {}),
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
