// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Chat, type ChatProps } from './Chat.js'
import type { DisplayMessage } from './MessageList.js'

/**
 * The pinned prompt, driven through `Chat` rather than in isolation.
 *
 * Testing `PinnedPrompt` alone would prove it renders text, which was never in doubt. What is
 * worth pinning is *when* it appears — that it stays hidden while the message is on screen and
 * appears once it is not — and that only exists in `Chat`.
 *
 * jsdom implements no layout, so `IntersectionObserver` does not exist and would never fire if
 * it did. It is stubbed with a handle onto the callback, letting a test say "the message just
 * scrolled out of view" directly. That tests our reaction to the observer, which is the part we
 * wrote; whether Chromium fires it correctly is Chromium's business.
 */

type ObserverCallback = (entries: { isIntersecting: boolean }[]) => void

let observerCallbacks: ObserverCallback[] = []
let container: HTMLDivElement
let root: Root

class StubIntersectionObserver {
  constructor(private readonly callback: ObserverCallback) {
    observerCallbacks.push(callback)
  }
  observe(): void {}
  disconnect(): void {
    observerCallbacks = observerCallbacks.filter((entry) => entry !== this.callback)
  }
  unobserve(): void {}
}

beforeEach(() => {
  observerCallbacks = []
  Element.prototype.scrollIntoView ??= () => {}
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = StubIntersectionObserver
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function chatProps(messages: DisplayMessage[]): ChatProps {
  return {
    messages,
    isStreaming: false,
    error: undefined,
    pendingApproval: undefined,
    canRollback: false,
    onSend: () => {},
    onCancel: () => {},
    onDecideApproval: () => {},
    onAlwaysAllow: () => {},
    onRollback: () => {},
    usage: undefined,
    expertSpend: { usd: 0, consultations: 0, unpriced: 0 },
    supportsVision: false,
    mentionCandidates: [],
    onQueryMentions: () => {},
    profiles: [],
    activeProfileId: undefined,
    onSelectProfile: () => {},
    expertEnabled: false,
    queued: [],
    onUnqueue: () => {},
    searchConnections: [],
    activeSearchId: undefined,
    onSelectSearch: () => {},
  }
}

function render(messages: DisplayMessage[]): void {
  act(() => root.render(<Chat {...chatProps(messages)} />))
}

/** Simulates the browser reporting that the observed message left the viewport. */
function scrollPromptOutOfView(visible: boolean): void {
  act(() => {
    for (const callback of observerCallbacks) callback([{ isIntersecting: visible }])
  })
}

const pin = (): HTMLElement | null => document.querySelector('[aria-label^="Your message:"]')

const CONVERSATION: DisplayMessage[] = [
  { kind: 'text', role: 'user', content: 'Why does the retry loop hang?' },
  { kind: 'text', role: 'assistant', content: 'Because the backoff never resets.' },
]

describe('the pinned prompt', () => {
  /** Printing the same sentence twice when it is already on screen is worse than not pinning. */
  it('stays hidden while the message is still visible', () => {
    render(CONVERSATION)
    expect(pin()).toBeNull()

    scrollPromptOutOfView(true)
    expect(pin()).toBeNull()
  })

  it('appears once the message scrolls away, showing what was asked', () => {
    render(CONVERSATION)
    scrollPromptOutOfView(false)

    expect(pin()).not.toBeNull()
    expect(pin()?.textContent).toContain('Why does the retry loop hang?')
  })

  it('disappears again when the message comes back into view', () => {
    render(CONVERSATION)
    scrollPromptOutOfView(false)
    expect(pin()).not.toBeNull()

    scrollPromptOutOfView(true)
    expect(pin()).toBeNull()
  })

  /** It pins the *latest* question — an older one is not what you are reading the answer to. */
  it('pins the most recent user message, not the first', () => {
    render([
      { kind: 'text', role: 'user', content: 'First question' },
      { kind: 'text', role: 'assistant', content: 'First answer' },
      { kind: 'text', role: 'user', content: 'Second question' },
      { kind: 'text', role: 'assistant', content: 'Second answer' },
    ])
    scrollPromptOutOfView(false)

    expect(pin()?.textContent).toContain('Second question')
    expect(pin()?.textContent).not.toContain('First question')
  })

  it('shows nothing when the user has not said anything yet', () => {
    render([{ kind: 'text', role: 'assistant', content: 'Hello' }])
    scrollPromptOutOfView(false)
    expect(pin()).toBeNull()
  })

  /** A dead-end pin would be worse than none: it must be the way back to the message. */
  it('is a button, so it can scroll back to the message', () => {
    render(CONVERSATION)
    scrollPromptOutOfView(false)

    expect(pin()?.tagName).toBe('BUTTON')
    expect(pin()?.getAttribute('title')).toMatch(/scroll back/i)
  })

  it('marks exactly one message as the latest prompt', () => {
    render([
      { kind: 'text', role: 'user', content: 'One' },
      { kind: 'text', role: 'user', content: 'Two' },
    ])
    expect(document.querySelectorAll('[data-lc-latest-prompt]')).toHaveLength(1)
  })
})
