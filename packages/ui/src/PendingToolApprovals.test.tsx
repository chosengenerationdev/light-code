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


/**
 * The row that cannot be approved, and the row that appears twice.
 *
 * Reported as "I am guessing last approval in the list only getting stuck". Two things produce
 * that, and only one of them was a bug in the approval path itself.
 */
describe('a tool that cannot be approved', () => {
  const stuck: PendingTool[] = [
    { name: 'good_tool', filePath: '/tools/good_tool.py', kind: 'unapproved' },
    { name: 'broken_tool', filePath: '/tools/broken_tool.py', kind: 'unapproved' },
  ]

  it('says why, in the row, instead of leaving it looking like every other one', () => {
    /*
     * A tool that parses but fails to load can never be approved - pinning it would have the
     * registry certifying broken code, which §13 forbids. That is correct and it was invisible:
     * the reason went into a toast, the row was unchanged, and the only thing left to do was
     * press Approve again and watch nothing happen.
     */
    render({
      tools: stuck,
      problems: { broken_tool: '"broken_tool" could not be loaded, so it was not approved' },
    })
    expect(container.textContent).toContain('Could not be approved')
    expect(container.textContent).toContain('Approving again will not help')
    // And it says what *will* help, since the row is otherwise a dead end.
    expect(container.textContent).toContain('Decline')
  })

  it('marks only the tool that failed', () => {
    render({
      tools: stuck,
      problems: { broken_tool: 'could not be loaded' },
    })
    expect(container.querySelectorAll('div')).not.toHaveLength(0)
    // One reason shown, not one per row.
    expect(container.textContent?.match(/Could not be approved/g)).toHaveLength(1)
  })

  it('shows nothing when nothing failed', () => {
    render({ tools: stuck })
    expect(container.textContent).not.toContain('Could not be approved')
  })
})

describe('the same tool in two folders', () => {
  it('renders both rows, keyed by path rather than by name', () => {
    /*
     * A bucket mirror beside the local folder is the supported case, so two rows can share a
     * name. Keyed by name they shared a React key, which is a list React cannot update
     * predictably as it shrinks - the other half of "the last one gets stuck".
     */
    render({
      tools: [
        { name: 'shared_tool', filePath: '/local/shared_tool.py', kind: 'unapproved' },
        { name: 'shared_tool', filePath: '/mirror/shared_tool.py', kind: 'unapproved' },
      ],
    })
    expect(container.textContent).toContain('/local/shared_tool.py')
    expect(container.textContent).toContain('/mirror/shared_tool.py')
    expect(container.textContent).toContain('2 Python tools waiting')
  })
})
