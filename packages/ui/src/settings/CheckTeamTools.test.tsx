// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CheckTeamTools } from './CheckTeamTools.js'

/**
 * "Check for new team tools" (asked for: the approval window for a colleague's new tool did not show soon
 * enough, because the team folders sync on a 15-minute timer). One press asks the host to pull them now.
 */
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Check for new team tools', () => {
  it('asks the host to pull the team folders now, waits, and says what came down', () => {
    const posted: unknown[] = []
    let deliver: ((message: unknown) => void) | undefined
    const transport = {
      post: (message: unknown) => void posted.push(message),
      onMessage: (handler: (message: unknown) => void) => {
        deliver = handler
        return () => (deliver = undefined)
      },
    }
    act(() => root.render(<CheckTeamTools transport={transport as never} />))
    const button = container.querySelector('button')
    act(() => button?.click())
    expect(posted).toEqual([{ type: 'checkTeamTools' }])
    expect(button?.disabled).toBe(true)
    expect(button?.textContent).toBe('Checking for new team tools…')
    act(() => deliver?.({ type: 'teamToolsChecked', ok: true, message: '1 new tool(s) to review: pay_jobs.' }))
    expect(button?.disabled).toBe(false)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('1 new tool(s) to review: pay_jobs.')
  })
})
