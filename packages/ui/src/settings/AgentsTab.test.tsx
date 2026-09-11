// @vitest-environment jsdom
import type { AgentRoleState } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentsTab, type AgentsTabProps } from './AgentsTab.js'

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

function role(partial: Partial<AgentRoleState> & { role: string }): AgentRoleState {
  return {
    name: partial.role,
    summary: 'does a thing',
    label: 'Nobody',
    available: false,
    prompt: 'You are a thing.',
    promptIsDefault: true,
    ...partial,
  }
}

const base: AgentsTabProps = {
  roles: [
    role({ role: 'expert', name: 'Expert', kind: 'cli', label: 'Claude', available: true }),
    role({ role: 'reviewer', name: 'Reviewer' }),
  ],
  profiles: [{ id: 'gw', label: 'Corporate gateway' }],
  cliAvailable: true,
  budgetMatters: false,
  teamGuidance: 'Consult when it helps.',
  defaultTeamGuidance: 'Consult when it helps.',
  teamGuidanceIsDefault: true,
  colors: { expert: '#D97757', reviewer: '#3B9EDB' },
  onAssign: () => {},
  onSetPrompt: () => {},
  onSetBudget: () => {},
  onSetTeamGuidance: () => {},
}

function render(props: Partial<AgentsTabProps>): void {
  act(() => root.render(<AgentsTab {...base} {...props} />))
}

function buttons(label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label)
}

function click(element: Element | undefined): void {
  act(() => element?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('the Agents tab', () => {
  /** Every role, including the ones nobody has taken — they are what you click to assign. */
  it('lists roles that are unassigned as well as assigned', () => {
    render({})
    expect(container.textContent).toContain('Expert')
    expect(container.textContent).toContain('Reviewer')
  })

  it('offers Claude only where it was detected', () => {
    render({})
    expect(container.textContent).toContain('Claude was found on this machine')

    render({ cliAvailable: false, cliReason: 'not on PATH' })
    expect(container.textContent).toContain('Claude was not found')
    expect(container.textContent).toContain('not on PATH')
  })

  /**
   * A role pointing at something that has gone says so here.
   *
   * Otherwise the only reader is the model, and the user finds out from a tool error in the
   * middle of a turn — which is the wrong place and the wrong time to learn it.
   */
  it('says why an assigned role cannot be reached', () => {
    render({
      roles: [
        role({
          role: 'reviewer',
          name: 'Reviewer',
          kind: 'profile',
          profileId: 'gone',
          available: false,
          reason: 'No profile "gone" exists any more.',
        }),
      ],
    })
    expect(container.textContent).toContain('No profile "gone" exists any more.')
  })

  it('opens the prompt for a role, and saves an edit', () => {
    const onSetPrompt = vi.fn()
    render({ onSetPrompt })

    click(buttons('Prompt')[0])
    const box = container.querySelector('textarea')
    expect(box?.value).toBe('You are a thing.')

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    act(() => {
      setter?.call(box, 'Be brutal.')
      box?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(buttons('Save prompt')[0])

    expect(onSetPrompt).toHaveBeenCalledWith('expert', 'Be brutal.')
  })

  /**
   * Reset sends *undefined*, not the default text.
   *
   * Storing the default verbatim would pin the user to whatever it said today, and every later
   * improvement to that prompt would reach everyone except the people who had looked at it.
   */
  it('resets a prompt by sending nothing rather than the default text', () => {
    const onSetPrompt = vi.fn()
    render({
      roles: [role({ role: 'expert', name: 'Expert', prompt: 'Edited.', promptIsDefault: false })],
      onSetPrompt,
    })

    click(buttons('Prompt')[0])
    click(buttons('Reset to default')[0])
    expect(onSetPrompt).toHaveBeenCalledWith('expert', undefined)
  })

  it('does not offer a reset for a prompt that is already the default', () => {
    render({})
    click(buttons('Prompt')[0])
    expect(buttons('Reset to default')[0]?.disabled).toBe(true)
  })

  /**
   * The point of the checkbox.
   *
   * A spend cap over something nothing meters looks like protection and is not, so the budget is
   * absent rather than shown at zero.
   */
  it('shows the budget only when cost is worth managing', () => {
    const panel = <p>BUDGET PANEL</p>
    render({ budgetMatters: false, budgetPanel: panel })
    expect(container.textContent).not.toContain('BUDGET PANEL')

    render({ budgetMatters: true, budgetPanel: panel })
    expect(container.textContent).toContain('BUDGET PANEL')
  })

  it('reports the budget choice', () => {
    const onSetBudget = vi.fn()
    render({ onSetBudget })
    const box = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0]
    click(box)
    expect(onSetBudget).toHaveBeenCalledWith(true)
  })

  it('edits the consulting advice and saves it', () => {
    const onSetTeamGuidance = vi.fn()
    render({ onSetTeamGuidance })

    click(buttons('Edit')[0])
    const box = container.querySelector('textarea[aria-label="When to consult"]')
    expect(box).not.toBeNull()

    click(buttons('Save')[0])
    expect(onSetTeamGuidance).toHaveBeenCalledWith('Consult when it helps.')
  })

  /** Says what the roster is for, so nobody edits it expecting to change who exists. */
  it('explains that the roster is added automatically', () => {
    render({})
    expect(container.textContent).toContain('you are editing the advice, not the roster')
  })

  it('says plainly when nobody is assigned', () => {
    render({ roles: [role({ role: 'reviewer', name: 'Reviewer' })] })
    expect(container.textContent).toContain('Nobody is assigned')
  })

  it('warns when there are no providers to assign at all', () => {
    render({ profiles: [], cliAvailable: false })
    expect(container.textContent).toContain('No providers are configured yet')
  })
})
