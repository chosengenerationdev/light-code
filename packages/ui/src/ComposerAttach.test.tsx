// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Composer } from './Composer.js'

/**
 * Attaching a file while a turn is running.
 *
 * Reported from real use: *"when i send a new message with attachment, attachment doesn't seem to
 * be queued, only message is passed on"*. Everything downstream was right — the composer sends the
 * images, the host queues them, the loop consumes them — and the attach **button** was disabled
 * while streaming, left over from when a mid-turn message was refused outright. Paste and drop had
 * never been disabled, so this was the one way in that still silently said no.
 *
 * A render test because the defect was a single prop, invisible to every test of the behaviour it
 * was preventing.
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

function render(isStreaming: boolean): void {
  act(() => {
    root.render(
      <Composer
        isStreaming={isStreaming}
        onSend={() => undefined}
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
      />,
    )
  })
}

const attachButton = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === 'Attach a file',
  )

describe('the attach button', () => {
  it('is offered when nothing is running', () => {
    render(false)
    expect(attachButton()).toBeDefined()
    expect(attachButton()?.disabled).toBe(false)
  })

  it('is offered mid-turn too, so an attachment can be queued', () => {
    /*
     * The regression. Queuing has carried images for a while; the button was the only thing that
     * refused, and from the outside it looks exactly like the attachment being dropped — you
     * click, nothing happens, and the text goes on its own.
     */
    render(true)
    expect(attachButton()).toBeDefined()
    expect(attachButton()?.disabled).toBe(false)
  })
})
