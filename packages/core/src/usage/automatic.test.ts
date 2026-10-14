import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { LightCodeConfig } from '../config/schema.js'
import { chooseUsageStore, usageCollectionOn } from './auto.js'
import { backfillFromTasks, comparablePath, eventsFromTask } from './backfill.js'
import { computeDashboard } from './dashboard.js'
import { createRecordUserProfileTool, userInfoToolCandidates, userProfileGuidance } from './profileTool.js'
import { cleanProfile, FolderShardStore } from './store.js'

/**
 * Collection that starts by itself, the initial statistics from past conversations, and the user
 * details that turn login names into people - each a promise the panel makes, pinned here.
 */

const os1 = { kind: 'opensearch' as const, label: 'Team cluster', url: 'https://search.example' }
const qd = { kind: 'qdrant' as const, label: 'Local Qdrant', url: 'http://127.0.0.1:6333' }

describe('choosing a store automatically', () => {
  it('OpenSearch first, even when another store is active', () => {
    const config = { vectorStores: { q: qd, o: os1 }, activeVectorStoreId: 'q' } as unknown as LightCodeConfig
    expect(chooseUsageStore(config, [])).toMatchObject({ store: { kind: 'vector', storeId: 'o' }, automatic: true })
  })

  it('then any vector store, the active one first', () => {
    const config = { vectorStores: { a: qd, b: { ...qd, label: 'Other' } }, activeVectorStoreId: 'b' } as unknown as LightCodeConfig
    expect(chooseUsageStore(config, [])?.store).toEqual({ kind: 'vector', storeId: 'b' })
  })

  it('then a writable bucket the team publishes to, never a read-only one', () => {
    const config = {
      s3: {
        skills: [
          { connectionId: 'ro', enabled: true, publish: true },
          { connectionId: 'team', enabled: true },
        ],
      },
    } as unknown as LightCodeConfig
    const targets = [
      { id: 'ro', label: 'Read only', readOnly: true },
      { id: 'team', label: 'Team bucket' },
    ]
    expect(chooseUsageStore(config, targets)?.store).toEqual({ kind: 's3', connectionId: 'team' })
  })

  it('nothing suitable means no collection; a hand-picked store always wins; "stopped" always stops', () => {
    expect(chooseUsageStore({} as LightCodeConfig, [])).toBeUndefined()
    const picked = { vectorStores: { o: os1 }, usage: { store: { kind: 'folder', path: 'X:\\usage' } } } as unknown as LightCodeConfig
    expect(chooseUsageStore(picked, [])).toMatchObject({ store: { kind: 'folder' }, automatic: false })
    const stopped = { vectorStores: { o: os1 }, usage: { enabled: false } } as unknown as LightCodeConfig
    expect(usageCollectionOn(stopped, chooseUsageStore(stopped, []))).toBe(false)
    const auto = { vectorStores: { o: os1 } } as unknown as LightCodeConfig
    expect(usageCollectionOn(auto, chooseUsageStore(auto, []))).toBe(true)
  })
})

describe('initial statistics from saved conversations', () => {
  const context = {
    user: 'ann',
    project: 'Proj',
    workspaceRoot: 'C:\\work\\proj',
    skills: [{ name: 'deploy', filePath: 'C:\\work\\proj\\.lightcode\\skills\\deploy.md', author: 'bob' }],
    toolAuthors: { fetch: 'cat' },
    skip: ['attempt_completion'],
    before: 5000,
  }
  const task = {
    workspaceRoot: 'C:\\work\\proj',
    createdAt: 1000,
    updatedAt: 3000,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', arguments: JSON.stringify({ path: '.lightcode\\skills\\deploy.md' }) }] },
      { role: 'tool', toolCallId: '1', content: '...' },
      { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'call_tool', arguments: JSON.stringify({ name: 'py__fetch', arguments: {} }) }] },
      { role: 'assistant', content: '', toolCalls: [{ id: '3', name: 'attempt_completion', arguments: '{}' }] },
    ],
  }

  it('finds tool calls and skill reads, spread over the conversation, and the same answer as the Rust helper', () => {
    const events = eventsFromTask(task, context)
    expect(events.map((event) => event.n)).toEqual(['read_file', 'deploy', 'py__fetch'])
    expect(events.map((event) => event.t)).toEqual([1000, 1000, 3000])
    expect(events[1]).toMatchObject({ k: 'skill', a: 'bob', p: 'Proj', u: 'ann' })
    expect(events[2]?.a).toBe('cat')
    // The fixture in usage_store.rs's backfill test is this one; its expectations are the same.
  })

  it('leaves out conversations saved after the import began', () => {
    expect(eventsFromTask({ ...task, updatedAt: 9000 }, context)).toEqual([])
  })

  it('reads a folder of saved tasks, skipping the index and counting what it could not read', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-backfill-'))
    try {
      await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify(task))
      await fs.writeFile(path.join(dir, 'index.json'), '[]')
      await fs.writeFile(path.join(dir, 'broken.json'), '{')
      const result = await backfillFromTasks(dir, context)
      expect(result).toMatchObject({ tasks: 2, unreadable: 1, via: 'node' })
      expect(result.events).toHaveLength(3)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('uses the helper when there is one, and falls back when it does not know the action', async () => {
    const rust = await backfillFromTasks('/nowhere', context, async () => ({ ok: true, events: [{ t: 1, u: 'ann', k: 'tool', n: 'x' }], tasks: 1, unreadable: 0 }))
    expect(rust.via).toBe('rust')
    const old = await backfillFromTasks('/nowhere', context, async () => ({ ok: false, error: 'Unknown usage action' }))
    expect(old.via).toBe('node')
  })

  it('compares paths however Windows spells them', () => {
    expect(comparablePath('C:\\Work\\Skills\\')).toBe(comparablePath('c:/work/skills'))
  })
})

describe('who the user is', () => {
  it('finds a user-info tool by its name, or the one named in settings', () => {
    const names = ['read_file', 'hr__whoami', 'py__employee_lookup', 'jira_search', 'record_user_profile', 'py__user_info']
    expect(userInfoToolCandidates(names)).toEqual(['hr__whoami', 'py__employee_lookup', 'py__user_info'])
    expect(userInfoToolCandidates(names, 'user_info')).toEqual(['py__user_info'])
    expect(userInfoToolCandidates(names, 'missing')).toEqual([])
    expect(userInfoToolCandidates(['read_file', 'search_users_table'])).toEqual([])
  })

  it('the guidance names the tool and forbids guessing', () => {
    const text = userProfileGuidance('aex1234', ['hr__whoami'])
    expect(text).toContain('`hr__whoami`')
    expect(text).toContain('record_user_profile')
    expect(text).toMatch(/never guess/)
  })

  it('records only known fields, shows them before writing, and lands in the store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-profile-'))
    try {
      const store = new FolderShardStore(dir)
      const tool = createRecordUserProfileTool({ user: () => 'aex1234', destination: () => 'the shared folder', save: (profile) => store.putProfile('aex1234', profile) })
      const preview = await tool.preview!({ displayName: 'Ann Example', team: 'Rates' }, undefined as never)
      expect(JSON.stringify(preview)).toContain('Ann Example')
      await tool.execute({ displayName: 'Ann Example', team: 'Rates' }, undefined as never)
      const profiles = await store.readProfiles()
      expect(profiles['aex1234']).toMatchObject({ displayName: 'Ann Example', team: 'Rates' })
      expect(cleanProfile({ displayName: 'x', password: 'secret' })).toEqual({ displayName: 'x' })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('the dashboard shows people by name and adds up teams', () => {
    const now = Date.UTC(2026, 9, 10)
    const events = [
      { t: now - 1000, u: 'aex1234', k: 'skill' as const, n: 'deploy' },
      { t: now - 2000, u: 'bob99', k: 'skill' as const, n: 'deploy' },
      { t: now - 3000, u: 'cat', k: 'tool' as const, n: 'read_file' },
    ]
    const d = computeDashboard({
      events,
      inventory: [],
      scope: 'team',
      me: 'aex1234',
      from: now - 86_400_000,
      to: now,
      profiles: { aex1234: { displayName: 'Ann Example', team: 'Rates' }, bob99: { displayName: 'Bob', department: 'Rates' } },
    })
    expect(d.people.find((person) => person.user === 'aex1234')?.displayName).toBe('Ann Example')
    expect(d.teams).toEqual([{ team: 'Rates', people: 2, uses: 2, skillUses: 2, topSkill: 'deploy' }])
  })
})
