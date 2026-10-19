// @vitest-environment jsdom
import type { AddonPageView, HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AddonPageTab, fillSummary } from './AddonPageTab.js'

/**
 * An add-on's own tab. Asked for in exactly these terms: "I don't want the new tab to be appearing in
 * Light Code or Fire Code, it should appear only when addon is installed" - so the tab is drawn from
 * what the host reports installed, and a form is drawn from what the add-on declares.
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
    act(() => {
      for (const listener of [...this.listeners]) listener(message)
    })
  }
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  // Select and the tab bar measure themselves; jsdom has no layout.
  Element.prototype.scrollIntoView = () => undefined
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const ICON = 'data:image/svg+xml;base64,PHN2Zy8+'
const page: AddonPageView['page'] = {
  title: 'Linux',
  records: {
    noun: 'machine',
    title: 'Machines',
    keyField: 'label',
    summary: '{username}@{host}:{port}',
    fields: [
      { key: 'label', label: 'Label', type: 'string', required: true },
      { key: 'host', label: 'Host', type: 'string', required: true },
      { key: 'port', label: 'Port', type: 'number', default: 22 },
      { key: 'auth', label: 'Sign in with', type: 'choice', default: 'pageant', options: [{ value: 'pageant', label: 'Pageant' }, { value: 'password', label: 'Password' }] },
      { key: 'password', label: 'Password', type: 'secret', required: true, showWhen: { field: 'auth', equals: 'password' } },
    ],
    actions: [{ label: 'Test connection', tool: 'test_connection' }],
  },
}
const view = (records: AddonPageView['records'], state: AddonPageView['state'] = 'enabled'): AddonPageView => ({
  package: 'light-code-addon-linux',
  displayName: 'Linux',
  icon: ICON,
  page,
  state,
  values: {},
  secretsSet: [],
  records,
  tools: [{ name: 'addon-linux__run', server: 'addon-linux', tool: 'run', description: 'Run a read-only command', permission: 'ask' }],
})
const button = (text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (found === undefined) throw new Error(`No button "${text}" in: ${container.textContent ?? ''}`)
  return found
}
const type = (input: HTMLInputElement, value: string): void => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('an add-on tab', () => {
  it('lists records with their summary, and runs a declared button on one', () => {
    const transport = new FakeTransport()
    act(() => root.render(<AddonPageTab transport={transport} package="light-code-addon-linux" />))
    expect(transport.sent).toEqual([{ type: 'requestAddonPage', package: 'light-code-addon-linux' }])
    transport.deliver({ type: 'addonPage', package: 'light-code-addon-linux', view: view([{ id: 'r1', values: { label: 'web1', host: 'h', port: 22, username: 'ann' }, secretsSet: [] }]) })
    expect(container.textContent).toContain('web1')
    expect(container.textContent).toContain('ann@h:22')
    act(() => button('Test connection').click())
    expect(transport.sent.at(-1)).toEqual({ type: 'runAddonAction', package: 'light-code-addon-linux', id: 'r1', tool: 'test_connection' })
    transport.deliver({ type: 'addonActionResult', package: 'light-code-addon-linux', id: 'r1', tool: 'test_connection', ok: true, text: 'Connected to web1' })
    expect(container.textContent).toContain('Connected to web1')
  })

  it('shows fields by the choice made, and sends a secret separately from the values', () => {
    const transport = new FakeTransport()
    act(() => root.render(<AddonPageTab transport={transport} package="light-code-addon-linux" />))
    transport.deliver({ type: 'addonPage', package: 'light-code-addon-linux', view: view([]) })
    act(() => button('Add machine').click())
    expect(container.querySelector('input[type="password"]')).toBeNull()

    const inputs = (): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('input[type="text"]')]
    type(inputs()[0]!, 'db1')
    type(inputs()[1]!, 'db1.corp')
    // Choosing Password brings its field.
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Sign in with"]')?.click())
    act(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes('Password'))?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true })))
    const secret = container.querySelector<HTMLInputElement>('input[type="password"]')
    expect(secret).not.toBeNull()

    // Required: refused in the panel before anything is sent.
    act(() => button('Add machine').click())
    expect(container.textContent).toContain('Password is required.')
    type(secret!, 'pw')
    act(() => button('Add machine').click())
    expect(transport.sent.at(-1)).toEqual({
      type: 'saveAddonRecord',
      package: 'light-code-addon-linux',
      values: { label: 'db1', host: 'db1.corp', port: 22, auth: 'password' },
      secrets: { password: 'pw' },
    })
  })

  it('never shows a stored secret, and deletes only on a second press', () => {
    const transport = new FakeTransport()
    act(() => root.render(<AddonPageTab transport={transport} package="light-code-addon-linux" />))
    transport.deliver({
      type: 'addonPage',
      package: 'light-code-addon-linux',
      view: view([{ id: 'r1', values: { label: 'web1', host: 'h', username: 'ann', auth: 'password' }, secretsSet: ['password'] }], 'available'),
    })
    expect(container.textContent).toContain('not enabled yet')
    act(() => button('Edit').click())
    const secret = container.querySelector<HTMLInputElement>('input[type="password"]')
    expect(secret?.value).toBe('')
    expect(secret?.placeholder).toBe('Set - leave blank to keep')

    act(() => button('Cancel').click())
    act(() => button('Delete').click())
    expect(transport.sent.some((m) => m.type === 'deleteAddonRecord')).toBe(false)
    act(() => button('Delete web1').click())
    expect(transport.sent.at(-1)).toEqual({ type: 'deleteAddonRecord', package: 'light-code-addon-linux', id: 'r1' })
  })

  it('lists the tools it gives the assistant', () => {
    const transport = new FakeTransport()
    act(() => root.render(<AddonPageTab transport={transport} package="light-code-addon-linux" />))
    transport.deliver({ type: 'addonPage', package: 'light-code-addon-linux', view: view([]) })
    expect(container.textContent).toContain('run')
    expect(container.querySelector('[aria-label="When run runs"]')?.textContent).toContain('Ask first')
    // Changed here, saved where the MCP tab keeps it.
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="When run runs"]')?.click())
    act(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes('Always allow'))?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true })))
    expect(transport.sent.at(-1)).toEqual({ type: 'setMcpToolPermission', server: 'addon-linux', tool: 'run', permission: 'always' })
  })

  it('offers a button only where it applies, and runs one that changes something only on a second press', () => {
    const transport = new FakeTransport()
    act(() => root.render(<AddonPageTab transport={transport} package="light-code-addon-linux" />))
    const withSetup: AddonPageView = {
      ...view([
        { id: 'r1', values: { label: 'web1', host: 'h', auth: 'password' }, secretsSet: ['password'] },
        { id: 'r2', values: { label: 'web2', host: 'h', auth: 'pageant' }, secretsSet: [] },
      ]),
    }
    withSetup.page = {
      ...page,
      records: {
        ...page.records!,
        actions: [{ label: 'Set up SSH key', tool: 'setup_key', confirm: 'This adds a key to {label}.', showWhen: { field: 'auth', equals: 'password' } }],
      },
    }
    transport.deliver({ type: 'addonPage', package: 'light-code-addon-linux', view: withSetup })
    expect([...container.querySelectorAll('button')].filter((b) => b.textContent === 'Set up SSH key')).toHaveLength(1)
    act(() => button('Set up SSH key').click())
    expect(container.textContent).toContain('This adds a key to web1.')
    expect(transport.sent.some((m) => m.type === 'runAddonAction')).toBe(false)
    const confirm = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent === 'Set up SSH key')!
    act(() => confirm.click())
    expect(transport.sent.at(-1)).toEqual({ type: 'runAddonAction', package: 'light-code-addon-linux', id: 'r1', tool: 'setup_key' })
  })

  it('fills a summary, leaving out what is missing', () => {
    expect(fillSummary('{username}@{host}:{port}', { username: 'a', host: 'h' })).toBe('a@h:')
  })
})
