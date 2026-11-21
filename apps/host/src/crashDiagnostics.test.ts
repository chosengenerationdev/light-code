import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { memoryLine } from './crashDiagnostics.js'

/*
 * Reported from real use: Fire Code's agent stopped often and its log named no cause. These run a
 * real Node process and kill it the way the real thing dies, so what is pinned is what a log would
 * actually contain - not what the code means to write.
 */

const MODULE = pathToFileURL(path.join(__dirname, 'crashDiagnostics.ts')).href

function run(body: string, dataDir: string): { stderr: string; status: number | null } {
  // Node runs the TypeScript directly (type stripping), so the shipped function is what is tested.
  const script = `import { installCrashDiagnostics } from ${JSON.stringify(MODULE)}\ninstallCrashDiagnostics(${JSON.stringify(dataDir)})\n${body}`
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { stderr: result.stderr, status: result.status }
}

describe('what a crashed host leaves behind', () => {
  it('says how it started and how it exited', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lc-crash-'))
    try {
      const { stderr } = run('process.exitCode = 4', dir)
      expect(stderr).toMatch(/\[diagnostics\] node v\d+.*heap limit \d+ MB/)
      expect(stderr).toMatch(/exiting through Node with code 4/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes a report when the heap runs out, which nothing in JavaScript can catch', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lc-crash-'))
    try {
      // A small heap so this takes a second, not minutes.
      const script = `import { installCrashDiagnostics } from ${JSON.stringify(MODULE)}\ninstallCrashDiagnostics(${JSON.stringify(dir)})\nconst keep = []; for (;;) keep.push(new Array(100000).fill(keep.length))`
      const result = spawnSync(
        process.execPath,
        ['--max-old-space-size=32', '--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
        { encoding: 'utf8', timeout: 120_000 },
      )
      expect(result.stderr).toMatch(/heap out of memory/i)
      // Killed natively: the Node exit line is absent, which is itself what tells the two apart.
      expect(result.stderr).not.toMatch(/exiting through Node/)
      const reports = readdirSync(path.join(dir, 'crash-reports'))
      expect(reports.length).toBe(1)
      const report = JSON.parse(readFileSync(path.join(dir, 'crash-reports', reports[0] as string), 'utf8')) as {
        header: { event: string }
      }
      expect(report.header.event).toMatch(/heap out of memory/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)

  it('reports memory against the limit', () => {
    const { text, fraction } = memoryLine(4096)
    expect(text).toMatch(/^rss \d+ MB, heap \d+ MB of 4096 MB, external \d+ MB, up \d+ min$/)
    expect(fraction).toBeGreaterThan(0)
    expect(fraction).toBeLessThan(1)
  })
})
