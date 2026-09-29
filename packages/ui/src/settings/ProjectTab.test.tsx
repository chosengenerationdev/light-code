// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

function render(overrides: Partial<ProjectTabProps> = {}): { saved: string[]; stamps: boolean[]; renames: boolean[] } {
  const saved: string[] = []
  const stamps: boolean[] = []
  const renames: boolean[] = []
  act(() => {
    root.render(
      <ProjectTab
        project={{ type: 'project', hasWorkspace: true, folder: 'pay-api', author: 'ana' }}
        stamp={undefined}
        renames={undefined}
        onSaveName={(name) => saved.push(name)}
        onStamp={(apply) => stamps.push(apply)}
        onRenames={(apply) => renames.push(apply)}
        {...overrides}
      />,
    )
  })
  return { saved, stamps, renames }
}

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

  it('lists exactly what labelling will add before offering to do it', () => {
    const calls = render({
      stamp: {
        type: 'projectStamp',
        running: false,
        entries: [{ kind: 'tool', name: 'ledger', filePath: '/t/ledger.py', adds: { author: 'ana', version: 1 }, approved: true }],
      },
    })
    expect(container.textContent).toContain('ledger')
    expect(container.textContent).toContain('author: ana, version: 1')
    expect(container.textContent).toContain('stay approved here')
    act(() => button('Label 1 file')?.click())
    expect(calls.stamps).toEqual([true])
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
