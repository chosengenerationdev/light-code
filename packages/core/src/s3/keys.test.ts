import { describe, expect, it } from 'vitest'

import { confineKey, displayKey, normalisePrefix } from './keys.js'

/**
 * Keeping a key inside the prefix a connection is limited to.
 *
 * `confine()`'s argument applied to a bucket. A bucket usually holds far more than one project, so
 * without this the prefix would be a comment and the model could read anything the key can reach.
 */
describe('confining a key to its prefix', () => {
  it('accepts a key written relative to the prefix', () => {
    expect(confineKey('report.csv', 'team/')).toEqual({ ok: true, key: 'team/report.csv' })
  })

  /* A listing shows the full key, so the model will often pass it back as it was shown. */
  it('accepts the same key written in full', () => {
    expect(confineKey('team/report.csv', 'team/')).toEqual({ ok: true, key: 'team/report.csv' })
  })

  it('leaves a key alone when the connection has no prefix', () => {
    expect(confineKey('anything.csv', undefined)).toEqual({ ok: true, key: 'anything.csv' })
  })

  /* S3 has no parent directory: `a/../b` is a literal key, so this is a mistake or an attempt. */
  it('refuses a key containing ..', () => {
    const refused = confineKey('../finance/salaries.csv', 'team/')
    expect(refused.ok).toBe(false)
  })

  it('says why, rather than failing as a 404 later', () => {
    const refused = confineKey('../x', 'team/')
    expect(refused.ok === false && refused.message).toMatch(/does not interpret/)
  })

  it('refuses an empty key', () => {
    expect(confineKey('   ', 'team/').ok).toBe(false)
  })

  it('ignores a leading slash rather than making a key that starts with one', () => {
    expect(confineKey('/report.csv', 'team/')).toEqual({ ok: true, key: 'team/report.csv' })
  })
})

describe('normalising a prefix', () => {
  it('adds the trailing slash so a prefix cannot match a sibling folder', () => {
    expect(normalisePrefix('team')).toBe('team/')
  })

  it('leaves one that already has it', () => {
    expect(normalisePrefix('team/')).toBe('team/')
  })

  it('treats absent and empty alike as the whole bucket', () => {
    expect(normalisePrefix(undefined)).toBe('')
    expect(normalisePrefix('  ')).toBe('')
  })
})

describe('showing a key to a person', () => {
  it('hides the prefix they already know about', () => {
    expect(displayKey('team/report.csv', 'team/')).toBe('report.csv')
  })

  it('shows the whole key when there is no prefix', () => {
    expect(displayKey('report.csv', undefined)).toBe('report.csv')
  })
})
