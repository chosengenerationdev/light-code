// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Select, type SelectOption } from './Select.js'

/**
 * The first render test in this repository.
 *
 * It exists because of a bug reported from real use: a long dropdown closed the instant you
 * tried to scroll it. That shipped because nothing here could render a component — the test
 * glob did not even match `.tsx` — so every UI change was reasoned about and never executed.
 *
 * Rendered with `react-dom/client` and React's own `act` rather than a testing library. One
 * new dev dependency (jsdom) buys the whole capability, and the interactions worth pinning
 * here are events on real DOM nodes, which is exactly what a library would be wrapping.
 */

let container: HTMLDivElement
let root: Root

/*
 * jsdom implements no layout, so `scrollIntoView` simply does not exist on its elements.
 * Stubbed here rather than guarded in `Select.tsx`: every real browser has it, and adding a
 * production branch to satisfy a test environment's missing API teaches the next reader that
 * the call is unsafe when it is not.
 */
beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {}
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const OPTIONS: SelectOption[] = Array.from({ length: 30 }, (_, index) => ({
  value: `v${String(index)}`,
  label: `Option ${String(index)}`,
}))

function render(props: Partial<Parameters<typeof Select>[0]> = {}): void {
  act(() => {
    root.render(<Select value="v0" options={OPTIONS} onChange={() => {}} ariaLabel="Test" {...props} />)
  })
}

const trigger = (): HTMLButtonElement => {
  const button = container.querySelector('button')
  if (button === null) throw new Error('no trigger button rendered')
  return button
}

/** The popup is portalled to the end of the document, not inside `container`. */
const listbox = (): HTMLElement | null => document.querySelector('[role="listbox"]')

const click = (element: Element): void => {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

const key = (element: Element, k: string): void => {
  act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
}

describe('Select', () => {
  it('shows the selected option and opens on click', () => {
    render()
    expect(trigger().textContent).toContain('Option 0')
    expect(listbox()).toBeNull()

    click(trigger())
    expect(listbox()).not.toBeNull()
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(30)
  })

  /**
   * **The reported bug.** The popup closes on scroll so a `fixed` element cannot drift away
   * from its button when an ancestor scrolls — but the popup is itself scrollable once the
   * list is long, and in capture phase its own scrolling reached that handler. It shut the
   * moment you tried to scroll it, which is precisely when a dropdown needs to stay open.
   */
  it('stays open when the list itself is scrolled', () => {
    render()
    click(trigger())
    const list = listbox()
    expect(list).not.toBeNull()

    act(() => list?.dispatchEvent(new Event('scroll', { bubbles: true })))

    expect(listbox()).not.toBeNull()
  })

  /** The other half: an ancestor scrolling *does* close it, or it would float loose. */
  it('closes when something outside it scrolls', () => {
    render()
    click(trigger())
    expect(listbox()).not.toBeNull()

    act(() => document.dispatchEvent(new Event('scroll', { bubbles: true })))

    expect(listbox()).toBeNull()
  })

  it('closes on a click elsewhere', () => {
    render()
    click(trigger())
    act(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(listbox()).toBeNull()
  })

  it('closes on Escape without choosing anything', () => {
    let chosen: string | undefined
    render({ onChange: (value) => (chosen = value) })
    click(trigger())
    key(trigger(), 'Escape')

    expect(listbox()).toBeNull()
    expect(chosen).toBeUndefined()
  })

  it('reports the chosen value and closes', () => {
    let chosen: string | undefined
    render({ onChange: (value) => (chosen = value) })
    click(trigger())

    const option = document.querySelectorAll('[role="option"]')[3]
    act(() => option?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))

    expect(chosen).toBe('v3')
    expect(listbox()).toBeNull()
  })

  it('opens with the keyboard and moves with the arrows', () => {
    let chosen: string | undefined
    render({ onChange: (value) => (chosen = value) })

    key(trigger(), 'ArrowDown')
    expect(listbox()).not.toBeNull()

    key(trigger(), 'ArrowDown')
    key(trigger(), 'Enter')
    expect(chosen).toBe('v1')
  })

  /** Landing on a disabled row and having Enter do nothing is a dead end for a keyboard user. */
  it('skips a disabled option when arrowing', () => {
    let chosen: string | undefined
    render({
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B', disabled: true },
        { value: 'c', label: 'C' },
      ],
      value: 'a',
      onChange: (value) => (chosen = value),
    })

    key(trigger(), 'ArrowDown')
    key(trigger(), 'ArrowDown')
    key(trigger(), 'Enter')

    expect(chosen).toBe('c')
  })

  it('does not open at all when disabled', () => {
    render({ disabled: true })
    click(trigger())
    key(trigger(), 'ArrowDown')
    expect(listbox()).toBeNull()
  })

  it('falls back to the placeholder when nothing matches the value', () => {
    render({ value: 'gone', placeholder: 'Choose something' })
    expect(trigger().textContent).toContain('Choose something')
  })

  it('marks the trigger as a combobox and tracks its expanded state', () => {
    render()
    expect(trigger().getAttribute('role')).toBe('combobox')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')

    click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })
})
