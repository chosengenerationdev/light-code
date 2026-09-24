import * as vscode from 'vscode'
import type { DebugSessionSnapshot, DebugStackFrame } from '@light-code/core'

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

export function startTrackingDebugSessions(context: vscode.ExtensionContext): void {
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
}

/**
 * Answers for `vscode.debug.activeDebugSession` — "whichever one you are looking at" — which is
 * the only session a chat running alongside it can mean without asking. There is no
 * `sessionId` parameter to resolve against anything else.
 */
export async function readDebugSession(): Promise<DebugSessionSnapshot | undefined> {
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
    recentOutput: [...entry.output],
  }
}
