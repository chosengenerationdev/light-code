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
    usesTools: true,
    canWrite: false,
    enabled: true,
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
  onSaveCustomRole: () => {},
  onDeleteCustomRole: () => {},
  onSetRoleTools: () => {},
  onSetRoleWrite: () => {},
  onSetRoleEnabled: () => {},
  onSetRoleThinking: () => {},
  customRoleLimit: 5,
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
    // By name, not by position: this used to take the first checkbox on the page, and adding a
    // per-role one above it pointed the test at something else entirely.
    const box = container.querySelector<HTMLInputElement>(
      'input[aria-label="What consultations cost is worth managing"]',
    )
    if (box === null) throw new Error('no budget checkbox')
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

/**
 * Inventing a role, from the tab.
 *
 * Rendered rather than reasoned about: jsdom is the only eye this has before it reaches a real
 * panel, and the two things worth catching here are both behavioural — a delete that fires on one
 * click, and an id the user never sees until it is wrong.
 */
describe('custom roles', () => {
  function click(label: string): void {
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes(label),
    )
    if (button === undefined) throw new Error(`no button matching "${label}"`)
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  function type(placeholder: string, value: string): void {
    const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[placeholder^="${placeholder}"]`,
    )
    if (field === null) throw new Error(`no field with placeholder "${placeholder}"`)
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('suggests an id from the name, so nobody has to learn the rules', () => {
    render({})
    click('Add a role')
    type('Security reviewer', 'DB Reviewer!')

    const id = container.querySelector<HTMLInputElement>('[placeholder="security"]')
    expect(id?.value).toBe('db-reviewer')
  })

  it('saves what was typed', () => {
    const onSaveCustomRole = vi.fn()
    render({ onSaveCustomRole })
    click('Add a role')
    type('Security reviewer', 'DB reviewer')
    type('Threat model', 'SQL and migrations')
    click('Add role')

    expect(onSaveCustomRole).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'db-reviewer', name: 'DB reviewer', summary: 'SQL and migrations' }),
    )
  })

  it('will not save a role with no name', () => {
    const onSaveCustomRole = vi.fn()
    render({ onSaveCustomRole })
    click('Add a role')
    click('Add role')
    expect(onSaveCustomRole).not.toHaveBeenCalled()
  })

  /*
   * Deleting takes a prompt somebody wrote and tuned with it, so one click arms and the second
   * does it. The label changing is the whole affordance — without it the first click looks like
   * nothing happened.
   */
  it('asks twice before deleting', () => {
    const onDeleteCustomRole = vi.fn()
    render({
      onDeleteCustomRole,
      roles: [role({ role: 'db', name: 'DB reviewer', custom: true })],
    })

    click('Delete')
    expect(onDeleteCustomRole).not.toHaveBeenCalled()

    click('Really delete?')
    expect(onDeleteCustomRole).toHaveBeenCalledWith('db')
  })

  it('offers no delete for a built-in role', () => {
    render({ roles: [role({ role: 'reviewer', name: 'Reviewer' })] })
    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent)
    expect(labels.some((label) => label?.includes('Delete'))).toBe(false)
  })

  /*
   * Switching a role off is not the same act as unassigning it: unassigning forgets who answered,
   * this keeps the model, the prompt and the flags exactly as configured. So the row stays,
   * dimmed, rather than vanishing -- a list that dropped it would leave you hunting for where it
   * went, and you switched it off intending to switch it back.
   */
  it('switches a role out of play without losing its settings', () => {
    const onSetRoleEnabled = vi.fn()
    render({
      onSetRoleEnabled,
      roles: [role({ role: 'reviewer', name: 'Reviewer', enabled: true })],
    })

    const box = container.querySelector<HTMLInputElement>('input[aria-label="Reviewer enabled"]')
    expect(box?.checked).toBe(true)
    act(() => box?.click())
    expect(onSetRoleEnabled).toHaveBeenCalledWith('reviewer', false)
  })

  it('says "off" in words, not only by dimming', () => {
    // Reported as "I don't see the enable or disable switch" while it was on screen: an
    // unlabelled checkbox beside the name, with two labelled ones under it. Dimming says
    // something is different; this says what.
    // The chip itself, not the word: the tab's own prose says "off" in a couple of places, so a
    // substring check passes whatever the row is doing.
    const chip = () =>
      [...container.querySelectorAll('span')].filter((node) => node.textContent === 'off')

    render({ roles: [role({ role: 'reviewer', name: 'Reviewer', enabled: false })] })
    expect(chip()).toHaveLength(1)

    render({ roles: [role({ role: 'reviewer', name: 'Reviewer', enabled: true })] })
    expect(chip()).toHaveLength(0)
  })

  it('still shows a switched-off role, and still lets it be configured', () => {
    render({ roles: [role({ role: 'reviewer', name: 'Reviewer', enabled: false })] })
    expect(container.textContent).toContain('Reviewer')
    // The controls stay usable: setting a role up while it is off is a reasonable thing to do.
    const tools = container.querySelector<HTMLInputElement>(
      'input[aria-label="Reviewer can read the workspace"]',
    )
    expect(tools).not.toBeNull()
    expect(tools?.disabled).toBe(false)
  })

  it('stops offering more once the cap is reached', () => {
    render({
      customRoleLimit: 1,
      roles: [role({ role: 'db', name: 'DB reviewer', custom: true })],
    })
    const add = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Add a role'),
    )
    expect(add?.disabled).toBe(true)
  })

  it('turns a role\'s workspace access on and off', () => {
    const onSetRoleTools = vi.fn()
    render({
      onSetRoleTools,
      roles: [role({ role: 'reviewer', name: 'Reviewer', usesTools: false })],
    })

    // By name: the first checkbox in a row is the enable switch now, and was the tools one
    // before. A positional selector here has already broken twice.
    const box = container.querySelector<HTMLInputElement>(
      'input[aria-label="Reviewer can read the workspace"]',
    )
    expect(box?.checked).toBe(false)
    act(() => box?.click())
    expect(onSetRoleTools).toHaveBeenCalledWith('reviewer', true)
  })
})

/**
 * A custom role is a role everywhere, including where colours are chosen.
 *
 * The Appearance list is built from the same roles array as the Agents tab, so this needed no
 * wiring — which is exactly why it is worth a test: nothing would have failed if it had been
 * built from a fixed list of five instead, and the symptom would be a role you cannot recolour.
 */
describe('colours for custom roles', () => {
  it('offers a picker for one, alongside the built-in roles', async () => {
    const { AppearanceSection } = await import('./AppearanceSection.js')
    act(() =>
      root.render(
        <AppearanceSection
          accentColor="#22C55E"
          onChangeAccent={() => {}}
          expertColor="#D97757"
          onChangeExpert={() => {}}
          agentRoles={[
            { role: 'reviewer', name: 'Reviewer' },
            { role: 'db-reviewer', name: 'DB reviewer' },
          ]}
          agentColors={{}}
          onChangeAgentColor={() => {}}
        />,
      ),
    )

    expect(container.textContent).toContain('DB reviewer colour')
    expect(container.textContent).toContain('Reviewer colour')
  })

  /*
   * The swatch must show what actually gets painted. It used to fall back to the expert's coral
   * for any role without a built-in default, while `applyAgentColors` derived a hue from the id —
   * so the setting you were looking at and the colour you were seeing were different colours.
   */
  it('shows the colour the role is actually painted with', async () => {
    const { defaultAgentColor } = await import('../styles.js')
    const { AppearanceSection } = await import('./AppearanceSection.js')

    const derived = defaultAgentColor('db-reviewer')
    expect(derived).not.toBe(defaultAgentColor('reviewer'))

    act(() =>
      root.render(
        <AppearanceSection
          accentColor="#22C55E"
          onChangeAccent={() => {}}
          expertColor="#D97757"
          onChangeExpert={() => {}}
          agentRoles={[{ role: 'db-reviewer', name: 'DB reviewer' }]}
          agentColors={{}}
          onChangeAgentColor={() => {}}
        />,
      ),
    )

    const hex = container.querySelector<HTMLInputElement>('#lc-agent-db-reviewer-hex')
    expect(hex?.value.toLowerCase()).toBe(derived.toLowerCase())
  })
})
