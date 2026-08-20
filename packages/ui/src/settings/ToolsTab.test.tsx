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

function render(props: { tools?: ToolCatalogueEntry[]; dispatcher?: boolean } = {}): void {
  act(() => root.render(<ToolsTab tools={props.tools ?? tools} dispatcher={props.dispatcher ?? false} />))
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
