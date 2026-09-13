// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ModelFitPanel, type ModelFitPanelProps } from './ModelFitPanel.js'

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

const assessment = {
  model: 'deepseek-chat',
  profileLabel: 'office gateway',
  assessedAt: Date.UTC(2026, 7, 15),
  verdict: 'Trust it with small edits. Do not trust it with multi-file refactors.',
  costUsd: 0.21,
  probes: [
    {
      id: 'instruction-following',
      measures: 'Following an exact output format',
      prompt: 'p',
      answer: 'alpha\nbeta\ngamma',
    },
    { id: 'honesty', measures: 'Admitting it does not know', prompt: 'p', answer: '', error: 'timed out' },
  ],
}

const base: ModelFitPanelProps = {
  assessments: [],
  seatFits: [
    {
      role: 'reviewer',
      name: 'Reviewer',
      probes: ['debugging'],
      lookFor: 'Finding the actual fault rather than the first plausible one.',
    },
  ],
  expertGuidance: 'No short probe stands in for planning.',
  assessor: { label: 'Claude', available: true },
  profiles: [
    { id: 'a', label: 'office gateway' },
    { id: 'b', label: 'local' },
  ],
  assessing: false,
  step: undefined,
  onAssess: () => {},
  onClear: () => {},
}

function render(props: Partial<ModelFitPanelProps>): void {
  act(() => root.render(<ModelFitPanel {...base} {...props} />))
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((element) =>
    (element.textContent ?? '').includes(label),
  )
  if (found === undefined) {
    throw new Error(`no button "${label}" — saw: ${container.textContent ?? ''}`)
  }
  return found
}

describe('deciding which model takes which seat', () => {
  it('offers to assess a model when none has been', () => {
    render({})
    expect(button('Assess it').disabled).toBe(false)
  })

  /*
   * The whole reason this panel exists separately: the Expert tab it used to live in is nested
   * inside the budget panel, which is hidden whenever no seat is held by the Claude CLI. Somebody
   * with four models on a gateway and no Claude could not reach the one screen that says which
   * model to put where.
   */
  it('can be used when a profile grades, not only the Claude CLI', () => {
    render({ assessor: { label: 'qwen through the office gateway', available: true } })
    expect(button('Assess it').disabled).toBe(false)
    expect(container.textContent).toContain('qwen through the office gateway')
  })

  it('cannot be started with nobody in the expert seat, since the verdict is theirs', () => {
    render({ assessor: { label: 'Nobody is in the expert seat', available: false } })
    expect(button('Assess it').disabled).toBe(true)
  })

  it('shows progress while it runs, rather than nothing', () => {
    render({ assessing: true, step: 'Asking qwen: honesty (2/5)' })
    expect(container.textContent).toContain('Asking qwen: honesty (2/5)')
    expect(button('Assess it').disabled).toBe(true)
  })

  /*
   * Comparing is the question. One slot could only answer "is the model I am using any good",
   * and assessing the second model destroyed the evidence about the first.
   */
  it('shows every model assessed, side by side', () => {
    render({
      assessments: [assessment, { ...assessment, model: 'gemma', profileLabel: 'local' }],
    })
    expect(container.textContent).toContain('deepseek-chat')
    expect(container.textContent).toContain('gemma')
  })

  /**
   * An assessment is one model's opinion of another. Showing what it actually said is what makes
   * it an argument the user can weigh rather than an oracle.
   */
  it('can reveal the answers a verdict was based on', () => {
    render({ assessments: [assessment] })
    expect(container.textContent).not.toContain('alpha')
    act(() => button('Show what it answered').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('alpha')
    // A probe that failed is a finding, not a gap to hide.
    expect(container.textContent).toContain('timed out')
  })

  it('says what each seat needs, and which probes speak to it', () => {
    render({})
    act(() => button('Show what each seat needs').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Reviewer')
    expect(container.textContent).toContain('debugging')
    expect(container.textContent).toContain('first plausible one')
    expect(container.textContent).toContain('No short probe stands in for planning')
  })

  /*
   * The one rule that survives whatever the probes say, and the easiest to get wrong when one
   * model is plainly the strongest thing available.
   */
  it('warns against one model holding both the programmer and reviewer seats', () => {
    render({})
    act(() => button('Show what each seat needs').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('agrees with itself')
  })

  it('forgets one assessment by subject, not by position', () => {
    const forgotten: string[] = []
    render({
      assessments: [assessment],
      onClear: (model, profileLabel) => forgotten.push(`${model}@${profileLabel}`),
    })
    act(() => button('Forget').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(forgotten).toEqual(['deepseek-chat@office gateway'])
  })
})
