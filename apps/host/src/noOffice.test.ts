import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Excel, Outlook and the mail index are not part of the Node host.
 *
 * Both Office tools attach over COM to an application running on somebody's *desktop*, which a
 * service account has no route to even on Windows; a mailbox belongs to a person rather than to
 * the account this process runs as. The user asked for the host's feature set to be smaller, and
 * this is the clearest cut in it.
 *
 * Declined rather than deleted, because `packages/core` and `packages/ui` are shared and the
 * extension is where the feature is actually used. So what this file checks is that the host
 * *says no* and that saying no is enough — one flag, consulted in one place.
 */
const hostSrc = path.join(__dirname)
const coreSrc = path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src')

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), 'utf8')
}

describe('the Node host and Office', () => {
  it('declines it', () => {
    expect(read(hostSrc, 'session.ts')).toContain('offersOffice: false')
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
  it('leaves the Outlook tab out of the navigation', () => {
    const panel = read(coreSrc, '..', '..', 'ui', 'src', 'settings', 'SettingsPanel.tsx')
    expect(panel).toContain('outlook: props.offersOffice !== false')
  })

  /*
   * The other half of "node only". `packages/core` is shared, so a change that removed the
   * feature rather than declining it would take it out of the extension too — where it is used
   * daily. Absent on the extension's side means offered, which is what keeps that true.
   */
  it('leaves the extension alone, which still offers it', () => {
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
