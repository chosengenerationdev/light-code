// @vitest-environment jsdom
import type { ProfileInput, Transport } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderForm } from './ProviderForm.js'
import { SeatModelPicker } from './SeatModelPicker.js'

/**
 * Asked for: "just select the provider and then select the model for that seat", and "why cant we directly show the drop
 * down where user dont have to click refresh".
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {}
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe("a seat's model", () => {
  it("loads the chosen provider's models by itself and saves the one chosen", () => {
    const sent: Record<string, unknown>[] = []
    const listeners = new Set<(message: unknown) => void>()
    const transport = {
      post: (message: unknown) => sent.push(message as Record<string, unknown>),
      onMessage: (listener: (message: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as unknown as Transport
    const chosen: (string | undefined)[] = []
    act(() => root.render(<SeatModelPicker transport={transport} profileId="gw" value={undefined} onChange={(model) => chosen.push(model)} />))
    expect(sent).toContainEqual({ type: 'requestProfileModels', profileId: 'gw' })
    act(() => listeners.forEach((listener) => listener({ type: 'profileModels', profileId: 'gw', models: ['gemini-flash', 'gemini-pro'], model: 'gemini-pro' })))
    act(() => (container.querySelector('[aria-label="Model for this seat"]') as HTMLButtonElement).click())
    const options = [...document.body.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '')
    expect(options[0]).toContain("The profile's own model (gemini-pro)")
    expect(options).toContain('gemini-flash')
    const flash = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'gemini-flash') as HTMLElement
    act(() => flash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(chosen).toEqual(['gemini-flash'])
  })
})

describe('the provider form', () => {
  it('loads the model list by itself when it opens on a saved profile, with no Refresh', () => {
    vi.useFakeTimers()
    const requested: ProfileInput[] = []
    act(() =>
      root.render(
        <ProviderForm
          initial={{ label: 'Gateway', wireFormat: 'openai', baseUrl: 'https://gw.example.internal/v1', model: 'm', authType: 'apiKey', hasApiKey: true, hasClientSecret: false, hasCertPassphrase: false }}
          onSave={() => undefined}
          onCancel={() => undefined}
          onRequestModels={(input) => requested.push(input)}
          onTestConnection={() => undefined}
          models={[]}
          modelsLoading={false}
          testRunning={false}
        />,
      ),
    )
    act(() => vi.advanceTimersByTime(1_000))
    expect(requested).toHaveLength(1)
    // The dropdown is there from the start, saying what it is waiting for.
    expect(container.querySelector('[aria-label="Choose from the gateway\'s catalogue"]')).not.toBeNull()
  })
})
