import fs from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import {
  describeSubmission,
  GUIDE_STEPS,
  resolveSessionVariables,
  sessionVariablesSchema,
  type Transport,
} from '@light-code/core'
import { reachableHosts, reachableOrigins } from './reachableHosts.js'
import {
  OpenIdentity,
  SingleUserIdentity,
  type IdentityProvider,
  type Principal,
} from './identity.js'
import { isAdminOnly, refusalFor, SINGLE_USER_POLICY, type RolePolicy } from './roles.js'
import {
  checkRequest,
  readJsonBody,
  reject,
  securityHeaders,
  type OriginPolicy,
} from './security.js'
import type { SharedConfig, SharedConfigStore } from './sharedConfig.js'
import { FileSecretStore } from './fileSecretStore.js'
import { ReviewQueue } from './reviewQueue.js'
import { toSharedProfileId } from './sharedProfiles.js'
import { userVariableStoreFor } from './userVariables.js'
import { createSession } from './session.js'

/*
 * `node:http` is on invariant 2's banned list, which exists so that all outbound traffic
 * goes through core's single HttpClient. A listening socket is ingress, not egress: nothing
 * here makes a request, and the model gateway is still reached only through HttpClient.
 * The disable is file-scoped and this comment is the recorded reason.
 */

export const CLIENT_ASSETS: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  /*
   * The administrator's URL. The same page — the client asks the server what it may do rather
   * than being a second bundle — but a distinct address, because that is what a proxy rule can
   * be written against.
   *
   * **Reaching it is assumed to be restricted upstream.** Light Code does not re-derive who may
   * be here; the proxy, the firewall or a separate listener decides. The consequence, stated
   * once so nobody has to infer it: anyone who can reach `/admin` directly is an administrator,
   * so exposing the port without the proxy in front exposes this with it.
   */
  '/admin': 'index.html',
  '/admin/': 'index.html',
  '/client.js': 'client.js',
  '/client.css': 'client.css',
  /*
   * The guide's diagrams, one entry per step and palette.
   *
   * Derived from `GUIDE_STEPS` rather than listed by hand, but still a *fixed table*: the keys
   * come from checked-in data, never from the request, so `serveAsset` keeps the property that
   * makes it safe — no part of the path is attacker-supplied and traversal is unreachable.
   */
  ...Object.fromEntries(
    GUIDE_STEPS.flatMap((step) =>
      (['light', 'dark'] as const).map((theme) => [
        `/guide/${step.id}-${theme}.svg`,
        `guide/${step.id}-${theme}.svg`,
      ]),
    ),
  ),
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Served as an image, and the CSP's `img-src 'self'` is what keeps it one: an SVG loaded
  // through <img> cannot run script, whatever it contains.
  '.svg': 'image/svg+xml',
}

/**
 * How much filler opens an event stream.
 *
 * Sized against nginx's `proxy_buffer_size`, which defaults to 4 KB and is 8 KB on some builds.
 * One buffer has to fill before a buffering proxy forwards anything, and it is paid once per
 * connection - a rounding error against a single reply, and the difference between a working
 * page and one that silently never receives anything.
 */
const STREAM_PADDING_BYTES = 8192

/**
 * The padding line itself. An SSE comment, so no client ever sees it as an event.
 *
 * Varied rather than one character repeated: an intermediary that gzips would squeeze 8 KB of the
 * same byte down to nothing and the padding would buy nothing at all. `no-transform` asks not to
 * be compressed; this does not rely on having been listened to.
 */
const STREAM_PADDING = `: ${((): string => {
  let filler = ''
  let seed = 1
  while (filler.length < STREAM_PADDING_BYTES) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    filler += (seed % 36).toString(36)
  }
  return filler
})()}\n\n`

export interface ServerOptions {
  workspaceRoot: string | undefined
  dataDir: string
  /** Directory holding the built browser bundle. */
  clientDir: string
  ripgrepPath: string | undefined
  /** A Python function that fetches credentials, when one is configured. See `credentialTool.ts`. */
  credentialTool?: { interpreter: string; file: string }
  identity?: IdentityProvider
  /**
   * Called when a handoff token was presented too late, or twice.
   *
   * The CLI prints a fresh launch URL. Here rather than in the server because only the caller
   * knows where it is safe to print one — a terminal in single-user mode, and nowhere at all if
   * this is ever embedded somewhere without one.
   */
  onHandoffLapsed?: (reason: 'expired' | 'spent') => void
  /** How long the launch URL stays valid. Default 10s — see `SingleUserIdentity`. */
  handoffSeconds?: number
  /**
   * Serves without a bearer token at all. See `OpenIdentity` for what that does and does not give
   * up — Origin and Host are still enforced, which is what actually stops a hostile page.
   */
  noToken?: boolean
  /**
   * Extra names this server answers to, beyond the ones it can work out for itself.
   *
   * For a reverse proxy, a container alias, or a DNS record pointing here — anything not
   * derivable from the machine. Declared rather than guessed: a guess wide enough to cover those
   * would be wide enough to cover an attacker's domain, which is the thing the check is for.
   */
  allowHosts?: readonly string[]
  /** Extra origins allowed to call it, e.g. the app embedding it in an iframe. */
  allowOrigins?: readonly string[]
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
  /** Settings an administrator sets once for everyone. Absent in single-user mode. */
  sharedConfig?: SharedConfigStore
}

export interface RunningServer {
  url: string
  /** Present only in single-user mode; the launch URL carries it in the fragment. */
  launchToken: string | undefined
  /** Mints a new handoff token and returns the full launch URL for it. Single-user mode only. */
  newLaunchUrl: (() => string) | undefined
  close: () => Promise<void>
}

/**
 * One live event stream per principal.
 *
 * Streaming out and posting in are two halves of one `Transport`. They are separate HTTP
 * requests, so the stream has to be found again by principal when a message arrives.
 */
/**
 * One user's session, which **outlives the event stream that carries it**.
 *
 * The same bug the extension already fixed once, wearing different clothes: there the bridge was
 * created per `resolveWebviewView`, so hiding the panel destroyed the conversation, the MCP
 * connections and the schedule timer. Here it was created per `/api/events` — and the client
 * reconnects a second after any drop, in a loop. Reported as "UI says disconnected every few
 * minutes, I had to restart light-code".
 *
 * A stream now *attaches* to a session rather than being one.
 */
interface Connection {
  transport: Transport
  deliver: (message: unknown) => void
  /** Points the outbound half at a newly opened stream, flushing whatever it missed. */
  attach: (response: ServerResponse) => void
  /** The stream went away. The session stays. */
  detach: (response: ServerResponse) => void
  dispose: () => void
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.logSink ?? ((line: string) => process.stderr.write(`${line}\n`))
  const identity =
    options.identity ??
    (options.noToken === true ? new OpenIdentity() : new SingleUserIdentity(options.handoffSeconds))
  const roles = options.roles ?? SINGLE_USER_POLICY
  /*
   * The administrator's settings, kept in memory and refreshed when they are saved.
   *
   * Held here rather than read per command because it is consulted on every one, and because the
   * *point* of it is to be shared: one copy that every session sees is the behaviour, not an
   * optimisation of it.
   */
  const sharedStore = options.sharedConfig
  /*
   * Where a shared profile's API key lives. Beside the shared config rather than in any one user's
   * directory, so it survives a user clearing their own secrets — and so nobody has to reason
   * about which user's file the organisation's gateway key ended up in.
   */
  const sharedSecretStore = new FileSecretStore(path.join(options.dataDir, 'shared-secrets.json'))
  /*
   * Tools and skills a non-administrator wrote, held until someone may approve them. Beside the
   * shared config rather than in a user's directory: the queue belongs to the server, and the
   * person who reads it is not the person who filled it.
   */
  const reviews = new ReviewQueue(path.join(options.dataDir, 'reviews.json'))
  let sharedCache: SharedConfig = {
    variables: [],
    adminIds: [],
    profiles: [],
    vectorStores: {},
    mcpServers: {},
  }

  const bindAddress = options.bindAddress ?? '127.0.0.1'
  if (sharedStore !== undefined) sharedCache = await sharedStore.load()

  /*
   * Which principals arrived through the admin URL.
   *
   * Kept here rather than read from the request at message time because the event stream and the
   * messages are separate HTTP requests: only the page load knows which door was used, and the
   * POSTs that follow do not carry it. Cleared with the connection, so closing the tab ends it.
   */
  const adminConnections = new Set<string>()
  const connections = new Map<string, Connection>()

  /*
   * An administrator is someone at the admin URL who is also on the list.
   *
   * Two conditions rather than one, and both earn their place. The URL alone is what the
   * operator's proxy rule guards, and it is what the user asked to rely on. The list is what
   * survives a proxy that was never configured — with no list, `roleFor` answers 'user' and a
   * shared server refuses configuration changes to everyone, which is the safe direction to
   * fail. Single-user mode is unaffected: `SINGLE_USER_POLICY` is not shared and answers
   * 'admin' for the one person there is.
   */
  function isAdminSession(principal: Principal): boolean {
    if (!roles.shared) return true
    return adminConnections.has(principal.id) && roles.roleFor(principal) === 'admin'
  }
  let policy: OriginPolicy = { allowedHosts: [], allowedOrigins: [] }

  async function openConnection(principal: Principal): Promise<Connection> {
    const listeners = new Set<(message: unknown) => void>()

    /** The stream currently carrying this session, if one is open. */
    let sink: ServerResponse | undefined
    /**
     * Frames written while no stream was attached.
     *
     * Not an optimisation. Every host→UI reply travels this way, so one produced in the second
     * between a drop and a reconnect is a control that spins for ever — which is what "refresh
     * the models and it just says Loading" looks like from the outside. Bounded, because a
     * session nobody returns to must not grow without limit.
     */
    const missed: string[] = []
    const MAX_MISSED = 500

    const write = (frame: string): void => {
      const target = sink
      /*
       * A gone socket is checked for rather than written to and caught.
       *
       * `write` to a socket the peer has left does not throw synchronously — it emits an error
       * asynchronously, and an error event with no listener takes the whole process down. A
       * server that dies when a browser tab closes is not a stable one.
       */
      if (target === undefined || target.writableEnded || target.destroyed) {
        if (missed.length >= MAX_MISSED) missed.shift()
        missed.push(frame)
        return
      }
      try {
        target.write(frame)
      } catch {
        sink = undefined
        if (missed.length >= MAX_MISSED) missed.shift()
        missed.push(frame)
      }
    }

    const transport: Transport = {
      // Server-sent events framing. `\n\n` terminates an event, so a newline inside the
      // payload would split it — JSON.stringify already guarantees none, but the data line is
      // written explicitly rather than relying on that.
      post: (message) => write(`data: ${JSON.stringify(message)}\n\n`),
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
      attach: (response: ServerResponse) => {
        sink = response
        // Without this an aborted request surfaces as an unhandled 'error' on the response.
        response.on('error', () => {
          if (sink === response) sink = undefined
        })
        for (const frame of missed.splice(0, missed.length)) {
          if (sink !== response) break
          write(frame)
        }
      },
      detach: (response: ServerResponse) => {
        if (sink === response) sink = undefined
      },
      dispose: () => {
        /*
         * Ended, not just forgotten.
         *
         * `server.close()` waits for every open request to finish, and an event stream never
         * finishes on its own — so a shutdown with a browser still attached simply never
         * completed. Found by a test whose `afterEach` timed out, which is the failure being
         * visible for the first time rather than a new one.
         */
        const open = sink
        sink = undefined
        missed.length = 0
        listeners.clear()
        if (open !== undefined && !open.writableEnded && !open.destroyed) {
          try {
            open.end()
          } catch {
            // Already gone. Nothing to do and nothing worth saying.
          }
        }
      },
    }

    const session = await createSession({
      principal,
      transport,
      workspaceRoot: options.workspaceRoot,
      dataDir: options.dataDir,
      ripgrepPath: options.ripgrepPath,
      logSink: log,
      // Passed straight through: the server owns no opinion about credentials, it only knows
      // whether the operator configured a source for them.
      ...(options.credentialTool !== undefined ? { credentialTool: options.credentialTool } : {}),
      /*
       * Read at use, not captured: an administrator saving a variable must reach a session that
       * is already open. `SharedConfigStore` caches, so this is a map lookup rather than a read.
       */
      adminVariables: () => sharedCache.variables,
      /*
       * Read at use, like the variables above: an administrator publishing a connection must
       * reach sessions that are already open, not only the next one to start.
       */
      sharedEntries: () => ({
        vectorStores: sharedCache.vectorStores,
        mcpServers: sharedCache.mcpServers,
      }),
      /*
       * Only for someone who cannot approve their own work. An administrator keeps the ordinary
       * in-chat prompt — the same mechanism with the approver already at the screen — so this is
       * absent for them rather than a queue they would have to visit to approve themselves.
       */
      ...(roles.shared && !isAdminSession(principal)
        ? {
            /*
             * A personal profile may not run a program to fetch its token.
             *
             * That would be arbitrary execution as the service account, which §14 says plainly is
             * the thing locking down configuration does *not* buy you. An administrator can still
             * set one up as a shared profile, which is where a credential belonging to the server
             * belongs anyway.
             */
            executableAuthRefusal:
              'A profile that runs a program to fetch its token can only be set up by an ' +
              'administrator on a shared server — it would run as the account this server runs ' +
              'as. Ask an administrator to add it as a shared profile, or use an API key.',
            submitForReview: async (request) => {
              const queued = await reviews.submit({
                ...request,
                authorId: principal.id,
                authorName: principal.displayName,
              })
              log(`${principal.displayName} submitted ${request.kind} "${request.name}" for review`)
              // Every administrator watching sees it appear without reloading.
              await broadcastReviews()
              return describeSubmission(queued)
            },
          }
        : {}),
      /*
       * Only in shared mode. Outside it there is one person and every profile is already theirs,
       * so wrapping the stores would add a prefix nobody needs and a second file nobody writes.
       */
      ...(sharedStore !== undefined
        ? {
            sharedProfiles: () => ({
              profiles: sharedCache.profiles,
              ...(sharedCache.defaultProfileId !== undefined
                ? { defaultProfileId: sharedCache.defaultProfileId }
                : {}),
              ...(sharedCache.defaultProgrammingProfileId !== undefined
                ? { defaultProgrammingProfileId: sharedCache.defaultProgrammingProfileId }
                : {}),
            }),
            sharedSecrets: sharedSecretStore,
          }
        : {}),
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
      /*
       * With no token configured there is nothing to exchange, and the page still asks — so it is
       * answered rather than refused. Returning an empty token keeps one code path in the client
       * instead of a second one that only runs in this mode.
       */
      if (identity instanceof OpenIdentity) {
        respondJson(response, 200, { token: '' })
        return
      }
      if (!(identity instanceof SingleUserIdentity)) {
        reject(response, { status: 404, reason: 'Handoff is only used in single-user mode.' })
        return
      }
      const body = (await readJsonBody(request)) as { handoff?: unknown } | undefined
      const handoff = typeof body?.handoff === 'string' ? body.handoff : ''
      const outcome = identity.redeem(handoff)
      if (outcome.token === undefined) {
        /*
         * An expired token gets you another one, printed to the terminal.
         *
         * Before this the only way back was to stop the server and start it again, losing the
         * session and anything running with it — for the entirely ordinary mishap of pasting a
         * URL a few seconds late. The new token goes only to the terminal, which is where the
         * first one was printed, so it reaches nobody it had not already reached.
         *
         * A *mismatch* gets nothing: that is a bug or an attack, and neither deserves a fresh
         * token, nor the ability to fill somebody's terminal with them.
         */
        if (outcome.reason === 'expired' || outcome.reason === 'spent')
          options.onHandoffLapsed?.(outcome.reason)
        reject(response, {
          status: 401,
          reason:
            outcome.reason === 'expired'
              ? 'That link expired. A fresh one has been printed in the terminal running light-code.'
              : outcome.reason === 'spent'
                ? 'That link has already been used. A fresh one has been printed in the terminal.'
                : 'Handoff token invalid.',
        })
        return
      }
      respondJson(response, 200, { token: outcome.token })
      return
    }

    const principal = await identity.authenticate(request)
    if (principal === undefined) {
      reject(response, { status: 401, reason: 'Not authenticated.' })
      return
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
      /*
       * The session is ready **before** the response headers go out. That ordering is the whole
       * point of these lines.
       *
       * A streamed `fetch` resolves for the client the moment headers arrive, and the page then
       * sends its opening requests immediately. Creating the session after writing them left a
       * window in which those requests were answered `409 No event stream open` — measured
       * against a running server, and it is the first POST every page makes that lands in it.
       *
       * That is what "there is no dark mode option any more" was: the settings reply carries
       * `choosesTheme`, the request for it was refused, and the client dropped the refusal
       * silently. The client retries a 409 now, but a window the server can simply not have is
       * better than one something else recovers from.
       *
       * It also means a session that fails to build reports as a failed request rather than as a
       * 200 that goes quiet.
       */
      let connection = connections.get(principal.id)
      if (connection === undefined) {
        connection = await openConnection(principal)
        connections.set(principal.id, connection)
      }

      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        /*
         * Both of these are about something between the browser and here.
         *
         * A proxy that buffers a response holds every event until it has "enough", which for a
         * stream is for ever — the page connects, renders, and then every reply appears to be
         * lost. `X-Accel-Buffering` is nginx's off switch and is ignored by everything else;
         * `no-transform` tells any intermediary not to recompress, which has the same effect.
         * Neither is needed on loopback, which is exactly why their absence survived until this
         * ran on a server.
         */
        ...securityHeaders(),
        /*
         * After the shared headers, not before: `securityHeaders()` sets its own `Cache-Control`
         * and object spread means last-one-wins, so putting these first meant they were silently
         * dropped. Found by reading the response of a running server rather than the source.
         *
         * `no-store` is kept from the shared value; `no-transform` is the addition, and it is the
         * half that matters here — it tells an intermediary not to recompress or repackage the
         * body, which is how a proxy ends up buffering a stream until it has "enough", which for
         * a stream is for ever. `X-Accel-Buffering` is nginx's explicit off switch and is ignored
         * by everything else. Neither is needed on loopback, which is why their absence survived
         * until this ran on a server.
         */
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      })
      /*
       * Padding, written before anything else, to force a buffering intermediary to let go.
       *
       * The fourteen bytes below were enough on loopback and are nowhere near enough anywhere
       * else. A proxy with response buffering on forwards when its buffer *fills* or the response
       * *ends* - nginx's `proxy_buffer_size` defaults to 4 or 8 KB - and an event stream never
       * ends. So a comment and a 20-second ping of eight bytes would take eight minutes to
       * release the first reply, which from the page is indistinguishable from a server that
       * answers nothing: the theme control never arrives, the Agents tab stays empty, and a save
       * appears to do nothing.
       *
       * `X-Accel-Buffering: no` and `no-transform` ask for the same thing politely and are
       * ignored by most proxies that are not nginx. This does not ask.
       */
      response.write(STREAM_PADDING)
      // Flushes headers so the client's reader resolves before the first real message.
      response.write(': connected\n\n')

      /*
       * The page says which URL it was loaded from, because only the page load knows: the
       * POSTs that follow are separate requests carrying no such thing. It is not a privilege
       * claim — it selects an interface, and the *upstream* decided who could load it at all.
       */
      const viaAdminUrl = url.searchParams.get('view') === 'admin'
      if (viaAdminUrl) adminConnections.add(principal.id)
      else adminConnections.delete(principal.id)

      /*
       * Attached, not built. Rebuilding here is what made a dropped stream cost the conversation,
       * the MCP connections, the Python worker and the schedule timer — every one of them torn
       * down and started again, a second after any blip, in a loop.
       */
      connection.attach(response)

      /*
       * Told once, at the top of the stream, so the UI can mark what this session may change
       * before it renders a control the server will refuse. §15's "scope is visible in the UI"
       * applied to people rather than to config files: a field that will be rejected on save
       * should not look editable.
       */
      // `transport.post` is outbound; `connection.deliver` feeds a message *into* the bridge as
      // though the UI had sent it. The names read the other way round, which cost an hour once.
      connection.transport.post({
        type: 'hostRole',
        role: isAdminSession(principal) ? 'admin' : 'user',
        shared: roles.shared,
        displayName: principal.displayName,
        sharedProfileIds: sharedCache.profiles.map((profile) => toSharedProfileId(profile.id)),
      })

      // Proxies and load balancers drop an idle stream; a comment line is not an event, so
      // the client never sees these.
      const heartbeat = setInterval(() => {
        // Guarded for the same reason `write` is: a ping to a socket that has gone emits an
        // error event, and one with no listener ends the process.
        if (response.writableEnded || response.destroyed) return
        try {
          response.write(': ping\n\n')
        } catch {
          // The close handler below does the tidying; there is nothing useful to say here.
        }
      }, 20_000)
      const stream = connection
      const cleanup = (): void => {
        clearInterval(heartbeat)
        /*
         * Detached, not disposed. The session stays open so a reconnect resumes it, and so a
         * reply produced while nobody was listening is still there to deliver.
         */
        stream.detach(response)
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
      const type =
        typeof (body as { type?: unknown })?.type === 'string'
          ? (body as { type: string }).type
          : ''
      if (roles.shared && !isAdminSession(principal) && isAdminOnly(type)) {
        log(
          `refused "${type}" from ${principal.displayName} (${principal.id}): not an administrator`,
        )
        // Answered rather than dropped: the UI hides these controls, so a message arriving
        // here is either a stale page or someone poking the API, and both deserve a reason.
        connection.transport.post({ type: 'error', message: refusalFor(type) })
        respondJson(response, 403, { ok: false })
        return
      }

      /*
       * Variables are the server's, not a session's.
       *
       * Answered here rather than forwarded because the whole question — whose value wins — only
       * exists on a shared server, and the bridge is shared with the extension where it does not.
       * Handled *after* the role check above, so an ordinary user reaching for the administrator's
       * half is refused by the same rule as every other shared setting.
       */
      if (await handleVariableMessage(principal, type, body, connection)) {
        respondJson(response, 202, { ok: true })
        return
      }

      connection.deliver(body)
      respondJson(response, 202, { ok: true })
      return
    }

    reject(response, { status: 404, reason: 'Not found.' })
  }

  /**
   * The queue, to everyone who should see it.
   *
   * An administrator sees every item and can decide. An author sees their own, so a rejection with
   * a reason reaches the person who has to act on it — a queue only administrators can read makes
   * the author wait without knowing what for.
   */
  async function postReviews(principal: Principal, connection: Connection): Promise<void> {
    const canDecide = isAdminSession(principal)
    const all = await reviews.list()
    const visible = canDecide ? all : all.filter((item) => item.authorId === principal.id)
    connection.transport.post({
      type: 'reviews',
      canDecide,
      items: visible
        .sort((a, b) => b.submittedAt - a.submittedAt)
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          content: item.content,
          existingContent: item.existingContent,
          authorName: item.authorName,
          submittedAt: item.submittedAt,
          status: item.status,
          ...(item.producedBy !== undefined ? { producedBy: item.producedBy } : {}),
          ...(item.decidedBy !== undefined ? { decidedBy: item.decidedBy } : {}),
          ...(item.reason !== undefined ? { reason: item.reason } : {}),
        })),
    })
  }

  /** Every open session, so a decision or a submission appears without anyone reloading. */
  async function broadcastReviews(): Promise<void> {
    for (const [id, connection] of connections) {
      await postReviews({ id, displayName: id }, connection)
    }
  }

  /**
   * Writes an approved submission where it belongs.
   *
   * The bytes come from the queue, never from disk: what the administrator read is what gets
   * written, even if something else touched the file in between. For a Python tool the hash is
   * recorded here too — the registry is the boundary (§13), and this is the moment the approval
   * becomes one.
   */
  async function applyApproval(item: {
    kind: string
    name: string
    content: string
  }): Promise<string | undefined> {
    if (options.workspaceRoot === undefined)
      return 'No workspace is open, so there is nowhere to write it.'
    try {
      if (item.kind === 'skill') {
        const dir = path.join(options.workspaceRoot, '.lightcode', 'skills')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, `${item.name}.md`), item.content, 'utf8')
        return undefined
      }
      const dir = path.join(options.workspaceRoot, '.lightcode', 'tools')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `${item.name}.py`), item.content, 'utf8')
      /*
       * Written but deliberately not registered here. Registration derives the schema by importing
       * the module in the Python worker, which this process does not own — the author's session
       * does that on its next load, and a file whose hash is not yet approved is simply reported
       * rather than run. Approving the hash without having imported it would claim a validation
       * that never happened.
       */
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** Everything a session variables panel needs, for whoever is asking. */
  async function postVariables(principal: Principal, connection: Connection): Promise<void> {
    const store = userVariableStoreFor(options.dataDir, principal)
    const user = store.read()
    const admin = sharedCache.variables
    connection.transport.post({
      type: 'variables',
      user: [...user],
      admin: [...admin],
      resolved: resolveSessionVariables(admin, user),
      adminIds: sharedCache.adminIds,
      canEditAdmin: isAdminSession(principal),
    })
  }

  /** True when the message was one of ours and has been dealt with. */
  async function handleVariableMessage(
    principal: Principal,
    type: string,
    body: unknown,
    connection: Connection,
  ): Promise<boolean> {
    const payload = body as { variables?: unknown; ids?: unknown }
    if (type === 'requestReviews') {
      await postReviews(principal, connection)
      return true
    }
    if (type === 'decideReview') {
      const id =
        typeof (body as { id?: unknown }).id === 'string' ? (body as { id: string }).id : ''
      const approved = (body as { approved?: unknown }).approved === true
      const reason =
        typeof (body as { reason?: unknown }).reason === 'string'
          ? (body as { reason: string }).reason
          : undefined
      const decided = await reviews.decide(id, {
        approved,
        by: principal.displayName,
        ...(reason !== undefined ? { reason } : {}),
      })
      if (decided === undefined) {
        connection.transport.post({
          type: 'error',
          message: 'That submission has already been decided. Reload to see the current queue.',
        })
        return true
      }
      if (approved) {
        const failure = await applyApproval(decided)
        if (failure !== undefined) {
          connection.transport.post({
            type: 'error',
            message: `Approved, but could not write it: ${failure}`,
          })
        }
      }
      log(
        `${principal.displayName} ${approved ? 'approved' : 'rejected'} ${decided.kind} "${decided.name}"`,
      )
      await broadcastReviews()
      return true
    }
    if (type === 'requestVariables') {
      await postVariables(principal, connection)
      return true
    }
    if (type === 'saveUserVariables') {
      const parsed = sessionVariablesSchema.safeParse(payload.variables)
      if (!parsed.success) {
        connection.transport.post({
          type: 'error',
          message: `Could not save variables: ${parsed.error.message}`,
        })
        return true
      }
      await userVariableStoreFor(options.dataDir, principal).save(parsed.data)
      await postVariables(principal, connection)
      return true
    }
    if (type === 'saveAdminVariables' || type === 'saveAdminIds') {
      if (sharedStore === undefined) {
        connection.transport.post({
          type: 'error',
          message: 'There are no shared settings outside --server mode.',
        })
        return true
      }
      if (type === 'saveAdminVariables') {
        const parsed = sessionVariablesSchema.safeParse(payload.variables)
        if (!parsed.success) {
          connection.transport.post({
            type: 'error',
            message: `Could not save variables: ${parsed.error.message}`,
          })
          return true
        }
        sharedCache = await sharedStore.save({ variables: parsed.data })
      } else {
        const ids = Array.isArray(payload.ids)
          ? payload.ids.filter((id): id is string => typeof id === 'string')
          : []
        /*
         * An administrator removing themselves is allowed but reported: it is a legitimate act
         * when handing over, and refusing it would mean the last admin can never be replaced.
         * Recovery is `--admin-id` on the command line, which still wins at startup.
         */
        if (!ids.includes(principal.id)) {
          log(`${principal.displayName} removed themselves from the administrator list`)
        }
        sharedCache = await sharedStore.save({ adminIds: [...new Set(ids)] })
      }
      /*
       * Every open session, not just this one. An administrator changing a shared variable is
       * changing what everyone's next command sees, and a panel still showing the old value is
       * showing something untrue.
       */
      for (const [id, other] of connections) {
        await postVariables({ id, displayName: id }, other)
      }
      return true
    }
    return false
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
      reject(response, {
        status: 500,
        reason: `Missing client asset "${asset}". Rebuild with pnpm build.`,
      })
    }
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, bindAddress, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('Server did not bind a port.')

  const authority = `${bindAddress}:${address.port}`
  // Both checks are pinned to the address actually bound, which is why this is set after
  // listening rather than guessed from the options.
  /*
   * Derived from what this machine *is*, not from what it bound to.
   *
   * `0.0.0.0` is not a name anybody browses to, so deriving the allowlist from the bind address
   * meant a public bind answered only to `localhost` — measured against the running server, and
   * the reason `reachableHosts` exists. Rebinding is still blocked, because an attacker's domain
   * is not one of this machine's names.
   */
  const allowedHosts = reachableHosts(bindAddress, address.port, options.allowHosts ?? [])
  policy = {
    allowedHosts,
    allowedOrigins: reachableOrigins(allowedHosts, options.allowOrigins ?? []),
  }

  return {
    url: `http://${authority}`,
    launchToken: identity instanceof SingleUserIdentity ? identity.launchToken : undefined,
    newLaunchUrl:
      identity instanceof SingleUserIdentity
        ? () => `http://${authority}/#t=${identity.remintHandoff()}`
        : undefined,
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections.values()) connection.dispose()
        connections.clear()
        server.close(() => resolve())
        /*
         * Keep-alive sockets from ordinary asset requests also hold `close` open, and this server
         * supports Node 17 where `closeAllConnections` does not exist. Called through a capability
         * check rather than assumed, so the old runtime simply waits for its sockets to time out
         * instead of throwing on a missing method.
         */
        const closeAll = (server as { closeAllConnections?: () => void }).closeAllConnections
        if (typeof closeAll === 'function') closeAll.call(server)
      }),
  }
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', ...securityHeaders() })
  response.end(JSON.stringify(body))
}
