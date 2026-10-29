// @vitest-environment jsdom
import type { HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { TeamRepoPanel } from './TeamRepoPanel.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fakeTransport() {
  const listeners: ((message: unknown) => void)[] = []
  const sent: UiToHostMessage[] = []
  const transport = {
    post: (message: unknown) => sent.push(message as UiToHostMessage),
    onMessage: (listener: (message: unknown) => void) => {
      listeners.push(listener)
      return () => undefined
    },
  } as unknown as Transport
  const deliver = (message: HostToUiMessage) => act(() => listeners.forEach((listener) => listener(message)))
  return { transport, sent, deliver }
}

const base = {
  type: 'teamRepo' as const,
  settings: { enabled: true, project: 'TEAM', repo: 'skills', branch: 'main', folder: '', syncMinutes: 15 },
  available: true,
  bucketFolders: ['Skills: team bucket / skills'],
}

let container: HTMLDivElement | undefined
afterEach(() => {
  container?.remove()
  container = undefined
})

function render(transport: Transport) {
  container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<TeamRepoPanel transport={transport} />))
  return container
}

const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text)) as HTMLButtonElement

describe('switching the S3 bucket folders off', () => {
  it('offers the switch only after a clean check, and asks the host to confirm', () => {
    const { transport, sent, deliver } = fakeTransport()
    const root = render(transport)
    deliver(base)
    expect(button(root, 'Switch bucket folders off').disabled).toBe(true)
    button(root, 'Check').click()
    expect(sent.at(-1)).toEqual({ type: 'retireS3Buckets', confirm: false })

    deliver({ ...base, retire: { ready: false, folders: base.bucketFolders, covered: { skills: 0, tools: 0 }, problems: ['a.md - not in the repository yet'] } })
    expect(root.textContent).toContain('Not yet - 1 to sort out first')
    expect(button(root, 'Switch bucket folders off').disabled).toBe(true)

    deliver({ ...base, retire: { ready: true, folders: base.bucketFolders, covered: { skills: 3, tools: 2 }, problems: [] } })
    expect(root.textContent).toContain('Ready: 3 skill file(s) and 2 tool(s)')
    const switchOff = button(root, 'Switch bucket folders off')
    expect(switchOff.disabled).toBe(false)
    switchOff.click()
    expect(sent.at(-1)).toEqual({ type: 'retireS3Buckets', confirm: true })
  })

  it('disables both buttons, saying why, when no bucket folder is syncing skills or tools', () => {
    const { transport, deliver } = fakeTransport()
    const root = render(transport)
    deliver({ ...base, bucketFolders: [] })
    expect(root.textContent).toContain('Use the repository instead of the S3 bucket')
    for (const label of ['Check', 'Switch bucket folders off']) {
      const control = button(root, label)
      expect(control.disabled).toBe(true)
      expect(control.title).toContain('No S3 bucket folders are syncing skills or tools')
    }
  })
})
