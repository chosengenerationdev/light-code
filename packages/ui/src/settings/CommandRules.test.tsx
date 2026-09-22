// @vitest-environment jsdom
import type { CommandRules } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandRulesSection } from './CommandRules.js'

/**
 * The panel that was missing, and the two things about it that are not cosmetic.
 *
 * Both lists were in the config schema and in the approval path from the day they were added,
 * with nowhere to edit them — so "how do I add my own rule for Auto mode" had no answer but
 * hand-editing `config.json`, which nobody was told either.
 */

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

function render(
  rules: CommandRules,
  onSave: (next: CommandRules) => void = () => {},
  modeId?: string,
): void {
  act(() =>
    root.render(
      <CommandRulesSection
        rules={rules}
        onSave={onSave}
        {...(modeId !== undefined ? { modeId } : {})}
      />,
    ),
  )
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((each) => each.textContent === label)
}

function checkbox(label: string): HTMLInputElement | undefined {
  return [...container.querySelectorAll('label')]
    .filter((each) => each.textContent?.includes(label) === true)
    .map((each) => each.querySelector('input[type="checkbox"]'))
    .find((each): each is HTMLInputElement => each !== null)
}

describe('CommandRulesSection', () => {
  it('shows what is stored, in both lists', () => {
    render({ risky: [{ contains: 'terraform apply' }], safe: ['dotnet build'] })
    const values = [...container.querySelectorAll('input[type="text"]')].map(
      (input) => (input as HTMLInputElement).value,
    )
    expect(values).toContain('terraform apply')
    expect(values).toContain('dotnet build')
  })

  it('adds a safe command and reports it back', () => {
    let saved: CommandRules | undefined
    render({}, (next) => void (saved = next))

    act(() => button('Add a command')?.click())
    const field = [...container.querySelectorAll('input[type="text"]')].at(-1) as HTMLInputElement
    act(() => {
      // React tracks the previous value on the node, so setting `.value` directly is ignored
      // unless the native setter is used. Without this the input reverts and nothing is saved.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(field, 'dotnet build')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => button('Save rules')?.click())

    expect(saved?.safe).toEqual(['dotnet build'])
  })

  it('treats both built-in lists as on unless explicitly off', () => {
    /*
     * The default is *absent*, not `true` — `config.json` stays sparse, and the approval path
     * reads "on unless explicitly false". A panel that rendered an absent key as unticked would
     * report protection as switched off when it is not, and then switch it off for real on the
     * next save.
     */
    render({})
    expect(checkbox('Also use the built-in list')?.checked).toBe(true)

    render({ builtinSafe: false })
    const boxes = [...container.querySelectorAll('label')]
      .filter((each) => each.textContent?.includes('Also use the built-in list') === true)
      .map((each) => each.querySelector('input[type="checkbox"]') as HTMLInputElement)
    // Risky first, safe second — the order they are rendered in.
    expect(boxes[0]?.checked).toBe(true)
    expect(boxes[1]?.checked).toBe(false)
  })

  it('shows the built-in commands rather than summarising them', () => {
    /*
     * The question that brings anybody to this panel is "why did it ask about X?", and a
     * sentence naming three examples cannot answer it. The list is rendered from core's own
     * constant, so the panel and the approval path cannot disagree about what is covered.
     */
    render({})
    expect(container.textContent).toContain('findstr ')
    expect(container.textContent).toContain('type ')
    expect(container.textContent).toContain('git rev-parse')
  })

  it('says that Auto mode is the only mode the safe list applies in', () => {
    // The list is a real relaxation, and somebody reading this panel has to be able to tell
    // which of the two halves is the one that fails open.
    render({})
    expect(container.textContent).toContain('Run without asking, in Auto mode')
  })

  it('says plainly when the safe list is not in force', () => {
    /*
     * The reported bug read as Auto mode ignoring its own list. The stored mode was `junior`,
     * which resolves to Agent team, which has no safe-command relaxation - so nothing was broken
     * and nothing said so. A panel describing a rule without saying whether it applies is one you
     * can read twice and still be wrong about.
     */
    render({}, () => {}, 'agent-team')
    expect(container.textContent).toContain('not in Auto mode')

    render({}, () => {}, 'auto')
    expect(container.textContent).toContain('in force now')
    expect(container.textContent).not.toContain('not in Auto mode')
  })

  it('survives being rendered before the host has answered', () => {
    // What `SettingsNavigation.test.tsx` covers for every tab, pinned here too because this
    // component threw on exactly that when it was first written.
    expect(() =>
      render(undefined as unknown as CommandRules),
    ).not.toThrow()
  })
})
