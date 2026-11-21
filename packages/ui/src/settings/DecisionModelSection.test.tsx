// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import type { Transport } from '@light-code/core/browser'

import { DecisionRouteNote } from '../DecisionRouteNote.js'
import { DecisionModelSection } from './DecisionModelSection.js'

/** Asked for: decision-model features "available only when a decision model is setup". */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const containers: HTMLElement[] = []
afterEach(() => {
  for (const container of containers.splice(0)) container.remove()
})

function fakeTransport(): { transport: Transport; sent: { type: string }[]; deliver: (message: object) => void } {
  const listeners = new Set<(message: unknown) => void>()
  const sent: { type: string }[] = []
  return {
    sent,
    deliver: (message) => act(() => listeners.forEach((listener) => listener(message))),
    transport: {
      post: (message: unknown) => sent.push(message as { type: string }),
      onMessage: (listener: (message: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as unknown as Transport,
  }
}

function mount(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  act(() => createRoot(container).render(element))
  return container
}

describe('Settings → Agents → Decision model', () => {
  it('shows only the picker until a profile is chosen, then its switches and the Test button', () => {
    const { transport, sent, deliver } = fakeTransport()
    const container = mount(<DecisionModelSection transport={transport} />)
    expect(sent.map((m) => m.type)).toContain('requestDecisionModel')
    deliver({ type: 'decisionModel', settings: {}, profiles: [{ id: 'd3', label: 'D3' }] })
    expect(container.textContent).not.toContain('Test decision model')
    expect(container.textContent).not.toContain('Agent team mode, send')
    deliver({ type: 'decisionModel', settings: { profileId: 'd3' }, profiles: [{ id: 'd3', label: 'D3' }], label: 'D3' })
    expect(container.textContent).toContain('Test decision model')
    expect(container.textContent).toContain('In Agent team mode, send each message')
    deliver({ type: 'decisionModelTest', results: [{ question: 'Is it even? (42)', expected: 'yes', ok: true, source: 'logprobs', probabilities: { yes: 0.97, no: 0.03 }, raw: '{}', ms: 12 }] })
    expect(container.querySelector('[data-testid="decision-test"]')?.textContent).toContain('yes 0.97')
  })

  it('the routing note says who it went to and offers to take it back while the reply runs', () => {
    let answered: string | undefined
    const container = mount(<DecisionRouteNote route={{ role: 'tester', name: 'Tester', probability: 0.91 }} busy onAnswerYourself={(role) => (answered = role)} onDismiss={() => undefined} />)
    expect(container.textContent).toContain('Sent to Tester · 0.91')
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Answer it yourself')
    act(() => button?.click())
    expect(answered).toBe('tester')
    const empty = mount(<DecisionRouteNote route={undefined} busy={false} onAnswerYourself={() => undefined} onDismiss={() => undefined} />)
    expect(empty.textContent).toBe('')
  })
})
