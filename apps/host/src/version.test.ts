import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = readFileSync(path.join(here, 'cli.ts'), 'utf8')
const build = readFileSync(path.join(here, '..', 'esbuild.mjs'), 'utf8')
const manifest = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as {
  version: string
}

/**
 * `--version` has to work, and has to work on a copy too old to understand anything else.
 *
 * It was missing entirely, and because unknown flags are *rejected* rather than ignored,
 * `light-code --version` failed outright. That is the wrong way round for the one question people
 * ask when something else has already gone wrong — and this project has already been bitten by a
 * stale `npx` cache serving a build that predated `--server`, which is exactly the situation
 * `--version` exists to settle.
 */
describe('reporting the version', () => {
  it('accepts both spellings', () => {
    expect(cli).toContain("'--version'")
    expect(cli).toContain("'-v'")
  })

  it('answers before the unknown-flag check', () => {
    /*
     * Order is the whole point. Asked on a copy too old to understand the rest of the command
     * line, it must still answer rather than rejecting the line and exiting.
     */
    const versionAt = cli.indexOf("args.includes('--version')")
    const unknownAt = cli.indexOf('const unknown = args.filter')
    expect(versionAt).toBeGreaterThan(0)
    expect(unknownAt).toBeGreaterThan(versionAt)
  })

  it('is baked in at build time rather than read from disk', () => {
    // There is no manifest beside the bundle to read — the same reason the guide is inlined.
    expect(build).toContain('__LC_VERSION__')
    expect(build).toContain("fs.readFileSync('package.json', 'utf8')")
  })

  it('degrades to something obviously wrong rather than to a plausible number', () => {
    // A confident wrong version defeats the entire purpose of asking.
    expect(cli).toContain("'unknown (not a packaged build)'")
  })

  it('names the version where a stale copy actually shows itself', () => {
    // In the startup banner and in the unknown-flag error, not only when asked directly.
    expect(cli).toContain('Light Code ${VERSION}')
    expect(cli).toContain('you may be on an older cached copy. This one is ')
  })

  it('has a manifest version to report', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
