// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

const base: ExpertSpendProps = { usd: 0, consultations: 0, unpriced: 0 }

function render(props: Partial<ExpertSpendProps>): void {
  act(() => root.render(<ExpertSpend {...base} {...props} />))
}

describe('ExpertSpend', () => {
  it('stays out of the way until the expert has actually been used', () => {
    render({})
    expect(container.textContent).toBe('')
  })

  it('reports the spend for this chat', () => {
    render({ consultations: 2, usd: 0.1987 })
    expect(container.textContent).toContain('$0.1987')
    expect(container.textContent).toContain('2 consultations')
  })

  it('says when the budget has been reached', () => {
    render({ consultations: 5, usd: 1.2, usage: 1, exhausted: true })
    expect(container.textContent).toContain('budget reached')
  })

  /** An unpriced consultation still cost money, so the total must not read as exact. */
  it('marks the total as a floor when some consultations had no price', () => {
    render({ consultations: 3, unpriced: 1, usd: 0.05 })
    expect(container.textContent).toContain('*')
  })

  it('points at the header when the budget is spent, since the control lives there', () => {
    render({ consultations: 5, usd: 1.2, usage: 1, exhausted: true })
    expect(container.querySelector('[title]')?.getAttribute('title')).toMatch(/raise it from the header/i)
  })
})
