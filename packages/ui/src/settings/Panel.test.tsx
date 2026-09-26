// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Panel } from './Panel.js'
import { ConfluenceSection, type ConfluenceSectionProps } from './ConfluenceSection.js'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const header = (): HTMLButtonElement => {
  const found = container.querySelector<HTMLButtonElement>('button[aria-expanded]')
  if (found === null) throw new Error('no panel header')
  return found
}
const body = (): HTMLElement => {
  const found = container.querySelector<HTMLElement>('[id^="lc-panel-"]')
  if (found === null) throw new Error('no panel body')
  return found
}

describe('a collapsible panel', () => {
  it('starts closed unless told otherwise, and opens on click', () => {
    act(() => root.render(<Panel id="t" title="Things">content</Panel>))
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(body().hidden).toBe(true)
    act(() => header().click())
    expect(header().getAttribute('aria-expanded')).toBe('true')
    expect(body().hidden).toBe(false)
  })

  /** Collapsing must not unmount: a half-typed field would be thrown away. */
  it('keeps its content mounted while closed', () => {
    act(() => root.render(<Panel id="t" title="Things"><input aria-label="field" defaultValue="typed" /></Panel>))
    expect(container.querySelector<HTMLInputElement>('input[aria-label="field"]')?.value).toBe('typed')
  })

  it('remembers being opened, per panel', () => {
    act(() => root.render(<Panel id="remembered" title="Things">content</Panel>))
    act(() => header().click())
    act(() => root.unmount())
    root = createRoot(container)
    act(() => root.render(<Panel id="remembered" title="Things">content</Panel>))
    expect(header().getAttribute('aria-expanded')).toBe('true')
  })

  it('is held open while something in it is in progress', () => {
    act(() => root.render(<Panel id="t" title="Things" forceOpen>content</Panel>))
    expect(body().hidden).toBe(false)
  })
})

describe('the Confluence settings', () => {
  const base: ConfluenceSectionProps = {
    settings: { enabled: true, baseUrl: 'https://wiki.example.com', defaultSpace: 'TEAM', caFile: '', rejectUnauthorized: true },
    hasToken: true,
    savedTick: 0,
    test: undefined,
    testing: false,
    onSave: () => {},
    onClearToken: () => {},
    onTest: () => {},
  }

  /** Invariant 7: the token field is write-only, and blank means "keep the stored one". */
  it('never shows a stored token, and saving with the box blank keeps it', () => {
    let saved: { token: string | undefined } | undefined
    act(() =>
      root.render(
        <ConfluenceSection {...base} onSave={(_settings, token) => (saved = { token })} />,
      ),
    )
    const token = container.querySelector<HTMLInputElement>('#lc-confluence-token')
    expect(token?.value).toBe('')
    expect(token?.placeholder).toMatch(/Stored/)

    const space = container.querySelector<HTMLInputElement>('#lc-confluence-space')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(space, 'DOCS')
      space?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')
    act(() => save?.click())
    expect(saved).toEqual({ token: undefined })
  })

  it('warns in plain words when certificate verification is switched off', () => {
    act(() =>
      root.render(<ConfluenceSection {...base} settings={{ ...base.settings, rejectUnauthorized: false }} />),
    )
    expect(container.textContent).toMatch(/including your\s+token/)
  })
})
