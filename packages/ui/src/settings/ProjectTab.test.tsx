// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ProjectStampMessage } from '@light-code/core/browser'

import { ProjectTab, type ProjectTabProps } from './ProjectTab.js'

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

function render(overrides: Partial<ProjectTabProps> = {}): {
  saved: string[]
  stamps: boolean[]
  renames: boolean[]
  naming: Parameters<ProjectTabProps['onSaveNaming']>[0][]
} {
  const saved: string[] = []
  const stamps: boolean[] = []
  const renames: boolean[] = []
  const naming: Parameters<ProjectTabProps['onSaveNaming']>[0][] = []
  act(() => {
    root.render(
      <ProjectTab
        project={{ type: 'project', hasWorkspace: true, folder: 'pay-api', author: 'ana' }}
        stamp={undefined}
        renames={undefined}
        onSaveName={(name) => saved.push(name)}
        onSaveSearchScope={() => {}}
        onStamp={(apply) => stamps.push(apply)}
        onRenames={(apply) => renames.push(apply)}
        onSaveNaming={(value) => naming.push(value)}
        onAttachTeamAlias={() => {}}
        aliasResult={undefined}
        {...overrides}
      />,
    )
  })
  return { saved, stamps, renames, naming }
}

/** A button whose whole text is this — the panel header also contains the word "Label". */
const exactButton = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text)

function type(selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The Save beside a field: the next button after it in the same row. */
function saveBeside(selector: string): HTMLButtonElement {
  return container.querySelector(selector)!.parentElement!.querySelector('button')!
}

describe('shared names, moved here from Search and Skills', () => {
  it('saves each box on its own, so saving one never touches another', () => {
    const calls = render({
      project: {
        type: 'project',
        hasWorkspace: true,
        folder: 'pay-api',
        loginName: 'ana',
        indexName: 'pay-light-code-ana-1',
        codeAliases: ['payments-code'],
        defaultIndexPrefix: 'light-code',
      },
    })
    expect(container.querySelector<HTMLInputElement>('#project-code-alias')?.value).toBe('payments-code')
    expect(container.querySelector<HTMLInputElement>('#project-owner')?.placeholder).toContain('ana')

    type('#project-owner', 'Ana Silva')
    act(() => saveBeside('#project-owner').click())
    type('#project-prefix', 'fin')
    act(() => saveBeside('#project-prefix').click())
    type('#project-code-alias', 'payments-code, platform-code')
    act(() => saveBeside('#project-code-alias').click())

    expect(calls.naming).toEqual([
      { owner: 'Ana Silva' },
      { indexPrefix: 'fin' },
      { indexAliases: ['payments-code', 'platform-code'] },
    ])
  })

  it('refuses an alias OpenSearch would refuse, before it is saved', () => {
    render()
    type('#project-code-alias', 'Has Spaces')
    expect(saveBeside('#project-code-alias').disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })
})

const button = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text))

describe('Settings → Project', () => {
  it('saves the name typed, and offers the folder name when none is set', () => {
    const calls = render()
    const input = container.querySelector<HTMLInputElement>('#project-name')!
    expect(input.placeholder).toContain('pay-api')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Payments')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => button('Save')?.click())
    expect(calls.saved).toEqual(['Payments'])
  })

  it('will not look for indexes to move until a name is set', () => {
    render()
    expect(button('Find indexes to move')?.disabled).toBe(true)
  })

  /*
   * Files are mixed — colleagues', another team's from the bucket — so author and project are never
   * guessed: only facts are automatic, and labels go where somebody ticked.
   */
  describe('labelling existing files without guessing', () => {
    const entries: ProjectStampMessage['entries'] = [
      {
        kind: 'tool',
        name: 'ledger',
        filePath: '/p/.lightcode/tools/ledger.py',
        location: 'project',
        current: {},
        automatic: { version: 1, updated: '2026-01-02T03:04:05Z' },
        needsLabels: true,
        suggestion: { author: 'Ana Silva', source: 'git: the commit that added this file' },
        approved: true,
      },
      {
        kind: 'skill',
        name: 'deploy',
        filePath: '/p/.lightcode/skills/deploy.md',
        location: 'project',
        current: { project: 'Payments' },
        automatic: { version: 1 },
        needsLabels: true,
      },
      {
        kind: 'skill',
        name: 'lending-rules',
        filePath: '/mirror/lending-rules.md',
        location: 'bucket',
        current: {},
        automatic: { version: 1 },
        needsLabels: true,
      },
    ]
    const withLabels = (): { stamps: boolean[]; sent: unknown[] } => {
      const sent: unknown[] = []
      const calls = render({
        stamp: { type: 'projectStamp', running: false, entries },
        onStamp: (apply, labels) => {
          if (apply) sent.push(labels)
        },
      })
      return { stamps: calls.stamps, sent }
    }
    const tick = (name: string): void => {
      const row = [...container.querySelectorAll('label')].find((label) => label.textContent?.includes(name))!
      act(() => row.querySelector('input')!.click())
    }

    it('sends no author or project unless a row is ticked', () => {
      const { sent } = withLabels()
      expect(container.textContent).toContain('Suggested: author Ana Silva')
      expect(container.textContent).toContain('bucket — untouched unless ticked')
      act(() => exactButton('Label')?.click())
      expect(sent).toEqual([[]])
    })

    it('prefills a ticked row from its evidence, and never overwrites a label already there', () => {
      const { sent } = withLabels()
      tick('ledger')
      tick('deploy')
      type('[aria-label="Author of deploy"]', 'bo')
      act(() => exactButton('Label')?.click())
      expect(sent).toEqual([
        [
          { filePath: '/p/.lightcode/tools/ledger.py', author: 'Ana Silva' },
          { filePath: '/p/.lightcode/skills/deploy.md', author: 'bo' },
        ],
      ])
      // deploy already says Payments, so its project box is shown and locked.
      expect(container.querySelector<HTMLInputElement>('[aria-label="Project of deploy"]')?.disabled).toBe(true)
    })

    it('fills every ticked row at once, and ticks the ones with a suggestion in one go', () => {
      const { sent } = withLabels()
      act(() => button('Tick the 1 with a suggestion')?.click())
      tick('lending-rules')
      type('[aria-label="Project for ticked rows"]', 'Lending')
      act(() => button('Fill ticked rows')?.click())
      act(() => exactButton('Label')?.click())
      expect(sent).toEqual([
        [
          { filePath: '/p/.lightcode/tools/ledger.py', author: 'Ana Silva', project: 'Lending' },
          { filePath: '/mirror/lending-rules.md', project: 'Lending' },
        ],
      ])
    })
  })

  it('names every index it will copy, old to new', () => {
    render({
      project: { type: 'project', hasWorkspace: true, configured: 'Payments', folder: 'pay-api' },
      renames: { type: 'indexRenames', running: false, plans: [{ kind: 'codebase', from: 'lc-ana-1', to: 'payments-lc-ana-1' }] },
    })
    expect(container.textContent).toContain('codebase: lc-ana-1 → payments-lc-ana-1')
    expect(button('Copy 1 index')).toBeDefined()
  })
})

describe('the default search scope', () => {
  // jsdom has no layout, so the listbox's scrollIntoView does not exist there.
  Element.prototype.scrollIntoView ??= () => {}

  it('shows the saved choice and saves a new one', () => {
    const chosen: string[] = []
    render({
      project: { type: 'project', hasWorkspace: true, folder: 'pay-api', searchScope: 'author' },
      onSaveSearchScope: (scope) => chosen.push(scope),
    })
    const trigger = container.querySelector<HTMLElement>('#project-scope')!
    expect(trigger.textContent).toContain('Only mine')
    act(() => trigger.click())
    const everything = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes('Everything'))
    // The listbox picks on pointerdown, before the focus change a click would cause.
    act(() => everything?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(chosen).toEqual(['all'])
  })
})
