// @vitest-environment jsdom
import { resolveSessionVariables, type SessionVariable } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { VariablesTab } from './VariablesTab.js'

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

const savedUser: SessionVariable[][] = []
const savedAdmin: SessionVariable[][] = []
const savedIds: string[][] = []

const admin: SessionVariable[] = [{ name: 'REGISTRY', value: 'https://pypi.internal/simple' }]
const user: SessionVariable[] = [
  { name: 'REGISTRY', value: 'https://pypi.org/simple' },
  { name: 'MY_TICKET', value: 'ABC-1234' },
]

function render(options: { canEditAdmin?: boolean; user?: SessionVariable[]; admin?: SessionVariable[] } = {}): void {
  savedUser.length = 0
  savedAdmin.length = 0
  savedIds.length = 0
  const u = options.user ?? user
  const a = options.admin ?? admin
  act(() =>
    root.render(
      <VariablesTab
        user={u}
        admin={a}
        resolved={resolveSessionVariables(a, u)}
        adminIds={['entra-alice']}
        canEditAdmin={options.canEditAdmin ?? false}
        onSaveUser={(next) => savedUser.push(next)}
        onSaveAdmin={(next) => savedAdmin.push(next)}
        onSaveAdminIds={(ids) => savedIds.push(ids)}
      />,
    ),
  )
}

const inputs = (label: string): HTMLInputElement[] =>
  [...container.querySelectorAll<HTMLInputElement>(`input[aria-label="${label}"]`)]
const buttons = (text: string): HTMLButtonElement[] =>
  [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)

const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the variables panel', () => {
  it('shows both scopes', () => {
    render()
    expect(container.textContent).toContain('Yours')
    expect(container.textContent).toContain("Everyone's")
    expect(inputs('Variable name').map((input) => input.value)).toContain('MY_TICKET')
  })

  /**
   * The reason the panel exists. Without it a user edits a value that will never apply and sees
   * nothing to say so — the resolver already carries the loser precisely for this.
   */
  it('says when the administrator has overridden one of yours, and shows what wins', () => {
    render()
    expect(container.textContent).toContain('overridden')
    expect(container.textContent).toContain('https://pypi.internal/simple')
  })

  it('does not mark a variable nobody overrode', () => {
    render({ admin: [] })
    expect(container.textContent).not.toContain('overridden')
  })

  /**
   * Said where a value is typed, not only in the hosting document. Someone entering a value is
   * entitled to know another user's assistant can read it.
   */
  it('warns that these are not secret, in the panel itself', () => {
    render()
    expect(container.textContent).toContain('Not secret')
    expect(container.textContent).toContain('Providers')
  })
})

describe('editing', () => {
  it('saves the user’s list', () => {
    render()
    const first = inputs('Variable value')[0]
    if (first === undefined) throw new Error('no value field')
    type(first, 'https://changed/simple')
    act(() => buttons('Save')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(savedUser[0]?.[0]?.value).toBe('https://changed/simple')
  })

  /** Refused where it is typed: a name a shell cannot set would otherwise fail silently later. */
  it('refuses a name the platform cannot express, and says why', () => {
    render()
    const name = inputs('Variable name')[0]
    if (name === undefined) throw new Error('no name field')
    type(name, 'not valid')
    expect(container.textContent).toContain('cannot be set as an environment variable')
    expect(buttons('Save')[0]?.disabled).toBe(true)
  })

  it('will not save an empty name', () => {
    render()
    act(() => buttons('Add')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(buttons('Save')[0]?.disabled).toBe(true)
    expect(container.textContent).toContain('A name is required')
  })

  it('keeps Save disabled until something changes', () => {
    render()
    expect(buttons('Save')[0]?.disabled).toBe(true)
  })
})

describe('who may edit the shared half', () => {
  /** A field that will be refused on save should not look editable — §15, applied to people. */
  it('renders the administrator’s variables read-only for an ordinary user', () => {
    render({ canEditAdmin: false })
    const adminName = inputs('Variable name').find((input) => input.value === 'REGISTRY' && input.disabled)
    expect(adminName).toBeDefined()
    // One Save button, for their own list.
    expect(buttons('Save')).toHaveLength(1)
  })

  it('lets an administrator edit them, and offers the administrator list', () => {
    render({ canEditAdmin: true })
    expect(container.querySelector('textarea[aria-label="Administrator ids"]')).not.toBeNull()
    expect(buttons('Save').length).toBeGreaterThan(1)
  })

  it('does not offer the administrator list to an ordinary user', () => {
    render({ canEditAdmin: false })
    expect(container.querySelector('textarea[aria-label="Administrator ids"]')).toBeNull()
  })

  it('saves administrator ids one per line, ignoring blanks', () => {
    render({ canEditAdmin: true })
    const box = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Administrator ids"]')
    if (box === null) throw new Error('no admin id field')
    type(box, 'entra-alice\n\n  entra-bob  \n')
    const save = [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Save').at(-1)
    act(() => save?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(savedIds[0]).toEqual(['entra-alice', 'entra-bob'])
  })
})
