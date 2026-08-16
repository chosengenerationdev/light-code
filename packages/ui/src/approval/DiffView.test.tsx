// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DiffView } from './DiffView.js'

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

/** The gutter column only — a `+` inside the code is not a diff marker. */
function markers(): string[] {
  return [...container.querySelectorAll('[data-diff-marker]')].map((element) => (element.textContent ?? '').trim())
}

function render(path: string, before: string, after: string): void {
  act(() => root.render(<DiffView path={path} before={before} after={after} />))
}

const NEW_TOOL = 'def run(a: int, b: int) -> int:\n    """Add two numbers."""\n    return a + b\n'

describe('DiffView', () => {
  /**
   * A file that does not exist yet is shown as a file, not as a diff against nothing.
   *
   * Every line marked `+` on a green field is technically accurate and reads as though
   * something were being *changed*. For a tool being created there is nothing to contrast
   * with, so the marker column and the wash of colour are noise.
   */
  it('shows a new file as plain source, with no + markers', () => {
    render('add.py', '', NEW_TOOL)

    expect(container.textContent).toContain('def run(a: int, b: int) -> int:')
    expect(container.textContent).toContain('(new file)')
    // The gutter marker specifically — `a + b` in the code is not one, which is exactly
    // the trap a naive "contains a plus" assertion falls into.
    expect(markers()).toEqual([])
  })

  it('numbers a new file from one, with no phantom trailing line', () => {
    render('add.py', '', NEW_TOOL)
    // Three lines of content; the trailing newline must not become a fourth.
    const numbers = [...container.querySelectorAll('span')]
      .map((element) => element.textContent ?? '')
      .filter((text) => /^\d+$/.test(text))
    expect(numbers).toEqual(['1', '2', '3'])
  })

  it('still shows a real edit as a diff', () => {
    render('a.py', 'x = 1\n', 'x = 2\n')
    expect(markers()).toContain('+')
    expect(markers()).toContain('-')
  })

  /** Removing a file *is* a change, so it keeps its markers. */
  it('shows a deletion as a removal', () => {
    render('a.py', 'x = 1\n', '')
    expect(markers()).toContain('-')
    expect(container.textContent).not.toContain('(new file)')
  })

  it('shows the path either way', () => {
    render('tools/add.py', '', NEW_TOOL)
    expect(container.textContent).toContain('tools/add.py')
  })

  /** Ground truth (invariant 8): what is rendered is exactly what would be written. */
  it('renders every line of the content', () => {
    render('add.py', '', NEW_TOOL)
    for (const line of NEW_TOOL.trimEnd().split('\n')) {
      expect(container.textContent).toContain(line.trim())
    }
  })
})
