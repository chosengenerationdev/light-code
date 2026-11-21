// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { remainingSuggestion } from './completions.js'
import { Composer, type ComposerProps } from './Composer.js'

/** Asked for: grey suggestions while typing; Tab takes one word, Ctrl+Space the whole suggestion. */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const containers: HTMLElement[] = []
afterEach(() => {
  for (const container of containers.splice(0)) container.remove()
  vi.useRealTimers()
})

function render(complete: (text: string) => Promise<string>): { textarea: HTMLTextAreaElement; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  const props = {
    isStreaming: false,
    plan: '',
    planCheckpoints: [],
    onSetPlan: () => undefined,
    onSend: () => undefined,
    onCancel: () => undefined,
    supportsVision: false,
    mentionCandidates: [],
    directRoles: [],
    onQueryMentions: () => undefined,
    profiles: [],
    activeProfileId: undefined,
    onSelectProfile: () => undefined,
    expertEnabled: false,
    queued: [],
    onUnqueue: () => undefined,
    complete,
  } as unknown as ComposerProps
  act(() => createRoot(container).render(<Composer {...props} />))
  return { textarea: container.querySelector('textarea') as HTMLTextAreaElement, container }
}

function type(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(textarea, value)
    textarea.setSelectionRange(value.length, value.length)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(textarea: HTMLTextAreaElement, init: KeyboardEventInit): void {
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(600)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('suggestions in the chat box', () => {
  it('shows the suggestion in grey, Tab takes one word, Ctrl+Space the rest', async () => {
    vi.useFakeTimers()
    const asked: string[] = []
    const { textarea, container } = render(async (text) => {
      asked.push(text)
      return ' test in the parser'
    })
    type(textarea, 'fix the failing')
    await settle()
    expect(asked).toEqual(['fix the failing'])
    expect(container.querySelector('[data-testid="composer-suggestion"]')?.textContent).toBe('fix the failing test in the parser')

    key(textarea, { key: 'Tab' })
    await act(async () => vi.advanceTimersByTime(20))
    expect(textarea.value).toBe('fix the failing test')
    // What is left is still offered, without asking again.
    expect(container.querySelector('[data-testid="composer-suggestion"] span')?.textContent).toBe(' in the parser')

    key(textarea, { key: ' ', ctrlKey: true })
    expect(textarea.value).toBe('fix the failing test in the parser')
    await settle()
  })

  it('drops the suggestion when the typing goes another way, and Esc hides it', async () => {
    vi.useFakeTimers()
    const { textarea, container } = render(async () => ' test')
    type(textarea, 'fix the failing')
    await settle()
    type(textarea, 'fix the failing build')
    expect(container.querySelector('[data-testid="composer-suggestion"]')).toBeNull()
    await settle()
    key(textarea, { key: 'Escape' })
    expect(container.querySelector('[data-testid="composer-suggestion"]')).toBeNull()
    key(textarea, { key: 'Tab' })
    expect(textarea.value).toBe('fix the failing build')
  })

  it('keeps what is left while the typing matches it', () => {
    expect(remainingSuggestion('fix the', ' failing test', 'fix the fai')).toBe('ling test')
    expect(remainingSuggestion('fix the', ' failing test', 'fix the bu')).toBe('')
    expect(remainingSuggestion('fix the', ' failing test', 'fix')).toBe('')
  })
})
