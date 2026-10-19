// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { HandoffProgress } from './HandoffProgress.js'

/** Writing a handoff takes as long as a long reply; the panel must show it is moving, and offer a way out. */
function render(props: Parameters<typeof HandoffProgress>[0]): HTMLDivElement {
  const container = document.createElement('div')
  act(() => createRoot(container).render(<HandoffProgress {...props} />))
  return container
}

describe('handoff progress', () => {
  it('shows the step, how much is written, a moving bar, and Cancel', () => {
    const cancels: number[] = []
    const view = render({ phase: 'writing', written: 1240, onCancel: () => cancels.push(1), onDismiss: () => undefined })
    expect(view.textContent).toContain('✓ Saving this chat')
    expect(view.textContent).toContain('1,240 characters so far')
    expect(view.querySelector('.lc-handoff-bar')).not.toBeNull()
    act(() => [...view.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click())
    expect(cancels).toEqual([1])
  })

  it('says why it failed and that the chat is unchanged, with Close', () => {
    const view = render({ phase: 'failed', message: 'The handoff could not be written: HTTP 503. This chat is unchanged.', onCancel: () => undefined, onDismiss: () => undefined })
    expect(view.textContent).toContain('This chat is unchanged')
    expect([...view.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Close'])
  })
})
