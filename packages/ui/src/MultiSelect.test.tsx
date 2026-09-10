// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { MultiSelect, type MultiSelectOption } from './MultiSelect.js'

/**
 * Picking several tools from a list that can be very long.
 *
 * The user asked the question this component answers: *"will it come with a search box to
 * select as well? else it will be difficult when there are many tools"*. With a few MCP servers
 * attached the list runs well past forty.
 *
 * The property worth pinning is not the filter itself but that filtering never changes the
 * *selection*. A tick that vanished because you typed would be a permission silently withdrawn,
 * and on a scheduled job you would find out when it failed overnight.
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

function options(count: number): MultiSelectOption[] {
  return Array.from({ length: count }, (_, index) => ({
    value: `tool_${String(index)}`,
    label: index === 0 ? 'read_file' : `tool_${String(index)}`,
  }))
}

function render(props: {
  options: MultiSelectOption[]
  selected: string[]
  onChange?: (next: string[]) => void
}): void {
  act(() =>
    root.render(
      <MultiSelect
        options={props.options}
        selected={props.selected}
        onChange={props.onChange ?? (() => undefined)}
        ariaLabel="Tools"
      />,
    ),
  )
}

function filterBox(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[type="text"]')
}

function checkboxes(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
}

/**
 * Types into the filter the way a person does.
 *
 * Assigning `.value` directly does nothing useful: React installs its own setter on the input
 * prototype and tracks the last value it wrote, so a direct assignment is seen as "no change"
 * and the handler never runs. The native setter has to be called explicitly — without this the
 * filter tests pass while filtering nothing at all, which is exactly how they were written the
 * first time.
 */
function type(value: string): void {
  const box = filterBox()
  if (box === null) throw new Error('no filter box rendered')
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    nativeSetter?.call(box, value)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the filter box', () => {
  it('appears once the list is long enough to be awkward', () => {
    render({ options: options(40), selected: [] })
    expect(filterBox()).not.toBeNull()
  })

  /** A search box over six checkboxes is furniture. */
  it('stays away for a short list', () => {
    render({ options: options(4), selected: [] })
    expect(filterBox()).toBeNull()
  })

  it('narrows the list to what matches', () => {
    render({ options: options(40), selected: [] })
    expect(checkboxes()).toHaveLength(40)

    type('read_file')

    expect(checkboxes()).toHaveLength(1)
  })

  it('says so when nothing matches, rather than showing an empty box', () => {
    render({ options: options(40), selected: [] })
    type('zzzznothing')

    expect(checkboxes()).toHaveLength(0)
    expect(container.textContent).toContain('Nothing matches')
  })
})

describe('what filtering must never do', () => {
  /**
   * The one that matters. Typing hides rows; it does not untick them.
   */
  it('keeps a selection that the filter has hidden', () => {
    let latest: string[] | undefined
    render({
      options: options(40),
      selected: ['tool_5'],
      onChange: (next) => {
        latest = next
      },
    })

    type('read_file')
    // Tick the one visible row.
    act(() => checkboxes()[0]?.click())

    expect(latest).toEqual(['tool_0', 'tool_5'])
  })

  /**
   * "All" with a filter active means all *shown*. Acting on the hidden ones would be the same
   * surprise wearing a different hat, so the label changes to say which set is meant.
   */
  it('applies bulk actions to the visible rows only, and says so', () => {
    let latest: string[] | undefined
    render({
      options: options(40),
      selected: ['tool_9'],
      onChange: (next) => {
        latest = next
      },
    })

    type('read_file')
    const all = [...container.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes('shown'),
    )
    expect(all?.textContent).toContain('All 1 shown')
    act(() => all?.click())

    expect(latest).toEqual(['tool_0', 'tool_9'])
  })
})

describe('the answer it produces', () => {
  /** Ordered as offered, so the value does not depend on the order things were clicked. */
  it('returns selections in the order the options were given', () => {
    let latest: string[] | undefined
    render({
      options: options(10),
      selected: ['tool_7'],
      onChange: (next) => {
        latest = next
      },
    })

    act(() => checkboxes()[2]?.click())

    expect(latest).toEqual(['tool_2', 'tool_7'])
  })

  it('reports how many are selected', () => {
    render({ options: options(10), selected: ['tool_1', 'tool_2'] })
    expect(container.textContent).toContain('2 selected')
  })

  it('says none rather than showing a zero', () => {
    render({ options: options(10), selected: [] })
    expect(container.textContent).toContain('None selected')
  })
})
