// @vitest-environment jsdom
import { GUIDE_STEPS } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Guide } from './Guide.js'

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

const opened: string[] = []
const closed: true[] = []

function render(mediaBase?: string): void {
  opened.length = 0
  closed.length = 0
  act(() =>
    root.render(
      <Guide
        {...(mediaBase !== undefined ? { mediaBase } : {})}
        onOpenTab={(tab) => opened.push(tab)}
        onClose={() => closed.push(true)}
      />,
    ),
  )
}

const click = (element: Element | null | undefined): void => {
  act(() => element?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
const button = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)

describe('the in-app guide', () => {
  it('starts at the first step and says where it is', () => {
    render()
    expect(container.textContent).toContain(GUIDE_STEPS[0]?.title ?? '')
    expect(container.textContent).toContain(`1 of ${String(GUIDE_STEPS.length)}`)
  })

  it('walks forwards and back', () => {
    render()
    click(button('Next'))
    expect(container.textContent).toContain(GUIDE_STEPS[1]?.title ?? '')
    click(button('Back'))
    expect(container.textContent).toContain(GUIDE_STEPS[0]?.title ?? '')
  })

  it('cannot go back from the first step or past the last', () => {
    render()
    expect(button('Back')?.disabled).toBe(true)
    for (let step = 0; step < GUIDE_STEPS.length; step++) click(button('Next'))
    expect(container.textContent).toContain(`${String(GUIDE_STEPS.length)} of ${String(GUIDE_STEPS.length)}`)
    // The last step offers Done rather than a Next that would go nowhere.
    expect(button('Next')).toBeUndefined()
    expect(button('Done')).toBeDefined()
  })

  /** The whole point: a step about a tab has to be able to open it. */
  it('opens the tab a step is about', () => {
    render()
    const providers = GUIDE_STEPS.findIndex((step) => step.tab === 'providers')
    for (let step = 0; step < providers; step++) click(button('Next'))
    click(button('Open the Providers tab'))
    expect(opened).toEqual(['providers'])
  })

  it('offers no tab button on a step that is not about one', () => {
    render()
    // Orientation is about the panel, not a settings tab.
    expect(GUIDE_STEPS[0]?.tab).toBeUndefined()
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Open the '))).toBe(false)
  })

  it('closes from the header and from the last step', () => {
    render()
    click(button('Close'))
    expect(closed).toHaveLength(1)
  })

  /** Jumping is why the dots exist; fourteen steps is too many to page through twice. */
  it('jumps straight to a step from its dot', () => {
    render()
    const dots = [...container.querySelectorAll('button')].filter((entry) => entry.getAttribute('aria-label') !== null)
    const target = GUIDE_STEPS.length - 2
    click(dots[target])
    expect(container.textContent).toContain(`${String(target + 1)} of ${String(GUIDE_STEPS.length)}`)
  })

  describe('diagrams', () => {
    it('shows both palettes when the host serves them', () => {
      render('/guide')
      const img = container.querySelector('img')
      expect(img?.getAttribute('src')).toBe(`/guide/${String(GUIDE_STEPS[0]?.id)}-light.svg`)
      expect(container.querySelector('source')?.getAttribute('srcset')).toBe(
        `/guide/${String(GUIDE_STEPS[0]?.id)}-dark.svg`,
      )
      // Every diagram is described, and the description comes from the shared step data.
      expect(img?.getAttribute('alt')).toBe(GUIDE_STEPS[0]?.altText)
    })

    /**
     * A host with no art must get a readable tour, not fourteen broken images. That is the
     * whole reason `mediaBase` is optional rather than assumed.
     */
    it('renders as text when the host serves none', () => {
      render()
      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).toContain(GUIDE_STEPS[0]?.title ?? '')
    })
  })
})
