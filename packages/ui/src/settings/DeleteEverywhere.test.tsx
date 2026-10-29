// @vitest-environment jsdom
import type { DeleteEverywherePlan, HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { DeleteEverywhere } from './DeleteEverywhere.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | undefined
afterEach(() => {
  container?.remove()
  container = undefined
})

function setup() {
  const listeners: ((message: unknown) => void)[] = []
  const sent: UiToHostMessage[] = []
  const transport = {
    post: (message: unknown) => sent.push(message as UiToHostMessage),
    onMessage: (listener: (message: unknown) => void) => {
      listeners.push(listener)
      return () => undefined
    },
  } as unknown as Transport
  container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<DeleteEverywhere transport={transport} kind="skill" name="deploy" />))
  const deliver = (message: HostToUiMessage) => act(() => listeners.forEach((listener) => listener(message)))
  const button = (text: string) => [...container!.querySelectorAll('button')].find((each) => each.textContent?.includes(text)) as HTMLButtonElement
  return { sent, deliver, button, root: container }
}

const plan: DeleteEverywherePlan = {
  kind: 'skill',
  name: 'deploy',
  local: ['C:\\proj\\.lightcode\\skills\\deploy.md'],
  buckets: [{ connectionId: 'team', label: 'team bucket', keys: ['skills/deploy.md'] }],
  repo: ['light-code/skills/deploy.md'],
  repoLabel: 'TEAM/skills (main)',
  notes: [],
}

describe('Delete everywhere', () => {
  it('shows exactly what will go before anything does, and sends back that list', () => {
    const { sent, deliver, button, root } = setup()
    act(() => button('Delete everywhere').click())
    expect(sent).toEqual([{ type: 'previewDeleteEverywhere', kind: 'skill', name: 'deploy' }])
    deliver({ type: 'deleteEverywherePlan', plan })
    expect(root.textContent).toContain('C:\\proj\\.lightcode\\skills\\deploy.md')
    expect(root.textContent).toContain('skills/deploy.md')
    expect(root.textContent).toContain('light-code/skills/deploy.md')
    act(() => button('Delete all of this').click())
    expect(sent.at(-1)).toEqual({ type: 'deleteEverywhere', plan })
    deliver({ type: 'deleteEverywhereDone', kind: 'skill', name: 'deploy', ok: true, message: 'Removed 1 copy on this computer.' })
    expect(root.textContent).toContain('Removed 1 copy on this computer.')
  })

  it('ignores answers about another skill, and Cancel sends nothing', () => {
    const { sent, deliver, button, root } = setup()
    act(() => button('Delete everywhere').click())
    deliver({ type: 'deleteEverywherePlan', plan: { ...plan, name: 'other' } })
    expect(root.textContent).not.toContain('Delete all of this')
    deliver({ type: 'deleteEverywherePlan', plan })
    act(() => button('Cancel').click())
    expect(sent).toHaveLength(1)
    expect(root.textContent).toContain('Delete everywhere')
  })
})
