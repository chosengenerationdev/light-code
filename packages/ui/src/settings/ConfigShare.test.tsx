// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfigShare, type ShareSectionView } from './ConfigShare.js'

/**
 * The chooser is the whole of what the user sees of config sharing, and every claim it makes is
 * one somebody acts on — what will travel, what they will have to re-enter, whether their own
 * settings are about to be replaced. None of that is visible to a test of `config/share.ts`.
 */

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

const SECTIONS: ShareSectionView[] = [
  {
    id: 'profiles',
    label: 'Providers',
    description: 'Gateways and models.',
    present: true,
    detail: '2 providers',
    secretRefs: ['Corporate gateway: API key'],
  },
  {
    id: 'python',
    label: 'Python tools',
    description: 'uv and the tools folder.',
    present: true,
    detail: 'set',
    machineSpecific: true,
    secretRefs: [],
  },
  {
    id: 'datasets',
    label: 'Custom data',
    description: 'Dataset definitions.',
    present: false,
    detail: '0 datasets',
    secretRefs: [],
  },
]

function render(props: Partial<Parameters<typeof ConfigShare>[0]> = {}): {
  confirmed: string[][]
  cancelled: number[]
} {
  const confirmed: string[][] = []
  const cancelled: number[] = []
  act(() => {
    root.render(
      <ConfigShare
        direction="export"
        sections={SECTIONS}
        initialSelected={['profiles', 'python']}
        onConfirm={(selected) => confirmed.push(selected)}
        onCancel={() => cancelled.push(1)}
        {...props}
      />,
    )
  })
  return { confirmed, cancelled }
}

const boxes = (): HTMLInputElement[] => [
  ...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
]
const buttonSaying = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text))

describe('the share chooser', () => {
  it('shows what each section holds, not just its name', () => {
    // "Providers" is a category; "2 providers" is something somebody can decide about.
    render()
    expect(container.textContent).toContain('2 providers')
  })

  it('shows a section with nothing in it, disabled rather than hidden', () => {
    /*
     * Absent and unticked look identical when a row is simply missing, and only one of them means
     * "you have none of these" — which is what somebody needs to know before wondering why their
     * colleague's import did not bring any.
     */
    render()
    expect(container.textContent).toContain('Custom data')
    const empty = boxes()[2]
    expect(empty?.disabled).toBe(true)
  })

  it('names the credentials rather than counting them', () => {
    // "Re-enter 1 credential" leaves somebody hunting through tabs.
    render()
    expect(container.textContent).toContain('Corporate gateway: API key')
    expect(container.textContent).toContain('They will need to enter:')
  })

  it('drops a credential line when its section is unticked', () => {
    // The list has to follow the selection, or it describes a file that is not being written.
    render()
    act(() => {
      boxes()[0]?.click()
    })
    expect(container.textContent).not.toContain('Corporate gateway: API key')
  })

  it('warns beside a section that carries paths from this machine', () => {
    render()
    expect(container.textContent).toContain('paths from this machine')
  })

  it('hands back exactly what is ticked', () => {
    const { confirmed } = render()
    act(() => {
      boxes()[1]?.click()
    })
    act(() => {
      buttonSaying('Export')?.click()
    })
    expect(confirmed).toEqual([['profiles']])
  })

  it('cannot be confirmed with nothing selected', () => {
    // An export of nothing is a file somebody sends and a colleague cannot use.
    const { confirmed } = render({ initialSelected: [] })
    const confirm = buttonSaying('Export')
    expect(confirm?.disabled).toBe(true)
    act(() => {
      confirm?.click()
    })
    expect(confirmed).toEqual([])
  })

  it('counts only sections that have something in them', () => {
    // Ticking an empty section and being told three will be exported is how somebody ends up
    // debugging an import that was never going to carry what they expected.
    render({ initialSelected: ['profiles', 'python', 'datasets'] })
    expect(buttonSaying('Export')?.textContent).toContain('2 section')
  })

  it('says on the way in that a section replaces rather than merges', () => {
    // The one thing somebody can get wrong here: there is no honest way to merge two lists of
    // providers, so importing Providers replaces the ones on this machine.
    render({ direction: 'import', path: 'C:/shared/team-config.json' })
    expect(container.textContent).toContain('replaces what is here')
    expect(container.textContent).toContain('You will need to enter:')
    expect(container.textContent).toContain('team-config.json')
  })

  it('reports a file that could not be read, with a way out', () => {
    const { cancelled } = render({ direction: 'import', error: 'Config file is not valid JSON' })
    expect(container.textContent).toContain('not valid JSON')
    act(() => {
      buttonSaying('Close')?.click()
    })
    expect(cancelled).toHaveLength(1)
  })
})
