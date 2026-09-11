import { spawn } from 'node:child_process'

import type { AuthStrategy } from '../types.js'

/**
 * A token fetched by running a command, refreshed before it expires.
 *
 * ## The problem it solves
 *
 * A parent process launches Light Code and already holds a gateway credential — a Streamlit app
 * whose internal library does the Apigee handshake, a wrapper script, a container entrypoint.
 * `env:API_TOKEN` covers handing it over once, and for a short session that is enough.
 *
 * It stops being enough the moment the token expires. An OAuth token is typically good for an
 * hour; the environment a child process was started with **cannot be changed by its parent**, so a
 * long session ends with every request failing 401 and no way to recover short of restarting.
 * This asks for a new one instead: the command is whatever the parent already uses — `python -c
 * "import ourauth; print(ourauth.token())"` — so the credential logic stays in the one place that
 * owns it and Light Code never learns how the gateway's auth works.
 *
 * ## Why argv, never a shell string
 *
 * §16: nothing is interpolated into a command line. The command is an array and is spawned
 * directly, so a path with a space is an argument rather than two, and nothing in it is parsed by
 * a shell. That also means no pipes or redirection — write a script if the logic needs them, which
 * is the better place for it anyway.
 *
 * ## Why it reuses the Apigee refresh shape
 *
 * Proactive refresh, single-flight, one retry — the same three properties `ApigeeMtlsAuthStrategy`
 * needed and for the same reasons. Waiting for a 401 stalls mid-stream; concurrent requests must
 * share one in-flight fetch or a burst spawns a process each; and a retry loop on a genuinely
 * broken command is worse than an error.
 *
 * ## What it is not
 *
 * This runs a program the user configured, so it is exactly as powerful as the account Light Code
 * runs under. `profiles` is user-scope only (invariant 5), so a repository cannot introduce one —
 * but on a shared host it must never be reachable from a personal profile, and `roles.ts` refuses
 * it there.
 */
export interface TokenCommandSettings {
  /** argv. The first element is the program; nothing is shell-parsed. */
  command: string[]
  cwd?: string | undefined
  /**
   * Where the token sits in the output.
   *
   * Absent means the whole of stdout, trimmed, is the token — which is what `print(token)` gives
   * and is the shape most wrapper scripts produce. A dotted path reads it out of JSON instead.
   */
  tokenPath?: string | undefined
  /** Dotted path to a lifetime in seconds, when the command reports one. */
  expiresInPath?: string | undefined
  /**
   * Assumed lifetime when the command does not report one.
   *
   * An hour, matching the usual OAuth default. Deliberately not "forever": a token that is
   * refreshed sooner than it needed to be costs one cheap subprocess, and one refreshed too late
   * costs the turn.
   */
  fallbackExpirySeconds?: number | undefined
  refreshSkewSeconds?: number | undefined
  timeoutSeconds?: number | undefined
  headerName?: string | undefined
  headerPrefix?: string | undefined
  /** Extra variables for the child. The parent's own environment is passed through as well. */
  env?: Record<string, string> | undefined
}

interface HeldToken {
  value: string
  expiresAt: number
}

function readPath(source: unknown, dotted: string): unknown {
  let current = source
  for (const part of dotted.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export class TokenCommandAuthStrategy implements AuthStrategy {
  private held: HeldToken | undefined
  private inFlight: Promise<HeldToken> | undefined

  constructor(private readonly settings: TokenCommandSettings) {
    if (settings.command.length === 0) {
      throw new Error('The token command is empty. Give the program and its arguments.')
    }
  }

  async resolveHeaders(): Promise<Record<string, string>> {
    const token = await this.token()
    const name = this.settings.headerName ?? 'Authorization'
    const prefix = this.settings.headerPrefix ?? 'Bearer '
    return { [name]: `${prefix}${token.value}` }
  }

  /**
   * Checked before a stream opens, with margin for a long generation.
   *
   * The same reasoning as the Apigee strategy: a token that expires halfway through a response
   * cannot be recovered from without discarding what has already been written.
   */
  async ensureTokenForStream(marginSeconds = 120): Promise<void> {
    const deadline = Date.now() + marginSeconds * 1000
    if (this.held === undefined || this.held.expiresAt <= deadline) {
      this.held = undefined
      await this.token()
    }
  }

  /** Drops the held token, so the next request fetches a new one. For a 401 retry. */
  invalidate(): void {
    this.held = undefined
  }

  private async token(): Promise<HeldToken> {
    const skew = (this.settings.refreshSkewSeconds ?? 60) * 1000
    if (this.held !== undefined && this.held.expiresAt - skew > Date.now()) return this.held

    // Single-flight: a burst of concurrent requests shares one subprocess rather than one each.
    this.inFlight ??= this.fetch()
      .then((token) => {
        this.held = token
        return token
      })
      .finally(() => {
        this.inFlight = undefined
      })
    return this.inFlight
  }

  private async fetch(): Promise<HeldToken> {
    const [program, ...args] = this.settings.command as [string, ...string[]]
    const timeout = (this.settings.timeoutSeconds ?? 30) * 1000

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(program, args, {
        // Never `shell: true`. See the note at the top of this file.
        shell: false,
        ...(this.settings.cwd === undefined ? {} : { cwd: this.settings.cwd }),
        env: { ...process.env, ...(this.settings.env ?? {}) },
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(
          new Error(
            `The token command did not finish within ${String(timeout / 1000)}s: ` +
              `${program}. Raise its timeout, or check whether it is waiting for input — a ` +
              'command that prompts will never return here, because nothing is attached to answer.',
          ),
        )
      }, timeout)

      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      // Captured rather than inherited, so a failure can quote the reason instead of losing it
      // to a console nobody is watching.
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(
          new Error(
            error.code === 'ENOENT'
              ? `The token command's program was not found: ${program}. Give an absolute path, ` +
                'or make sure it is on the PATH of the process that started Light Code.'
              : `The token command could not be started: ${error.message}`,
          ),
        )
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) {
          resolve(stdout)
          return
        }
        const detail = stderr.trim().length > 0 ? stderr.trim() : stdout.trim()
        reject(
          new Error(
            `The token command exited with code ${String(code ?? -1)}.` +
              (detail.length > 0 ? `\n${detail.slice(0, 2000)}` : ' It printed nothing.'),
          ),
        )
      })
    })

    return this.parse(output)
  }

  private parse(stdout: string): HeldToken {
    const fallback = (this.settings.fallbackExpirySeconds ?? 3600) * 1000

    if (this.settings.tokenPath === undefined) {
      const value = stdout.trim()
      if (value.length === 0) {
        throw new Error(
          'The token command succeeded but printed nothing. It must write the token to stdout, ' +
            'or name `tokenPath` if it prints JSON.',
        )
      }
      /*
       * A whole trimmed stdout, including any newlines inside it.
       *
       * A token never contains whitespace, so multi-line output means the command printed
       * something else as well — a warning, a log line, a banner. Saying so is much better help
       * than sending the banner as a bearer token and reporting the 401 that follows.
       */
      if (/\s/.test(value)) {
        throw new Error(
          'The token command printed more than one line, so it is not clear which part is the ' +
            'token. Print only the token, or have it print JSON and set `tokenPath`.',
        )
      }
      return { value, expiresAt: Date.now() + fallback }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error(
        `\`tokenPath\` is set, so the token command's output is read as JSON — and it did not ` +
          `parse. It printed: ${stdout.trim().slice(0, 200)}`,
      )
    }

    const value = readPath(parsed, this.settings.tokenPath)
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `The token command's JSON has nothing usable at "${this.settings.tokenPath}". ` +
          `It printed: ${stdout.trim().slice(0, 200)}`,
      )
    }

    let lifetime = fallback
    if (this.settings.expiresInPath !== undefined) {
      const reported = readPath(parsed, this.settings.expiresInPath)
      const seconds = typeof reported === 'string' ? Number(reported) : reported
      // A lifetime that is not a positive number falls back rather than producing a token that is
      // already expired, which would refresh on every single request.
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
        lifetime = seconds * 1000
      }
    }

    return { value: value.trim(), expiresAt: Date.now() + lifetime }
  }
}
