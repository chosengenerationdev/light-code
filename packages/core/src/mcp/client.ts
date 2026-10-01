import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { SecretStore } from '../platform/secrets.js'
import { isStdioServer, type McpServerConfig } from './types.js'

const CLIENT_INFO = { name: 'light-code', version: '0.0.0' }

/**
 * References in an env value or header, resolved at connect time — never stored.
 *
 * `${secret:NAME}` reads secret storage; `${env:NAME}` reads this process's environment. The
 * second is the form Roo Code and Cline use, so a config pasted from either works unchanged —
 * unread, it would be sent **literally**, and a server receiving `Bearer ${env:TOKEN}` answers
 * 401, which reads as a bad token rather than an unread reference.
 */
const REFERENCE = /\$\{([A-Za-z]+):([^}]+)\}/g

export interface InterpolationOptions {
  /**
   * The server was defined by the repository (`.lightcode/config.json`), not by the user.
   *
   * Such a server may not resolve any reference. `mcpServers` is deliberately allowed in
   * workspace config (§11: every *call* is approval-gated), but **connecting is not gated** — it
   * happens when the panel opens. So a cloned repository naming its own URL and a header of
   * `${secret:profile:gateway:apiKey}` would post your gateway key to a host of its choosing
   * before you had looked at anything. Literal values in a repository's config are the
   * repository's own business; references reach into yours.
   */
  repositoryDefined?: boolean
  /** The environment `${env:NAME}` reads. Defaults to this process's. */
  env?: Record<string, string | undefined>
}

export async function interpolateSecrets(
  values: Record<string, string> | undefined,
  secrets: SecretStore,
  options: InterpolationOptions = {},
): Promise<Record<string, string>> {
  if (values === undefined) return {}
  const env = options.env ?? process.env
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(values)) {
    let resolved = raw
    for (const match of raw.matchAll(REFERENCE)) {
      const written = match[1] as string
      const kind = written.toLowerCase()
      const name = (match[2] as string).trim()
      if (kind !== 'secret' && kind !== 'env') {
        // `${input:...}` is VS Code's own mcp.json prompt syntax. Sent literally, it is a 401.
        throw new Error(
          `"${key}" uses \${${written}:${name}}, which Light Code does not resolve — only \${secret:NAME} (secret storage) and \${env:NAME} (an environment variable) are understood.`,
        )
      }
      if (options.repositoryDefined === true) {
        throw new Error(
          `"${key}" references \${${kind}:${name}}, but this server is defined in the project's .lightcode/config.json. A repository may not read your secrets or environment, because a server connects as soon as the panel opens. Add the server in Settings → MCP instead.`,
        )
      }
      const value = kind === 'secret' ? await secrets.get(name) : env[name]
      if (value === undefined) {
        throw new Error(
          kind === 'secret'
            ? `Secret "${name}" is referenced by this MCP server but is not stored. Add it in Settings.`
            : `Environment variable "${name}" is referenced by this MCP server but is not set in the environment VS Code was started from. Set it and restart VS Code, or store the value as a secret and use \${secret:NAME}.`,
        )
      }
      resolved = resolved.replace(match[0], value)
    }
    out[key] = resolved
  }
  return out
}

async function buildTransport(
  config: McpServerConfig,
  secrets: SecretStore,
  options: InterpolationOptions,
): Promise<Transport> {
  if (isStdioServer(config)) {
    const configuredEnv = await interpolateSecrets(config.env, secrets, options)
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

  const headers = await interpolateSecrets(config.headers, secrets, options)
  return httpTransport(config.url, headers, httpKindOf(config))
}

/**
 * Which HTTP protocol to try first.
 *
 * A declared `type` is obeyed. Absent, Streamable HTTP is tried first and SSE is the fallback —
 * the order the specification itself recommends, since SSE is superseded but widely deployed
 * (§11). **The URL is not used to guess**: plenty of Streamable HTTP endpoints are served at a
 * path containing `sse`, and a guess that is wrong produces an authentication-shaped error
 * rather than a transport-shaped one, which sends people to check their token.
 */
function httpKindOf(config: { type?: string | undefined }): 'sse' | 'streamable-http' {
  return config.type === 'sse' ? 'sse' : 'streamable-http'
}

/**
 * One HTTP transport, built for a named protocol.
 *
 * Configured headers go on `requestInit` for both. Checked against the SDK rather than assumed,
 * because the usual trap here is an SSE stream opening unauthenticated while the POSTs carry the
 * token: `SSEClientTransport._startOrAuth` builds the long-lived GET from `_commonHeaders()`,
 * which folds in `requestInit.headers`, so one place covers both halves. Re-check on SDK upgrades
 * — the failure would be a 401 on the stream alone, with a configuration that visibly holds the
 * token.
 */
function httpTransport(
  url: string,
  headers: Record<string, string>,
  kind: 'sse' | 'streamable-http',
): Transport {
  const options = Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}
  const transport =
    kind === 'sse'
      ? new SSEClientTransport(new URL(url), options)
      : new StreamableHTTPClientTransport(new URL(url), options)
  // The SDK's own concrete transports are not assignable to its `Transport` interface
  // under `exactOptionalPropertyTypes` (`sessionId: string | undefined` vs `sessionId?:
  // string`). That is an upstream strictness mismatch, not a real incompatibility —
  // cast here rather than relaxing the setting for the whole package. Re-check on SDK
  // upgrades; if it is fixed upstream this cast can go.
  return transport as unknown as Transport
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
    /**
     * The global tool timeout, when one is set, as the last fallback before the SDK's own.
     *
     * A function rather than a value: raising it should apply to the next call, not after a
     * restart, and this object outlives any one settings load.
     */
    private readonly defaultTimeout: (() => number | undefined) | undefined = undefined,
    /** See `InterpolationOptions` — whether this server came from the repository. */
    private readonly interpolation: InterpolationOptions = {},
  ) {}

  async connect(): Promise<void> {
    const client = new Client(CLIENT_INFO, {
      capabilities: {},
      listChanged: { tools: { onChanged: () => this.onToolsChanged() } },
    })
    const transport = await buildTransport(this.config, this.secrets, this.interpolation)

    // Attached *before* connect, so startup diagnostics aren't missed — and, more
    // importantly, so the pipe is drained. `stderr: 'pipe'` with no reader fills the OS
    // buffer (~64KB) and then blocks the child on its next write, which looks like the
    // server mysteriously hanging partway through work.
    if (transport instanceof StdioClientTransport) {
      this.attachStderr(transport)
    }

    this.onLog(await describeMcpRequest(this.config, this.secrets, this.interpolation))

    try {
      await client.connect(transport)
    } catch (error) {
      /*
       * One retry on the other HTTP protocol, and only where nothing was declared.
       *
       * A server speaking the superseded SSE protocol, driven with Streamable HTTP, fails at the
       * first POST — and how it fails is up to whatever is in front of it. Reported from real use
       * as a 401 from a server another client talks to happily, which reads as a rejected token
       * and sends people to check a credential that was never the problem.
       *
       * A declared `type` is never second-guessed: somebody who wrote it down wants to be told
       * their server is not answering, not to have a different protocol tried behind their back.
       */
      const fallback = await this.fallbackTransport(error)
      if (fallback === undefined) {
        if (isUnauthorized(error)) this.onLog(unauthorizedHint(this.config))
        throw error
      }
      try {
        await client.connect(fallback)
      } catch (sseError) {
        /*
         * Both errors, never only the second. The fallback's failure used to replace the first,
         * so a Streamable HTTP server that failed for some ordinary reason — and then refused the
         * SSE retry with a 401, as an endpoint not expecting a GET often does — was reported as a
         * rejected token. Somebody checks the token, finds it right, and has nowhere to go.
         */
        if (isUnauthorized(error) || isUnauthorized(sseError)) this.onLog(unauthorizedHint(this.config))
        throw new Error(
          `Streamable HTTP failed: ${describeError(error)}. Retried as SSE, which also failed: ${describeError(sseError)}. If you know which one the server speaks, choose it under Transport in the server's settings so only that one is tried.`,
          { cause: sseError },
        )
      }
      this.client = client
      this.transport = fallback
      this.onLog(`Connected over SSE; Streamable HTTP was refused (${describeError(error)})`)
      return
    }
    this.client = client
    this.transport = transport
  }

  /** The other HTTP protocol, when this server never said which it speaks. */
  private async fallbackTransport(error: unknown): Promise<Transport | undefined> {
    const config = this.config
    if (isStdioServer(config) || config.type !== undefined) return undefined
    this.onLog(`Streamable HTTP failed (${describeError(error)}) — retrying as SSE`)
    const headers = await interpolateSecrets(config.headers, this.secrets, this.interpolation)
    return httpTransport(config.url, headers, 'sse')
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
    /*
     * The SDK's own timeout, rather than a race against our own timer.
     *
     * Racing would leave the request outstanding on a server that is merely slow, so the reply
     * arrives later against a call nobody is waiting for. Passing it down means the SDK cancels
     * the request properly.
     */
    // Most specific wins: this tool's own limit, then the server's, then the SDK's default.
    // Most specific wins: this tool, then this server, then the global default, then the SDK's.
    const timeoutSeconds = this.config.toolTimeouts?.[name] ?? this.config.timeout ?? this.defaultTimeout?.()
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      timeoutSeconds === undefined ? undefined : { timeout: timeoutSeconds * 1000 },
    )
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

/** A one-line reason, for the server's own log in the MCP tab. Never carries a header value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What is about to be sent, as one line for this server's log.
 *
 * **Header names, never values** (§15) — the point is a line somebody can paste into a bug report,
 * and a token in it would be a leak on the way past.
 *
 * It exists because of a report this could not otherwise answer: a remote server replying "double
 * check your token or domain" while the configuration plainly contained a token. From the outside
 * there is no way to tell whether the header was never sent, sent empty, sent under a name the
 * server does not read, or sent over the wrong protocol — four different fixes behind one message.
 *
 * A free function rather than a method so it can be tested without opening a socket: the version
 * that called `connect()` to read its own log spent thirty seconds resolving a hostname that does
 * not exist.
 */
export async function describeMcpRequest(
  config: McpServerConfig,
  secrets: SecretStore,
  options: InterpolationOptions = {},
): Promise<string> {
  if (isStdioServer(config)) return `Starting ${config.command}`

  const kind = config.type ?? 'streamable-http (no type set; SSE is the fallback)'
  let names: string[]
  try {
    // Resolved, so a `${secret:NAME}` that is stored but empty is visible as such.
    const resolved = await interpolateSecrets(config.headers, secrets, options)
    names = Object.entries(resolved).map(([name, value]) =>
      value.trim().length === 0 ? `${name} (EMPTY)` : name,
    )
  } catch (error) {
    return `Connecting to ${config.url} as ${kind}; headers unresolved: ${describeError(error)}`
  }

  const headers = names.length === 0 ? 'no headers configured' : `headers: ${names.join(', ')}`
  return `Connecting to ${config.url} as ${kind}; ${headers}`
}

/** The SDK reports a refused request as an error whose message carries the status. */
function isUnauthorized(error: unknown): boolean {
  return /\b401\b|unauthori[sz]ed/i.test(describeError(error))
}

/**
 * What a 401 usually means, written to the server's log. Names headers, never values.
 *
 * The causes that cover nearly every report, roughly in order: the scheme is missing or doubled,
 * the server reads a different header than the one sent, the server signs in through a browser
 * (OAuth), which other clients do and Light Code does not, and an expired token.
 */
export function unauthorizedHint(config: McpServerConfig): string {
  if (isStdioServer(config)) return 'The server refused the request (401).'
  const headers = Object.entries(config.headers ?? {})
  const lines = ['The server answered 401 (not authorised). Worth checking, in order:']
  if (headers.length === 0) {
    lines.push('- No headers are configured, so nothing identified you. Add the one the server expects, usually Authorization: Bearer <token>.')
  } else {
    const auth = headers.find(([name]) => name.trim().toLowerCase() === 'authorization')
    const value = auth?.[1].trim()
    if (value !== undefined && /^bearer\s+bearer\s/i.test(value)) {
      lines.push('- Authorization reads "Bearer Bearer …" — the token itself probably already starts with Bearer.')
    } else if (value !== undefined && !/^\S+\s+\S/.test(value) && !value.startsWith('${')) {
      lines.push('- Authorization holds a bare token with no scheme. Most servers want "Bearer <token>"; compare with the value the other client sends.')
    }
    lines.push(`- Sending ${headers.map(([name]) => name).join(', ')}. Is that the header name the server reads (Authorization, X-API-Key, …)?`)
  }
  lines.push('- Does the server sign in through a browser (OAuth) in the other client? Light Code sends configured headers only, so it needs a token supplied as a header.')
  lines.push('- Is it the same, unexpired token the other client uses?')
  return lines.join('\n')
}
