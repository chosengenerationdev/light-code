// @vitest-environment jsdom
import type { ProfileSummary } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProvidersTab } from './ProvidersTab.js'

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

const duplicated: string[] = []

const profiles = [
  { id: 'shared:gateway', label: 'Corporate gateway', baseUrl: 'https://gateway.internal/v1', model: 'gpt-4o', hasApiKey: true },
  { id: 'mine', label: 'My own key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasApiKey: true },
] as unknown as ProfileSummary[]

function render(sharedProfileIds?: string[]): void {
  duplicated.length = 0
  act(() =>
    root.render(
      <ProvidersTab
        profiles={profiles}
        activeProfileId="shared:gateway"
        onSave={() => undefined}
        onDuplicate={(id) => duplicated.push(id)}
        onDelete={() => undefined}
        onSetActive={() => undefined}
        onExport={() => undefined}
        onImport={() => undefined}
        onRequestModels={() => undefined}
        onTestConnection={() => undefined}
        onEditingChange={() => undefined}
        models={[]}
        modelsLoading={false}
        testRunning={false}
        {...(sharedProfileIds !== undefined ? { sharedProfileIds } : {})}
      />,
    ),
  )
}

/*
 * By the row's own id rather than by searching for text: every ancestor of a label also contains
 * it, so a text search finds an outer container holding both rows and every button in the list.
 */
const rowFor = (id: string): Element | null => container.querySelector(`[data-profile="${id}"]`)
const actionsIn = (id: string): string[] =>
  [...(rowFor(id)?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label') ?? '')

describe('a profile the administrator provides', () => {
  /**
   * The reason this exists. A shared server strips these from anything written to a user's file,
   * so an Edit that appeared to work would simply not be there next time. Offering the control is
   * the lie, not the discarding.
   */
  it('offers no Edit and no Delete', () => {
    render(['shared:gateway'])
    const actions = actionsIn('shared:gateway')
    expect(actions).not.toContain('Edit')
    expect(actions).not.toContain('Delete')
  })

  /** The useful move: a copy that *is* yours, pointed at your own key. */
  it('can still be duplicated, which is how you make one of your own', () => {
    render(['shared:gateway'])
    expect(actionsIn('shared:gateway')).toContain('Duplicate')

    const button = [...(rowFor('shared:gateway')?.querySelectorAll('button') ?? [])].find(
      (b) => b.getAttribute('aria-label') === 'Duplicate',
    )
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(duplicated).toEqual(['shared:gateway'])
  })

  /** Missing controls need a visible reason, or they read as a bug. */
  it('says why, rather than just being short of buttons', () => {
    render(['shared:gateway'])
    expect(container.textContent).toContain('provided')
    expect(container.textContent).toContain('administrator')
  })

  it('leaves the user’s own profile fully editable', () => {
    render(['shared:gateway'])
    const actions = actionsIn('mine')
    expect(actions).toContain('Edit')
    expect(actions).toContain('Delete')
  })

  /** The extension passes none of this, and must behave exactly as it always has. */
  it('treats every profile as the user’s when the host names none', () => {
    render()
    expect(actionsIn('shared:gateway')).toContain('Edit')
    expect(container.textContent).not.toContain('provided')
  })
})
