import { describe, expect, it } from 'vitest'

import { configSchema, type LightCodeConfig } from './schema.js'
import {
  applyImport,
  buildExport,
  defaultSelection,
  describeSections,
  NEVER_SHARED,
  SHARE_SECTIONS,
  type ShareSectionId,
} from './share.js'

const sample: LightCodeConfig = {
  profiles: [
    {
      id: 'gateway',
      label: 'Corporate gateway',
      wireFormat: 'openai',
      baseUrl: 'https://gateway.example.internal/v1',
      model: 'gpt-4o',
      auth: { type: 'apiKey', apiKeyRef: 'profile:gateway:apiKey' },
    },
    {
      id: 'local',
      label: 'Local dev',
      wireFormat: 'openai',
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'qwen',
      auth: { type: 'none' },
    },
  ],
  activeProfileId: 'gateway',
  mcpServers: { filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] } },
  schedules: {
    nightly: {
      id: 'nightly',
      name: 'Nightly check',
      prompt: 'check things',
      trigger: { kind: 'daily', hour: 3, minute: 0 },
      enabled: true,
      allowedTools: ['execute_command'],
    },
  },
  approvals: { 'd:\\work': { allowedCommands: ['npm test'] } },
  workspaces: { 'd:\\work': { modeId: 'ask' } },
  identity: { owner: 'someone' },
  certDir: 'C:\\certs',
  ui: { accentColor: '#22C55E' },
}

describe('the section table', () => {
  it('covers every key the schema has, or names it as never shared', () => {
    /*
     * The point of this test: the export is built by copying in what a section owns, so a key
     * added to the schema and to no section is silently never exported. That is the safe
     * direction, and it is also invisible — so this fails when a new key belongs to neither list,
     * forcing the decision to be made rather than defaulted into.
     */
    const owned = new Set(SHARE_SECTIONS.flatMap((section) => section.keys as string[]))
    const excluded = new Set(NEVER_SHARED as string[])
    const schemaKeys = Object.keys(configSchema._zod.def.shape)

    const unaccounted = schemaKeys.filter((key) => !owned.has(key) && !excluded.has(key))
    expect(unaccounted).toEqual([])
  })

  it('never offers approvals, whatever is ticked', () => {
    /*
     * Not merely off by default. Importing somebody's approvals pre-approves shell commands on
     * this machine that nobody here has read — invariant 5's own threat, arriving through a file
     * a colleague sent rather than through a repository. A checkbox saying so is a checkbox
     * somebody eventually ticks.
     */
    expect(NEVER_SHARED).toContain('approvals')
    const everything = SHARE_SECTIONS.map((section) => section.id)
    expect(buildExport(sample, everything).approvals).toBeUndefined()
  })

  it('never offers per-project overrides or the index owner', () => {
    const everything = SHARE_SECTIONS.map((section) => section.id)
    const exported = buildExport(sample, everything)
    expect(exported.workspaces).toBeUndefined()
    expect(exported.identity).toBeUndefined()
  })

  it('gives every key exactly one owner', () => {
    // Two sections owning one key would make the export depend on which was ticked last.
    const seen = new Set<string>()
    for (const section of SHARE_SECTIONS) {
      for (const key of section.keys) {
        expect(seen.has(key as string)).toBe(false)
        seen.add(key as string)
      }
    }
  })
})

describe('describing a config', () => {
  it('counts rather than only naming', () => {
    // "Providers" is a category; "2 providers" is something somebody can decide about.
    const sections = describeSections(sample)
    expect(sections.find((section) => section.id === 'profiles')?.detail).toBe('2 providers')
    expect(sections.find((section) => section.id === 'mcpServers')?.detail).toBe('1 server')
  })

  it('reports a section with nothing in it as absent rather than leaving it out', () => {
    // Absent and unticked look identical otherwise, and only one of them means "you have none".
    const sections = describeSections(sample)
    expect(sections.find((section) => section.id === 'datasets')?.present).toBe(false)
    expect(sections.map((section) => section.id)).toContain('datasets')
  })

  it('names the credentials an importer will have to supply, and never their values', () => {
    const profiles = describeSections(sample).find((section) => section.id === 'profiles')
    expect(profiles?.secretRefs).toEqual(['Corporate gateway: API key'])
    // The profile with `auth: none` needs nothing, and saying otherwise sends somebody hunting
    // for a credential that does not exist.
    expect(profiles?.secretRefs).not.toContain('Local dev: API key')
    expect(JSON.stringify(profiles)).not.toContain('profile:gateway:apiKey')
  })

  it('leaves schedules out of the default selection', () => {
    // A schedule carries tools that run unattended, bound to a path that will not exist on the
    // importing machine. Somebody who means to share one can; nobody should acquire one.
    expect(defaultSelection(sample)).not.toContain('schedules')
    expect(defaultSelection(sample)).toContain('profiles')
  })
})

describe('building an export', () => {
  it('carries only what was chosen', () => {
    const exported = buildExport(sample, ['profiles'])
    expect(exported.profiles).toHaveLength(2)
    expect(exported.activeProfileId).toBe('gateway')
    expect(exported.mcpServers).toBeUndefined()
    expect(exported.ui).toBeUndefined()
  })

  it('produces something the loader will accept', () => {
    // A file that will not import is a file somebody discovers is broken on the other machine.
    const exported = buildExport(sample, SHARE_SECTIONS.map((section) => section.id))
    const parsed = configSchema.safeParse(exported)
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues))
    expect(parsed.success).toBe(true)
  })

  it('still holds only references, never key values', () => {
    const exported = buildExport(sample, ['profiles'])
    const auth = exported.profiles?.[0]?.auth
    expect(auth?.type).toBe('apiKey')
    expect(JSON.stringify(exported)).not.toContain('sk-')
  })
})

describe('applying an import', () => {
  const incoming: LightCodeConfig = {
    profiles: [
      {
        id: 'theirs',
        label: 'Their gateway',
        wireFormat: 'anthropic',
        baseUrl: 'https://other.example.internal',
        model: 'claude',
        auth: { type: 'none' },
      },
    ],
    activeProfileId: 'theirs',
    ui: { accentColor: '#D97757' },
  }

  it('replaces a chosen section rather than merging it', () => {
    /*
     * Merging a list has no answer to "is this the same entry as that one", and any answer it
     * invented would either duplicate everything on a second import or overwrite an entry the two
     * happened to share an id for. Take theirs or keep yours.
     */
    const merged = applyImport(sample, incoming, ['profiles'])
    expect(merged.profiles?.map((profile) => profile.id)).toEqual(['theirs'])
    expect(merged.activeProfileId).toBe('theirs')
  })

  it('leaves untaken sections exactly as they were', () => {
    const merged = applyImport(sample, incoming, ['profiles'])
    expect(merged.ui?.accentColor).toBe('#22C55E')
    expect(merged.mcpServers).toEqual(sample.mcpServers)
  })

  it('cannot bring in what the section table does not own', () => {
    // Belt and braces with `NEVER_SHARED`: even a hand-edited file carrying approvals cannot
    // apply them, because no selectable section names that key.
    const hostile: LightCodeConfig = { approvals: { 'd:\\work': { allowedCommands: ['rm -rf /'] } } }
    const merged = applyImport(sample, hostile, SHARE_SECTIONS.map((section) => section.id) as ShareSectionId[])
    expect(merged.approvals).toEqual(sample.approvals)
  })

  it('removes a key the incoming section does not have, rather than half-taking it', () => {
    // Half a section is a state neither person has ever run.
    const merged = applyImport(sample, { profiles: incoming.profiles ?? [] }, ['profiles'])
    expect(merged.activeProfileId).toBeUndefined()
  })
})
