import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * That the shared-tools plumbing is actually connected.
 *
 * Reading `bridge.ts` rather than testing behaviour, which is the pattern `config/retrieval.test.ts`
 * and `officeTrace.test.ts` already use here, for the same reason: **the defect is a decision not
 * reaching its owner**, and no test of the owner can see that.
 *
 * This is not hypothetical. `s3.tools` shipped configurable, syncing and reported in the panel,
 * with nothing on the other end — `mirroredToolsDirs` was computed and used for one line of UI and
 * never handed to `PythonManager`. Everything looked present. A tool put in a bucket was
 * downloaded and ignored, in both directions, while the panel said it had been copied.
 */

const bridge = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'host', 'bridge.ts'),
  'utf8',
)

describe('the bucket tools folders reach the Python manager', () => {
  it('passes the mirrored folders into configure, on every path that configures it', () => {
    // Sliced rather than matched with a paren-balanced regex: the call contains parentheses of
    // its own, and a pattern stopping at the first one would pass on a call it had only half read.
    const calls: string[] = []
    for (let at = bridge.indexOf('python.configure('); at !== -1; at = bridge.indexOf('python.configure(', at + 1)) {
      // A window rather than the rest of the line: the call is written across several lines in
      // places, and a line-bounded read would report a call it had only half seen.
      calls.push(bridge.slice(at, at + 260))
    }
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call, call).toContain('extraToolDirs')
    }
  })

  it('never configures Python from the raw config alone', () => {
    // The shape the defect had: `python.configure(config.python ?? {})`, correct-looking and
    // silently dropping every shared folder.
    expect(bridge).not.toMatch(/python\.configure\(config\.python \?\? \{\}\)/)
  })

  it('publishes a newly written tool, the way write_skill does', () => {
    expect(bridge).toContain('onToolSaved')
    // Only to a folder marked for publishing, and never to a read-only connection — the same
    // split the skills folders have: many read from, one written to.
    const hook = bridge.slice(bridge.indexOf('onToolSaved'), bridge.indexOf('onToolSaved') + 1200)
    expect(hook).toContain('publish === true')
    expect(hook).toContain('readOnly === true')
    expect(hook).toContain('.py')
  })

  it('approves into the folder that actually holds the file', () => {
    // Approving into `toolsDir` would write an entry in a folder with no file in it, leaving the
    // tool unapproved and a registry claiming otherwise.
    const handler = bridge.slice(
      bridge.indexOf('async function handleApprovePythonTool'),
      bridge.indexOf('async function handleApprovePythonTool') + 1800,
    )
    expect(handler).toContain('python.toolDirectories()')
  })
})
