// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import type { ArtifactEntry, HostToUiMessage, Transport } from '@light-code/core/browser'

import { ArtifactsPanel, badgesFor, formatSize } from './ArtifactsButton.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fakeTransport(): Transport & { posted: unknown[]; send: (message: HostToUiMessage) => void } {
  const listeners: ((message: unknown) => void)[] = []
  const posted: unknown[] = []
  return {
    posted,
    post(message: unknown) {
      posted.push(message)
    },
    onMessage(listener: (message: unknown) => void) {
      listeners.push(listener)
      return () => undefined
    },
    send(message: HostToUiMessage) {
      for (const listener of listeners) listener(message)
    },
  } as unknown as Transport & { posted: unknown[]; send: (message: HostToUiMessage) => void }
}

const entry = (over: Partial<ArtifactEntry>): ArtifactEntry => ({ path: 'a.txt', name: 'a.txt', kind: 'text', size: 10, modified: Date.now(), created: 0, changedThisChat: false, newThisChat: false, ...over })

let container: HTMLDivElement | undefined
afterEach(() => {
  container?.remove()
  container = undefined
})

describe('the Files panel', () => {
  it('opens on this chat\'s files, with the tool and reason, and asks for details when a row opens', async () => {
    const transport = fakeTransport()
    container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(<ArtifactsPanel transport={transport} onClose={() => undefined} />))
    expect(transport.posted).toContainEqual({ type: 'requestArtifacts' })

    await act(async () =>
      transport.send({
        type: 'artifacts',
        opens: { open: true, reveal: true },
        list: {
          root: 'C:\\work\\Reports',
          since: 0,
          scanned: 2,
          truncated: false,
          files: [
            entry({ path: 'out/q3.xlsx', name: 'q3.xlsx', kind: 'spreadsheet', size: 20480, changedThisChat: true, newThisChat: true, writes: [{ tool: 'excel_create_workbook', why: 'Make the Q3 workbook' }] }),
            entry({ path: 'notes.txt', name: 'notes.txt', summary: 'Old notes' }),
          ],
        },
      }),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Files in Reports')
    expect(text).toContain('q3.xlsx')
    expect(text).toContain('Created by the agent')
    expect(text).toContain('Make the Q3 workbook')
    expect(text).not.toContain('notes.txt')

    const row = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('q3.xlsx'))!
    await act(async () => row.click())
    expect(transport.posted).toContainEqual({ type: 'describeArtifact', path: 'out/q3.xlsx' })

    const all = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('All files'))!
    await act(async () => all.click())
    expect(container.textContent).toContain('notes.txt')
    expect(container.textContent).toContain('Old notes')

    const open = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Open')!
    await act(async () => open.click())
    expect(transport.posted).toContainEqual({ type: 'openArtifact', path: 'out/q3.xlsx', how: 'open' })
    await act(async () => root.unmount())
  })

  it('offers no Open where the host cannot open files here', async () => {
    const transport = fakeTransport()
    container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(<ArtifactsPanel transport={transport} onClose={() => undefined} />))
    await act(async () => transport.send({ type: 'artifacts', opens: { open: false, reveal: false }, list: { root: '/srv', since: 0, scanned: 1, truncated: false, files: [entry({ changedThisChat: true })] } }))
    const row = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('a.txt'))!
    await act(async () => row.click())
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Open')).toBe(false)
    await act(async () => root.unmount())
  })

  it('says sizes and badges in words', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(20480)).toBe('20 KB')
    expect(badgesFor(entry({ changedThisChat: true }))).toEqual(['Changed this chat'])
    expect(badgesFor(entry({ writes: [{ tool: 'apply_diff' }] }))).toEqual(['Written by the agent'])
  })
})
