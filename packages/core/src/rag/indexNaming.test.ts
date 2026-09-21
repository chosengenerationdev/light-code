import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { deriveIndexName, ownerSlug } from './indexNaming.js'

/**
 * The derived index name.
 *
 * Its whole job is that two people never write to one index by accident, and the failure it
 * replaced had no symptom: owner filtering still attributed hits correctly, so a shared index
 * looked exactly like a private one while each person's re-index quietly disturbed the other's.
 */

const ROOT = process.platform === 'win32' ? 'C:\\dev\\payments' : '/dev/payments'
const OTHER = process.platform === 'win32' ? 'C:\\dev\\ledger' : '/dev/ledger'

describe('telling people apart', () => {
  it('gives two owners of the same checkout different names', () => {
    // The case this exists for: a standardised build where everybody clones to the same path.
    const ana = deriveIndexName({ owner: 'ana', workspaceRoot: ROOT })
    const ben = deriveIndexName({ owner: 'ben', workspaceRoot: ROOT })
    expect(ana).not.toBe(ben)
  })

  it('still gives one person different names for different projects', () => {
    expect(deriveIndexName({ owner: 'ana', workspaceRoot: ROOT })).not.toBe(
      deriveIndexName({ owner: 'ana', workspaceRoot: OTHER }),
    )
  })

  it('gives the same person and project the same name every time', () => {
    // Otherwise every session re-embeds the repository.
    expect(deriveIndexName({ owner: 'ana', workspaceRoot: ROOT })).toBe(
      deriveIndexName({ owner: 'ana', workspaceRoot: ROOT }),
    )
  })

  it('is unmoved by how the path happens to be spelled', () => {
    // §16: Windows hands the same folder back more than one way, and a name that changed with the
    // spelling would re-embed for no reason at all.
    expect(deriveIndexName({ owner: 'ana', workspaceRoot: ROOT })).toBe(
      deriveIndexName({ owner: 'ana', workspaceRoot: ROOT.toUpperCase() }),
    )
    expect(deriveIndexName({ owner: 'ana', workspaceRoot: ROOT })).toBe(
      deriveIndexName({ owner: 'ana', workspaceRoot: path.join(ROOT, '.') }),
    )
  })
})

describe('what the name looks like', () => {
  it('puts the owner where somebody scanning a cluster can read it', () => {
    // The schema's own complaint about the old name was that it was unreadable: nobody looking at
    // an index list could tell whose `light-code-a3f2…` it was.
    expect(deriveIndexName({ owner: 'ana', workspaceRoot: ROOT })).toMatch(/^light-code-ana-[0-9a-f]{16}$/)
  })

  it('takes the configured prefix, which is a team namespace and travels on purpose', () => {
    expect(deriveIndexName({ prefix: 'platform', owner: 'ana', workspaceRoot: ROOT })).toMatch(
      /^platform-ana-/,
    )
  })

  it('falls back to the old shape when there is no owner to name', () => {
    // A name with a stray separator where a person should be is worse than no person.
    expect(deriveIndexName({ workspaceRoot: ROOT })).toMatch(/^light-code-[0-9a-f]{16}$/)
  })

  it('keeps two owners apart even when their slugs collide', () => {
    /*
     * `A Smith` and `a.smith` both reduce to `a-smith`. A readable name that collides is worse
     * than an unreadable one that does not, which is why the owner is hashed as well as shown.
     */
    expect(ownerSlug('A Smith')).toBe(ownerSlug('a.smith'))
    expect(deriveIndexName({ owner: 'A Smith', workspaceRoot: ROOT })).not.toBe(
      deriveIndexName({ owner: 'a.smith', workspaceRoot: ROOT }),
    )
  })
})

describe('reducing an owner to something an index name may hold', () => {
  it('drops a domain, because it is the same person either way', () => {
    // `CORP\A.Smith` is an ordinary answer from `os.userInfo()`, and keeping the domain would make
    // one person two indexes depending on how they signed in.
    expect(ownerSlug('CORP\\a.smith')).toBe('a-smith')
    expect(ownerSlug('a.smith@corp.example')).toBe('a-smith')
  })

  it('lowercases and collapses anything a backend would refuse', () => {
    expect(ownerSlug('Ana  García-López')).toBe('ana-garc-a-l-pez')
  })

  it('never ends or begins with a separator', () => {
    expect(ownerSlug('--ana--')).toBe('ana')
    expect(ownerSlug('ana!!!')).toBe('ana')
  })

  it('caps the length, without leaving a trailing separator behind', () => {
    const slug = ownerSlug('a'.repeat(20) + '-' + 'b'.repeat(20))
    expect(slug?.length).toBeLessThanOrEqual(24)
    expect(slug?.endsWith('-')).toBe(false)
  })

  it('gives up rather than returning nothing usable', () => {
    expect(ownerSlug('!!!')).toBeUndefined()
    expect(ownerSlug('')).toBeUndefined()
    expect(ownerSlug(undefined)).toBeUndefined()
  })
})
