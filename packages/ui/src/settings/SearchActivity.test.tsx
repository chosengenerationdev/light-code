// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SearchActivity, type SearchActivityProps } from './SearchActivity.js'

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

const base: SearchActivityProps = {
  entries: [],
  probe: undefined,
  probeRunning: false,
  onProbe: () => {},
  onClear: () => {},
  onClearProbe: () => {},
}

function render(props: Partial<SearchActivityProps>): void {
  act(() => root.render(<SearchActivity {...base} {...props} />))
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((element) =>
    (element.textContent ?? '').includes(label),
  )
  if (found === undefined) throw new Error(`no button "${label}" — saw: ${container.textContent ?? ''}`)
  return found
}

describe('SearchActivity', () => {
  it('offers nothing to dismiss before a query has been run', () => {
    render({})
    expect(container.textContent).not.toContain('Clear result')
  })

  it('shows the result and offers to dismiss it', () => {
    render({ probe: { query: 'where do we upload a report', text: 'a long answer' } })
    expect(container.textContent).toContain('a long answer')
    expect(button('Clear result')).toBeTruthy()
  })

  /**
   * Two different Clears, and they must not be confused: a result can be hundreds of lines and
   * stays until something replaces it, while the log below is a separate record of what was
   * asked. Dismissing the answer must not erase the history of asking it.
   */
  it('dismisses the result without touching the log', () => {
    const onClearProbe = vi.fn()
    const onClear = vi.fn()
    render({
      probe: { query: 'q', text: 'answer' },
      entries: [{ at: Date.now(), query: 'q', target: 'docs', semantic: true, hits: 2 }],
      onClearProbe,
      onClear,
    })

    act(() => button('Clear result').dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(onClearProbe).toHaveBeenCalledTimes(1)
    expect(onClear).not.toHaveBeenCalled()
  })

  it('names the query the result belongs to', () => {
    render({ probe: { query: 'upload a report', text: 'x' } })
    expect(container.textContent).toContain('upload a report')
  })

  it('still offers to dismiss a result that only failed', () => {
    render({ probe: { query: 'q', text: '', error: 'the cluster is unreachable' } })
    expect(container.textContent).toContain('unreachable')
    expect(button('Clear result')).toBeTruthy()
  })
})
