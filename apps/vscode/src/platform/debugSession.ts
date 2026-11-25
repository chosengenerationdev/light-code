import * as vscode from 'vscode'
import type { DebugEvaluation, DebugReadRequest, DebugSessionSnapshot, DebugStackFrame } from '@light-code/core'

/**
 * Watching every VS Code debug session for its console output and paused/running state.
 *
 * ## Why this has to be watched forward, not asked for on demand
 *
 * A debug adapter has no "give me the last 50 lines of output" request — output only ever
 * arrives as `output` events pushed forward as they happen. So this registers a tracker at
 * activation and keeps a small buffer per session; `readDebugSession` below then answers from
 * that buffer instantly rather than trying to ask the adapter something it cannot answer.
 *
 * ## Why one tracker covers every language
 *
 * `registerDebugAdapterTrackerFactory('*', …)` is the wildcard form — it attaches to every debug
 * session regardless of type, because every debug extension speaks the same Debug Adapter
 * Protocol underneath. Nothing here is Python-specific; `session.type` is whatever string the
 * active debug extension registered (`python`, `node`, `go`, …), read and reported, never
 * branched on.
 */

const MAX_OUTPUT_LINES = 200
const MAX_FRAMES = 5
const MAX_VARIABLES_PER_SCOPE = 60

interface TrackedSession {
  output: string[]
  stopped?: { threadId: number; reason: string; description?: string }
}

const tracked = new Map<string, TrackedSession>()

function bufferFor(sessionId: string): TrackedSession {
  let entry = tracked.get(sessionId)
  if (entry === undefined) {
    entry = { output: [] }
    tracked.set(sessionId, entry)
  }
  return entry
}

/** The shape of a DAP protocol message, read defensively — nothing here trusts the adapter. */
interface DapMessage {
  type?: string
  event?: string
  body?: Record<string, unknown>
}

let tracking = false

/**
 * Started at activation (so Fire Code can read a session's output before this window's panel was ever
 * opened) and again when the bridge is built; only the first call registers, or every line would be kept twice.
 */
export function startTrackingDebugSessions(context: vscode.ExtensionContext): void {
  if (tracking) return
  tracking = true
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        const entry = bufferFor(session.id)
        return {
          onDidSendMessage(message: unknown) {
            const dap = message as DapMessage
            if (dap.type !== 'event') return

            if (dap.event === 'output') {
              const text = typeof dap.body?.output === 'string' ? dap.body.output : undefined
              if (text === undefined) return
              for (const line of text.split(/\r?\n/)) {
                if (line.length === 0) continue
                entry.output.push(line)
              }
              // Trimmed from the front so the buffer stays bounded without ever losing the
              // most recent lines, which are the ones an investigation actually wants.
              if (entry.output.length > MAX_OUTPUT_LINES) {
                entry.output.splice(0, entry.output.length - MAX_OUTPUT_LINES)
              }
              return
            }

            if (dap.event === 'stopped') {
              const threadId = typeof dap.body?.threadId === 'number' ? dap.body.threadId : undefined
              // A `stopped` event with no thread id is not one this can act on — there is
              // nothing to run `stackTrace` against.
              if (threadId === undefined) return
              const reason = typeof dap.body?.reason === 'string' ? dap.body.reason : 'unknown'
              const description =
                (typeof dap.body?.description === 'string' ? dap.body.description : undefined) ??
                (typeof dap.body?.text === 'string' ? dap.body.text : undefined)
              entry.stopped = { threadId, reason, ...(description !== undefined ? { description } : {}) }
              return
            }

            if (dap.event === 'continued' || dap.event === 'exited' || dap.event === 'terminated') {
              delete entry.stopped
            }
          },
        }
      },
    }),
    // Otherwise a long session leaves its buffer in memory for the rest of the window's life.
    vscode.debug.onDidTerminateDebugSession((session) => tracked.delete(session.id)),
  )
}

interface DapStackFrame {
  id: number
  name: string
  source?: { path?: string }
  line?: number
}
interface DapScope {
  name: string
  variablesReference: number
  expensive?: boolean
}
interface DapVariable {
  name: string
  value: string
  type?: string
  variablesReference?: number
}

/**
 * Answers for `vscode.debug.activeDebugSession` — "whichever one you are looking at" — which is
 * the only session a chat running alongside it can mean without asking. There is no
 * `sessionId` parameter to resolve against anything else.
 */
export async function readDebugSession(request: DebugReadRequest = {}): Promise<DebugSessionSnapshot | undefined> {
  const session = vscode.debug.activeDebugSession
  if (session === undefined) return undefined

  const entry = bufferFor(session.id)
  const program =
    typeof session.configuration?.program === 'string' ? session.configuration.program : undefined

  if (entry.stopped === undefined) {
    return {
      sessionName: session.name,
      sessionType: session.type,
      ...(program !== undefined ? { program } : {}),
      recentOutput: [...entry.output],
    }
  }

  const frames: DebugStackFrame[] = []
  try {
    const stack = (await session.customRequest('stackTrace', {
      threadId: entry.stopped.threadId,
      startFrame: 0,
      levels: MAX_FRAMES,
    })) as { stackFrames?: DapStackFrame[] }

    for (const frame of stack.stackFrames ?? []) {
      // `session.customRequest` returns VS Code's own `Thenable`, which has no `.catch` — only
      // `.then` — so failures are wrapped through `Promise.resolve` instead.
      const scopesResult = (await Promise.resolve(
        session.customRequest('scopes', { frameId: frame.id }),
      ).catch(() => ({ scopes: [] }))) as { scopes?: DapScope[] }

      const scopes: DebugStackFrame['scopes'] = []
      for (const scope of scopesResult.scopes ?? []) {
        // `expensive` is the adapter's own signal that fetching this scope by default is not
        // wanted — a large globals or module scope, typically. Honoured rather than overridden.
        if (scope.expensive === true) continue
        const variablesResult = (await Promise.resolve(
          session.customRequest('variables', { variablesReference: scope.variablesReference }),
        ).catch(() => ({ variables: [] }))) as { variables?: DapVariable[] }
        const variables = (variablesResult.variables ?? [])
          .slice(0, MAX_VARIABLES_PER_SCOPE)
          .map((variable) => ({
            name: variable.name,
            value: variable.value,
            ...(variable.type !== undefined ? { type: variable.type } : {}),
          }))
        if (variables.length > 0) scopes.push({ name: scope.name, variables })
      }

      frames.push({
        name: frame.name,
        ...(frame.source?.path !== undefined ? { file: frame.source.path } : {}),
        ...(frame.line !== undefined ? { line: frame.line } : {}),
        scopes,
      })
    }
  } catch {
    // A session that stopped and then raced to continue or terminate before these requests
    // landed is reported as paused with no frames, rather than failing the whole read.
  }

  return {
    sessionName: session.name,
    sessionType: session.type,
    ...(program !== undefined ? { program } : {}),
    stopped: {
      reason: entry.stopped.reason,
      ...(entry.stopped.description !== undefined ? { description: entry.stopped.description } : {}),
      frames,
    },
    ...(request.expand !== undefined && request.expand.trim() !== ''
      ? { expanded: await expandVariable(session, entry.stopped.threadId, request.expand.trim(), request.frame ?? 0, request.depth ?? 2) }
      : {}),
    recentOutput: [...entry.output],
  }
}

const MAX_EXPANDED_LINES = 300
const MAX_CHILDREN = 100

type Request = (command: string, args: Record<string, unknown>) => Promise<unknown>

/** The DAP request function for a session, as a real Promise (VS Code's Thenable has no `.catch`). */
function requester(session: vscode.DebugSession): Request {
  return (command, args) => Promise.resolve(session.customRequest(command, args))
}

async function frameId(ask: Request, threadId: number, frame: number): Promise<number | undefined> {
  const stack = (await ask('stackTrace', { threadId, startFrame: frame, levels: 1 }).catch(() => ({}))) as { stackFrames?: DapStackFrame[] }
  return stack.stackFrames?.[0]?.id
}

async function children(ask: Request, reference: number): Promise<DapVariable[]> {
  const answer = (await ask('variables', { variablesReference: reference }).catch(() => ({}))) as { variables?: DapVariable[] }
  return answer.variables ?? []
}

/** A variable's children as indented lines, `depth` levels deep, through DAP `variables` alone - nothing is run. */
async function renderChildren(ask: Request, reference: number, depth: number, indent: string, lines: string[]): Promise<void> {
  const list = await children(ask, reference)
  for (const child of list.slice(0, MAX_CHILDREN)) {
    if (lines.length >= MAX_EXPANDED_LINES) {
      lines.push(`${indent}… (more not shown)`)
      return
    }
    lines.push(`${indent}${child.name}${child.type !== undefined ? `: ${child.type}` : ''} = ${child.value}`)
    if (depth > 1 && (child.variablesReference ?? 0) > 0) await renderChildren(ask, child.variablesReference ?? 0, depth - 1, `${indent}  `, lines)
  }
  if (list.length > MAX_CHILDREN) lines.push(`${indent}… ${String(list.length - MAX_CHILDREN)} more`)
}

/**
 * `read_debug_session`'s `expand`: a variable found by a dotted path ("df", "result.items") in a frame's scopes, and its
 * children a few levels deep - a DataFrame's columns, an object's attributes. Read through the debugger only.
 */
async function expandVariable(
  session: vscode.DebugSession,
  threadId: number,
  path: string,
  frame: number,
  depth: number,
): Promise<NonNullable<DebugSessionSnapshot['expanded']>> {
  const ask = requester(session)
  const id = await frameId(ask, threadId, frame)
  if (id === undefined) return { path, frame, lines: [], error: `There is no frame ${String(frame)} in the call stack.` }
  const scopes = ((await ask('scopes', { frameId: id }).catch(() => ({}))) as { scopes?: DapScope[] }).scopes ?? []
  const [first, ...rest] = path.split('.')
  let found: DapVariable | undefined
  // Cheap scopes first; a large globals scope only when the name is not in the others.
  for (const scope of [...scopes.filter((s) => s.expensive !== true), ...scopes.filter((s) => s.expensive === true)]) {
    found = (await children(ask, scope.variablesReference)).find((variable) => variable.name === first)
    if (found !== undefined) break
  }
  if (found === undefined) return { path, frame, lines: [], error: `No variable named "${first ?? ''}" in frame ${String(frame)}.` }
  for (const part of rest) {
    const inside: DapVariable[] = (found.variablesReference ?? 0) > 0 ? await children(ask, found.variablesReference ?? 0) : []
    const next: DapVariable | undefined = inside.find((variable) => variable.name === part || variable.name === `'${part}'` || variable.name === `"${part}"`)
    if (next === undefined) return { path, frame, lines: [], error: `"${part}" is not inside ${found.name}. It has: ${inside.slice(0, 30).map((v) => v.name).join(', ')}` }
    found = next
  }
  const lines = [`${path}${found.type !== undefined ? `: ${found.type}` : ''} = ${found.value}`]
  if ((found.variablesReference ?? 0) > 0) await renderChildren(ask, found.variablesReference ?? 0, depth, '  ', lines)
  return { path, frame, lines }
}

/** A Python (or JS) string literal as its text: debuggers show a string's value quoted and escaped. */
export function unquote(value: string): string {
  const match = /^(?:[rRbBuU]?)(['"])([\s\S]*)\1$/.exec(value.trim())
  if (match === null) return value
  return (match[2] ?? '').replace(/\\(n|t|r|\\|'|")/g, (_all, code: string) => (code === 'n' ? '\n' : code === 't' ? '\t' : code === 'r' ? '' : code))
}

/**
 * `evaluate_in_debug_session`: an expression evaluated in a frame of the paused thread. The `clipboard` context first -
 * debuggers that support it give the whole value there, not a shortened one - then `repl`. Undefined when nothing is
 * paused.
 */
export async function evaluateInDebugSession(request: { expression: string; frame?: number }): Promise<DebugEvaluation | undefined> {
  const session = vscode.debug.activeDebugSession
  if (session === undefined) return undefined
  const stopped = bufferFor(session.id).stopped
  if (stopped === undefined) return undefined
  const ask = requester(session)
  const id = await frameId(ask, stopped.threadId, request.frame ?? 0)
  if (id === undefined) return { ok: false, error: `There is no frame ${String(request.frame ?? 0)} in the call stack.` }
  let answer: { result?: string; type?: string; variablesReference?: number } | undefined
  let failure = ''
  for (const context of ['clipboard', 'repl']) {
    try {
      answer = (await ask('evaluate', { expression: request.expression, frameId: id, context })) as typeof answer
      break
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
  }
  if (answer === undefined) return { ok: false, error: failure || 'The debugger gave no answer.' }
  const raw = answer.result ?? ''
  const result = answer.type === 'str' || answer.type === 'string' ? unquote(raw) : raw
  const lines: string[] = []
  if ((answer.variablesReference ?? 0) > 0 && answer.type !== 'str') await renderChildren(ask, answer.variablesReference ?? 0, 1, '  ', lines)
  return { ok: true, result: result.length > 60_000 ? `${result.slice(0, 60_000)}\n… (cut at 60,000 characters)` : result, ...(answer.type !== undefined ? { type: answer.type } : {}), ...(lines.length > 0 ? { children: lines } : {}) }
}
