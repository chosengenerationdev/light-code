// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Composer } from './Composer.js'

/**
 * Reported from real use: typing `@tyj:rust` showed nothing at all, and that looked like @ search
 * being broken. Nothing in that codebase was named "rust" - the search was right and the picker
 * simply vanished. A search that found nothing now says so.
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

function render(candidates: string[], answeredFor: string | undefined): void {
  act(() => {
    root.render(
      <Composer
        isStreaming={false}
        onSend={() => undefined}
        onCancel={() => undefined}
        supportsVision
        mentionCandidates={candidates}
        mentionAnsweredFor={answeredFor}
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
      />,
    )
  })
}

function type(text: string): void {
  const box = container.querySelector('textarea')
  if (box === null) throw new Error('no composer box')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, text)
    box.setSelectionRange(text.length, text.length)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const status = (): string | undefined => container.querySelector('[role="status"]')?.textContent ?? undefined

describe('the @ picker', () => {
  it('says nothing matches once the answer for what was typed is in', () => {
    render([], undefined)
    type('@tyj:rust')
    expect(status()).toBeUndefined() // still searching
    render([], 'tyj:rust')
    expect(status()).toContain('No file or folder name matches')
  })

  it('stays quiet while an answer for an older query is all there is', () => {
    render([], 'tyj:rus')
    type('@tyj:rust')
    expect(status()).toBeUndefined()
  })
})
