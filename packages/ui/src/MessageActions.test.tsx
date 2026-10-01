// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MessageQuote, Reaction } from '@light-code/core/browser'
import type { MessageFeedback } from './MessageActions.js'
import { MessageList, type DisplayMessage } from './MessageList.js'

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

function feedback(overrides: Partial<MessageFeedback> = {}) {
  const calls = { replies: [] as MessageQuote[], reacts: [] as [string, Reaction | undefined, MessageQuote][] }
  const value: MessageFeedback = {
    reactions: {},
    pendingKeys: new Set(),
    onReply: (quote) => calls.replies.push(quote),
    onReact: (key, reaction, quote) => calls.reacts.push([key, reaction, quote]),
    ...overrides,
  }
  return { value, calls }
}

const messages: DisplayMessage[] = [
  { kind: 'text', role: 'user', content: 'fix it' },
  { kind: 'reasoning', content: 'maybe rewrite the parser' },
  { kind: 'text', role: 'assistant', content: 'I will add a lock.' },
  { kind: 'text', role: 'assistant', content: 'still typing', pending: true },
]
const button = (label: string): HTMLButtonElement[] =>
  [...container.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === label) as HTMLButtonElement[]

describe('replying and reacting', () => {
  it('offers the controls on a finished reply only, never on yours or a streaming one', () => {
    const { value } = feedback()
    act(() => root.render(<MessageList messages={messages} error={undefined} feedback={value} />))
    expect(button('Reply to this reply')).toHaveLength(1)
  })

  it('quotes the whole reply when nothing is selected, and reacts by message key', () => {
    const { value, calls } = feedback()
    act(() => root.render(<MessageList messages={messages} error={undefined} feedback={value} />))
    act(() => button('Reply to this reply')[0]!.click())
    expect(calls.replies[0]).toEqual({ excerpt: 'I will add a lock.', source: 'message' })
    act(() => button('👍 Right direction, keep this')[0]!.click())
    expect(calls.reacts[0]?.slice(0, 2)).toEqual(['2', 'up'])
  })

  /* Reacting to thinking you have not read is a guess, so the controls wait for it to be opened. */
  it('offers them on a thought process once it is expanded', () => {
    const { value, calls } = feedback()
    act(() => root.render(<MessageList messages={messages} error={undefined} feedback={value} />))
    expect(button('Reply to this thinking')).toHaveLength(0)
    act(() => container.querySelector<HTMLButtonElement>('button[title="Show the reasoning"]')!.click())
    act(() => button('👎 Wrong, do not pursue this')[0]!.click())
    expect(calls.reacts[0]).toEqual(['1', 'down', { excerpt: 'maybe rewrite the parser', source: 'reasoning' }])
  })

  it('withdraws a pending reaction, and locks one already delivered', () => {
    const pending = feedback({ reactions: { '2': 'up' }, pendingKeys: new Set(['2']) })
    act(() => root.render(<MessageList messages={messages} error={undefined} feedback={pending.value} />))
    act(() => button('👍 Right direction, keep this')[0]!.click())
    expect(pending.calls.reacts[0]?.[1]).toBeUndefined()

    const sent = feedback({ reactions: { '2': 'up' } })
    act(() => root.render(<MessageList messages={messages} error={undefined} feedback={sent.value} />))
    act(() => button('👍 Right direction, keep this')[0]!.click())
    expect(sent.calls.reacts).toHaveLength(0)
    expect(button('👎 Wrong, do not pursue this')[0]!.disabled).toBe(true)
  })
})
