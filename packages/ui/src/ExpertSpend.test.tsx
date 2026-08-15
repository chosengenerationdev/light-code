// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExpertSpend, type ExpertSpendProps } from './ExpertSpend.js'

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

const base: ExpertSpendProps = {
  usd: 0,
  consultations: 0,
  unpriced: 0,
  maxSpendUsd: 0,
  maxConsultations: 0,
  overridden: false,
  enabled: true,
  onSetLimits: () => {},
}

function render(props: Partial<ExpertSpendProps>): void {
  act(() => root.render(<ExpertSpend {...base} {...props} />))
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((element) =>
    (element.textContent ?? '').includes(label),
  )
  if (found === undefined) throw new Error(`no button matching "${label}" — saw: ${container.textContent ?? ''}`)
  return found
}

function click(element: HTMLElement): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('ExpertSpend', () => {
  it('stays hidden for someone who never turned the expert on', () => {
    render({ enabled: false })
    expect(container.textContent).toBe('')
  })

  /**
   * A budget is most useful *before* the first consultation. Requiring money to have been spent
   * before the control appears would mean it could only ever be set too late.
   */
  it('appears as soon as the expert is enabled, before anything is spent', () => {
    render({ enabled: true })
    expect(container.textContent).toContain('Expert:')
    expect(container.textContent).toContain('no limit')
  })

  it('still shows for a chat that spent money before the expert was switched off', () => {
    render({ enabled: false, consultations: 2, usd: 0.2 })
    expect(container.textContent).toContain('2 consultations')
  })

  it('applies a per-chat limit', () => {
    const onSetLimits = vi.fn()
    render({ maxSpendUsd: 1, maxConsultations: 5, onSetLimits })

    click(button('$1.00 / 5 calls'))
    const [spend, calls] = [...container.querySelectorAll('input')]
    act(() => {
      // React tracks the previous value on the node, so setting `.value` directly is ignored
      // unless the native setter is used.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(spend, '2.5')
      spend?.dispatchEvent(new Event('input', { bubbles: true }))
      setter?.call(calls, '9')
      calls?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(button('Apply to this chat'))

    expect(onSetLimits).toHaveBeenCalledWith({ maxSpendUsd: 2.5, maxConsultations: 9 })
  })

  /** An empty object is what clears the override — it must not be confused with "zero". */
  it('clears the override back to the configured default', () => {
    const onSetLimits = vi.fn()
    render({ maxSpendUsd: 3, overridden: true, onSetLimits })

    click(button('$3.00'))
    click(button('Use the default'))

    expect(onSetLimits).toHaveBeenCalledWith({})
  })

  it('offers no way to clear an override that is not there', () => {
    render({ maxSpendUsd: 3, overridden: false })
    click(button('$3.00'))
    expect(container.textContent).not.toContain('Use the default')
  })

  it('says when the budget has been reached', () => {
    render({ consultations: 5, usd: 1.2, maxSpendUsd: 1, usage: 1, exhausted: true })
    expect(container.textContent).toContain('budget reached')
  })

  /**
   * The moment someone wants more budget is the moment they have just been cut off. Making
   * them recognise a small grey figure as a button is the wrong thing to ask for then.
   */
  it('offers to raise the budget once it is spent, rather than only showing the number', () => {
    const onSetLimits = vi.fn()
    render({ consultations: 5, usd: 1.2, maxSpendUsd: 1, usage: 1, exhausted: true, onSetLimits })

    click(button('Raise budget'))
    click(button('Apply to this chat'))

    // Applies to the chat in progress; no new chat needed.
    expect(onSetLimits).toHaveBeenCalled()
  })

  it('marks the total as a floor when some consultations had no price', () => {
    render({ consultations: 3, unpriced: 1, usd: 0.05 })
    expect(container.textContent).toContain('*')
  })

  it('follows the host when a new chat resets the limits', () => {
    render({ maxSpendUsd: 5, maxConsultations: 10, overridden: true })
    click(button('$5.00 / 10 calls'))
    // Reset arrives from the host; the open editor must not keep showing the old numbers.
    render({ maxSpendUsd: 0, maxConsultations: 0, overridden: false })

    const [spend] = [...container.querySelectorAll('input')]
    expect(spend?.value).toBe('0')
  })
})
