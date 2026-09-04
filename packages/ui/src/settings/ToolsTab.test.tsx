// @vitest-environment jsdom
import type { ToolCatalogueEntry } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ToolsTab } from './ToolsTab.js'

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

const tools: ToolCatalogueEntry[] = [
  { name: 'read_file', description: 'Read a file with line numbers', group: 'read', source: 'built-in', advertised: true },
  { name: 'write_to_file', description: 'Write full file content', group: 'edit', source: 'built-in', advertised: true },
  {
    name: 'filesystem__list_directory',
    description: 'List the contents of a folder',
    group: 'mcp',
    source: 'mcp',
    server: 'filesystem',
    advertised: false,
  },
  {
    name: 'py__parse_report',
    description: 'Parse a spreadsheet report into rows',
    group: 'edit',
    source: 'python',
    advertised: false,
  },
]

function render(
  props: {
    tools?: ToolCatalogueEntry[]
    dispatcher?: boolean
    office?: { supported: boolean; excel: boolean; outlook: boolean }
    onSetOffice?: (excel: boolean, outlook: boolean) => void
    toolTimeoutSeconds?: number
    onSetToolTimeout?: (seconds?: number) => void
    onSetToolTimeoutFor?: (name: string, seconds?: number) => void
  } = {},
): void {
  act(() =>
    root.render(
      <ToolsTab
        tools={props.tools ?? tools}
        dispatcher={props.dispatcher ?? false}
        office={props.office ?? { supported: true, excel: false, outlook: false }}
        onSetOffice={props.onSetOffice ?? (() => undefined)}
        {...(props.toolTimeoutSeconds === undefined ? {} : { toolTimeoutSeconds: props.toolTimeoutSeconds })}
        onSetToolTimeout={props.onSetToolTimeout ?? (() => undefined)}
        onSetToolTimeoutFor={props.onSetToolTimeoutFor ?? (() => undefined)}
      />,
    ),
  )
}

function search(value: string): void {
  const input = container.querySelector<HTMLInputElement>('#lc-tools-search')
  if (input === null) throw new Error('no search field')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ToolsTab', () => {
  it('lists every tool, grouped by where it came from', () => {
    render()
    expect(container.textContent).toContain('Built in')
    expect(container.textContent).toContain('MCP servers')
    expect(container.textContent).toContain('Python tools')
    expect(container.textContent).toContain('read_file')
    expect(container.textContent).toContain('py__parse_report')
  })

  it('names the server an MCP tool belongs to', () => {
    render()
    expect(container.textContent).toContain('filesystem')
  })

  /** Someone looking for a capability knows what they want done, not what it is called. */
  it('searches descriptions as well as names', () => {
    render()
    search('spreadsheet')
    expect(container.textContent).toContain('py__parse_report')
    expect(container.textContent).not.toContain('read_file')
  })

  it('says so when nothing matches, rather than showing an empty list', () => {
    render()
    search('nothing-like-this-exists')
    expect(container.textContent).toContain('Nothing matches')
  })

  /**
   * The misreading the dispatcher invites: that a shorter prompt means a shorter tool list.
   * A hidden tool is still callable, and the view has to say so or it teaches the opposite.
   */
  it('explains that hidden tools are still callable', () => {
    render({ dispatcher: true })
    expect(container.textContent).toContain('still')
    expect(container.textContent).toContain('callable')
    expect(container.textContent).toContain('2 of these are kept out of the system prompt')
  })

  it('marks which ones are looked up rather than advertised', () => {
    render({ dispatcher: true })
    expect(container.textContent).toContain('looked up')
  })

  it('says nothing about the prompt when the dispatcher is off', () => {
    render({ dispatcher: false })
    expect(container.textContent).not.toContain('kept out of the system prompt')
  })

  it('counts what is shown against what exists', () => {
    render()
    expect(container.textContent).toContain('4 of 4 tools')
    // A distinctive term: substring matching is deliberately loose, and "read" also appears
    // inside "spreadsheet" — which is the behaviour wanted from a search box, not a bug.
    search('write_to_file')
    expect(container.textContent).toContain('1 of 4 tools')
  })

  it('explains an empty catalogue rather than looking broken', () => {
    render({ tools: [] })
    expect(container.textContent).toContain('Nothing yet')
  })
})

/**
 * Switching these on lets the assistant read open workbooks and local mail. The copy is the
 * only thing standing between a click and that grant, so what it says is worth pinning.
 */
describe('the Excel and Outlook toggles', () => {
  it('are off, and say what turning them on allows', () => {
    render()
    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes.length).toBeGreaterThanOrEqual(2)
    expect(boxes.every((box) => !box.checked)).toBe(true)
    expect(container.textContent).toContain('any workbook you have open')
    expect(container.textContent).toContain('Read-only')
  })

  it('report each change without losing the other', () => {
    const calls: [boolean, boolean][] = []
    render({ office: { supported: true, excel: false, outlook: true }, onSetOffice: (e, o) => calls.push([e, o]) })

    const excel = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    act(() => excel?.click())
    expect(calls).toEqual([[true, true]])
  })

  /** Hiding them off Windows would leave someone wondering where the feature went. */
  it('are disabled with a reason rather than hidden where COM does not exist', () => {
    render({ office: { supported: false, excel: false, outlook: false } })
    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes.every((box) => box.disabled)).toBe(true)
    expect(container.textContent).toContain('Windows only')
  })
})

/**
 * One limit for every kind of tool, as a fallback.
 *
 * Each kind had its own timeout and there was nowhere to say "everything on this machine is
 * slow" — a property of the environment, not of any one tool. It is deliberately a fallback:
 * a tool that genuinely needs ten minutes says so on its own row, because raising the floor for
 * everything means a hung call anywhere waits ten minutes before anyone hears about it.
 */
describe('the global tool timeout', () => {
  const field = (): HTMLInputElement => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Tool timeout in seconds"]')
    if (input === null) throw new Error('no timeout field')
    return input
  }

  const type = (value: string): void => {
    const input = field()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      // React delegates onBlur from focusout: a plain blur event does not bubble and is missed.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
  }

  it('says each tool decides when nothing is set', () => {
    render()
    expect(field().value).toBe('')
    expect(container.textContent).toContain('each tool decides')
  })

  it('reports a value the user commits', () => {
    const calls: (number | undefined)[] = []
    render({ onSetToolTimeout: (s) => calls.push(s) })
    type('300')
    expect(calls).toEqual([300])
  })

  it('clears back to each tool’s own default when emptied', () => {
    const calls: (number | undefined)[] = []
    render({ toolTimeoutSeconds: 300, onSetToolTimeout: (s) => calls.push(s) })
    type('')
    expect(calls).toEqual([undefined])
  })

  /** A typo should not quietly become a limit nobody chose. */
  it('refuses a value out of range and puts the old one back', () => {
    const calls: (number | undefined)[] = []
    render({ toolTimeoutSeconds: 120, onSetToolTimeout: (s) => calls.push(s) })
    type('99999')
    expect(calls).toEqual([])
    expect(field().value).toBe('120')
  })

  it('says plainly that it applies to everything', () => {
    render()
    expect(container.textContent).toContain('MCP servers, Python tools and the Excel and Outlook tools')
  })
})
