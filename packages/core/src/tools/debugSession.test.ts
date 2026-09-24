import { describe, expect, it } from 'vitest'

import { createReadDebugSessionTool, renderDebugSnapshot, type DebugSessionSnapshot } from './debugSession.js'
import type { ToolExecutionContext } from './types.js'

const NO_CONTEXT = {} as unknown as ToolExecutionContext

describe('read_debug_session', () => {
  it('says plainly when nothing is being debugged, rather than an empty result', async () => {
    const tool = createReadDebugSessionTool({ read: async () => undefined })
    const result = await tool.execute({}, NO_CONTEXT)
    expect(result.content).toContain('No debug session is currently running')
  })

  it('reports a running, unpaused session without inventing a stack', async () => {
    const snapshot: DebugSessionSnapshot = {
      sessionName: 'Launch script',
      sessionType: 'python',
      program: '/repo/app.py',
      recentOutput: ['starting up'],
    }
    const tool = createReadDebugSessionTool({ read: async () => snapshot })
    const result = await tool.execute({}, NO_CONTEXT)
    expect(result.content).toContain('python')
    expect(result.content).toContain('/repo/app.py')
    expect(result.content).toContain('Running')
    expect(result.content).not.toContain('Call stack')
  })

  /**
   * The point of the feature: paused state, with the call stack and variables at the point of
   * pause, rendered so the model can read it as plain text without a second lookup.
   */
  it('renders the call stack and variables when paused', () => {
    const snapshot: DebugSessionSnapshot = {
      sessionName: 'Launch script',
      sessionType: 'python',
      stopped: {
        reason: 'exception',
        description: "ZeroDivisionError: division by zero",
        frames: [
          {
            name: 'divide',
            file: '/repo/app.py',
            line: 12,
            scopes: [
              { name: 'Locals', variables: [{ name: 'a', value: '1', type: 'int' }, { name: 'b', value: '0', type: 'int' }] },
            ],
          },
        ],
      },
      recentOutput: [],
    }
    const rendered = renderDebugSnapshot(snapshot)
    expect(rendered).toContain('exception')
    expect(rendered).toContain('ZeroDivisionError')
    expect(rendered).toContain('divide')
    expect(rendered).toContain('/repo/app.py:12')
    expect(rendered).toContain('a: int = 1')
    expect(rendered).toContain('b: int = 0')
  })

  it('is language-agnostic in its rendering — nothing branches on sessionType', () => {
    const snapshot: DebugSessionSnapshot = {
      sessionName: 'Launch',
      sessionType: 'node',
      stopped: { reason: 'breakpoint', frames: [{ name: 'main', scopes: [] }] },
      recentOutput: [],
    }
    const rendered = renderDebugSnapshot(snapshot)
    expect(rendered).toContain('node')
    expect(rendered).toContain('breakpoint')
  })

  /** A scope that could not be read is skipped, not shown as an empty, confusing header. */
  it('omits a scope with no variables rather than an empty heading', () => {
    const snapshot: DebugSessionSnapshot = {
      sessionName: 'Launch',
      sessionType: 'go',
      stopped: {
        reason: 'breakpoint',
        frames: [{ name: 'main', scopes: [{ name: 'Globals', variables: [] }] }],
      },
      recentOutput: [],
    }
    const rendered = renderDebugSnapshot(snapshot)
    expect(rendered).not.toContain('Globals')
  })

  it('says when no console output has been captured yet', () => {
    const snapshot: DebugSessionSnapshot = { sessionName: 'Launch', sessionType: 'python', recentOutput: [] }
    expect(renderDebugSnapshot(snapshot)).toContain('No console output captured yet.')
  })
})
