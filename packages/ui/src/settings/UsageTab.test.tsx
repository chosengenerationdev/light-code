// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HostToUiMessage, UsageDashboard } from '@light-code/core/browser'
import { UsageTab, rankContributors, trend, usageRange } from './UsageTab.js'

/**
 * What the Usage tab shows, and when: the setup alone until collection is on (an empty dashboard
 * would read as "nobody uses anything"), the dashboard once it is, and a delete that takes two clicks
 * and names what goes.
 */

let container: HTMLDivElement
let root: Root
let listener: ((message: unknown) => void) | undefined
let posted: unknown[]

const transport = {
  post: (message: unknown) => void posted.push(message),
  onMessage: (next: (message: unknown) => void) => {
    listener = next
    return () => {
      listener = undefined
    }
  },
}

beforeEach(() => {
  posted = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function send(message: HostToUiMessage): void {
  act(() => listener?.(message))
}

const zero = { value: 0, previous: 0 }
const dashboard: UsageDashboard = {
  scope: 'team',
  me: 'ann',
  from: 0,
  to: 1,
  totals: { uses: { value: 9, previous: 3 }, skillUses: { value: 5, previous: 1 }, toolUses: { value: 4, previous: 2 }, failures: zero, people: { value: 2, previous: 2 }, skillsUsed: zero, toolsUsed: zero },
  timeline: { unit: 'day', buckets: [{ start: 0, skills: 2, tools: 1, failures: 0 }] },
  heatmap: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
  topSkills: [{ kind: 'skill', name: 'deploy', label: 'deploy', uses: 5, previous: 1, users: 2, failures: 0, lastUsed: 0, spark: [1, 4], installed: true }],
  topTools: [],
  rising: [],
  people: [{ user: 'ann', displayName: 'Ann Example', team: 'Rates', uses: 9, skills: 1, tools: 1, favourite: 'deploy', lastActive: 0 }],
  teams: [{ team: 'Rates', people: 1, uses: 9, skillUses: 5, topSkill: 'deploy' }],
  contributors: [
    { author: 'bob', skills: 1, tools: 0, uses: 5, reached: 2, impact: 10, added: 0, updated: 1 },
    { author: 'cat', skills: 3, tools: 1, uses: 1, reached: 1, impact: 1, added: 2, updated: 0 },
  ],
  myImpact: { skills: 0, tools: 0, uses: 0, reached: 0, usedByOthers: 0 },
  unused: [{ kind: 'skill', name: 'old-notes', filePath: '/s/old-notes.md', location: 'this project', deletable: true, stale: true }],
  recent: [],
  problems: [],
  inventory: { skills: 2, tools: 0, authors: 1 },
  eventsInStore: 9,
}

const options = { s3: [], vectorStores: [] }

describe('the Usage tab', () => {
  it('asks for the dashboard on open, and shows only the setup while collection is off', () => {
    act(() => root.render(<UsageTab transport={transport} />))
    expect(posted[0]).toMatchObject({ type: 'requestUsage', scope: 'team' })
    send({ type: 'usage', settings: { collecting: false, stopped: false, userInfoCandidates: [], userInfoSkills: [], directory: { available: false, reason: 'not on a domain', people: 0 } }, options })
    expect(container.textContent).toContain('Collection and storage')
    expect(container.textContent).not.toContain('Most used skills')
    // No bucket or vector store configured: those choices are offered but cannot be picked.
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type=radio]')]
    expect(radios.map((radio) => radio.disabled)).toEqual([false, false, true, true])
    expect(container.textContent).toContain('no shared store is configured')
  })

  it('shows the dashboard once collecting, and deletes only on the second click', () => {
    act(() => root.render(<UsageTab transport={transport} />))
    send({
      type: 'usage',
      settings: { collecting: true, stopped: false, effective: { store: { kind: 'vector', storeId: 'os' }, automatic: true, reason: 'the OpenSearch connection "Team" is configured' }, userInfoCandidates: ['whoami'], userInfoSkills: [], directory: { available: true, people: 12, via: 'rust' } },
      options,
      storeLabel: 'Team (collection light-code-usage)',
      dashboard,
    })
    // People are shown by name and team, not by login, once a user-info tool has said who they are.
    expect(container.textContent).toContain('Ann Example')
    expect(container.textContent).toContain('By team')
    expect(container.textContent).toContain('Most used skills')
    expect(container.textContent).toContain('deploy')
    expect(container.textContent).toContain('bob')
    const deleteButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete')!
    act(() => deleteButton.click())
    expect(posted.some((message) => (message as { type: string }).type === 'deleteSkillFile')).toBe(false)
    const confirm = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Yes, delete')!
    act(() => confirm.click())
    expect(posted).toContainEqual({ type: 'deleteSkillFile', name: 'old-notes' })
  })

  it('a refused save is said on the panel', () => {
    act(() => root.render(<UsageTab transport={transport} />))
    send({ type: 'usage', settings: { collecting: false, stopped: false, userInfoCandidates: [], userInfoSkills: [], directory: { available: false, reason: 'not on a domain', people: 0 } }, options, saveError: 'Could not write to the shared folder' })
    expect(container.textContent).toContain('Could not write to the shared folder')
  })
})

describe('the leaderboard', () => {
  it('ranks by what was written, by impact, or by what was done in the range', () => {
    const people = [
      { author: 'bob', skills: 1, tools: 0, uses: 5, reached: 2, impact: 10, added: 0, updated: 1 },
      { author: 'cat', skills: 3, tools: 1, uses: 1, reached: 1, impact: 1, added: 2, updated: 0 },
      { author: 'dan', skills: 0, tools: 0, uses: 0, reached: 0, impact: 0, added: 0, updated: 0 },
    ]
    expect(rankContributors(people, 'written').map((p) => p.author)).toEqual(['cat', 'bob', 'dan'])
    expect(rankContributors(people, 'impact').map((p) => p.author)).toEqual(['bob', 'cat', 'dan'])
    expect(rankContributors(people, 'period').map((p) => p.author)).toEqual(['cat', 'bob', 'dan'])
  })
})

describe('ranges and trends', () => {
  it('presets end now; a custom range covers the whole last day', () => {
    const now = Date.parse('2026-10-10T12:00:00')
    expect(usageRange('1w', '', '', now)).toEqual({ from: now - 7 * 86_400_000, to: now })
    const custom = usageRange('custom', '2026-10-01', '2026-10-02', now)
    expect(custom.to - custom.from).toBe(2 * 86_400_000 - 1)
    // A backwards custom range falls back rather than showing nothing.
    expect(usageRange('custom', '2026-10-05', '2026-10-01', now).to).toBe(now)
  })

  it('says "new" rather than an infinite percentage', () => {
    expect(trend(5, 0).text).toBe('new')
    expect(trend(6, 4).text).toBe('+50%')
    expect(trend(2, 4).text).toBe('−50%')
  })
})
