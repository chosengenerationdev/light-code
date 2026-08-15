import os from 'node:os'
import { describe, expect, it } from 'vitest'

import { detectClaudeCli, withDeadline } from './claudeCli.js'

/**
 * Detection must always answer.
 *
 * The reported bug was the Expert tab stuck on "Checking…" for the life of the session. The
 * mechanism is §16's: killing a `cmd /c` shim on Windows does not kill the grandchild it
 * launched, and a grandchild holding stdout open means `execFile` never calls back. Bounding
 * the child's own timeout is not enough — the *wait* has to be bounded too.
 */
describe('detectClaudeCli', () => {
  it('reports "not found" rather than hanging when the command does not exist', async () => {
    const info = await detectClaudeCli('lc-definitely-not-a-real-command', 2_000)
    expect(info.available).toBe(false)
    expect(info.reason).toMatch(/could not be run/i)
  })

  it('names a way forward when it cannot find it', async () => {
    const info = await detectClaudeCli('lc-definitely-not-a-real-command', 2_000)
    // Errors are for humans (§17): the two things that actually fix this are the full path and
    // the install command.
    expect(info.reason).toMatch(/full path/i)
    expect(info.reason).toMatch(/npm install -g/i)
  })

  /**
   * The mechanism itself, rather than a command that happens to hang.
   *
   * Which system commands hang is environment-dependent — the first version of this test used
   * `timeout`, which exits immediately on Windows and proved nothing. Testing the shipped
   * `withDeadline` is deterministic and is what actually has to hold.
   */
  it('withDeadline resolves even when the work never settles', async () => {
    const started = Date.now()
    const result = await withDeadline(new Promise<string>(() => undefined), 50, 'gave up')

    expect(result).toBe('gave up')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('withDeadline prefers the real answer when it arrives in time', async () => {
    expect(await withDeadline(Promise.resolve('real'), 1_000, 'gave up')).toBe('real')
  })

  it('accepts an absolute path and does not go hunting elsewhere', async () => {
    const missing = `${os.tmpdir()}/lc-no-such-claude`
    const info = await detectClaudeCli(missing, 2_000)
    expect(info.available).toBe(false)
    expect(info.executable).toBe(missing)
  })
})
