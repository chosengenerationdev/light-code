import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { computeDashboard } from './dashboard.js'
import { entryMatches, escapeLdapFilter, lookupDirectory, profileFromPerson } from './directory.js'
import { userInfoSkillCandidates, userProfileGuidance } from './profileTool.js'

/**
 * The company directory as the first source of who people are, and the leaderboard built on it.
 *
 * Off a domain - which this development machine is - only the "unavailable" path can run for real
 * (it does, in `directory.rs`'s tests and by hand); a domain's answer is simulated here, in the shape
 * the Rust helper returns, so the parsing is pinned even where no directory exists.
 */

describe('the company directory', () => {
  it('escapes a name so it cannot change the filter - the same as directory.rs', () => {
    expect(escapeLdapFilter('a*)(objectClass=*')).toBe('a\\2a\\29\\28objectClass=\\2a')
    expect(escapeLdapFilter('DOMAIN\\ann')).toBe('DOMAIN\\5cann')
  })

  it('matches an entry by account, sign-in name, email or display name, without case', () => {
    const entry = { sAMAccountName: 'AEX1234', userPrincipalName: 'aex1234@corp.example', mail: 'ann@corp.example', displayName: 'Ann Example' }
    for (const name of ['aex1234', 'CORP\\aex1234', 'ann@corp.example', 'Ann Example', 'AEX1234@corp.example']) expect(entryMatches(entry, name), name).toBe(true)
    expect(entryMatches(entry, 'bob')).toBe(false)
  })

  it('reads through the Rust helper, keeping only the known fields', async () => {
    const rust = await lookupDirectory(['ann'], { platform: 'win32', helper: async () => ({ ok: true, available: true, people: { ann: { displayName: 'Ann', secret: 'x' } }, notFound: [] }) })
    expect(rust).toMatchObject({ available: true, via: 'rust', people: { ann: { displayName: 'Ann' } } })
    if (rust.available) expect(rust.people['ann']).not.toHaveProperty('secret')
    const unreachable = await lookupDirectory(['x'], { platform: 'win32', helper: async () => ({ ok: true, available: false, reason: 'The specified domain either does not exist or could not be contacted.' }) })
    expect(unreachable).toMatchObject({ available: false, reason: expect.stringContaining('domain') })
  })

  /*
   * The PowerShell fallback (`powershell -EncodedCommand` with a DirectorySearcher) raised a security
   * alert on a managed machine; the machines using the Rust helper for the same lookup raised none.
   */
  it('never falls back to PowerShell: no helper, or a helper without the operation, means unavailable', async () => {
    expect(await lookupDirectory(['ann'], { platform: 'win32' })).toMatchObject({ available: false, via: 'none' })
    const older = await lookupDirectory(['ann'], { platform: 'win32', helper: async () => ({ ok: false, error: 'Unknown operation "directory".' }) })
    expect(older).toMatchObject({ available: false, via: 'rust' })
    const source = readFileSync(new URL('./directory.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/node:child_process|spawn\(|powershell\.exe/)
  })

  it('is not asked anywhere but Windows', async () => {
    expect(await lookupDirectory(['ann'], { platform: 'linux' })).toMatchObject({ available: false, via: 'none' })
  })

  it('a directory entry becomes a profile whose team is the department', () => {
    expect(profileFromPerson({ displayName: 'Ann', department: 'Rates', title: 'Quant' })).toEqual({ displayName: 'Ann', department: 'Rates', team: 'Rates', title: 'Quant', source: 'company directory' })
  })
})

describe('the second way: a skill or tool', () => {
  it('a skill named like a user lookup counts, and the guidance says to read and follow it', () => {
    const skills = [
      { name: 'who-am-i', filePath: '/s/who-am-i.md' },
      { name: 'deploy', filePath: '/s/deploy.md' },
      { name: 'user-info', filePath: '/s/user-info.md' },
    ]
    expect(userInfoSkillCandidates(skills).map((skill) => skill.name)).toEqual(['who-am-i', 'user-info'])
    const text = userProfileGuidance('aex1234', [], [skills[0]!])
    expect(text).toContain('read the skill "who-am-i"')
    expect(text).toContain('company directory did not say')
  })
})

describe('the leaderboard', () => {
  it('counts what each author added and updated in the range, and their impact', () => {
    const now = Date.UTC(2026, 9, 10)
    const day = 86_400_000
    const d = computeDashboard({
      events: [
        { t: now - day, u: 'x', k: 'skill', n: 'deploy' },
        { t: now - day, u: 'y', k: 'skill', n: 'deploy' },
      ],
      inventory: [
        { kind: 'skill', name: 'deploy', filePath: '/a', deletable: true, location: 'here', author: 'Ann', version: 1, updated: new Date(now - 2 * day).toISOString() },
        { kind: 'skill', name: 'old', filePath: '/b', deletable: true, location: 'here', author: 'Ann', version: 4, updated: new Date(now - 3 * day).toISOString() },
        { kind: 'tool', name: 'ancient', filePath: '/c', deletable: true, location: 'here', author: 'Ann', version: 2, updated: new Date(now - 90 * day).toISOString() },
      ],
      scope: 'team',
      me: 'x',
      from: now - 7 * day,
      to: now,
      // Asked of the directory in lower case; the label says "Ann".
      profiles: { ann: { displayName: 'Ann Example', team: 'Rates' } },
    })
    expect(d.contributors[0]).toMatchObject({ author: 'Ann', displayName: 'Ann Example', team: 'Rates', skills: 2, tools: 1, added: 1, updated: 1, uses: 2, reached: 2, impact: 4 })
  })
})

describe('wiring', () => {
  const bridge = readFileSync(new URL('../host/bridge.ts', import.meta.url), 'utf8')

  it('the agent is asked only after the directory has had its say, and the directory runs after every push', () => {
    expect(bridge).toMatch(/cachedProfileFresh === false && directoryChecked/)
    // In the background only the signed-in user; everybody else only when the dashboard is opened.
    expect(bridge).toContain('void enrichFromDirectory([])')
    expect(bridge).not.toContain('void enrichFromDirectory(namesToEnrich')
  })

  it('the directory wins over a tool-recorded profile, which only fills gaps', () => {
    expect(bridge).toContain('profiles[key] = { ...profiles[key], ...fromDirectory }')
  })

  it("uses Fire Code's helper for the directory when it has the operation", () => {
    expect(bridge).toContain("fastFsOps.has('directory')")
  })
})
