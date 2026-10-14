// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NetworkSettingsSummary } from '@light-code/core/browser'
import { NetworkTab } from './NetworkTab.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function render(settings: NetworkSettingsSummary, saves: { http: string; https: string; noProxy: string }[]): void {
  act(() =>
    root.render(
      <NetworkTab settings={settings} onSave={() => undefined} onSaveProxy={(p) => saves.push(p)} onBrowse={() => undefined} pickedPath={undefined} />,
    ),
  )
}

function type(id: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the http_request proxy panel', () => {
  it('sends the address with its login, and says a password is stored without showing it', () => {
    const saves: { http: string; https: string; noProxy: string }[] = []
    render({ tls: {}, hasPassphrase: false, proxy: { https: 'http://ann@proxy.corp:8080', httpHasPassword: false, httpsHasPassword: true } }, saves)
    expect(container.querySelector<HTMLInputElement>('#net-proxy-https')!.value).toBe('http://ann@proxy.corp:8080')
    expect(container.textContent).toContain('Password stored')
    type('net-proxy-http', 'http://ann:pw@proxy.corp:8080')
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save proxy')!
    act(() => button.click())
    expect(saves).toEqual([{ http: 'http://ann:pw@proxy.corp:8080', https: 'http://ann@proxy.corp:8080', noProxy: '' }])
  })

  it('shows a refused save on the panel, where it was made', () => {
    render({ tls: {}, hasPassphrase: false, proxy: { httpHasPassword: false, httpsHasPassword: false }, proxyError: 'The HTTP proxy "x y" is not an address.' }, [])
    expect(container.textContent).toContain('is not an address')
  })
})
