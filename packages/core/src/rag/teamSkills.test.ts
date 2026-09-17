import { describe, expect, it } from 'vitest'

import type { Skill } from '../skills/index.js'
import {
  describeTeamSkillCollision,
  findTeamSkillsNamed,
  renderTeamSkillHits,
  teamSkillDocument,
  teamSkillId,
  type TeamSkillHit,
} from './teamSkills.js'
import type { VectorMatch, VectorSearcher } from './vectorStore.js'

/**
 * A shared pool of skills across a team.
 *
 * User-requested and flagged as important: *"if user wants to create a new skill but it is
 * already exist in team skills, then user should be told about it, if user wants to modify it,
 * then he should be able to do it too."* Both halves of that sentence matter — being told is the
 * requirement, being blocked is not.
 */

const skill = (name: string): Skill => ({ name, description: `about ${name}` }) as Skill

function searcher(matches: VectorMatch[]): VectorSearcher {
  return {
    kind: 'opensearch',
    label: 'cluster',
    searchByVector: async () => matches,
  }
}

const embedder = { embed: async () => [0.1], dimensions: 1 } as never

function hit(name: string, owner: string | undefined, mine: boolean): TeamSkillHit {
  return { name, text: 'body', score: 1, isMine: mine, ...(owner !== undefined ? { owner } : {}) }
}

describe('storing a skill for the team', () => {
  /** Stable across machines, and scoped by owner so two people may both have `deployment`. */
  it('identifies a skill by owner and name', () => {
    expect(teamSkillId({ name: 'deployment' }, 'r.silva')).toBe('skill:r.silva:deployment')
  })

  it('does not claim an unattributed skill belongs to anyone', () => {
    expect(teamSkillId({ name: 'deployment' }, undefined)).toBe('skill:unknown:deployment')
  })

  /**
   * The body is stored, unlike a codebase chunk. A colleague's skill has no file on this
   * machine, so the index has to be the whole answer or the feature does not work at all.
   */
  it('stores the whole body, not a pointer to it', () => {
    const document = teamSkillDocument(skill('pricing'), 'Call it with an idempotency key.', [0.1], {
      owner: 'r.silva',
      project: 'billing',
    })

    expect(document.text).toContain('Call it with an idempotency key.')
    expect(document.text).toContain('about pricing')
    expect(document.owner).toBe('r.silva')
    expect(document.project).toBe('billing')
  })
})

describe('finding out whether a name is taken', () => {
  /**
   * Matched exactly, not by similarity. "Does this exist" is an exact question, and a semantic
   * near-miss answering it would tell someone a colleague owns something they do not.
   */
  it('keeps only an exact name match, whatever the search returned', async () => {
    const matches: VectorMatch[] = [
      { id: '1', score: 0.9, text: 'x', path: 'skill:deployment', owner: 'r.silva' },
      { id: '2', score: 0.8, text: 'x', path: 'skill:deployment-notes', owner: 'a.patel' },
    ]
    const found = await findTeamSkillsNamed(
      { searcher: searcher(matches), embedder, collections: ['team-skills'], owner: 'me' },
      'deployment',
    )

    expect(found.map((entry) => entry.name)).toEqual(['deployment'])
  })

  it('marks your own copy as yours', async () => {
    const matches: VectorMatch[] = [{ id: '1', score: 0.9, text: 'x', path: 'skill:deployment', owner: 'me' }]
    const found = await findTeamSkillsNamed(
      { searcher: searcher(matches), embedder, collections: ['team-skills'], owner: 'me' },
      'deployment',
    )

    expect(found[0]?.isMine).toBe(true)
  })
})

describe('what the user is told about a collision', () => {
  /** A warning on every write teaches people to skip warnings. */
  it('says nothing when nobody else has it', () => {
    expect(describeTeamSkillCollision('deployment', [])).toBeUndefined()
  })

  it('says nothing when the only copy is your own', () => {
    expect(describeTeamSkillCollision('deployment', [hit('deployment', 'me', true)])).toBeUndefined()
  })

  it('names the colleague who has it', () => {
    const message = describeTeamSkillCollision('deployment', [hit('deployment', 'r.silva', false)])
    expect(message).toContain('r.silva')
    expect(message).toContain('deployment')
  })

  /**
   * The requirement was to be *told*, not stopped. So the message offers both paths and says
   * plainly that writing your own does not overwrite theirs.
   */
  it('offers the choice rather than making it', () => {
    const message = describeTeamSkillCollision('deployment', [hit('deployment', 'r.silva', false)])
    expect(message).toContain('search_team_skills')
    expect(message).toContain('write your own version anyway')
    expect(message).toContain('does not overwrite theirs')
  })

  it('names several owners when more than one has it', () => {
    const message = describeTeamSkillCollision('deployment', [
      hit('deployment', 'r.silva', false),
      hit('deployment', 'a.patel', false),
    ])
    expect(message).toContain('r.silva')
    expect(message).toContain('a.patel')
  })
})

describe('rendering team skills for the model', () => {
  it('says a colleague’s skill has no file to open', () => {
    const rendered = renderTeamSkillHits({ hits: [hit('pricing', 'r.silva', false)], collection: 'team-skills', tried: ['team-skills'] }, 'pricing')
    expect(rendered).toContain('no file on this machine')
    expect(rendered).toContain('do not try to read_file')
  })

  it('distinguishes your own from a colleague’s', () => {
    const rendered = renderTeamSkillHits({ hits: [hit('mine', 'me', true), hit('theirs', 'r.silva', false)], collection: 'team-skills', tried: ['team-skills'] }, 'x')
    expect(rendered).toContain('(yours)')
    expect(rendered).toContain('(r.silva)')
  })

  /** An empty result must not read as "the subject is undocumented". */
  it('distinguishes no matches from nothing being indexed', () => {
    const rendered = renderTeamSkillHits({ hits: [], collection: 'team-skills', tried: ['team-skills'] }, 'pricing')
    expect(rendered).toContain('has not been built yet')
    expect(rendered).toContain('does not mean the subject is undocumented')
  })
})
