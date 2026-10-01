import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Two reported failures that left nothing on screen, pinned against the bridge's source like
 * `config/retrieval.test.ts`: both were a line in the wrong place, which no test of a helper sees.
 */

const bridge = fs.readFileSync(path.join(import.meta.dirname, 'bridge.ts'), 'utf8')
const fn = (signature: string): string => {
  const start = bridge.indexOf(signature)
  expect(start, signature).toBeGreaterThan(-1)
  return bridge.slice(start, bridge.indexOf('\n  }\n', start))
}

describe('pressing Run on a schedule', () => {
  /*
   * Reported from a demo: Run did nothing. A reply was still finishing, and a busy bridge skipped
   * the run with a log line. A person who pressed Run is told, and the run waits.
   */
  it('waits for a reply in progress instead of dropping the run, and says so', () => {
    const run = fn('async function runSchedule(')
    expect(run).toContain("if (reason === 'manual') {")
    expect(run).toContain('will run as soon as')
    expect(run).toContain('while (busy() && Date.now() < deadline)')
    expect(run).toContain('Running "${name}" now')
  })

  /*
   * The second half of the same report: errors during a scheduled run are hidden from the screen,
   * and the run was then recorded as a success with an empty summary.
   */
  it('records a run that raised an error as failed, and tells somebody', () => {
    expect(fn('function post(message: HostToUiMessage)')).toContain("if (message.type === 'error') backgroundRunErrors.push(message.message)")
    const inner = fn('async function runScheduleInner(')
    expect(inner).toContain('backgroundRunErrors = []')
    expect(inner).toContain("if (backgroundRunErrors.length > 0) throw new Error(backgroundRunErrors.join(' '))")
    expect(inner).toContain('finished.`')
  })
})

describe('the Python tab', () => {
  /*
   * Reported: "Dynamic Python tools are off" and no tools, with them switched on. The manager was
   * configured only when a message was sent, so a tab opened first showed its starting state.
   */
  it('configures Python from saved settings before reporting its status', () => {
    const route = bridge.slice(bridge.indexOf("message.type === 'requestPython'"), bridge.indexOf("message.type === 'requestPython'") + 200)
    expect(route).toContain('configurePythonFromSettings().then(postPython)')
    const configure = fn('async function configurePythonFromSettings(')
    expect(configure).toContain('pythonFolders(config)')
    expect(configure).toContain('if (userTurnRunning || runningScheduleId !== undefined) return')
  })
})
