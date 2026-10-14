import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { isOffloadable } from '../tools/offload.js'
import type { InventoryItem } from './dashboard.js'
import type { UsageEvent } from './events.js'
import { createUsageStatsTool, statsRange } from './statsTool.js'

/**
 * `usage_stats`: the dashboard's own data for the assistant, so custom metrics are computed from the
 * same numbers the page shows - rows for `dataframe`, never a second reading of the store.
 */

const DAY = 86_400_000
const now = Date.UTC(2026, 9, 11, 12)
const events: UsageEvent[] = [
  { t: now - DAY, u: 'aex1234', k: 'skill', n: 'deploy', a: 'bob' },
  { t: now - DAY, u: 'bob99', k: 'tool', n: 'py__fetch', ok: false, d: 900, p: 'Proj' },
  { t: now - 2 * DAY, u: 'bob99', k: 'skill', n: 'deploy', a: 'bob' },
  { t: now - 40 * DAY, u: 'aex1234', k: 'skill', n: 'old' },
]
const inventory: InventoryItem[] = [{ kind: 'skill', name: 'deploy', filePath: '/d', deletable: true, location: 'this project', author: 'bob', version: 2, updated: '2026-10-01T00:00:00Z' }]

const tool = createUsageStatsTool({
  gather: async () => ({ events, profiles: { aex1234: { displayName: 'Ann Example', team: 'Rates' }, bob99: { displayName: 'Bob', department: 'FX' } }, storeLabel: 'Team cluster' }),
  inventory: async () => inventory,
  me: () => 'aex1234',
})
const run = async (input: Record<string, unknown>) => tool.execute({ action: 'events', to: '2026-10-11', ...input } as never, undefined as never)

describe('usage_stats', () => {
  it('events: rows the dataframe tool can use, with names and teams, filtered', async () => {
    const rows = JSON.parse((await run({ days: 7 })).content) as Record<string, unknown>[]
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ user: 'aex1234', displayName: 'Ann Example', team: 'Rates', kind: 'skill', name: 'deploy', author: 'bob', failed: false })
    const fx = JSON.parse((await run({ days: 7, team: 'fx' })).content) as Record<string, unknown>[]
    expect(fx.map((row) => row['user'])).toEqual(['bob99', 'bob99'])
    const tools = JSON.parse((await run({ days: 7, kind: 'tool' })).content) as Record<string, unknown>[]
    expect(tools[0]).toMatchObject({ name: 'fetch', pythonTool: true, failed: true, ms: 900, project: 'Proj' })
    const mine = JSON.parse((await run({ days: 7, scope: 'me' })).content) as Record<string, unknown>[]
    expect(mine.every((row) => row['user'] === 'aex1234')).toBe(true)
    expect(JSON.parse((await run({ days: 7, user: 'ann example' })).content)).toHaveLength(1)
  })

  it('summary: the dashboard in words, leaderboard included', async () => {
    const text = (await run({ action: 'summary', days: 7 })).content
    expect(text).toContain('# Usage for the team')
    expect(text).toContain('| deploy | 2 |')
    expect(text).toContain('## Leaderboard')
    expect(text).toContain('From Team cluster.')
  })

  it('people and inventory', async () => {
    const people = JSON.parse((await run({ action: 'people', days: 60 })).content) as Record<string, unknown>[]
    expect(people.find((row) => row['user'] === 'bob99')).toMatchObject({ displayName: 'Bob', team: 'FX' })
    const items = JSON.parse((await run({ action: 'inventory' })).content) as Record<string, unknown>[]
    expect(items[0]).toMatchObject({ name: 'deploy', author: 'bob', version: 2, deletableHere: true })
  })

  it('says why when nothing is collected, and refuses a bad date', async () => {
    const off = createUsageStatsTool({ gather: async () => ({ problem: 'usage is not being collected' }), inventory: async () => [], me: () => 'x' })
    expect((await off.execute({ action: 'events' } as never, undefined as never)).isError).toBe(true)
    expect(statsRange({ from: 'yesterday' })).toEqual({ problem: expect.stringContaining('not a date') })
    expect(statsRange({ from: '2026-10-01', to: '2026-10-02' })).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 2, 23, 59, 59, 999) })
  })

  it('is offloaded with its family, advertised otherwise, and reads what the dashboard reads', () => {
    expect(isOffloadable('usage_stats')).toBe(true)
    const bridge = readFileSync(new URL('../host/bridge.ts', import.meta.url), 'utf8')
    expect(bridge).toContain('if (usageCollecting()) combined.register(usageStatsTool)\n')
    expect(bridge).toContain('gather: gatherUsage,')
    expect(bridge).toMatch(/async function handleRequestUsage[\s\S]*?const data = await gatherUsage\(message\.from, message\.to\)/)
  })
})
