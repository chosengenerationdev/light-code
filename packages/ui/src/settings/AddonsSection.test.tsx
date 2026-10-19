// @vitest-environment jsdom
import type { HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AddonsSection } from './AddonsSection.js'

/**
 * Enabling an add-on runs a program, so the panel shows which program before it does (invariant 8):
 * the first press shows the script, only the second sends anything.
 */
class FakeTransport implements Transport {
  sent: UiToHostMessage[] = []
  private listeners: ((message: unknown) => void)[] = []
  post(message: unknown): void {
    this.sent.push(message as UiToHostMessage)
  }
  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }
  deliver(message: HostToUiMessage): void {
    for (const listener of this.listeners) listener(message)
  }
}

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

const button = (text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === text)
  if (found === undefined) throw new Error(`No button "${text}" in: ${container.textContent ?? ''}`)
  return found
}

describe('the Add-ons panel', () => {
  it('shows an enabled add-on that could not start, with its log, since its server is not on the MCP tab', () => {
    const transport = new FakeTransport()
    act(() => root.render(<AddonsSection transport={transport} />))
    act(() =>
      transport.deliver({
        type: 'addons',
        addons: [{ package: 'p', version: '1', displayName: 'Linux', dir: 'd', main: 'm', server: 'addon-linux', state: 'enabled', status: 'failed', error: 'spawn ENOENT', logs: ['line one', 'line two'] }],
        problems: [],
        missing: [],
        folders: [],
        defaultFolders: [],
      }),
    )
    expect(container.textContent).toContain('Could not start: spawn ENOENT')
    expect(container.querySelector('details pre')?.textContent).toBe(['line one', 'line two'].join('\n'))
    // A change in any server's state asks for the list again.
    act(() => transport.deliver({ type: 'mcp' } as never))
    expect(transport.sent.at(-1)).toEqual({ type: 'requestAddons' })
  })

  it('adds a folder chosen with Browse to the list, keeping the box typeable', () => {
    const transport = new FakeTransport()
    const browsed: unknown[] = []
    act(() => root.render(<AddonsSection transport={transport} onBrowse={(request) => browsed.push(request)} />))
    act(() => transport.deliver({ type: 'addons', addons: [], problems: [], missing: [], folders: ['C:\\one'], defaultFolders: [] }))
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Browse…')?.click())
    expect(browsed).toEqual([{ purpose: 'addons:folder', kind: 'folder' }])
    act(() => root.render(<AddonsSection transport={transport} onBrowse={(request) => browsed.push(request)} pickedPath={{ purpose: 'addons:folder', path: 'D:\\two' }} />))
    expect(container.querySelector<HTMLTextAreaElement>('#addon-folders')?.value).toBe('C:\\one\nD:\\two')
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save folders')?.click())
    expect(transport.sent.at(-1)).toEqual({ type: 'saveAddonFolders', folders: ['C:\\one', 'D:\\two'] })
  })

  it('asks for the list, shows the program before enabling, and enables only on the second press', () => {
    const transport = new FakeTransport()
    act(() => root.render(<AddonsSection transport={transport} />))
    expect(transport.sent).toEqual([{ type: 'requestAddons' }])

    act(() =>
      transport.deliver({
        type: 'addons',
        addons: [
          {
            package: 'light-code-addon-hello',
            version: '1.0.0',
            displayName: 'Hello',
            dir: 'C:\\npm\\node_modules\\light-code-addon-hello',
            main: 'C:\\npm\\node_modules\\light-code-addon-hello\\server.js',
            server: 'addon-hello',
            state: 'available',
          },
        ],
        problems: [],
        missing: [],
        folders: [],
        defaultFolders: ['C:\\npm\\node_modules'],
      }),
    )
    expect(container.textContent).toContain('1 installed, 0 enabled')
    expect(container.textContent).not.toContain('server.js')

    act(() => button('Enable').click())
    expect(container.textContent).toContain('node C:\\npm\\node_modules\\light-code-addon-hello\\server.js')
    expect(transport.sent).toHaveLength(1)

    act(() => button('Run it').click())
    expect(transport.sent[1]).toEqual({ type: 'enableAddon', package: 'light-code-addon-hello' })
  })

  it('says an updated add-on is off, and offers to enable the new version', () => {
    const transport = new FakeTransport()
    act(() => root.render(<AddonsSection transport={transport} />))
    act(() =>
      transport.deliver({
        type: 'addons',
        addons: [{ package: 'w', version: '2.0.0', displayName: 'W', dir: 'd', main: 'd/s.js', server: 'addon-w', state: 'updated', enabledVersion: '1.0.0' }],
        problems: [{ dir: 'x', package: 'broken', problem: 'server.js does not exist - was the package built?' }],
        missing: [],
        folders: [],
        defaultFolders: [],
      }),
    )
    expect(container.textContent).toContain('Updated from 1.0.0 - off')
    expect(container.textContent).toContain('broken: server.js does not exist')
    expect(button('Enable this version')).toBeDefined()
  })
})
