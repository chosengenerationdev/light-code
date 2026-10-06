// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Composer } from './Composer.js'

/**
 * Reported: type something, switch away (Settings, History) and come back, and it was gone - the
 * box is unmounted with the view. The draft is kept in the page's storage and restored.
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


describe('the draft in the message box', () => {
  it('survives the box being taken away and brought back', () => {
    window.localStorage.clear()
    render([], undefined)
    type('half a thought about the parser')
    act(() => root.unmount())
    root = createRoot(container)
    render([], undefined)
    expect(container.querySelector('textarea')?.value).toBe('half a thought about the parser')
  })

  it('is forgotten once emptied', () => {
    render([], undefined)
    type('')
    expect(window.localStorage.getItem('light-code:composer-draft')).toBeNull()
  })
})
