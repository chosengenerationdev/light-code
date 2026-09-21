import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Excel, Outlook and the mail index in the Node host: on your own machine, never on a server.
 *
 * ## What changed, and why it is not a reversal of the reasoning
 *
 * This file used to assert `offersOffice: false` outright. The reasoning behind that flat refusal
 * was sound and is unchanged: both tools attach over COM to an application on somebody's
 * *desktop*, which a service account has no route to even on Windows, and a mailbox belongs to a
 * person rather than to the account the process runs as.
 *
 * **The premise changed, not the argument.** The host was built as a server, and it is also how
 * somebody runs Light Code when they can install Node but cannot reach a registry to install the
 * extension. On that machine Excel and Outlook are exactly as reachable as they are from the
 * extension, because it is the same desktop and the same logged-in session.
 *
 * So the decision is now made from the thing that actually separates the two cases — is anybody
 * else here — rather than from which host this is. The server keeps precisely the behaviour it
 * had.
 *
 * Declined rather than deleted, still: `packages/core` and `packages/ui` are shared, so removing
 * the feature would take it out of the extension too.
 */
const hostSrc = path.join(__dirname)
const coreSrc = path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src')

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), 'utf8')
}

describe('the Node host and Office', () => {
  it('offers it on a single-user machine and declines it when shared', () => {
    // One expression, reading one flag. A second way of asking "is this shared" is how two parts
    // of the product end up disagreeing about it.
    expect(read(hostSrc, 'session.ts')).toContain('offersOffice: options.shared !== true')
  })

  it('takes that flag from the role policy rather than re-deriving it', () => {
    /*
     * `roles.shared` already answers "is more than one person here" — it is what the admin/user
     * split is built on. Inferring it again from whichever shared store happens to be configured
     * would be the same fact in two places, and the two would drift.
     */
    expect(read(hostSrc, 'server.ts')).toContain('shared: roles.shared')
  })

  /**
   * The reason this is worth a test of its own.
   *
   * The platform check was one question asked in six places, which was fine while the answer was
   * only ever "is this Windows". A second term — does this host want it — makes six call sites
   * that each have to learn about it, and the one that did not would leave a tab, a timer or a
   * tool behind. A missing call is invisible to any test of the function that was not called.
   */
  it('asks one function, not the platform, everywhere it matters', () => {
    const bridge = read(coreSrc, 'host', 'bridge.ts')
    const direct = bridge.match(/officeSupported\(\)/g) ?? []
    // One: inside `officeAvailable` itself. Every other site goes through that.
    expect(
      direct.length,
      'bridge.ts asks the platform directly somewhere outside officeAvailable()',
    ).toBe(1)
    expect(bridge).toContain('function officeAvailable()')
    expect(bridge).toContain('services.offersOffice !== false')
  })

  /** Absent, not present-and-apologising: a tab whose only content is an apology is worse. */
  it('leaves the Outlook tab out when it is declined', () => {
    const panel = read(coreSrc, '..', '..', 'ui', 'src', 'settings', 'SettingsPanel.tsx')
    expect(panel).toContain('outlook: props.offersOffice !== false')
  })

  /*
   * `packages/core` is shared, so a change that removed the feature rather than declining it
   * would take it out of the extension too — where it is used daily. Absent on the extension's
   * side means offered, which is what keeps that true.
   */
  it('leaves the extension alone, which still offers it unconditionally', () => {
    const extension = [
      read(__dirname, '..', '..', 'vscode', 'src', 'extension.ts'),
      read(__dirname, '..', '..', 'vscode', 'src', 'webview', 'chatViewProvider.ts'),
    ].join('\n')
    expect(
      extension.includes('offersOffice'),
      'the extension now declares an Office preference',
    ).toBe(false)
  })
})
