// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ExpertTab, type ExpertState } from './ExpertTab.js'

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

function render(state: ExpertState | undefined): void {
  act(() =>
    root.render(
      <ExpertTab
        expert={state}
        onSave={() => {}}
        onRecheck={() => {}}
        onMeasureCost={() => {}}
        onClearPricing={() => {}}
        onSetKeepAlive={() => {}}
      />,
    ),
  )
}

/**
 * A spend cap cannot bind on a plan that reports no cost — the running total stays at zero and the
 * limit is never reached. A cap that silently never fires is worse than no cap, because it is
 * believed. So the panel says which case you are in, once a consultation has settled it.
 */
describe('whether the spending limit can apply at all', () => {
  it('says nothing has settled it yet', () => {
    render({ enabled: true, available: true, path: 'claude', maxSpendUsd: 1, maxConsultations: 6 })
    expect(container.textContent).toContain('settled by the first consultation')
  })

  it('warns plainly when the plan reports no cost', () => {
    render({ enabled: true, available: true, path: 'claude', maxSpendUsd: 1, maxConsultations: 6, reportsCost: false })
    expect(container.textContent).toContain('does not report a cost per consultation')
    expect(container.textContent).toContain('consultation limit instead')
  })

  it('says nothing at all once cost is known to work', () => {
    render({ enabled: true, available: true, path: 'claude', maxSpendUsd: 1, maxConsultations: 6, reportsCost: true })
    expect(container.textContent).not.toContain('does not report a cost')
    expect(container.textContent).not.toContain('settled by the first consultation')
  })
})

/**
 * The bug this covers: the measured price was saved and the panel showed nothing. Two places
 * built the expert message and only one carried `pricing` — the same drift that had already
 * happened with the guide capability and the programming profile.
 */
describe('the measured price', () => {
  it('is shown once it exists, with when it was measured', () => {
    render({
      enabled: true,
      available: true,
      path: 'claude',
      maxSpendUsd: 1,
      maxConsultations: 6,
      keepAlive: false,
      reportsCost: true,
      pricing: { coldUsd: 0.187, resumedUsd: 0.0099, measuredAt: Date.UTC(2026, 7, 27), reportsCost: true },
    })
    expect(container.textContent).toContain('$0.19')
    expect(container.textContent).toContain('$0.0099')
    // The ratio is the number every cost rule depends on, so it is stated rather than left to arithmetic.
    expect(container.textContent).toContain('times cheaper')
    expect(container.textContent).toContain('Measured')
  })

  it('says what measuring will cost before it is clicked', () => {
    render({ enabled: true, available: true, path: 'claude', maxSpendUsd: 1, maxConsultations: 6, keepAlive: false })
    expect(container.textContent).toContain('two real consultations')
  })

  it('reports a plan that prices nothing as a result rather than an absence', () => {
    render({
      enabled: true,
      available: true,
      path: 'claude',
      maxSpendUsd: 1,
      maxConsultations: 6,
      keepAlive: false,
      pricing: { measuredAt: Date.UTC(2026, 7, 27), reportsCost: false },
    })
    expect(container.textContent).toContain('reports no cost per consultation')
  })
})

describe('the keep-alive toggle', () => {
  /** A timer that spends unattended has to say so where it is switched on. */
  it('says it spends while you are away, and that the cost is counted', () => {
    render({ enabled: true, available: true, path: 'claude', maxSpendUsd: 1, maxConsultations: 6, keepAlive: false })
    expect(container.textContent).toContain('spends while you are away')
    expect(container.textContent).toContain('counted in the meter')
  })

  /*
   * By its own label. The tab has another checkbox — the expert's enable switch — and asserting
   * over "the checkboxes" tested that one instead.
   */
  const keepAliveBox = (): HTMLInputElement | undefined => {
    const label = [...container.querySelectorAll('label')].find(
      (entry) => entry.textContent?.includes('Keep the session warm') === true,
    )
    return label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? undefined
  }

  it('is off unless the host says otherwise', () => {
    render({ enabled: true, available: true, path: 'claude', maxSpendUsd: 1, maxConsultations: 6, keepAlive: false })
    expect(keepAliveBox()?.checked).toBe(false)
  })

  it('is on when the host says it is', () => {
    render({ enabled: true, available: true, path: 'claude', maxSpendUsd: 1, maxConsultations: 6, keepAlive: true })
    expect(keepAliveBox()?.checked).toBe(true)
  })

  /** Nothing to keep warm without a working CLI, so the control does not pretend otherwise. */
  it('is disabled when the expert is unavailable', () => {
    render({ enabled: true, available: false, path: 'claude', maxSpendUsd: 0, maxConsultations: 0, keepAlive: false })
    expect(keepAliveBox()?.disabled).toBe(true)
  })
})
