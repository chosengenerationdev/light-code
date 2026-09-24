import { z } from 'zod'

import type { Tool, ToolResult } from './types.js'

/**
 * Reading the state of a live debug session, for investigating a crash or unexpected behaviour.
 *
 * ## Why this and not "read the terminal"
 *
 * Terminal-reading was asked for alongside this, and dropped: VS Code gives an extension no
 * reliable way to read what is currently on screen in an arbitrary terminal — there is no
 * "current buffer" API, only ways to send text to one or to capture output from a command the
 * extension itself started with shell integration. A debug session is a completely different
 * story: **VS Code standardises every debugger — Python, Node, Go, C++, whatever the user has
 * installed — on the Debug Adapter Protocol (DAP)**, so anything built against DAP requests
 * (`stackTrace`, `scopes`, `variables`) rather than a language-specific API works for all of them
 * automatically. That is the whole reason this is feasible and general-purpose at once.
 *
 * ## What is deliberately not built
 *
 * No way to *control* the session (continue, step, set a breakpoint) — this is read-only, in the
 * `read` group, same as `read_file`. A tool that could also single-step a program the user is
 * looking at needs a different design conversation than the one this was asked for.
 *
 * No cross-session lookup or `sessionId` parameter: the host always answers for
 * `vscode.debug.activeDebugSession`, which is "whichever one you are looking at" — the only
 * session that means anything to ask about from a chat running alongside it.
 *
 * ## Why this needs no privacy toggle the way Office/mail do
 *
 * A debug session's variables can hold secrets — an API key sitting in a local variable mid
 * request. But this is not a standing background capability the way a mailbox is: it only ever
 * answers for a debugger the user *personally started, in this window, right now*, and it goes
 * through the same `read`-group approval every other tool that can see secrets already does
 * (`read_file` is no different). A special toggle here would be protecting against a risk
 * `read_file` already carries.
 */

export interface DebugVariable {
  name: string
  /** The adapter's own rendering — often already a repr for a complex value. */
  value: string
  type?: string
}

export interface DebugScope {
  name: string
  variables: DebugVariable[]
}

export interface DebugStackFrame {
  name: string
  file?: string
  line?: number
  scopes: DebugScope[]
}

export interface DebugSessionSnapshot {
  sessionName: string
  /** The debug adapter type VS Code assigned — `python`, `node`, `go`, … */
  sessionType: string
  program?: string
  /** Present and populated only while genuinely paused at a breakpoint, step, or exception. */
  stopped?: {
    reason: string
    description?: string
    /** Top frames of the thread that stopped, most recent call first. */
    frames: DebugStackFrame[]
  }
  /** Most recent console/stdout/stderr lines, oldest first, already capped by the host. */
  recentOutput: string[]
}

export interface DebugSessionToolOptions {
  /** Undefined return means no debug session is currently active. */
  read: () => Promise<DebugSessionSnapshot | undefined>
}

/** Formats a variable line, indented to its scope. */
function renderVariable(variable: DebugVariable): string {
  const typed = variable.type !== undefined ? `: ${variable.type}` : ''
  return `      ${variable.name}${typed} = ${variable.value}`
}

function renderFrame(frame: DebugStackFrame): string {
  const where = frame.file !== undefined ? `${frame.file}${frame.line !== undefined ? `:${String(frame.line)}` : ''}` : undefined
  const lines = [`  - ${frame.name}${where !== undefined ? ` (${where})` : ''}`]
  for (const scope of frame.scopes) {
    if (scope.variables.length === 0) continue
    lines.push(`    ${scope.name}:`)
    lines.push(...scope.variables.map(renderVariable))
  }
  return lines.join('\n')
}

export function renderDebugSnapshot(snapshot: DebugSessionSnapshot): string {
  const lines: string[] = [
    `Session: ${snapshot.sessionName} (${snapshot.sessionType})`,
    ...(snapshot.program !== undefined ? [`Program: ${snapshot.program}`] : []),
  ]

  if (snapshot.stopped !== undefined) {
    lines.push(
      '',
      `Paused: ${snapshot.stopped.reason}${snapshot.stopped.description !== undefined ? ` — ${snapshot.stopped.description}` : ''}`,
      '',
      'Call stack (most recent call first):',
      ...(snapshot.stopped.frames.length === 0
        ? ['  (could not be read — the session may have moved on while this was running)']
        : snapshot.stopped.frames.map(renderFrame)),
    )
  } else {
    lines.push('', 'Running — not currently paused. Set a breakpoint to inspect state at a point in time.')
  }

  lines.push(
    '',
    snapshot.recentOutput.length === 0
      ? 'No console output captured yet.'
      : 'Recent console output:',
    ...snapshot.recentOutput,
  )

  return lines.join('\n')
}

export function createReadDebugSessionTool(options: DebugSessionToolOptions): Tool<Record<string, never>> {
  return {
    name: 'read_debug_session',
    group: 'read',
    description:
      'Reads the active VS Code debug session: whether it is paused at a breakpoint or ' +
      'exception, and if so the call stack and local variables at that point, plus recent ' +
      'console output (stdout/stderr). Works for any language VS Code can debug — Python, ' +
      'Node.js, Go, and others — not just one. Use this when investigating a crash, an ' +
      'exception, or unexpected runtime behaviour while the user has something paused in the ' +
      'debugger, instead of asking them to paste variable values by hand. Read-only: it cannot ' +
      'step, continue, or set breakpoints. Returns a clear message if nothing is being debugged.',
    parametersSchema: z.object({}),
    async execute(): Promise<ToolResult> {
      const snapshot = await options.read()
      if (snapshot === undefined) {
        return {
          content:
            'No debug session is currently running. Start one from Run and Debug (F5), pause at ' +
            'the point of interest, and try again.',
        }
      }
      return { content: renderDebugSnapshot(snapshot) }
    },
  }
}
