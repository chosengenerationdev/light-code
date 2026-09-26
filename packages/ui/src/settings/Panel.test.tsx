// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Panel } from './Panel.js'
import { ATLASSIAN_PRODUCTS } from '@light-code/core/browser'

import { AtlassianSection, AtlassianTab, type AtlassianSectionProps } from './AtlassianTab.js'

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

describe('the Atlassian settings', () => {
  const confluence = ATLASSIAN_PRODUCTS.find((product) => product.id === 'confluence')!
  const base: AtlassianSectionProps = {
    info: confluence,
    settings: {
      enabled: true,
      baseUrl: 'https://wiki.example.com',
      caFile: '',
      rejectUnauthorized: true,
      defaults: { defaultSpace: 'TEAM' },
    },
    hasToken: true,
    savedTick: 0,
    test: undefined,
    testing: false,
    onSave: () => {},
    onClearToken: () => {},
    onTest: () => {},
  }

  const type = (input: HTMLInputElement | null, value: string): void => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  /** Invariant 7: the token field is write-only, and blank means "keep the stored one". */
  it('never shows a stored token, and saving with the box blank keeps it', () => {
    let saved: { token: string | undefined; space: string | undefined } | undefined
    act(() =>
      root.render(
        <AtlassianSection
          {...base}
          onSave={(settings, token) => (saved = { token, space: settings.defaults['defaultSpace'] })}
        />,
      ),
    )
    const token = container.querySelector<HTMLInputElement>('#lc-confluence-token')
    expect(token?.value).toBe('')
    expect(token?.placeholder).toMatch(/Stored/)

    type(container.querySelector<HTMLInputElement>('#lc-confluence-defaultSpace'), 'DOCS')
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')
    act(() => save?.click())
    expect(saved).toEqual({ token: undefined, space: 'DOCS' })
  })

  it('warns in plain words when certificate verification is switched off', () => {
    act(() =>
      root.render(<AtlassianSection {...base} settings={{ ...base.settings, rejectUnauthorized: false }} />),
    )
    expect(container.textContent).toMatch(/including your\s+token/)
  })

  /** Separate panels, and each saves as its own product — a Jira save must never land on Confluence. */
  it('shows Confluence, Jira and Bitbucket as separate panels, each with its own defaults', () => {
    const blank = { enabled: false, baseUrl: '', caFile: '', rejectUnauthorized: true, defaults: {} }
    const saves: string[] = []
    act(() =>
      root.render(
        <AtlassianTab
          products={{
            confluence: { settings: blank, hasToken: false },
            jira: { settings: blank, hasToken: false },
            bitbucket: { settings: blank, hasToken: false },
          }}
          savedTicks={{}}
          tests={{}}
          testing={{}}
          onSave={(product) => saves.push(product)}
          onClearToken={() => {}}
          onTest={() => {}}
        />,
      ),
    )
    const titles = [...container.querySelectorAll('button[aria-expanded]')].map((button) => button.textContent ?? '')
    expect(titles.some((title) => title.includes('Confluence'))).toBe(true)
    expect(titles.some((title) => title.includes('Jira'))).toBe(true)
    expect(titles.some((title) => title.includes('Bitbucket'))).toBe(true)
    expect(container.querySelector('#lc-jira-defaultProject')).not.toBeNull()
    expect(container.querySelector('#lc-bitbucket-defaultRepo')).not.toBeNull()

    type(container.querySelector<HTMLInputElement>('#lc-jira-defaultProject'), 'ABC')
    const jiraSave = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save' && !(button as HTMLButtonElement).disabled,
    )
    act(() => jiraSave?.click())
    expect(saves).toEqual(['jira'])
  })
})
