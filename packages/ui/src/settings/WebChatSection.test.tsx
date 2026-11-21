// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import type { Transport } from '@light-code/core/browser'

import { WebChatSection } from './WebChatSection.js'

/**
 * Asked for: "setup to choose the chrome mcp that needs to be associated with web chat, i dont want existing chrome mcp
 * to be disturbed" - nothing is picked for the user, and the capture uses only the server they chose.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView = (): void => undefined

const containers: HTMLElement[] = []
afterEach(() => {
  for (const container of containers.splice(0)) container.remove()
})

function mount(): { container: HTMLElement; sent: Record<string, unknown>[]; deliver: (message: object) => void } {
  const listeners = new Set<(message: unknown) => void>()
  const sent: Record<string, unknown>[] = []
  const transport = {
    post: (message: unknown) => sent.push(message as Record<string, unknown>),
    onMessage: (listener: (message: unknown) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as Transport
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  act(() => createRoot(container).render(<WebChatSection transport={transport} />))
  return { container, sent, deliver: (message) => act(() => listeners.forEach((listener) => listener(message))) }
}

const button = (container: HTMLElement, text: string): HTMLButtonElement => [...container.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement

describe('Settings → Agents → Web chat', () => {
  it('picks no server by itself, and captures with the one chosen', () => {
    const { container, sent, deliver } = mount()
    deliver({
      type: 'webChat',
      available: true,
      chrome: { servers: [{ name: 'chrome-devtools', problems: ['Its arguments must include --no-usage-statistics.'] }, { name: 'chrome-webchat', problems: [] }] },
    })
    const input = container.querySelector('#webchat-page') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'https://ai-chat.example.internal/')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Nothing chosen yet: Capture waits for a choice.
    expect(button(container, 'Capture').disabled).toBe(true)
    // Choose "chrome-webchat" in the select.
    act(() => (container.querySelector('[aria-label="The Chrome DevTools MCP server for the web chat"]') as HTMLButtonElement).click())
    const option = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent?.includes('chrome-webchat')) as HTMLElement
    act(() => option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(button(container, 'Capture').disabled).toBe(false)
    act(() => button(container, 'Capture').click())
    expect(sent.find((m) => m['type'] === 'startWebChatCapture')).toEqual({ type: 'startWebChatCapture', pageUrl: 'https://ai-chat.example.internal/', server: 'chrome-webchat' })
  })

  it('shows why a chosen server cannot be used', () => {
    const { container, deliver } = mount()
    deliver({ type: 'webChat', available: true, chrome: { servers: [{ name: 'chrome-devtools', problems: ['With npx the version must be pinned.'] }], chosen: 'chrome-devtools' } })
    expect(container.textContent).toContain('"chrome-devtools" cannot be used for the web chat yet')
    expect(container.textContent).toContain('With npx the version must be pinned.')
  })
})
