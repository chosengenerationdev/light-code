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

async function probe(executable: string, timeoutMs: number): Promise<ClaudeCliInfo | undefined> {
  try {
    const { code, stdout } = await run(executable, ['--version'], { timeoutMs })
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
  const direct = await probe(executable, timeoutMs)
  if (direct !== undefined) return direct

  for (const candidate of fallbackLocations(executable)) {
    if (!existsSync(candidate)) continue
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
}

interface CliResultEnvelope {
  type?: string
  subtype?: string
  result?: unknown
  is_error?: unknown
  total_cost_usd?: unknown
  duration_ms?: unknown
  permission_denials?: unknown
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

  let raw
  try {
    raw = await run(cli.executable, args, {
      cwd: consultation.cwd,
      timeoutMs: consultation.timeoutMs ?? 180_000,
      ...(consultation.signal !== undefined ? { signal: consultation.signal } : {}),
      // The question goes on stdin, never in argv: it contains model-generated text, and
      // §16 is explicit that model output must never be interpolated into a command line.
      input: consultation.question,
    })
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
  return answer
}
