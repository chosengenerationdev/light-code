import { describe, expect, it } from 'vitest'

import { aliasFields, aliasProblem, parseAliases, skillAliases } from './aliases.js'
import type { LightCodeConfig } from '../config/schema.js'

/**
 * Reported from real use as "search team skills is dead, other people couldn't see the team
 * skills". Alias names were stored exactly as typed, and OpenSearch only accepts lowercase — so a
 * capital made the name unusable on the machine that typed it, and a colleague who typed it in
 * lowercase was using a different name from the first machine's. Both halves are pinned here.
 */
describe('alias names', () => {
  it('are lowercased on the way out, so a config saved with capitals works unedited', () => {
    const config = { embedder: { skillsAlias: 'Team-Skills', skillsAliases: ['Platform'] } } as unknown as LightCodeConfig
    expect(skillAliases(config)).toEqual(['team-skills', 'platform'])
  })

  it('are lowercased on the way in, so two spellings are one name', () => {
    expect(parseAliases('Team-Skills, team-skills, EVERYONE')).toEqual(['team-skills', 'everyone'])
    expect(aliasFields(['Squad', 'Everyone'])).toEqual({ primary: 'squad', rest: ['everyone'] })
  })

  it('accept what OpenSearch accepts', () => {
    for (const ok of ['team-skills', 'platform_skills', 'a.b+c', 'Team-Skills']) {
      expect(aliasProblem(ok)).toBeUndefined()
    }
  })

  it('refuse, with a reason, what OpenSearch would refuse', () => {
    expect(aliasProblem('team skills')).toMatch(/no spaces/)
    expect(aliasProblem('-team')).toMatch(/start with a letter or digit/)
    expect(aliasProblem('team*')).toMatch(/wildcard/)
    expect(aliasProblem('a..b')).toMatch(/\.\./)
    expect(aliasProblem('   ')).toMatch(/empty/)
  })
})
