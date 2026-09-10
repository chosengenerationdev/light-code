import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { installNodeCompat } from './nodeCompat.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = readFileSync(path.join(here, 'cli.ts'), 'utf8')

/**
 * The Node 17 floor, and the one thing that makes it real.
 *
 * Everything Light Code writes stays inside Node 17 already — the newest API anywhere in core is
 * `structuredClone`, which landed in 17.0 exactly. What does not is `@modelcontextprotocol/sdk`,
 * which declares `>=18` because of the web globals Node 18 promoted: `fetch`, the stream types,
 * `Blob`. On 17 those all exist, just not on `globalThis`.
 *
 * So the floor holds only while the shim runs *first*. A dependency that reads one of those at
 * module scope captures the absence, and fails much later with a ReferenceError naming nothing in
 * this repository — which is exactly the sort of failure nobody traces back to an import order.
 */
describe('the Node 17 compatibility shim', () => {
  it('is installed before any other import in the entry point', () => {
    const compatImport = cli.indexOf("from './nodeCompat.js'")
    expect(compatImport).toBeGreaterThan(-1)

    // Every other import must come after it. `node:child_process` is simply the first one today;
    // the assertion is about ordering, not about that module.
    const others = [...cli.matchAll(/^import .* from '(?!\.\/nodeCompat)/gm)].map((match) => match.index ?? 0)
    expect(others.length).toBeGreaterThan(0)
    expect(Math.min(...others)).toBeGreaterThan(compatImport)
  })

  it('is called, not merely imported', () => {
    expect(cli).toMatch(/installNodeCompat\(\)/)
  })

  it('leaves a modern runtime untouched', () => {
    // This suite runs on a current Node, where all of these are already global. Installing
    // anything here would mean the shim was replacing Node's own objects rather than filling gaps.
    const report = installNodeCompat()
    expect(report.installed).toEqual([])
  })

  it('reports the runtime, so an odd session is diagnosable from one line', () => {
    expect(installNodeCompat().nodeVersion).toBe(process.version)
  })

  it('provides every global the SDK needs, whether from Node or from undici', () => {
    /*
     * Named explicitly rather than inferred from what happens to be missing. On the machine this
     * runs on nothing is missing, so a list built from the environment would be empty and the test
     * would pass without checking anything.
     */
    for (const name of ['fetch', 'Headers', 'Request', 'Response', 'FormData', 'ReadableStream', 'Blob']) {
      expect(typeof (globalThis as Record<string, unknown>)[name]).not.toBe('undefined')
    }
  })
})
