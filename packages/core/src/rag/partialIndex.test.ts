import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { docEntryId, parseDocEntryId } from './toolDocs.js'

/**
 * Reindexing tools must never delete skills, or the other way round.
 *
 * The index has one stale sweep: everything in the store that the freshly built corpus does not
 * contain is deleted. That is correct for a full run and catastrophic for a partial one — a
 * tools-only rebuild contains no skills at all, so an unscoped sweep would remove every one of
 * them, silently, leaving a search that quietly stops finding things.
 *
 * The behaviour lives inside `indexDocs`, which is not reachable without a store and an embedder.
 * So this pins the two things that make it correct: the ids carry their kind, and the sweep in
 * `bridge.ts` filters on it. A shape test, because the defect is an omission — and an omission is
 * invisible to any test of the code that is present.
 */
describe('a partial reindex', () => {
  it('can tell the two kinds apart from the stored id alone', () => {
    expect(parseDocEntryId(docEntryId('tool', 's3__get_object'))).toEqual({ kind: 'tool', name: 's3__get_object' })
    expect(parseDocEntryId(docEntryId('skill', 'house-style'))).toEqual({ kind: 'skill', name: 'house-style' })
  })

  /** A name containing a colon must not be read as a different kind. */
  it('is not confused by a colon inside a name', () => {
    expect(parseDocEntryId('tool:server:tool_name')).toEqual({ kind: 'tool', name: 'server:tool_name' })
  })

  it('ignores an id that is not one of ours rather than guessing its kind', () => {
    expect(parseDocEntryId('src/api.ts')).toBeUndefined()
    expect(parseDocEntryId('other:thing')).toBeUndefined()
  })

  it('sweeps only its own kind, and the sweep says so in the code', async () => {
    const bridge = await fs.readFile(fileURLToPath(new URL('../host/bridge.ts', import.meta.url)), 'utf8')
    const sweep = /const stale = \(await writer\.listPaths\(index\)\)\.filter\(\([\s\S]{0,600}?\n {6}\}\)/.exec(bridge)

    expect(sweep, 'the stale sweep should still be a filter over listPaths').not.toBeNull()
    expect(sweep?.[0]).toContain('parseDocEntryId')
    expect(sweep?.[0]).toContain('wanted')
  })

  /**
   * Fingerprints are per kind too. Sharing one would let a tools-only run record "everything is
   * current", after which a full run would find nothing to do and the skills would never arrive.
   */
  it('keeps a separate fingerprint per kind', async () => {
    const bridge = await fs.readFile(fileURLToPath(new URL('../host/bridge.ts', import.meta.url)), 'utf8')
    expect(bridge).toMatch(/docs\.\$\{kind\}/)
  })
})
