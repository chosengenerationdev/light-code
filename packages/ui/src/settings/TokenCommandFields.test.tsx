// @vitest-environment jsdom
import type { TokenCommandInput } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TokenCommandFields } from './TokenCommandFields.js'

/**
 * The form is a *shape* over one stored field, and must never lose what it cannot express.
 *
 * A friendly editor that silently cannot round-trip the config file is worse than no editor: it
 * rewrites a working credential into whatever it happens to understand, and the profile keeps
 * working until the current token expires. So the mode is derived from the stored command rather
 * than remembered separately, and a command it cannot show as a script opens as raw argv.
 */
let container: HTMLDivElement
let root: Root
let latest: TokenCommandInput | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  latest = undefined
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(value: TokenCommandInput): void {
  act(() =>
    root.render(<TokenCommandFields value={value} onChange={(next) => (latest = next)} />),
  )
}

/** React 19 ignores a directly assigned `.value`; the native setter is what it observes. */
function type(selector: string, value: string): void {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
  if (field === null) throw new Error(`no field ${selector}`)
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  act(() => {
    Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('editing a token command', () => {
  it('opens a python script as the script form', () => {
    render({ command: ['python', 'C:\\tools\\get_token.py'] })
    expect(container.querySelector('#lc-token-script')).not.toBeNull()
    expect(container.querySelector<HTMLInputElement>('#lc-token-interpreter')?.value).toBe('python')
  })

  it('opens anything else as raw argv rather than mangling it', () => {
    // `python -c "..."` cannot be shown as "an interpreter and a file", so it must not try.
    render({ command: ['python', '-c', 'import lib; print(lib.token())'] })
    expect(container.querySelector('#lc-token-raw')).not.toBeNull()
    expect(container.querySelector('#lc-token-script')).toBeNull()
  })

  it('keeps a raw command byte-identical when nothing is edited', () => {
    const original = ['python', '-c', 'import lib; print(lib.token())']
    render({ command: original })
    // Round-tripping through the textarea must reproduce exactly what was stored.
    expect(container.querySelector<HTMLTextAreaElement>('#lc-token-raw')?.value).toBe(original.join('\n'))
  })

  it('builds argv from the script fields', () => {
    render({ command: ['python', 'old.py'] })
    type('#lc-token-script', 'C:\\tools\\get_token.py')
    expect(latest?.command).toEqual(['python', 'C:\\tools\\get_token.py'])

    render({ command: ['python', 'C:\\tools\\get_token.py'] })
    type('#lc-token-interpreter', 'C:\\venv\\Scripts\\python.exe')
    expect(latest?.command).toEqual(['C:\\venv\\Scripts\\python.exe', 'C:\\tools\\get_token.py'])
  })

  it('keeps an argument containing a space as one argument', () => {
    /*
     * The reason arguments are one per line rather than a space-separated box. Nothing is parsed
     * by a shell, so splitting on spaces here would invent an argument boundary that the spawn
     * does not have.
     */
    render({ command: ['python', 'get_token.py'] })
    type('#lc-token-args', 'C:\\Program Files\\thing\\conf.ini')
    expect(latest?.command).toEqual(['python', 'get_token.py', 'C:\\Program Files\\thing\\conf.ini'])
  })

  it('drops blank argument lines but never the interpreter or the script', () => {
    render({ command: ['python', 'get_token.py'] })
    type('#lc-token-args', '--env\n\nprod\n')
    expect(latest?.command).toEqual(['python', 'get_token.py', '--env', 'prod'])
  })

  it('starts a new profile in the script form', () => {
    render({ command: [] })
    expect(container.querySelector('#lc-token-script')).not.toBeNull()
  })
})
