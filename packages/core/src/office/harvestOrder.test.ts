import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const worker = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.ps1'),
  'utf8',
)

/**
 * The harvest must sort *after* restricting, and must not let one folder eat the batch.
 *
 * Both defects are invisible to any test of what the harvest returns, because both produce a
 * perfectly well-formed answer containing the wrong messages — which is exactly why they were
 * reported as "a lot of the latest emails are not in the index" rather than as an error. Same
 * reasoning as `officeTrace.test.ts` reading this file: where the fault is in how the work is
 * done rather than in its shape, the source is the only place to look.
 */
describe('the mail harvest', () => {
  const body = worker.slice(worker.indexOf('function Invoke-OutlookHarvest'))
  const routine = body.slice(0, body.indexOf('\nfunction '))

  it('sorts after restricting, not before', () => {
    const restrict = routine.indexOf('.Restrict(')
    const sort = routine.indexOf(".Sort('[ReceivedTime]'")
    expect(restrict).toBeGreaterThan(0)
    expect(sort).toBeGreaterThan(0)
    // `Restrict` returns a new collection and does not carry the sort across, so sorting first
    // leaves the results in arbitrary order — and the count limit then cuts that arbitrary order.
    expect(sort).toBeGreaterThan(restrict)
  })

  it('sorts newest first', () => {
    expect(routine).toContain(".Sort('[ReceivedTime]', $true)")
  })

  it('gives each folder its own share of the batch', () => {
    // Without this the first folder consumes the whole limit and every folder after it indexes
    // nothing, for as many passes as that folder has history.
    expect(routine).toContain('$folderBudget')
    expect(routine).toContain('$fromThisFolder -ge $folderBudget')
  })
})
