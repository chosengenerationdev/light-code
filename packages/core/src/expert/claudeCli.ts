import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Logger } from '../logging/logger.js'

/**
 * The Claude CLI as a consulting expert for a cheaper primary model.
 *
 * **Read-only by construction.** Claude is allowed to read and search the workspace so it
 * can gather its own context, but never to edit a file or run a command. Everything that
 * changes the workspace still goes through Light Code's own tools and its approval gate —
 * otherwise a second agent would be mutating the repository behind the gate, which is
 * exactly what §8 and invariant 8 exist to prevent.
 *
 * That restriction is also the cheaper design. An agentic Claude session costs many times a
 * single consultation, and the point of this feature is to spend less.
 */

/** Tools Claude may use. Read and search only — nothing that writes or executes. */
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob']

/**
 * `npm i -g @anthropic-ai/claude-code` installs a `.cmd` shim on Windows, which Node cannot
 * spawn without a shell (§16). Rather than enabling `shell: true` — which would reintroduce
 * argument injection on a string that contains model output — the shim is invoked through
 * `cmd /c` with the prompt passed as a *separate argv entry*, so it is never parsed as
 * command line syntax.
 */
function spawnArgs(executable: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/c', executable, ...args] }
  }
  return { command: executable, args }
}

function run(
  executable: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; signal?: AbortSignal; input?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const spawned = spawnArgs(executable, args)
  return new Promise((resolve, reject) => {
    const child = execFile(
      spawned.command,
      spawned.args,
      {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        timeout: options.timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`Could not run "${executable}".`))
          return
        }
        // A non-zero exit is data, not a throw: the CLI reports refusals and usage limits
        // that way, and the caller turns them into a readable tool result.
        resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout, stderr })
      },
    )
    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })
}

export interface ClaudeCliInfo {
  available: boolean
  /** What was actually run, so the UI can show it rather than assert "installed". */
  executable: string
  version?: string
  /** Why it is unavailable, phrased for a human. */
  reason?: string
}

/**
 * Places to look when the bare command is not on PATH.
 *
 * This is not defensive padding — it is the observed case. `npm i -g @anthropic-ai/claude-code`
 * installs into the npm prefix, and a process whose PATH was captured before that (an editor
 * started earlier, or a shell with its own PATH) does not see it. The user has installed the
 * thing and it still "isn't found", which is a miserable place to leave someone.
 */
function fallbackLocations(name: string): string[] {
  if (path.isAbsolute(name)) return []

  const candidates: string[] = []
  const push = (dir: string | undefined): void => {
    if (dir === undefined || dir.length === 0) return
    // The `.cmd` shim first on Windows: it is what npm actually creates.
    if (process.platform === 'win32') candidates.push(path.join(dir, `${name}.cmd`))
    candidates.push(path.join(dir, name))
  }

  if (process.platform === 'win32') {
    push(process.env.APPDATA !== undefined ? path.join(process.env.APPDATA, 'npm') : undefined)
  } else {
    push('/usr/local/bin')
    push('/opt/homebrew/bin')
    push(process.env.HOME !== undefined ? path.join(process.env.HOME, '.npm-global', 'bin') : undefined)
    push(process.env.HOME !== undefined ? path.join(process.env.HOME, '.local', 'bin') : undefined)
  }
  return candidates
}

/**
 * Resolves to `fallback` if the promise has not settled in time.
 *
 * **Never trust a child process to die.** `execFile`'s own `timeout` sends a signal and then
 * waits for the process to exit and its pipes to close — and on Windows killing a `cmd /c`
 * shim does not kill the grandchild it launched (§16). A grandchild holding stdout open means
 * the callback never fires, `detectClaudeCli` never resolves, and the Expert tab sits on
 * "Checking…" for the rest of the session. That is the reported bug.
 *
 * This bounds the *wait*, not the process. A leaked child is a smaller problem than a UI that
 * never answers.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function probe(executable: string, timeoutMs: number): Promise<ClaudeCliInfo | undefined> {
  try {
    // A margin over the child's own timeout, so the ordinary path still reports a real result
    // and this only fires when the process genuinely failed to die.
    const { code, stdout } = await withDeadline(run(executable, ['--version'], { timeoutMs }), timeoutMs + 2_000, {
      code: 1,
      stdout: '',
      stderr: 'timed out',
    })
    // A non-zero exit means it ran but is broken — a stale shim pointing at a removed Node
    // version, say. That is a different problem from "not installed", so it is not a
    // candidate to keep searching past.
    if (code !== 0) return undefined
    return { available: true, executable, version: stdout.trim().split('\n')[0] ?? '' }
  } catch {
    return undefined
  }
}

/**
 * Checks whether the CLI can actually be executed — not merely whether a file exists.
 * A stale shim pointing at a removed Node version is a real and confusing failure, and
 * only running it reveals that.
 */
export async function detectClaudeCli(executable = 'claude', timeoutMs = 10_000): Promise<ClaudeCliInfo> {
  /*
   * A budget for the whole search, not just for each probe.
   *
   * Several candidates each waiting out their own timeout adds up to most of a minute, which
   * is indistinguishable from stuck to the person watching it.
   */
  const deadline = Date.now() + timeoutMs * 2

  const direct = await probe(executable, timeoutMs)
  if (direct !== undefined) return direct

  for (const candidate of fallbackLocations(executable)) {
    if (!existsSync(candidate)) continue
    if (Date.now() >= deadline) break
    const found = await probe(candidate, timeoutMs)
    // Report the path that actually worked, so the settings tab shows the truth rather
    // than the name the user typed.
    if (found !== undefined) return found
  }

  return {
    available: false,
    executable,
    reason:
      `"${executable}" could not be run. If it is installed, give the full path here — ` +
      'a program installed after this editor started may not be on its PATH. ' +
      'Otherwise install it with: npm install -g @anthropic-ai/claude-code',
  }
}

export interface ExpertConsultation {
  question: string
  /** Workspace root — Claude reads relative to it. */
  cwd: string
  /** Overrides the model the CLI would otherwise pick. */
  model?: string
  /**
   * Continue an earlier consultation instead of starting cold.
   *
   * **This is the single largest cost lever in the feature.** Measured against CLI 2.1.227:
   * a cold consultation pays `cache_creation_input_tokens: 18643` to establish Claude Code's
   * own system prompt and tool definitions -- $0.187 for a reply of "OK". Resuming the same
   * session turns that into `cache_read_input_tokens: 18643` and costs $0.0099. Nineteen
   * times cheaper, before counting the workspace context that no longer has to be re-sent.
   *
   * The cache is 1-hour TTL (`ephemeral_1h_input_tokens`), so this holds while a session is
   * being used and lapses back to the cold price after an idle hour.
   */
  resumeSessionId?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ExpertAnswer {
  text: string
  /** Tools Claude asked for but was not allowed. Surfaced rather than hidden. */
  deniedTools: string[]
  /** Reported cost in USD, when the CLI provides it. */
  costUsd?: number
  durationMs?: number
  isError: boolean
  /**
   * The CLI's id for this conversation. Pass it back as `resumeSessionId` to continue.
   *
   * Returned even on failure when the CLI supplied one, so a session is not orphaned by a
   * single bad answer.
   */
  sessionId?: string
  /** True when a resume was attempted and had to fall back to a cold start. */
  resumeFailed?: boolean
}

interface CliResultEnvelope {
  type?: string
  subtype?: string
  result?: unknown
  is_error?: unknown
  total_cost_usd?: unknown
  duration_ms?: unknown
  permission_denials?: unknown
  session_id?: unknown
}

/** Pulls the tool names out of the CLI's permission-denial records, whatever their shape. */
function extractDeniedTools(denials: unknown): string[] {
  if (!Array.isArray(denials)) return []
  const names = new Set<string>()
  for (const denial of denials) {
    const name = (denial as { tool_name?: unknown })?.tool_name
    if (typeof name === 'string' && name.length > 0) names.add(name)
  }
  return [...names]
}

/**
 * Runs one consultation and returns the answer.
 *
 * `--output-format json` gives a single envelope with the result, the cost, and any
 * permission denials. Cost is surfaced deliberately: the whole point of this feature is
 * spending less, and a number the user never sees cannot be managed.
 */
export async function consultExpert(
  cli: ClaudeCliInfo,
  consultation: ExpertConsultation,
  logger?: Logger,
): Promise<ExpertAnswer> {
  if (!cli.available) {
    return { text: cli.reason ?? 'The Claude CLI is not available.', deniedTools: [], isError: true }
  }

  const args = [
    '-p',
    '--output-format',
    'json',
    // Read and search only.
    //
    // Verified against CLI 2.1.227: a disallowed tool is not *refused at call time*, it is
    // **never offered**. Asked to run a shell command, Claude replies "I don't have a Bash
    // tool available in this session" and adapts — it does not prompt, and it does not
    // hang. Asked to write a file it reports "Write is disabled for this session, in
    // subagents as well as here", so the restriction holds transitively.
    //
    // A consequence worth knowing: `permission_denials` came back **empty** in all of
    // those cases, because nothing was requested-and-refused. `deniedTools` is therefore
    // usually empty, and is kept for the case where a tool *is* offered but declined.
    '--allowedTools',
    ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    'Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch',
    // There is no terminal to prompt on inside another agent's turn, and nobody to answer.
    '--permission-mode',
    'default',
  ]
  if (consultation.model !== undefined && consultation.model.length > 0) {
    args.push('--model', consultation.model)
  }

  const invoke = async (sessionId: string | undefined): Promise<Awaited<ReturnType<typeof run>>> => {
    /*
     * Every restriction above is passed on a resume too, not just on the first call. The
     * session is stored by the CLI and we do not control what it remembers about its own
     * configuration — re-asserting read-only each time costs nothing and means the guarantee
     * cannot lapse partway through a conversation.
     */
    const withSession = sessionId !== undefined ? [...args, '--resume', sessionId] : args
    return run(cli.executable, withSession, {
      cwd: consultation.cwd,
      timeoutMs: consultation.timeoutMs ?? 180_000,
      ...(consultation.signal !== undefined ? { signal: consultation.signal } : {}),
      // The question goes on stdin, never in argv: it contains model-generated text, and
      // §16 is explicit that model output must never be interpolated into a command line.
      input: consultation.question,
    })
  }

  let raw
  let resumeFailed = false
  try {
    raw = await invoke(consultation.resumeSessionId)

    /*
     * A stored session can disappear — the CLI prunes transcripts, the user cleared them, or
     * the id came from a different machine. That must degrade to a cold consultation rather
     * than failing the turn: the question is still perfectly answerable, just more expensive.
     * Detected by exit code plus an empty stdout, since `--resume` on a missing id fails
     * before producing a JSON envelope.
     */
    if (consultation.resumeSessionId !== undefined && raw.code !== 0 && raw.stdout.trim().length === 0) {
      logger?.debug(`expert session ${consultation.resumeSessionId} could not be resumed; starting a fresh one`)
      resumeFailed = true
      raw = await invoke(undefined)
    }
  } catch (error) {
    return {
      text: `Could not consult the expert: ${error instanceof Error ? error.message : String(error)}`,
      deniedTools: [],
      isError: true,
    }
  }

  if (raw.stdout.trim().length === 0) {
    return {
      text: `The expert returned nothing (exit code ${raw.code}). ${raw.stderr.trim().slice(0, 400)}`.trim(),
      deniedTools: [],
      isError: true,
    }
  }

  let envelope: CliResultEnvelope
  try {
    envelope = JSON.parse(raw.stdout) as CliResultEnvelope
  } catch {
    // An older CLI, or one configured to print plain text. The answer is still usable.
    logger?.debug('claude cli did not return JSON; using raw output')
    return { text: raw.stdout.trim(), deniedTools: [], isError: raw.code !== 0 }
  }

  const answer: ExpertAnswer = {
    text: typeof envelope.result === 'string' ? envelope.result : raw.stdout.trim(),
    deniedTools: extractDeniedTools(envelope.permission_denials),
    isError: envelope.is_error === true || raw.code !== 0,
  }
  if (typeof envelope.total_cost_usd === 'number') answer.costUsd = envelope.total_cost_usd
  if (typeof envelope.duration_ms === 'number') answer.durationMs = envelope.duration_ms
  // Captured even when the answer failed: the session still exists, and throwing it away
  // would make the next consultation pay the cold-start price for nothing.
  if (typeof envelope.session_id === 'string' && envelope.session_id.length > 0) {
    answer.sessionId = envelope.session_id
  }
  if (resumeFailed) answer.resumeFailed = true
  return answer
}
