// @vitest-environment jsdom
import type { ProfileInput } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProviderForm } from './ProviderForm.js'

/**
 * The GitHub Copilot preset: offered only where VS Code's models can be reached, and once chosen a
 * form with nothing to type but a model - VS Code signs the request, so a key or URL box would mean nothing.
 */

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
})

function render(hostModels: boolean, requested: ProfileInput[] = [], saved: ProfileInput[] = []): void {
  act(() =>
    root.render(
      <ProviderForm
        initial={{ label: '', wireFormat: 'openai', baseUrl: '', model: '', authType: 'apiKey', hasApiKey: false, hasClientSecret: false, hasCertPassphrase: false }}
        onSave={(input) => saved.push(input)}
        onCancel={() => undefined}
        onRequestModels={(input) => requested.push(input)}
        onTestConnection={() => undefined}
        hostModels={hostModels}
        models={['gpt-4.1', 'claude-sonnet-4']}
        modelsLoading={false}
        testRunning={false}
      />,
    ),
  )
}

function presetOptions(): string[] {
  act(() => (container.querySelector('#lc-preset') as HTMLButtonElement).click())
  return [...document.body.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? '')
}

function choose(label: string): void {
  const option = [...document.body.querySelectorAll('[role="option"]')].find((each) => each.textContent === label)
  act(() => option?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
}

describe('the GitHub Copilot preset', () => {
  it('is not offered where VS Code cannot be reached', () => {
    render(false)
    expect(presetOptions()).not.toContain('GitHub Copilot (from VS Code)')
  })

  it('once chosen, asks only for a model, and fetches the list at once', () => {
    const requested: ProfileInput[] = []
    render(true, requested)
    expect(presetOptions()).toContain('GitHub Copilot (from VS Code)')
    choose('GitHub Copilot (from VS Code)')

    expect(container.querySelector('#lc-base-url')).toBeNull()
    expect(container.querySelector('#lc-api-key')).toBeNull()
    expect(container.textContent).not.toContain('Thinking')
    expect(container.textContent).toContain("Copilot's own")
    expect(requested.at(-1)).toMatchObject({ wireFormat: 'vscode-lm', authType: 'none' })
  })

  it('saves with no key, no auth, and the label base URL', () => {
    const saved: ProfileInput[] = []
    render(true, [], saved)
    presetOptions()
    choose('GitHub Copilot (from VS Code)')
    const model = container.querySelector<HTMLInputElement>('input[placeholder*="model" i], input[list], #lc-model')
    if (model !== null) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      act(() => {
        setter?.call(model, 'gpt-4.1')
        model.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')?.click())
    expect(saved[0]).toMatchObject({ wireFormat: 'vscode-lm', authType: 'none', baseUrl: 'vscode://language-models', apiKey: '' })
  })
})
