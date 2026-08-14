// @vitest-environment jsdom
import type { Schedule, ScheduleToolInfo } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SchedulesTab } from './SchedulesTab.js'

/**
 * The tool picker, which is the security surface of Phase 9b rather than a convenience.
 *
 * With a few MCP servers the list runs to dozens, so it has a filter — and a filter over a
 * permission list has a specific hazard: if searching hides what is already ticked, the
 * visible list disagrees with what the schedule may actually do. These pin that it cannot.
 */

let container: HTMLDivElement
let root: Root

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

const TOOLS: ScheduleToolInfo[] = [
  { name: 'read_file', description: 'Read a file with line numbers.', group: 'read' },
  { name: 'apply_diff', description: 'Edit a file.', group: 'edit' },
  { name: 'execute_command', description: 'Run a shell command.', group: 'command' },
  { name: 'confluence__create_page', description: 'Publish a page to the wiki.', group: 'mcp' },
  { name: 'attempt_completion', description: 'Finish.', group: 'always' },
]

function render(schedules: Schedule[] = [], saved: Schedule[] = []): void {
  act(() =>
    root.render(
      <SchedulesTab
        schedules={schedules}
        tools={TOOLS}
        onSave={(schedule) => saved.push(schedule)}
        onDelete={() => {}}
        onToggle={() => {}}
        onRunNow={() => {}}
      />,
    ),
  )
}

const click = (element: Element | null | undefined): void => {
  act(() => element?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function openEditor(): void {
  render()
  const newButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'New schedule')
  click(newButton)
}

const checkboxes = (): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
const toolNames = (): string[] =>
  [...container.querySelectorAll('label')].map((label) => label.textContent ?? '').filter((text) => text.length > 0)

function type(placeholder: string, value: string): void {
  const input = [...container.querySelectorAll('input')].find((i) => i.placeholder.startsWith(placeholder))
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the schedule tool picker', () => {
  /** A schedule runs unattended, so every capability must be an explicit decision. */
  it('starts with nothing ticked', () => {
    openEditor()
    expect(checkboxes().length).toBeGreaterThan(0)
    expect(checkboxes().every((box) => !box.checked)).toBe(true)
  })

  /** Control tools are always available, so offering them implies ticking changes something. */
  it('does not list the always-available tools', () => {
    openEditor()
    expect(toolNames().join(' ')).not.toContain('attempt_completion')
  })

  it('lists MCP and built-in tools together', () => {
    openEditor()
    const listed = toolNames().join(' ')
    expect(listed).toContain('read_file')
    expect(listed).toContain('confluence__create_page')
  })

  it('filters by name and by description', () => {
    openEditor()
    type('Filter by name', 'wiki')
    expect(toolNames().join(' ')).toContain('confluence__create_page')
    expect(toolNames().join(' ')).not.toContain('read_file')
  })

  /** "create page" should find confluence__create_page — nobody types the underscores. */
  it('treats underscores in a tool name as spaces', () => {
    openEditor()
    type('Filter by name', 'create page')
    expect(toolNames().join(' ')).toContain('confluence__create_page')
  })

  /**
   * The hazard specific to filtering a permission list. If a search hid a ticked tool, the
   * visible list would disagree with what the schedule may actually do — and the obvious
   * reading is that searching deselected it.
   */
  it('keeps a selected tool visible however the filter is set', () => {
    openEditor()
    const readFile = checkboxes()[0]
    act(() => readFile?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    type('Filter by name', 'zzz-nothing-matches')

    const listed = toolNames().join(' ')
    expect(listed).toContain('read_file')
    expect(checkboxes().some((box) => box.checked)).toBe(true)
  })

  /** Bulk select must act on what is shown, never on the whole hidden catalogue. */
  it('only offers to select the filtered set, and says how many', () => {
    openEditor()
    type('Filter by name', 'file')

    const bulk = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Select the'))
    expect(bulk?.textContent).toMatch(/Select the \d+ shown/)
  })

  it('offers no bulk select when nothing is being filtered', () => {
    openEditor()
    const bulk = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Select the'))
    expect(bulk).toBeUndefined()
  })

  it('says so when a filter matches nothing', () => {
    openEditor()
    type('Filter by name', 'zzz-nothing-matches')
    expect(container.textContent).toContain('No tool matches')
  })
})
