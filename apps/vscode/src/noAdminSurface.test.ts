import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The shared-server work must not surface in the extension.
 *
 * Roles, session variables, shared profiles and the review queue exist because a second user does.
 * The extension has one, so none of it should appear there — and "should" is not the same as
 * "does", which is what this checks. `packages/ui` is shared, so the components are compiled into
 * the webview bundle either way; what matters is that nothing renders them, because the extension
 * host supplies none of the services and the bridge answers none of the messages.
 */
const hostDir = path.join(__dirname, '..', 'src')

function sourceOf(...parts: string[]): string {
  return readFileSync(path.join(hostDir, ...parts), 'utf8')
}

describe('the VS Code host and the shared-server seams', () => {
  /** Each of these is optional on HostServices; supplying none is what keeps the feature absent. */
  it('supplies none of them', () => {
    const extension = sourceOf('extension.ts')
    const bridgeSetup = [extension, sourceOf('webview', 'chatViewProvider.ts')].join('\n')
    for (const seam of ['sessionEnv', 'submitForReview', 'guideMediaBase', 'sharedProfiles']) {
      expect(bridgeSetup.includes(seam), `extension host supplies ${seam}`).toBe(false)
    }
  })
})

describe('the bridge and the administrator-only messages', () => {
  /**
   * These are answered by the Node host's server, never by the bridge. If one ever appeared here
   * the extension would grow an admin concept it has no second user for.
   */
  it('answers none of them', () => {
    const bridge = readFileSync(path.join(hostDir, '..', '..', '..', 'packages', 'core', 'src', 'host', 'bridge.ts'), 'utf8')
    for (const message of [
      "'requestVariables'",
      "'saveUserVariables'",
      "'saveAdminVariables'",
      "'saveAdminIds'",
      "'requestReviews'",
      "'decideReview'",
      "'hostRole'",
    ]) {
      expect(bridge.includes(message), `bridge handles ${message}`).toBe(false)
    }
  })
})
