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

  /*
   * Reported: after Approve all, the card stayed exactly as it was for long enough to look broken.
   * Each approval loads the tool, seconds apiece, so the rows must say they are being dealt with.
   */
  it('says a tool is being approved, and offers no second click while it is', () => {
    render({ approving: ['ledger_fetch'], approvalProgress: { done: 0, total: 1 } })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Checking 1 of 1')
    expect(container.textContent).toContain('Checking…')
    // The other row is untouched and still answerable.
    expect(button('Approve')).toBeDefined()
    expect(button('Approve all')).toBeUndefined()
    expect(button('Decline all')).toBeUndefined()
  })

  /* Motion and a count, because a still "Approving…" over several seconds per tool read as hung. */
  it('spins on the tool being checked, queues the rest, and fills a bar as each finishes', () => {
    render({ approving: ['ledger_fetch', 'risk_export'], approvalProgress: { done: 1, total: 3 } })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Checking 2 of 3')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('py__ledger_fetch')
    // One spinner in the heading, one on the row being checked; the queued row has none.
    expect(container.querySelectorAll('svg.lc-spin')).toHaveLength(2)
    expect(container.textContent).toContain('Queued')
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('1')
    expect((bar?.firstElementChild as HTMLElement | null)?.style.width).toBe('33%')
  })

  it('shows the source highlighted as Python', () => {
    render({ sources: { ledger_fetch: { source: 'def run(x: int) -> str:\n    # doc\n    return "a"\n' } } })
    act(() => button('View source')?.click())
    const pre = container.querySelector('pre')
    expect(pre?.textContent).toContain('def run(x: int)')
    const coloured = [...(pre?.querySelectorAll('span[style]') ?? [])].map((span) => span.textContent)
    expect(coloured).toContain('def')
    expect(coloured).toContain('return')
    expect(coloured).toContain('"a"')
  })
})

describe('packages a waiting tool needs', () => {
  it('says which are missing and installs them from the row', () => {
    const installed: string[][] = []
    act(() => {
      root.render(
        <PendingToolApprovals
          tools={TOOLS}
          sources={{}}
          onRequestSource={() => {}}
          onApprove={() => {}}
          onDecline={() => {}}
          missingPackages={{ ledger_fetch: ['pandas', 'PyYAML'] }}
          canInstallPackages
          onInstall={(packages) => installed.push(packages)}
        />,
      )
    })
    expect(container.textContent).toContain('Needs pandas, PyYAML')
    act(() => button('Install')?.click())
    expect(installed).toEqual([['pandas', 'PyYAML']])
  })

  it('says to install them by hand where Light Code does not own the environment', () => {
    act(() => {
      root.render(
        <PendingToolApprovals
          tools={TOOLS}
          sources={{}}
          onRequestSource={() => {}}
          onApprove={() => {}}
          onDecline={() => {}}
          missingPackages={{ ledger_fetch: ['pandas'] }}
          canInstallPackages={false}
          onInstall={() => {}}
        />,
      )
    })
    expect(button('Install')).toBeUndefined()
    expect(container.textContent).toContain('Install them into that environment')
  })
})
