// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ApprovalPrompt, type PendingApproval } from './ApprovalPrompt.js'

/**
 * Tools that change something shared — starting an AutoSys job, applying JIL, replaying a
 * Jenkinsfile — ask every time, and the policy never consults an "always allow" for them. Offering
 * the button anyway records a rule that does nothing: asked for directly, "no always allow".
 */

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

const render = (approval: PendingApproval): void => {
  act(() => root.render(<ApprovalPrompt approval={approval} onDecide={() => {}} onAlwaysAllow={() => {}} />))
}
const buttons = (): string[] => [...container.querySelectorAll('button')].map((button) => button.textContent ?? '')

describe('the approval prompt', () => {
  it('offers no Always allow for a tool that asks every time, and says so', () => {
    render({ id: '1', toolName: 'autosys_send_event', group: 'command', preview: { kind: 'text', text: 'sendevent -E FORCE_STARTJOB -J PAY_B' }, alwaysAsk: true })
    expect(buttons().some((text) => text.includes('Always allow'))).toBe(false)
    expect(container.textContent).toContain('Asked every time')
  })

  it('still offers it for an ordinary read', () => {
    render({ id: '2', toolName: 'autosys_status', group: 'read', preview: { kind: 'text', text: 'status' } })
    expect(buttons().some((text) => text.includes('Always allow autosys_status'))).toBe(true)
  })
})
