// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { LspSettings } from '@light-code/core/browser'

import { LanguageServersSection, splitCommand, type LanguageServersState } from './LanguageServersSection.js'

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

const servers: LanguageServersState = {
  provider: 'servers',
  settings: {},
  languages: [
    { language: 'python', label: 'Python', extensions: ['py'], command: 'D:/bin/pyright-langserver.cmd', state: 'available' },
    { language: 'go', label: 'Go', extensions: ['go'], state: 'not installed', detail: 'Install one of: gopls' },
  ],
}

function render(lsp: LanguageServersState | undefined): LspSettings[] {
  const saved: LspSettings[] = []
  act(() => root.render(<LanguageServersSection lsp={lsp} onSave={(s) => saved.push(s)} onRefresh={() => {}} />))
  return saved
}

const button = (label: string, index = 0): HTMLButtonElement =>
  [...container.querySelectorAll('button')].filter((b) => b.textContent === label)[index] as HTMLButtonElement

describe('language servers panel', () => {
  it('shows what was found and what to install', () => {
    render(servers)
    expect(container.textContent).toContain('pyright-langserver.cmd')
    expect(container.textContent).toContain('Install one of: gopls')
  })

  it('turns one language off, and names a command with a quoted path', () => {
    const saved = render(servers)
    act(() => button('Turn off').click())
    expect(saved.at(-1)).toEqual({ servers: { python: false } })
    expect(splitCommand('"D:/Program Files/lsp/ls.exe" --stdio')).toEqual(['D:/Program Files/lsp/ls.exe', '--stdio'])
  })

  it('in VS Code says the editor provides it and offers no server controls', () => {
    render({ provider: 'host', settings: {}, languages: [] })
    expect(container.textContent).toContain("VS Code's own language support")
    expect(button('Turn off')).toBeUndefined()
  })

  it('is absent where nothing can provide diagnostics', () => {
    render({ provider: 'none', settings: {}, languages: [] })
    expect(container.textContent).toBe('')
  })
})
