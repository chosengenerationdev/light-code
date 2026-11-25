// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import type { Transport } from '@light-code/core/browser'

import { RerankerSection } from './RerankerSection.js'

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
  act(() => createRoot(container).render(<RerankerSection transport={transport} />))
  return { container, sent, deliver: (message) => act(() => listeners.forEach((listener) => listener(message))) }
}

const button = (container: HTMLElement, text: string): HTMLButtonElement => [...container.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement

describe('Settings → Search → Reranker', () => {
  it('shows only the picker until a profile is chosen', () => {
    const { container, sent, deliver } = mount()
    expect(sent[0]).toEqual({ type: 'requestReranker' })
    deliver({ type: 'reranker', settings: {}, profiles: [{ id: 'bge', label: 'BGE' }] })
    expect(container.textContent).not.toContain('Use it for')
  })

  it('switches a use off, and shows the test order', () => {
    const { container, sent, deliver } = mount()
    deliver({ type: 'reranker', settings: { profileId: 'bge' }, profiles: [{ id: 'bge', label: 'BGE' }], label: 'BGE' })
    const codebase = [...container.querySelectorAll('label')].find((label) => label.textContent?.startsWith('Codebase search'))?.querySelector('input') as HTMLInputElement
    expect(codebase.checked).toBe(true)
    act(() => codebase.click())
    expect(sent.at(-1)).toEqual({ type: 'saveReranker', settings: { profileId: 'bge', codebase: false } })
    act(() => button(container, 'Test reranker').click())
    expect(sent.at(-1)).toEqual({ type: 'testReranker' })
    deliver({
      type: 'rerankerTest',
      result: { ok: true, query: 'How do I deploy?', ms: 42, endpoint: '/rerank (texts)', order: [{ text: 'Deploying the pricing service', score: 0.97, expectedFirst: true }, { text: 'Lemon cake', score: 0.01, expectedFirst: false }] },
    })
    const shown = container.querySelector('[data-testid="reranker-test"]')?.textContent ?? ''
    expect(shown).toContain('Works - 42 ms, at /rerank (texts)')
    expect(shown).toContain('0.970 Deploying the pricing service')
  })
})
