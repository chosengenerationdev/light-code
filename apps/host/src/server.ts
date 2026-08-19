import fs from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import path from 'node:path'
import type { Transport } from '@light-code/core'
import { SingleUserIdentity, type IdentityProvider, type Principal } from './identity.js'
import { isAdminOnly, refusalFor, SINGLE_USER_POLICY, type RolePolicy } from './roles.js'
import { checkRequest, readJsonBody, reject, securityHeaders, type OriginPolicy } from './security.js'
import { createSession } from './session.js'

/*
 * `node:http` is on invariant 2's banned list, which exists so that all outbound traffic
 * goes through core's single HttpClient. A listening socket is ingress, not egress: nothing
 * here makes a request, and the model gateway is still reached only through HttpClient.
 * The disable is file-scoped and this comment is the recorded reason.
 */

const CLIENT_ASSETS: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/client.js': 'client.js',
  '/client.css': 'client.css',
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

export interface ServerOptions {
  workspaceRoot: string | undefined
  dataDir: string
  /** Directory holding the built browser bundle. */
  clientDir: string
  ripgrepPath: string | undefined
  identity?: IdentityProvider
  /**
   * Loopback only unless deliberately changed. Binding the literal address rather than
   * `localhost` matters: the name resolves differently per machine and can dual-stack onto
   * an interface that is not loopback at all (§14).
   */
  bindAddress?: string
  port?: number
  logSink?: (line: string) => void
  /**
   * Who may change shared configuration. Defaults to "everyone", which is correct for the
   * local single-user case and wrong for anything else — see `roles.ts`.
   */
  roles?: RolePolicy
}

export interface RunningServer {
  url: string
  /** Present only in single-user mode; the launch URL carries it in the fragment. */
  launchToken: string | undefined
  close: () => Promise<void>
}

/**
 * One live event stream per principal.
 *
 * Streaming out and posting in are two halves of one `Transport`. They are separate HTTP
 * requests, so the stream has to be found again by principal when a message arrives.
 */
interface Connection {
  transport: Transport
  deliver: (message: unknown) => void
  dispose: () => void
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.logSink ?? ((line: string) => process.stderr.write(`${line}\n`))
  const identity = options.identity ?? new SingleUserIdentity()
  const roles = options.roles ?? SINGLE_USER_POLICY
  const bindAddress = options.bindAddress ?? '127.0.0.1'

  const connections = new Map<string, Connection>()
  let policy: OriginPolicy = { allowedHosts: [], allowedOrigins: [] }

  async function openConnection(principal: Principal, response: ServerResponse): Promise<Connection> {
    const listeners = new Set<(message: unknown) => void>()

    const deliver = (message: unknown): void => {
      // Server-sent events framing. `\n\n` terminates an event, so any newline inside the
      // payload has to be escaped — JSON.stringify already guarantees none, but the data
      // line is written explicitly rather than relying on that.
      response.write(`data: ${JSON.stringify(message)}\n\n`)
    }

    const transport: Transport = {
      post: (message) => deliver(message),
      onMessage: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }

    const connection: Connection = {
      transport,
      deliver: (message) => {
        for (const listener of listeners) listener(message)
      },
      dispose: () => listeners.clear(),
    }

    const session = await createSession({
      principal,
      transport,
      workspaceRoot: options.workspaceRoot,
      dataDir: options.dataDir,
      ripgrepPath: options.ripgrepPath,
      logSink: log,
    })
    const originalDispose = connection.dispose
    connection.dispose = () => {
      originalDispose()
      session.dispose()
    }
    return connection
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      log(`[error] ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) reject(response, { status: 500, reason: 'Internal error.' })
      else response.end()
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const isApi = url.pathname.startsWith('/api/')

    const rejected = checkRequest(request, policy, { requireOrigin: isApi })
    if (rejected !== undefined) {
      log(`[reject] ${request.method ?? '?'} ${url.pathname}: ${rejected.reason}`)
      reject(response, rejected)
      return
    }

    if (!isApi) {
      await serveAsset(url.pathname, response)
      return
    }

    /*
     * Stage two of the handoff (§14). The launch URL's fragment is never sent to the
     * server by the browser, so the page reads it and POSTs it here in exchange for a
     * long-lived token that only ever travels in an Authorization header — never in a URL,
     * and never in a cookie, which the browser would attach to forged requests
     * automatically. That is precisely what CSRF exploits.
     */
    if (url.pathname === '/api/session' && request.method === 'POST') {
      if (!(identity instanceof SingleUserIdentity)) {
        reject(response, { status: 404, reason: 'Handoff is only used in single-user mode.' })
        return
      }
      const body = (await readJsonBody(request)) as { handoff?: unknown } | undefined
      const handoff = typeof body?.handoff === 'string' ? body.handoff : ''
      const token = identity.redeemHandoff(handoff)
      if (token === undefined) {
        reject(response, { status: 401, reason: 'Handoff token invalid or expired. Restart light-code.' })
        return
      }
      respondJson(response, 200, { token })
      return
    }

    const principal = await identity.authenticate(request)
    if (principal === undefined) {
      reject(response, { status: 401, reason: 'Not authenticated.' })
      return
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
      const existing = connections.get(principal.id)
      // A reload opens a second stream. The old one is dead but the server cannot know
      // that until it writes, so it is replaced rather than accumulated.
      existing?.dispose()

      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        ...securityHeaders(),
      })
      // Flushes headers so the client's reader resolves before the first real message.
      response.write(': connected\n\n')

      const connection = await openConnection(principal, response)
      connections.set(principal.id, connection)

      // Proxies and load balancers drop an idle stream; a comment line is not an event, so
      // the client never sees these.
      const heartbeat = setInterval(() => response.write(': ping\n\n'), 20_000)
      const cleanup = (): void => {
        clearInterval(heartbeat)
        if (connections.get(principal.id) === connection) connections.delete(principal.id)
        connection.dispose()
      }
      request.on('close', cleanup)
      return
    }

    if (url.pathname === '/api/message' && request.method === 'POST') {
      const connection = connections.get(principal.id)
      if (connection === undefined) {
        reject(response, { status: 409, reason: 'No event stream open. Reload the page.' })
        return
      }
      const body = await readJsonBody(request)

      /*
       * The one place inbound messages enter, and therefore the one place this can be
       * enforced. Checked here rather than in the bridge because the bridge is shared with
       * the VS Code host, where there is no such thing as a second user — teaching core about
       * roles would put a concept in it that only one host has.
       */
      const type = typeof (body as { type?: unknown })?.type === 'string' ? (body as { type: string }).type : ''
      if (roles.shared && roles.roleFor(principal) !== 'admin' && isAdminOnly(type)) {
        log(`refused "${type}" from ${principal.displayName} (${principal.id}): not an administrator`)
        // Answered rather than dropped: the UI hides these controls, so a message arriving
        // here is either a stale page or someone poking the API, and both deserve a reason.
        connection.transport.post({ type: 'error', message: refusalFor(type) })
        respondJson(response, 403, { ok: false })
        return
      }

      connection.deliver(body)
      respondJson(response, 202, { ok: true })
      return
    }

    reject(response, { status: 404, reason: 'Not found.' })
  }

  async function serveAsset(pathname: string, response: ServerResponse): Promise<void> {
    const asset = CLIENT_ASSETS[pathname]
    if (asset === undefined) {
      reject(response, { status: 404, reason: 'Not found.' })
      return
    }
    try {
      // Only ever a value from the fixed table above, so no traversal is reachable here.
      const body = await fs.readFile(path.join(options.clientDir, asset))
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(asset)] ?? 'application/octet-stream',
        ...securityHeaders(),
      })
      response.end(body)
    } catch {
      reject(response, { status: 500, reason: `Missing client asset "${asset}". Rebuild with pnpm build.` })
    }
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, bindAddress, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Server did not bind a port.')

  const authority = `${bindAddress}:${address.port}`
  // Both checks are pinned to the address actually bound, which is why this is set after
  // listening rather than guessed from the options.
  policy = { allowedHosts: [authority, `localhost:${address.port}`], allowedOrigins: [`http://${authority}`] }

  return {
    url: `http://${authority}`,
    launchToken: identity instanceof SingleUserIdentity ? identity.launchToken : undefined,
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections.values()) connection.dispose()
        connections.clear()
        server.close(() => resolve())
      }),
  }
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', ...securityHeaders() })
  response.end(JSON.stringify(body))
}
