// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { StrategyEditor } from './StrategyEditor.js'

/**
 * The Strategy window: a role clicked becomes a step, a step can be made read-only, and Save and use sends the
 * chart to the host, which checks it (the schema) and keeps it in the library.
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

function setup(): { posted: Record<string, unknown>[]; deliver: (message: unknown) => void } {
  const posted: Record<string, unknown>[] = []
  let handler: ((message: unknown) => void) | undefined
  const transport = {
    post: (message: Record<string, unknown>) => void posted.push(message),
    onMessage: (h: (message: unknown) => void) => {
      handler = h
      return () => (handler = undefined)
    },
  }
  act(() => root.render(<StrategyEditor transport={transport as never} onClose={() => undefined} />))
  return { posted, deliver: (message) => act(() => handler?.(message)) }
}

const roles = [
  { id: 'programmer', name: 'Programmer', summary: 'writes', assigned: true, label: 'gpt', ownProcess: true },
  { id: 'tester', name: 'Tester', summary: 'tests', assigned: true, label: 'claude' },
  { id: 'reviewer', name: 'Reviewer', summary: 'reviews', assigned: false },
]

describe('the Strategy window', () => {
  it('adds steps from the roles, makes one read-only, and saves the chart to use in this chat', () => {
    const { posted, deliver } = setup()
    expect(posted[0]).toEqual({ type: 'requestStrategies' })
    deliver({ type: 'strategies', library: [], progress: {}, problems: [], roles, processes: [] })

    const roleButton = (name: string): HTMLButtonElement => [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(name)) as HTMLButtonElement
    act(() => roleButton('Programmer').click())
    act(() => roleButton('Tester').click())
    expect(container.querySelectorAll('svg rect[width="168"]')).toHaveLength(2)

    // The tester was added last, so it is the one selected: make it read-only.
    const readOnly = [...container.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Read-only'))?.querySelector('input') as HTMLInputElement
    act(() => readOnly.click())

    const use = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save and use in this chat') as HTMLButtonElement
    act(() => use.click())
    const saved = posted.find((m) => m['type'] === 'saveStrategy') as { strategy: { nodes: { role: string; readOnly?: boolean }[] }; use: boolean }
    expect(saved.use).toBe(true)
    expect(saved.strategy.nodes.map((n) => [n.role, n.readOnly === true])).toEqual([
      ['programmer', false],
      ['tester', true],
    ])
  })

  it('warns about a role nobody is assigned to, and cannot save an empty chart', () => {
    const { deliver } = setup()
    deliver({ type: 'strategies', library: [], progress: {}, problems: [], roles, processes: [] })
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    act(() => ([...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Reviewer')) as HTMLButtonElement).click())
    expect(container.textContent).toContain('Reviewer has no model yet')
  })

  it("opens a step's instructions from its ✎, and shows which step is running and where each loop stands", () => {
    const { deliver } = setup()
    const active = {
      id: 's1',
      name: 'TDD',
      updatedAt: 1,
      nodes: [
        { id: 'a', role: 'programmer', x: 0, y: 0 },
        { id: 'b', role: 'tester', x: 300, y: 0, instructions: 'run every test' },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b', twoWay: true, maxRounds: 4, until: 'all tests pass' }],
    }
    deliver({ type: 'strategies', library: [active], active, progress: { e: { rounds: 2, verdict: 'not met - 1 fails' } }, current: { role: 'tester', running: true }, problems: [], roles, processes: [] })
    expect(container.textContent).toContain('2. Tester is working on it')
    expect(container.textContent).toContain('Programmer ⇄ Tester: round 2 of 4 · not met - 1 fails')
    expect(container.textContent).toContain('working now…')

    const pencils = [...container.querySelectorAll('svg g title')].filter((title) => title.textContent?.includes('instructions'))
    expect(pencils).toHaveLength(2)
    act(() => {
      pencils[1]!.parentElement!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    const box = container.querySelector('#strategy-node-instructions') as HTMLTextAreaElement
    expect(box.value).toBe('run every test')
  })

  it('connects two steps with clicks - Connect to…, then the other step - and the other way makes a back-and-forth', () => {
    const { posted, deliver } = setup()
    deliver({ type: 'strategies', library: [], progress: {}, problems: [], roles, processes: [] })
    const button = (text: string): HTMLButtonElement => [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text)) as HTMLButtonElement
    act(() => button('Programmer').click())
    act(() => button('Tester').click())
    const boxes = (): Element[] => [...container.querySelectorAll('svg rect[width="168"]')]
    const press = (element: Element): void => act(() => void element.dispatchEvent(new Event('pointerdown', { bubbles: true })))

    // Programmer -> Tester
    press(boxes()[0]!)
    act(() => button('Connect to').click())
    expect(container.textContent).toContain('Now click the step it should lead to')
    press(boxes()[1]!)
    // Tester -> Programmer: the same connector becomes a back-and-forth
    press(boxes()[1]!)
    act(() => button('Connect to').click())
    press(boxes()[0]!)

    act(() => button('Save and use').click())
    const saved = posted.find((m) => m['type'] === 'saveStrategy') as { strategy: { edges: { twoWay?: boolean }[] } }
    expect(saved.strategy.edges).toHaveLength(1)
    expect(saved.strategy.edges[0]!.twoWay).toBe(true)
  })
})

