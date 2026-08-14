// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DismissableProblems } from './DismissableProblems.js'

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

function render(problems: string[]): void {
  act(() => root.render(<DismissableProblems title="Not loaded" problems={problems} />))
}

function dismiss(): void {
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent === 'Dismiss')
  if (button === undefined) throw new Error('no Dismiss button rendered')
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('DismissableProblems', () => {
  it('renders nothing when there is nothing wrong', () => {
    render([])
    expect(container.textContent).toBe('')
  })

  it('hides the list when dismissed', () => {
    render(['a.py — bad hash'])
    expect(container.textContent).toContain('bad hash')

    dismiss()
    expect(container.textContent).toBe('')
  })

  it('stays hidden while the same problems persist', () => {
    render(['a.py — bad hash'])
    dismiss()
    // A re-render from a routine status refresh must not resurrect what was just put away.
    render(['a.py — bad hash'])

    expect(container.textContent).toBe('')
  })

  it('comes back when a new problem appears', () => {
    render(['a.py — bad hash'])
    dismiss()
    render(['a.py — bad hash', 'b.py — syntax error'])

    // The property that matters: dismissing one failure must never silence the next one. A
    // refused tool nobody is told about is the outcome this list exists to prevent.
    expect(container.textContent).toContain('syntax error')
  })

  it('comes back when a problem is fixed and then recurs', () => {
    render(['a.py — bad hash'])
    dismiss()
    render([])
    render(['a.py — bad hash'])

    expect(container.textContent).toContain('bad hash')
  })
})
