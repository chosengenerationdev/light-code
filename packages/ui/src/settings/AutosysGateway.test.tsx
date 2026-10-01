// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ATLASSIAN_PRODUCTS, type AtlassianSettingsView, type AutosysGatewayView } from '@light-code/core/browser'
import { AtlassianSection, type GatewaySave } from './AtlassianTab.js'

/*
 * Reported: site address, token URL, client id and secret, certificate and key all filled in, and
 * Test connection still said "save the site address and token first". The gateway had a Save of its
 * own, and the Save at the bottom of the panel — the one anybody presses — left it out. One Save now
 * carries everything, and Test says what is actually missing.
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

const autosys = ATLASSIAN_PRODUCTS.find((info) => info.id === 'autosys')!
const settings: AtlassianSettingsView = { enabled: false, baseUrl: '', caFile: '', rejectUnauthorized: true, defaults: {} }
const gateway: AutosysGatewayView = {
  enabled: false, tokenUrl: '', clientId: '', scope: '', grantType: '', clientAuthentication: 'body', tokenPath: '', expiresInPath: '',
  tokenHeaderName: '', tokenHeaderPrefix: '', extraHeaders: '', extraTokenParams: '', sendBasic: false, basicHeaderName: '', certFile: '', keyFile: '', pfxFile: '',
  useGlobalClientCertificate: true, hasClientSecret: false, hasPassphrase: false,
}

function render(overrides: { settings?: AtlassianSettingsView; gateway?: AutosysGatewayView; hasToken?: boolean } = {}) {
  const saves: [AtlassianSettingsView, string | undefined, GatewaySave | undefined][] = []
  act(() =>
    root.render(
      <AtlassianSection
        info={autosys}
        settings={overrides.settings ?? settings}
        hasToken={overrides.hasToken ?? false}
        gateway={overrides.gateway ?? gateway}
        savedTick={0}
        test={undefined}
        testing={false}
        onSave={(s, t, g) => saves.push([s, t, g])}
        onClearToken={() => {}}
        onTest={() => {}}
        onClearGatewaySecret={() => {}}
      />,
    ),
  )
  return saves
}

function type(selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const buttonByText = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text)!

describe('the AutoSys panel with an API gateway', () => {
  it('sends the gateway with the one Save, ticked because a token URL was typed', () => {
    const saves = render()
    type('#lc-autosys-url', 'https://autosys.test')
    type('#lc-autosys-gw-tokenUrl', 'https://gw.test/oauth/token')
    type('#lc-autosys-gw-clientId', 'lc-app')
    type('#lc-autosys-gw-secret', 's3cret')
    type('#lc-autosys-gw-certFile', 'client.crt')
    type('#lc-autosys-gw-keyFile', 'client.key')
    act(() => buttonByText('Save').click())

    const [, , sent] = saves[0]!
    expect(saves[0]![0].baseUrl).toBe('https://autosys.test')
    expect(sent?.settings).toMatchObject({ enabled: true, tokenUrl: 'https://gw.test/oauth/token', clientId: 'lc-app', certFile: 'client.crt', keyFile: 'client.key' })
    expect(sent?.clientSecret).toBe('s3cret')
    expect(buttonByText('Save gateway')).toBeUndefined()
  })

  it('says what Test connection is waiting for, on the page', () => {
    render()
    type('#lc-autosys-url', 'https://autosys.test')
    expect(container.textContent).toContain('Save your changes first')

    render({ settings: { ...settings, baseUrl: 'https://autosys.test' } })
    expect(container.textContent).toContain('tick "Sign in through the gateway"')

    render({ settings: { ...settings, baseUrl: 'https://autosys.test' }, gateway: { ...gateway, enabled: true, tokenUrl: 'https://gw.test/t', clientId: 'a' } })
    expect(container.textContent).toContain('Enter the gateway client secret and save.')

    render({ settings: { ...settings, baseUrl: 'https://autosys.test' }, gateway: { ...gateway, enabled: true, tokenUrl: 'https://gw.test/t', clientId: 'a', hasClientSecret: true } })
    expect(buttonByText('Test connection').disabled).toBe(false)
  })

  /* Reported next: the gateway wants its token and AutoSys's Basic sign-in on the same request. */
  it('offers Basic alongside the token, and warns before saving when both would share a header', () => {
    const saves = render({ settings: { ...settings, baseUrl: 'https://autosys.test' }, gateway: { ...gateway, enabled: true, tokenUrl: 'https://gw.test/t', clientId: 'a', hasClientSecret: true } })
    const box = [...container.querySelectorAll('label')].find((label) => label.textContent?.includes('Also send the AutoSys username'))!.querySelector('input')!
    act(() => box.click())
    expect(container.textContent).toContain('would both go in the Authorization header')
    type('#lc-autosys-gw-tokenHeaderName', 'x-apigee-token')
    expect(container.textContent).not.toContain('would both go in')
    act(() => buttonByText('Save').click())
    expect(saves[0]?.[2]?.settings).toMatchObject({ sendBasic: true, tokenHeaderName: 'x-apigee-token' })
  })
})
