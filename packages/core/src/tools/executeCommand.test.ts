import { describe, expect, it } from 'vitest'

import { PathDenylist } from '../fs/denylist.js'
import type { TerminalProcess, TerminalRunOptions } from '../platform/terminal.js'
import { executeCommandTool } from './executeCommand.js'
import type { ToolExecutionContext } from './types.js'

/** Records what it was asked to run, and finishes immediately. */
function recordingTerminal(): { calls: { command: string; options?: TerminalRunOptions }[]; terminal: ToolExecutionContext['terminal'] } {
  const calls: { command: string; options?: TerminalRunOptions }[] = []
  return {
    calls,
    terminal: {
      run(command, options) {
        calls.push({ command, ...(options !== undefined ? { options } : {}) })
        const exitListeners: ((code: number | null) => void)[] = []
        const proc: TerminalProcess = {
          pid: 1,
          onData: () => undefined,
          onExit: (listener) => {
            exitListeners.push(listener)
            // Next tick, so the tool has attached its listeners before the process "ends".
            setTimeout(() => listener(0), 0)
          },
          write: () => undefined,
          killTree: async () => undefined,
        }
        return proc
      },
    },
  }
}

function context(sessionEnv?: Record<string, string>): ToolExecutionContext {
  const { terminal } = recordingTerminal()
  return {
    fs: {} as ToolExecutionContext['fs'],
    terminal,
    workspaceRoot: '/workspace',
    denylist: new PathDenylist(),
    readFiles: new Set(),
    ...(sessionEnv !== undefined ? { sessionEnv } : {}),
  }
}

describe('execute_command and the session environment', () => {
  /**
   * The half of session variables that no amount of resolving proves: they have to reach the
   * process. Asserted against the shipped tool rather than by reading it, because "the resolver
   * is right" and "the value arrives" are different claims and only the second one matters to
   * someone whose command cannot see their variable.
   */
  it('passes the resolved variables to the process', async () => {
    const recorder = recordingTerminal()
    const ctx = { ...context(), terminal: recorder.terminal, sessionEnv: { REGISTRY: 'https://pypi.internal/simple' } }

    await executeCommandTool.execute({ command: 'pip install requests' }, ctx)

    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]?.options?.env).toEqual({ REGISTRY: 'https://pypi.internal/simple' })
  })

  /**
   * Absent, not empty. `NodeTerminal` treats an absent `env` as "inherit" and a present one as a
   * patch over `process.env`, so passing `{}` would be the same thing — but the extension supplies
   * no session environment at all, and the call it makes should look exactly as it did before.
   */
  it('passes no env at all when the host supplies none', async () => {
    const recorder = recordingTerminal()
    const ctx = { ...context(), terminal: recorder.terminal }

    await executeCommandTool.execute({ command: 'npm test' }, ctx)

    expect(recorder.calls[0]?.options).toEqual({ cwd: '/workspace' })
    expect(recorder.calls[0]?.options).not.toHaveProperty('env')
  })

  it('still passes the working directory alongside', async () => {
    const recorder = recordingTerminal()
    const ctx = { ...context(), terminal: recorder.terminal, sessionEnv: { A: '1' } }

    await executeCommandTool.execute({ command: 'ls', cwd: '/workspace/sub' }, ctx)

    expect(recorder.calls[0]?.options).toEqual({ cwd: '/workspace/sub', env: { A: '1' } })
  })
})
