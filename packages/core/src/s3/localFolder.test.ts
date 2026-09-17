import { describe, expect, it } from 'vitest'

import { mirrorFolder } from './localFolder.js'

/**
 * Where a mirrored bucket folder lands.
 *
 * A mirror is a cache — the bucket is the source — so it lives under `storageDir` beside tasks and
 * spilled results, not in the workspace where somebody would eventually commit it.
 */

const base = { storageDir: '/data', connectionId: 'team', kind: 'skills' as const }

describe('choosing the local folder', () => {
  it('puts it under storage, not the workspace', () => {
    expect(mirrorFolder(base).startsWith('/data/s3/')).toBe(true)
  })

  it('names the kind, so the folder reads plainly', () => {
    expect(mirrorFolder(base)).toContain('/skills-')
    expect(mirrorFolder({ ...base, kind: 'tools' })).toContain('/tools-')
  })

  /* A sync must refresh the same folder, not leave a new copy on every panel open. */
  it('is the same folder for the same connection and prefix', () => {
    expect(mirrorFolder({ ...base, prefix: 'a/' })).toBe(mirrorFolder({ ...base, prefix: 'a/' }))
  })

  /*
   * Changing the prefix gives a fresh folder. Merged, skills from a prefix nobody has configured
   * would keep being loaded and indexed with nothing to say why — and the sync never deletes, so
   * they would stay for good.
   */
  it('changes when the prefix changes', () => {
    expect(mirrorFolder({ ...base, prefix: 'team/' })).not.toBe(mirrorFolder({ ...base, prefix: 'platform/' }))
  })

  it('keeps two connections apart', () => {
    expect(mirrorFolder(base)).not.toBe(mirrorFolder({ ...base, connectionId: 'other' }))
  })

  it('keeps skills and tools apart for one connection', () => {
    expect(mirrorFolder(base)).not.toBe(mirrorFolder({ ...base, kind: 'tools' }))
  })
})

/**
 * Ids are hand-editable config, so one can contain a separator — and a segment carrying one would
 * write outside the folder this is supposed to own.
 */
describe('an id that is not a safe path segment', () => {
  /*
   * The property that matters is that the id cannot introduce a **separator** — a literal `.` in
   * a folder name is harmless, an escape is not. Asserted as "no separator" rather than "no dots",
   * which is what the first version of this test checked and was the wrong rule.
   */
  it('never lets an id introduce a path separator', () => {
    const folder = mirrorFolder({ ...base, connectionId: '../../etc' })
    expect(folder.startsWith('/data/s3/')).toBe(true)
    const segment = folder.slice('/data/s3/'.length).split('/')[0] ?? ''
    expect(segment.includes('/')).toBe(false)
    expect(segment.includes('\\')).toBe(false)
    expect(segment).not.toBe('..')
  })

  it('keeps two ids apart even when they flatten to the same text', () => {
    expect(mirrorFolder({ ...base, connectionId: 'a/b' })).not.toBe(
      mirrorFolder({ ...base, connectionId: 'a:b' }),
    )
  })

  it('still produces a usable folder for an id of only odd characters', () => {
    expect(mirrorFolder({ ...base, connectionId: '///' })).toContain('/data/s3/connection-')
  })
})
