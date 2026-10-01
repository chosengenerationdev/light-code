// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { McpServerForm, type McpServerFormProps } from './McpServerForm.js'

/**
 * Reported: adding an MCP server "always shows the script that I previously added". The last
 * browsed file and the last detected interpreter live above the form and outlive it, and a new
 * form copied them in as it opened.
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

const base: McpServerFormProps = {
  initialName: '',
  initialConfig: undefined,
  existingNames: ['ledger'],
  platform: 'win32',
  saving: false,
  probe: undefined,
  onDetect: () => {},
  onBrowse: () => {},
  pickedPath: undefined,
  onSave: () => {},
  onCancel: () => {},
}

const render = (props: Partial<McpServerFormProps>): void => {
  act(() => root.render(<McpServerForm {...base} {...props} />))
}
const value = (id: string): string | undefined => container.querySelector<HTMLInputElement>(`#${id}`)?.value

describe('a new MCP server form', () => {
  it('opens empty, whatever was browsed or detected for the last one', () => {
    render({
      pickedPath: { purpose: 'mcp.script', path: 'C:\\old\\server.py' },
      probe: { interpreter: 'C:\\old\\.venv\\Scripts\\python.exe', venvDir: 'C:\\old\\.venv', detail: 'found' },
    })
    expect(value('lc-mcp-script')).toBe('')
    expect(value('lc-mcp-venvDir') ?? '').toBe('')
  })

  it('still takes a file browsed while it is open', () => {
    render({ pickedPath: { purpose: 'mcp.script', path: 'C:\\old\\server.py' } })
    render({ pickedPath: { purpose: 'mcp.script', path: 'C:\\new\\server.py' } })
    expect(value('lc-mcp-script')).toBe('C:\\new\\server.py')
  })
})

describe('cloning a server', () => {
  it("starts from the other server's settings under a new name, and saves as a new server", () => {
    const saved: [string, string | undefined][] = []
    render({
      cloneOf: 'ledger',
      suggestedName: 'ledger-copy',
      initialConfig: { command: 'C:\\srv\\.venv\\Scripts\\python.exe', args: ['C:\\srv\\server.py'] },
      onSave: (name, previous) => saved.push([name, previous]),
    })
    expect(container.textContent).toContain('Clone ledger')
    expect(value('lc-mcp-name')).toBe('ledger-copy')
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Save')
    act(() => save?.click())
    expect(saved).toEqual([['ledger-copy', undefined]])
  })
})
