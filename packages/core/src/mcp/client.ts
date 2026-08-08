import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { SecretStore } from '../platform/secrets.js'
import { isStdioServer, type McpServerConfig } from './types.js'

const CLIENT_INFO = { name: 'light-code', version: '0.0.0' }

/** `${secret:NAME}` in an env value or header, resolved at spawn time — never stored. */
const SECRET_REFERENCE = /\$\{secret:([^}]+)\}/g

export async function interpolateSecrets(
  values: Record<string, string> | undefined,
  secrets: SecretStore,
): Promise<Record<string, string>> {
  if (values === undefined) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(values)) {
    const matches = [...raw.matchAll(SECRET_REFERENCE)]
    let resolved = raw
    for (const match of matches) {
      const secretName = match[1] as string
      const value = await secrets.get(secretName)
      if (value === undefined) {
        throw new Error(`Secret "${secretName}" is referenced by this MCP server but is not stored. Add it in Settings.`)
      }
      resolved = resolved.replace(match[0], value)
    }
    out[key] = resolved
  }
  return out
}

async function buildTransport(config: McpServerConfig, secrets: SecretStore): Promise<Transport> {
  if (isStdioServer(config)) {
    const configuredEnv = await interpolateSecrets(config.env, secrets)
    return new StdioClientTransport({
      command: config.command,
      ...(config.args !== undefined ? { args: config.args } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      // Passing `env` *replaces* the SDK's default rather than merging, so a server given
      // any env var at all would otherwise lose PATH and fail to spawn. The SDK's default
      // is already a safe allowlist (no arbitrary inheritance), which is what §15 wants:
      // nothing reaches an MCP server unless it was explicitly configured to receive it.
      env: { ...getDefaultEnvironment(), ...configuredEnv },
      // Otherwise a chatty server's stderr is interleaved into the extension host's own.
      stderr: 'pipe',
    })
  }

  const headers = await interpolateSecrets(config.headers, secrets)
  const httpTransport = new StreamableHTTPClientTransport(new URL(config.url), {
    ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
  })
  // The SDK's own concrete transports are not assignable to its `Transport` interface
  // under `exactOptionalPropertyTypes` (`sessionId: string | undefined` vs `sessionId?:
  // string`). That is an upstream strictness mismatch, not a real incompatibility —
  // cast here rather than relaxing the setting for the whole package. Re-check on SDK
  // upgrades; if it is fixed upstream this cast can go.
  return httpTransport as unknown as Transport
}

export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: unknown
}

/**
 * Thin wrapper over the SDK client. Deliberately thin: the SDK owns the protocol, and
 * hand-rolling JSON-RPC is explicitly out (§11).
 */
export class McpConnection {
  private client: Client | undefined
  private transport: Transport | undefined

  constructor(
    readonly serverName: string,
    private readonly config: McpServerConfig,
    private readonly secrets: SecretStore,
    /** Called when the server announces its tool list changed (`tools/list_changed`). */
    private readonly onToolsChanged: () => void,
    /** Receives the server's stderr, line by line. */
    private readonly onLog: (line: string) => void = () => {},
  ) {}

  async connect(): Promise<void> {
    const client = new Client(CLIENT_INFO, {
      capabilities: {},
      listChanged: { tools: { onChanged: () => this.onToolsChanged() } },
    })
    const transport = await buildTransport(this.config, this.secrets)

    // Attached *before* connect, so startup diagnostics aren't missed — and, more
    // importantly, so the pipe is drained. `stderr: 'pipe'` with no reader fills the OS
    // buffer (~64KB) and then blocks the child on its next write, which looks like the
    // server mysteriously hanging partway through work.
    if (transport instanceof StdioClientTransport) {
      this.attachStderr(transport)
    }

    await client.connect(transport)
    this.client = client
    this.transport = transport
  }

  private attachStderr(transport: StdioClientTransport): void {
    const stream = transport.stderr
    if (stream === null) return
    let buffered = ''
    stream.on('data', (chunk: Buffer | string) => {
      buffered += chunk.toString()
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length > 0) this.onLog(line)
      }
    })
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    if (this.client === undefined) throw new Error(`MCP server "${this.serverName}" is not connected.`)
    const result = await this.client.listTools()
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (this.client === undefined) throw new Error(`MCP server "${this.serverName}" is not connected.`)
    const result = await this.client.callTool({ name, arguments: args })
    return renderToolResult(result)
  }

  async close(): Promise<void> {
    try {
      await this.client?.close()
    } finally {
      this.client = undefined
      this.transport = undefined
    }
  }

  get isConnected(): boolean {
    return this.client !== undefined
  }
}

/** Flattens MCP's content blocks into the plain string our `ToolResult` carries. */
function renderToolResult(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content
  if (!Array.isArray(content)) return JSON.stringify(result)

  const parts = content.map((block) => {
    const typed = block as { type?: string; text?: string }
    if (typed.type === 'text' && typeof typed.text === 'string') return typed.text
    // Images and embedded resources aren't renderable as text in v1 — say what was
    // returned rather than dumping base64 into the conversation.
    return `[${typed.type ?? 'unknown'} content omitted]`
  })
  return parts.join('\n')
}
