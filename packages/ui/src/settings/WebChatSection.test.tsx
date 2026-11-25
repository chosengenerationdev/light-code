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

  // Asked for: "provide a test button to verify both primary way and backup way".
  it('tests both ways and shows each result', () => {
    const { container, sent, deliver } = mount()
    deliver({
      type: 'webChat',
      available: true,
      chrome: { servers: [{ name: 'chrome-webchat', problems: [] }], chosen: 'chrome-webchat' },
      setup: { pageUrl: 'https://ai-chat.example.internal/', backend: 'https://api.example.internal/v1/chat', via: 'replay', method: 'POST', fromPage: [], capturedAt: '2026-11-21' },
    })
    act(() => button(container, 'Test both ways').click())
    expect(sent.some((m) => m['type'] === 'testWebChat')).toBe(true)
    expect(button(container, 'Test both ways').disabled).toBe(true)
    expect(container.textContent).toContain('Direct to the approved address: asking…')
    deliver({
      type: 'webChatTest',
      results: [
        { way: 'direct', ok: false, text: 'The web chat answered HTTP 405.', ms: 800 },
        { way: 'window', ok: true, text: 'ready', ms: 4200, from: 'reply' },
      ],
    })
    const shown = container.querySelector('[data-testid="webchat-test"]')?.textContent ?? ''
    expect(shown).toContain('Direct to the approved address: failed (0.8 s) - The web chat answered HTTP 405.')
    expect(shown).toContain('Through the chat window: works (4.2 s) - ready')
    expect(button(container, 'Test both ways').disabled).toBe(false)
  })
})

describe('fixing the chosen server', () => {
  // Asked for: "its tiring for me to go back and forth, can you fix these for good please".
  it('offers to fix a server the web chat cannot use yet', () => {
    const { container, sent, deliver } = mount()
    deliver({ type: 'webChat', available: true, chrome: { servers: [{ name: 'chrome-webchat', problems: ['Its arguments must include --no-usage-statistics.'], fixable: true }], chosen: 'chrome-webchat' } })
    act(() => button(container, 'Fix it for me').click())
    expect(sent.find((m) => m['type'] === 'fixWebChatServer')).toEqual({ type: 'fixWebChatServer', server: 'chrome-webchat' })
  })
})

describe('which Chrome', () => {
  it('switches the chosen server between your own Chrome and one it starts', () => {
    const { container, sent, deliver } = mount()
    deliver({ type: 'webChat', available: true, chrome: { servers: [{ name: 'chrome-webchat', problems: [], mode: 'own' }], chosen: 'chrome-webchat' } })
    expect(container.textContent).toContain('chrome://inspect/#remote-debugging')
    act(() => (container.querySelector('[aria-label="Which Chrome the web chat uses"]') as HTMLButtonElement).click())
    const option = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent?.includes('A Chrome it starts')) as HTMLElement
    act(() => option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(sent.find((m) => m['type'] === 'setWebChatChrome')).toEqual({ type: 'setWebChatChrome', server: 'chrome-webchat', mode: 'started' })
  })
})
