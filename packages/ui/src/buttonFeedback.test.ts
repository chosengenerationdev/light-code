// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BUSY_CAP_MS, installButtonFeedback } from './buttonFeedback.js'

/*
 * Reported from Fire Code: buttons felt like stone - click Save, nothing visible, "Saved" seconds later.
 * A button whose click sent work to the host is marked until the host answers.
 */
function fakeTransport() {
  const listeners: ((message: unknown) => void)[] = []
  const posted: unknown[] = []
  return {
    posted,
    transport: {
      post: (message: unknown) => posted.push(message),
      onMessage: (listener: (message: unknown) => void) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
    },
    answer: (message: unknown) => listeners.forEach((listener) => listener(message)),
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('a button that sends work to the host', () => {
  it('is marked busy until the host answers, and the message still goes', () => {
    const { transport, posted, answer } = fakeTransport()
    const stop = installButtonFeedback(transport)
    const button = document.createElement('button')
    button.addEventListener('click', () => transport.post({ type: 'saveAtlassian' }))
    document.body.append(button)
    button.click()
    expect(posted).toEqual([{ type: 'saveAtlassian' }])
    expect(button.getAttribute('data-lc-busy')).toBe('true')
    // A chat streaming is not the answer.
    answer({ type: 'textChunk', text: 'x' })
    expect(button.getAttribute('data-lc-busy')).toBe('true')
    answer({ type: 'atlassianSaved' })
    expect(button.hasAttribute('data-lc-busy')).toBe(false)
    stop()
  })

  it('leaves a button alone that did not send anything, and a later post with no click', async () => {
    const { transport } = fakeTransport()
    const stop = installButtonFeedback(transport)
    const button = document.createElement('button')
    document.body.append(button)
    button.click()
    // Something else posting afterwards - a refresh, a timer - is not this button's work.
    await new Promise((resolve) => setTimeout(resolve, 0))
    transport.post({ type: 'requestSkills' })
    expect(button.hasAttribute('data-lc-busy')).toBe(false)
    stop()
  })

  it('never stays busy for ever', () => {
    vi.useFakeTimers()
    const { transport } = fakeTransport()
    const stop = installButtonFeedback(transport)
    const button = document.createElement('button')
    button.addEventListener('click', () => transport.post({ type: 'testAtlassian' }))
    document.body.append(button)
    button.click()
    expect(button.getAttribute('data-lc-busy')).toBe('true')
    vi.advanceTimersByTime(BUSY_CAP_MS)
    expect(button.hasAttribute('data-lc-busy')).toBe(false)
    stop()
  })
})
