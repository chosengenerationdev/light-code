import { describe, expect, it } from 'vitest'

import { belongsToSkill, removeSkillFromBucket, skillKeysInBucket } from './remove.js'
import type { S3Target } from './tools.js'

/**
 * Deleting from a bucket is the only destructive thing in `s3/`, and it reaches other people.
 * Everything here is about the two ways that goes wrong quietly: taking a neighbour's skill with
 * it, and deleting something the user was never shown.
 */

function fakeTarget(options: {
  keys?: string[]
  readOnly?: boolean
  failOn?: string
  /** The connection's own prefix. `skills/` throughout, which is what a real mirror looks like. */
  prefix?: string
}): S3Target & { removed: string[] } {
  const removed: string[] = []
  return {
    id: 'team',
    label: 'Team bucket',
    bucket: 'team',
    prefix: options.prefix ?? 'skills/',
    removed,
    ...(options.readOnly === true ? { readOnly: true } : {}),
    client: {
      async list() {
        return (options.keys ?? []).map((key) => ({ key, size: 1, lastModified: '' }))
      },
      async remove(key: string) {
        if (key === options.failOn) throw new Error('Access Denied')
        removed.push(key)
      },
    },
  } as unknown as S3Target & { removed: string[] }
}

describe('which objects belong to a skill', () => {
  it('matches the flat layout exactly', () => {
    expect(belongsToSkill('skills/deploy.md', 'skills/', 'deploy')).toBe(true)
  })

  it('matches the folder layout and everything under it', () => {
    // A folder skill carries pictures and reference files. Leaving those behind would leave a
    // folder that still syncs, still looks like a skill in the bucket, and loads as nothing.
    expect(belongsToSkill('skills/deploy/SKILL.md', 'skills/', 'deploy')).toBe(true)
    expect(belongsToSkill('skills/deploy/files/template.xlsx', 'skills/', 'deploy')).toBe(true)
  })

  it('never takes a neighbour whose name merely starts the same', () => {
    /*
     * The whole reason this is exact rather than a prefix test. Short names that prefix longer
     * ones are the normal case, and a delete that took `deployment` with `deploy` would be
     * discovered by somebody else, later, with nothing to say what happened.
     */
    expect(belongsToSkill('skills/deployment.md', 'skills/', 'deploy')).toBe(false)
    expect(belongsToSkill('skills/deployment/SKILL.md', 'skills/', 'deploy')).toBe(false)
  })

  it('never reaches outside the mirror prefix', () => {
    expect(belongsToSkill('other/deploy.md', 'skills/', 'deploy')).toBe(false)
  })
})

describe('listing what would go', () => {
  it('returns the real objects, both layouts included', async () => {
    const target = fakeTarget({
      keys: [
        'skills/deploy.md',
        'skills/deploy/SKILL.md',
        'skills/deploy/files/template.xlsx',
        'skills/deployment.md',
        'skills/other.md',
      ],
    })
    const keys = await skillKeysInBucket({ target, name: 'deploy' })
    expect(keys).toEqual([
      'skills/deploy.md',
      'skills/deploy/SKILL.md',
      'skills/deploy/files/template.xlsx',
    ])
  })

  it('returns nothing rather than failing when the skill is already gone', async () => {
    // Somebody may have removed it already, and that is a real answer worth being able to give.
    const target = fakeTarget({ keys: ['skills/other.md'] })
    expect(await skillKeysInBucket({ target, name: 'deploy' })).toEqual([])
  })
})

describe('removing', () => {
  it('deletes exactly the keys it was given', async () => {
    const target = fakeTarget({})
    const result = await removeSkillFromBucket({
      target,
      name: 'deploy',
      keys: ['skills/deploy.md', 'skills/deploy/SKILL.md'],
    })
    expect(target.removed).toEqual(['skills/deploy.md', 'skills/deploy/SKILL.md'])
    expect(result.removed).toHaveLength(2)
  })

  it('refuses a key that is not this skill, rather than trusting the caller', async () => {
    /*
     * The keys arrive from the UI, and "the UI would not send that" is not a boundary. A stale or
     * malformed request must not reach past the folder it was about.
     */
    const target = fakeTarget({})
    const result = await removeSkillFromBucket({
      target,
      name: 'deploy',
      keys: ['skills/deploy.md', 'skills/deployment.md', 'other/secret.md'],
    })
    expect(target.removed).toEqual(['skills/deploy.md'])
    // Reported, not swallowed: deleting fewer objects than the user agreed to would leave them
    // believing the skill was gone.
    expect(result.rejected).toEqual(['skills/deployment.md', 'other/secret.md'])
  })

  it('refuses outright on a read-only connection', async () => {
    const target = fakeTarget({ readOnly: true })
    await expect(
      removeSkillFromBucket({ target, name: 'deploy', keys: ['skills/deploy.md'] }),
    ).rejects.toThrow(/read-only/)
    expect(target.removed).toEqual([])
  })

  it('attempts every key even when one fails, and names the ones that did not go', async () => {
    // Half a folder skill removed is the state to avoid, and stopping at the first error is what
    // produces it.
    const target = fakeTarget({ failOn: 'skills/deploy/SKILL.md' })
    const result = await removeSkillFromBucket({
      target,
      name: 'deploy',
      keys: ['skills/deploy.md', 'skills/deploy/SKILL.md', 'skills/deploy/files/t.xlsx'],
    })
    expect(result.removed).toEqual(['skills/deploy.md', 'skills/deploy/files/t.xlsx'])
    expect(result.failed).toEqual([
      { key: 'skills/deploy/SKILL.md', problem: expect.stringContaining('Access Denied') },
    ])
  })

  it('honours the connection prefix as well as the mirror one', async () => {
    const target = fakeTarget({ prefix: 'org/' })
    const result = await removeSkillFromBucket({
      target,
      prefix: 'skills/',
      name: 'deploy',
      keys: ['org/skills/deploy.md', 'skills/deploy.md'],
    })
    // The second is outside this mirror's folder, however plausible it looks.
    expect(target.removed).toEqual(['org/skills/deploy.md'])
    expect(result.rejected).toEqual(['skills/deploy.md'])
  })
})
