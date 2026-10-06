// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Composer } from './Composer.js'
import type { StagedResult } from './stagedFiles.js'

/**
 * Reported: dropping a file or an email out of Outlook said it was too big and asked for it to be
 * saved locally first. Such a file now goes to the host to be read, and what comes back is sent.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  localStorage.clear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(sent: string[], staged: string[]): void {
  act(() => {
    root.render(
      <Composer
        isStreaming={false}
        onSend={(text) => sent.push(text)}
        onCancel={() => undefined}
        supportsVision
        mentionCandidates={[]}
        onQueryMentions={() => undefined}
        profiles={[]}
        onSelectProfile={() => undefined}
        searchConnections={[]}
        onSelectSearch={() => undefined}
        queued={[]}
        onUnqueue={() => undefined}
        planCheckpoints={[]}
        plan=""
        directRoles={[]}
        onSetPlan={() => undefined}
        activeProfileId={undefined}
        activeSearchId={undefined}
        expertEnabled={false}
        stageFile={async (name): Promise<StagedResult> => {
          staged.push(name)
          return { name, path: `C:\\tmp\\light-code-drops\\x\\${name}`, text: 'Subject: Q3 numbers\nFrom: someone' }
        }}
      />,
    )
  })
}

async function attach(file: File): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function send(): void {
  const button = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement
  act(() => button.click())
}

describe('dropping a file the panel cannot read', () => {
  it('sends an Outlook message to the host and attaches what it read', async () => {
    const sent: string[] = []
    const staged: string[] = []
    render(sent, staged)
    await attach(new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])], 'Q3 numbers.msg'))
    expect(staged).toEqual(['Q3 numbers.msg'])
    expect(container.textContent).not.toMatch(/too large|cannot be read/)
    send()
    expect(sent[0]).toContain('Subject: Q3 numbers')
    expect(sent[0]).toContain('light-code-drops')
  })

  it('sends a text file over 512 KB to the host rather than refusing it', async () => {
    const sent: string[] = []
    const staged: string[] = []
    render(sent, staged)
    await attach(new File(['x'.repeat(600 * 1024)], 'big.log'))
    expect(staged).toEqual(['big.log'])
  })

  it('pastes a small text file in directly', async () => {
    const sent: string[] = []
    const staged: string[] = []
    render(sent, staged)
    await attach(new File(['hello'], 'note.txt'))
    expect(staged).toEqual([])
    send()
    expect(sent[0]).toContain('hello')
  })
})
