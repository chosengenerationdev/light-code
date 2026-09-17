import { describe, expect, it } from 'vitest'

import { mirrorFolder } from './localFolder.js'
import { configSchema } from '../config/schema.js'

/**
 * Several bucket folders, not one.
 *
 * Asked for directly: a bucket folder should be usable the way "Also read skills from" already is
 * — any number of sources, read in order. Which means the shape that matters is a *list*, and that
 * each entry lands somewhere of its own.
 */

const parse = (s3: unknown): { skills?: { connectionId: string; publish?: boolean }[] } => {
  const result = configSchema.safeParse({ s3 })
  expect(result.success).toBe(true)
  return (result.success ? (result.data.s3 ?? {}) : {}) as never
}

describe('configuring several folders', () => {
  it('accepts a list of them', () => {
    const parsed = parse({
      skills: [
        { connectionId: 'team', prefix: 'skills/', enabled: true },
        { connectionId: 'platform', prefix: 'shared-skills/', enabled: true },
      ],
    })
    expect(parsed.skills).toHaveLength(2)
  })

  it('keeps the order, because they are read in it', () => {
    const parsed = parse({
      skills: [{ connectionId: 'first' }, { connectionId: 'second' }],
    })
    expect(parsed.skills?.map((mirror) => mirror.connectionId)).toEqual(['first', 'second'])
  })

  it('allows one to be the place new skills are saved', () => {
    const parsed = parse({ skills: [{ connectionId: 'team', publish: true, enabled: true }] })
    expect(parsed.skills?.[0]?.publish).toBe(true)
  })

  /* A cap, so a misconfigured file cannot ask for a hundred syncs on every panel open. */
  it('refuses an unreasonable number', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ connectionId: `c${String(index)}` }))
    expect(configSchema.safeParse({ s3: { skills: many } }).success).toBe(false)
  })
})

/**
 * Each folder needs its own place on disk, or two sources would be written over each other and the
 * skills of whichever synced last would be all that survived.
 */
describe('where several folders land', () => {
  const base = { storageDir: '/data', kind: 'skills' as const }

  it('gives two connections different folders', () => {
    expect(mirrorFolder({ ...base, connectionId: 'team', prefix: 'skills/' })).not.toBe(
      mirrorFolder({ ...base, connectionId: 'platform', prefix: 'skills/' }),
    )
  })

  it('gives two prefixes on one connection different folders', () => {
    expect(mirrorFolder({ ...base, connectionId: 'team', prefix: 'a/' })).not.toBe(
      mirrorFolder({ ...base, connectionId: 'team', prefix: 'b/' }),
    )
  })

  it('gives skills and tools different folders even for the same prefix', () => {
    expect(mirrorFolder({ ...base, connectionId: 'team', prefix: 'x/' })).not.toBe(
      mirrorFolder({ storageDir: '/data', kind: 'tools', connectionId: 'team', prefix: 'x/' }),
    )
  })
})
