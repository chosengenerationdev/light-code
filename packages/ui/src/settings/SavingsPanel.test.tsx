// @vitest-environment jsdom
import type { ExpertSavings, SavingsWindow } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SavingsPanel } from './SavingsPanel.js'

/**
 * This panel is about money, so the thing worth testing is what it refuses to say. An
 * unmeasured saving must not render as zero, and a figure must never appear without the word
 * that makes it honest.
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

const window_ = (overrides: Partial<SavingsWindow> = {}): SavingsWindow => ({
  spentUsd: 0,
  unpriced: 0,
  consultations: 0,
  overheadCalls: 0,
  juniorTurns: 0,
  avoidedUsd: 0,
  ...overrides,
})

const render = (savings: ExpertSavings | undefined): void => {
  act(() => {
    root.render(<SavingsPanel savings={savings} />)
  })
}

const click = (label: string): void => {
  const button = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(label),
  )
  if (button === undefined) throw new Error(`no button matching ${label}`)
  act(() => (button as HTMLButtonElement).click())
}

describe('the Junior mode savings panel', () => {
  /**
   * Reported as "when I did F5, I don't see the metrics". The first version hid itself until
   * there was something to show, which is indistinguishable from the feature not existing.
   */
  it('is visible with nothing recorded, and says what will fill it', () => {
    render({ today: window_(), last30Days: window_(), allTime: window_(), measured: true })
    expect(container.textContent).toContain('Junior mode')
    expect(container.textContent).toContain('Nothing recorded yet')
    expect(container.textContent).toContain('the count begins now')
  })

  it('shows all three windows once there is something to show', () => {
    render({
      today: window_({ juniorTurns: 3, avoidedUsd: 0.03 }),
      last30Days: window_({ juniorTurns: 40, avoidedUsd: 0.4 }),
      allTime: window_({ juniorTurns: 120, avoidedUsd: 1.25 }),
      measured: true,
    })

    expect(container.textContent).toContain('Today')
    expect(container.textContent).toContain('Last 30 days')
    expect(container.textContent).toContain('All time')
    expect(container.textContent).toContain('$1.25')
  })

  /** Every figure is a floor. Presenting one as an exact saving would be the dishonest version. */
  it('never states a saving without saying it is a lower bound', () => {
    render({
      today: window_({ juniorTurns: 3, avoidedUsd: 0.03 }),
      last30Days: window_({ juniorTurns: 3, avoidedUsd: 0.03 }),
      allTime: window_({ juniorTurns: 3, avoidedUsd: 0.03 }),
      measured: true,
    })
    expect(container.textContent).toContain('≥')
    expect(container.textContent).toContain('at least')
  })

  /**
   * With no measurement the honest answer is "unknown". Zero would read as "this saved you
   * nothing" — a claim, and the wrong one.
   */
  it('shows a dash rather than zero when the price here was never measured', () => {
    render({
      today: window_({ juniorTurns: 5, avoidedUsd: undefined }),
      last30Days: window_({ juniorTurns: 5, avoidedUsd: undefined }),
      allTime: window_({ juniorTurns: 5, avoidedUsd: undefined }),
      measured: false,
    })

    expect(container.textContent).toContain('—')
    expect(container.textContent).toContain('not yet priced')
    expect(container.textContent).not.toContain('$0 avoided')
    // The turns were still counted, so the reader knows what measuring would buy them.
    expect(container.textContent).toContain('5 junior turns')
  })

  it('keeps unpriced consultations out of the spend rather than counting them as free', () => {
    const w = window_({ consultations: 4, unpriced: 2, spentUsd: 0.5, juniorTurns: 1, avoidedUsd: 0.01 })
    render({ today: w, last30Days: w, allTime: w, measured: true })
    expect(container.textContent).toContain('2 unpriced')
  })

  it('explains the derivation on request, including what it refuses to count', () => {
    const w = window_({ juniorTurns: 10, avoidedUsd: 0.1 })
    render({ today: w, last30Days: w, allTime: w, measured: true })

    expect(container.textContent).not.toContain('deliberately not counted')
    click('How is this worked out?')
    expect(container.textContent).toContain('Turns the expert never saw')
    expect(container.textContent).toContain('Cold starts avoided')
    expect(container.textContent).toContain('deliberately not counted')
  })

  it('keeps sub-cent totals legible instead of rounding them to nothing', () => {
    const w = window_({ juniorTurns: 2, avoidedUsd: 0.0142 })
    render({ today: w, last30Days: w, allTime: w, measured: true })
    expect(container.textContent).toContain('0.0142')
  })
})
