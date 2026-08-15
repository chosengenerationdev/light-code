// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExpertBudget, type ExpertBudgetProps } from './ExpertBudget.js'

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

const base: ExpertBudgetProps = {
  maxSpendUsd: 0,
  maxConsultations: 0,
  overridden: false,
  usd: 0,
  consultations: 0,
  enabled: true,
  modeId: 'junior',
  onSetLimits: () => {},
}

function render(props: Partial<ExpertBudgetProps>): void {
  act(() => root.render(<ExpertBudget {...base} {...props} />))
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

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    // React tracks the previous value on the node, so assigning `.value` directly is ignored
    // unless the native setter is used.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ExpertBudget', () => {
  it('is absent for someone who never turned the expert on', () => {
    render({ enabled: false })
    expect(container.textContent).toBe('')
  })

  /**
   * Junior mode is the one built around consulting the expert. Elsewhere the button would be
   * a permanent reminder of a feature the user is not using.
   */
  it('stays out of the header in other modes', () => {
    render({ modeId: 'code' })
    expect(container.textContent).toBe('')
  })

  /**
   * `ask_expert` is in the read group, so Code mode can consult and can spend. Hiding the
   * control outright would strand such a session with no way to adjust the ceiling it is
   * about to hit.
   */
  it('appears in other modes once the expert has actually been consulted', () => {
    render({ modeId: 'code', consultations: 2, usd: 0.2, maxSpendUsd: 1 })
    expect(container.textContent).toContain('$1.00')
  })

  /**
   * Visible from the start, before anything is spent. A budget that could only be set after
   * money had gone could only ever be set too late.
   */
  it('shows in the header as soon as the expert is enabled', () => {
    render({})
    expect(container.textContent).toContain('Budget')
  })

  it('shows the ceiling once one is set', () => {
    render({ maxSpendUsd: 2, maxConsultations: 8 })
    expect(container.textContent).toContain('$2.00 / 8×')
  })

  it('applies a limit to this chat', () => {
    const onSetLimits = vi.fn()
    render({ maxSpendUsd: 1, maxConsultations: 5, onSetLimits })

    click(button('$1.00 / 5×'))
    const [spend, calls] = [...container.querySelectorAll('input')] as HTMLInputElement[]
    type(spend as HTMLInputElement, '2.5')
    type(calls as HTMLInputElement, '9')
    click(button('Apply'))

    expect(onSetLimits).toHaveBeenCalledWith({ maxSpendUsd: 2.5, maxConsultations: 9 })
  })

  /** An empty object clears the override — it must never be confused with a limit of zero. */
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

  /**
   * The moment someone wants more budget is the moment they have just been cut off. Making
   * them recognise a figure as a button is the wrong thing to ask for then.
   */
  it('reads "Raise budget" once the budget is spent', () => {
    const onSetLimits = vi.fn()
    render({ maxSpendUsd: 1, usd: 1.2, consultations: 5, usage: 1, exhausted: true, onSetLimits })

    click(button('Raise budget'))
    click(button('Apply'))
    expect(onSetLimits).toHaveBeenCalled()
  })

  it('closes on Escape without applying anything', () => {
    const onSetLimits = vi.fn()
    render({ maxSpendUsd: 1, onSetLimits })

    click(button('$1.00'))
    expect(container.textContent).toContain('Stop after')
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))

    expect(container.textContent).not.toContain('Stop after')
    expect(onSetLimits).not.toHaveBeenCalled()
  })

  it('follows the host when a new chat resets the limits', () => {
    render({ maxSpendUsd: 5, maxConsultations: 10, overridden: true })
    click(button('$5.00 / 10×'))
    // The reset arrives from the host; an open popover must not keep showing the old numbers.
    render({ maxSpendUsd: 0, maxConsultations: 0, overridden: false })

    const [spend] = [...container.querySelectorAll('input')] as HTMLInputElement[]
    expect(spend?.value).toBe('0')
  })

  it('shows what has been spent, so the ceiling has context', () => {
    render({ maxSpendUsd: 2, usd: 0.42, consultations: 3 })
    click(button('$2.00'))
    expect(container.textContent).toContain('$0.4200')
    expect(container.textContent).toContain('3 consultations')
  })
})
