// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ExpertTab, type ExpertState } from './ExpertTab.js'

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

const expert: ExpertState = {
  enabled: true,
  available: true,
  path: 'claude',
  version: '2.1.227',
  model: 'sonnet',
  maxSpendUsd: 0,
  maxConsultations: 0,
}

const assessment = {
  model: 'deepseek-chat',
  profileLabel: 'office gateway',
  assessedAt: Date.UTC(2026, 7, 15),
  verdict: 'Trust it with small edits. Do not trust it with multi-file refactors.',
  costUsd: 0.21,
  probes: [
    { id: 'a', measures: 'Following an exact output format', prompt: 'p', answer: 'alpha\nbeta\ngamma' },
    { id: 'b', measures: 'Admitting it does not know', prompt: 'p', answer: '', error: 'timed out' },
  ],
}

function render(state: ExpertState | undefined): void {
  act(() =>
    root.render(
      <ExpertTab
        expert={state}
        onSave={() => {}}
        onRecheck={() => {}}
        onAssess={() => {}}
        onClearAssessment={() => {}}
      />,
    ),
  )
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((element) =>
    (element.textContent ?? '').includes(label),
  )
  if (found === undefined) throw new Error(`no button "${label}" — saw: ${container.textContent ?? ''}`)
  return found
}

describe('the junior assessment in the Expert tab', () => {
  it('offers to run one when there is none', () => {
    render(expert)
    expect(container.textContent).toContain('How good is the junior?')
    expect(button('Assess it')).toBeTruthy()
  })

  /** The reported symptom: it ran, and then the tab showed nothing. */
  it('shows the verdict once there is one', () => {
    render({ ...expert, assessment })
    expect(container.textContent).toContain('multi-file refactors')
    expect(container.textContent).toContain('deepseek-chat')
    expect(button('Assess again')).toBeTruthy()
  })

  it('shows progress while it runs, rather than nothing', () => {
    render({ ...expert, assessing: true, assessmentStep: 'Asking the junior: 2/5' })
    expect(container.textContent).toContain('Asking the junior: 2/5')
  })

  /**
   * An assessment is one model's opinion of another. Showing what the junior actually said is
   * what makes it an argument the user can weigh rather than an oracle.
   */
  it('can reveal the answers the verdict was based on', () => {
    render({ ...expert, assessment })
    expect(container.textContent).not.toContain('alpha\nbeta\ngamma')
    act(() => button('Show').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('alpha')
    // A probe that failed is a finding, not a gap to hide.
    expect(container.textContent).toContain('timed out')
  })

  /** A verdict about a different model reads as current and describes something else. */
  it('flags an assessment made for another model', () => {
    render({ ...expert, model: 'qwen-coder', assessment })
    expect(container.textContent).toContain('different model')
  })

  it('does not flag it when the model still matches', () => {
    render({ ...expert, model: 'deepseek-chat', assessment })
    expect(container.textContent).not.toContain('different model')
  })

  it('cannot be started without the CLI, since the verdict is the expert’s', () => {
    render({ ...expert, available: false })
    expect(button('Assess it').disabled).toBe(true)
  })
})

/**
 * A spend cap cannot bind on a plan that reports no cost — the running total stays at zero and the
 * limit is never reached. A cap that silently never fires is worse than no cap, because it is
 * believed. So the panel says which case you are in, once a consultation has settled it.
 */
describe('whether the spending limit can apply at all', () => {
  it('says nothing has settled it yet', () => {
    render({ enabled: true, available: true, path: 'claude', maxSpendUsd: 1, maxConsultations: 6 })
    expect(container.textContent).toContain('settled by the first consultation')
  })

  it('warns plainly when the plan reports no cost', () => {
    render({ enabled: true, available: true, path: 'claude', maxSpendUsd: 1, maxConsultations: 6, reportsCost: false })
    expect(container.textContent).toContain('does not report a cost per consultation')
    expect(container.textContent).toContain('consultation limit instead')
  })

  it('says nothing at all once cost is known to work', () => {
    render({ enabled: true, available: true, path: 'claude', maxSpendUsd: 1, maxConsultations: 6, reportsCost: true })
    expect(container.textContent).not.toContain('does not report a cost')
    expect(container.textContent).not.toContain('settled by the first consultation')
  })
})
