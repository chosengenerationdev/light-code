// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { StartupProgress } from './StartupProgress.js'
import { TokenBar } from './TokenBar.js'

/**
 * Asked for: chats took over 90 seconds to start, so show over the message box what is being waited on; and a switch to
 * hand off by itself at the context limit, beside the one that compacts.
 */
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the startup bar', () => {
  it('names each thing still getting ready with how long it has taken, and goes when nothing is left', () => {
    const now = Date.now()
    act(() => root.render(<StartupProgress waiting={[{ label: 'MCP server "jira" starting', since: now - 42_000 }, { label: 'Python tools', since: now - 3_000 }]} />))
    expect(container.textContent).toContain('MCP server "jira" starting (42 s)')
    expect(container.textContent).toContain('Python tools (3 s)')
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    act(() => root.render(<StartupProgress waiting={[]} />))
    expect(container.textContent).toBe('')
  })
})

describe('compacting or handing off at the limit', () => {
  const usage = { total: 9_000, contextWindow: 10_000, estimated: false, breakdown: { system: 1, toolDefinitions: 1, history: 1, results: 1 } } as never

  it('offers both, and ticking one unticks the other', () => {
    const calls: string[] = []
    act(() =>
      root.render(
        <TokenBar
          usage={usage}
          onCompact={() => undefined}
          autoCompact
          onSetAutoCompact={(value) => calls.push(`compact ${String(value)}`)}
          autoHandoff={false}
          onSetAutoHandoff={(value) => calls.push(`handoff ${String(value)}`)}
        />,
      ),
    )
    const box = [...container.querySelectorAll('label')].find((label) => label.textContent?.includes('Hand off automatically'))!.querySelector('input')!
    act(() => box.click())
    expect(calls).toEqual(['compact false', 'handoff true'])
  })
})
