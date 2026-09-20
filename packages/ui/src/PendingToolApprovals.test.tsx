// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PendingToolApprovals, type PendingTool } from './PendingToolApprovals.js'

/**
 * The card is the only thing standing between a bucket handing you a `.py` and that code running.
 * Its rules are behaviour, not appearance, so they are pinned here.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const TOOLS: PendingTool[] = [
  { name: 'ledger_fetch', filePath: '/shared/ledger_fetch.py', kind: 'unapproved' },
  { name: 'risk_export', filePath: '/shared/risk_export.py', kind: 'hash-mismatch' },
]

function render(overrides: Partial<Parameters<typeof PendingToolApprovals>[0]> = {}): {
  approved: string[][]
  declined: string[][]
  asked: string[]
} {
  const approved: string[][] = []
  const declined: string[][] = []
  const asked: string[] = []
  act(() => {
    root.render(
      <PendingToolApprovals
        tools={TOOLS}
        sources={{}}
        onRequestSource={(name) => asked.push(name)}
        onApprove={(names) => approved.push(names)}
        onDecline={(names) => declined.push(names)}
        {...overrides}
      />,
    )
  })
  return { approved, declined, asked }
}

const button = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text))

describe('the pending approval card', () => {
  it('renders nothing when there is nothing waiting', () => {
    render({ tools: [] })
    expect(container.textContent).toBe('')
  })

  it('says how many, and marks the ones that changed after approval', () => {
    // "New" and "changed since you approved it" are not the same news, and the second is the one
    // worth reading carefully.
    render()
    expect(container.textContent).toContain('2 Python tools waiting')
    expect(container.textContent).toContain('changed')
  })

  it('fetches a source only when somebody asks to see it', () => {
    // Most tools are already approved; shipping every file with every status update would put the
    // whole tools folder on the wire for a card that is usually empty.
    const { asked } = render()
    expect(asked).toEqual([])
    act(() => {
      button('View source')?.click()
    })
    expect(asked).toEqual(['ledger_fetch'])
  })

  it('does not offer to approve everything until every source has been shown', () => {
    /*
     * The load-bearing rule. §13 asks that a human sees the source once — not that they click per
     * file — so a bulk action is legitimate exactly when the code was on screen. Before that, the
     * only bulk control is one that *shows* it.
     */
    const { approved } = render()
    expect(button('Approve all')).toBeUndefined()
    expect(button('Review all 2')).toBeDefined()

    act(() => {
      button('Review all 2')?.click()
    })
    expect(button('Approve all 2')).toBeDefined()
    expect(approved).toEqual([])
  })

  it('requests every source when reviewing all', () => {
    const { asked } = render()
    act(() => {
      button('Review all 2')?.click()
    })
    expect(asked.sort()).toEqual(['ledger_fetch', 'risk_export'])
  })

  it('approves all of them once they have been shown', () => {
    const { approved } = render()
    act(() => {
      button('Review all 2')?.click()
    })
    act(() => {
      button('Approve all 2')?.click()
    })
    expect(approved).toEqual([['ledger_fetch', 'risk_export']])
  })

  it('approves one on its own without any of that', () => {
    // Reading one file and approving it is the ordinary case and must stay one click.
    const { approved } = render()
    act(() => {
      button('Approve')?.click()
    })
    expect(approved).toEqual([['ledger_fetch']])
  })

  it('declines without needing the source shown first', () => {
    // Saying no is the safe direction, and it deletes nothing — so it does not need the ceremony
    // that saying yes does.
    const { declined } = render()
    act(() => {
      button('Decline')?.click()
    })
    expect(declined).toEqual([['ledger_fetch']])
  })

  it('shows a fetched source, and a problem where there is one', () => {
    render({
      sources: {
        ledger_fetch: { source: 'def run():\n    return 1\n' },
        risk_export: { problem: 'The file could not be found.' },
      },
    })
    act(() => {
      button('Review all 2')?.click()
    })
    expect(container.textContent).toContain('def run():')
    expect(container.textContent).toContain('could not be found')
  })
})
