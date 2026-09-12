// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { Chat, type ChatProps } from './Chat.js'
import type { DisplayMessage } from './MessageList.js'
import { giveScrollGeometry, installScrollStub } from './testDom.js'

/**
 * Where the transcript sits when a conversation opens.
 *
 * Reported: "when i switch between chat sessions, vertical scroll bar always goes back to top,
 * instead it should be pointing the latest chat". There was no scrolling code here at all, so
 * every restored conversation opened on its oldest message.
 *
 * ## Why this test has to fake the geometry
 *
 * jsdom performs no layout, so `scrollHeight` and `clientHeight` are both zero and every
 * element is trivially "at the bottom" — a test written against the defaults would pass
 * whatever the component did. The three properties are therefore defined explicitly, which is
 * also what makes the "user has scrolled up" case expressible at all.
 */
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  installScrollStub()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function messages(count: number): DisplayMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'text' as const,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `message ${String(index)}`,
  }))
}

function props(overrides: Partial<ChatProps>): ChatProps {
  return {
    plan: '',
    planCheckpoints: [],
    onSetPlan: () => undefined,
    conversationKey: 'one',
    messages: messages(6),
    isStreaming: false,
    error: undefined,
    pendingApproval: undefined,
    pendingForm: undefined,
    onSubmitForm: () => undefined,
    onDismissForm: () => undefined,
    canRollback: false,
    onSend: () => undefined,
    onCancel: () => undefined,
    onDecideApproval: () => undefined,
    onAlwaysAllow: () => undefined,
    onRollback: () => undefined,
    usage: undefined,
    expertSpend: {
      usd: 0,
      consultations: 0,
      unpriced: 0,
      maxSpendUsd: 0,
      maxConsultations: 0,
      overridden: false,
    },
    supportsVision: false,
    mentionCandidates: [],
    onQueryMentions: () => undefined,
    profiles: [],
    activeProfileId: undefined,
    onSelectProfile: () => undefined,
    expertEnabled: false,
    queued: [],
    onUnqueue: () => undefined,
    searchConnections: [],
    activeSearchId: undefined,
    onSelectSearch: () => undefined,
    ...overrides,
  }
}

/** The scrolling element, with a page-and-a-half of content it cannot actually lay out. */
function transcript(): HTMLElement {
  const element = container.querySelector<HTMLElement>('.lc-scroll')
  if (element === null) throw new Error('no scroll container rendered')
  return element
}

/**
 * A page and a half of content, scrolled to wherever the test wants to start.
 *
 * Returns the live array rather than a mapped copy: destructuring evaluates a getter once, at
 * a point where nothing has scrolled yet, so a mapped view is always empty.
 */
function giveGeometry(element: HTMLElement, scrollTop: number): { scrolls: ScrollToOptions[] } {
  return giveScrollGeometry(element, { scrollHeight: 1000, clientHeight: 400, scrollTop })
}

/** Where the last scroll asked to go, or undefined if nothing scrolled. */
function lastTop(scrolls: readonly ScrollToOptions[]): number | undefined {
  return scrolls.at(-1)?.top
}

describe('opening a conversation', () => {
  it('lands at the newest message, not the oldest', () => {
    act(() => root.render(<Chat {...props({ conversationKey: 'first' })} />))
    const element = transcript()
    const { scrolls } = giveGeometry(element, 0)

    act(() =>
      root.render(<Chat {...props({ conversationKey: 'second', messages: messages(20) })} />),
    )

    expect(lastTop(scrolls)).toBe(1000)
  })

  /** Instantly. Animating through an entire history on every switch is its own annoyance. */
  it('jumps rather than animating', () => {
    act(() => root.render(<Chat {...props({ conversationKey: 'first' })} />))
    const element = transcript()
    const { scrolls } = giveScrollGeometry(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 0,
    })

    act(() => root.render(<Chat {...props({ conversationKey: 'second' })} />))

    expect(scrolls.at(-1)?.behavior).toBe('auto')
  })
})

describe('following a reply as it arrives', () => {
  it('keeps someone at the bottom pinned there', () => {
    act(() => root.render(<Chat {...props({})} />))
    const element = transcript()
    // 1000 - 600 - 400 = 0 from the bottom.
    const { scrolls } = giveGeometry(element, 600)

    act(() => root.render(<Chat {...props({ messages: messages(8) })} />))

    expect(lastTop(scrolls)).toBe(1000)
  })

  /**
   * The half that matters more. Someone who scrolled up is reading something, and dragging
   * them back down mid-sentence is the behaviour every chat window gets wrong once.
   */
  it('leaves someone who has scrolled up where they are', () => {
    act(() => root.render(<Chat {...props({})} />))
    const element = transcript()
    // 1000 - 100 - 400 = 500 from the bottom, far past the threshold.
    const { scrolls } = giveGeometry(element, 100)

    act(() => root.render(<Chat {...props({ messages: messages(8) })} />))

    expect(scrolls).toEqual([])
  })

  /** A reply can add a line between frames, so "at the bottom" cannot mean exactly zero. */
  it('treats a few pixels from the bottom as the bottom', () => {
    act(() => root.render(<Chat {...props({})} />))
    const element = transcript()
    // 1000 - 540 - 400 = 60 from the bottom, inside the threshold.
    const { scrolls } = giveGeometry(element, 540)

    act(() => root.render(<Chat {...props({ messages: messages(8) })} />))

    expect(lastTop(scrolls)).toBe(1000)
  })
})
