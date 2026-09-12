import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The Node host gets the Agent team, on the same code as the extension.
 *
 * It briefly had its own expert instead: `expertMode: 'profile'`, a cut-down panel, and a separate
 * `ask_expert` that consulted a provider. That was the right shape for a week — a server has no
 * `claude` binary, and the expert had to be *something*. The Agents work then superseded it
 * outright: the expert is a role, which model sits in it is one picker among five, and the CLI is
 * offered where it happens to exist.
 *
 * So the parallel path went rather than being kept in step. When the node-only split was chosen I
 * said two expert implementations would drift; the honest end of that is to remove one once they
 * no longer need to differ, not to maintain both.
 */
const hostSrc = __dirname
const coreSrc = path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src')

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), 'utf8')
}

describe('the host and the team', () => {
  it('asks for no expert of its own', () => {
    expect(read(hostSrc, 'session.ts')).not.toContain('expertMode')
  })

  /** One path for both hosts: whoever is assigned to a role answers it. */
  it('leaves nothing of the separate provider-expert behind', () => {
    const bridge = read(coreSrc, 'host', 'bridge.ts')
    for (const gone of ['providerExpertFor', 'createAskProviderExpertTool', 'expertMode']) {
      expect(bridge.includes(gone), `bridge.ts still references ${gone}`).toBe(false)
    }
  })

  it('still offers the team, which is what replaced it', () => {
    const bridge = read(coreSrc, 'host', 'bridge.ts')
    expect(bridge).toContain('createAskAgentTool(')
    expect(bridge).toContain('resolveTeam(')
  })

  /**
   * And the Claude CLI is offered where it exists rather than assumed absent.
   *
   * The host used to declare there was no CLI, which is true of a server and wrong of a laptop
   * running `npx light-code`. Detection answers it either way now.
   */
  it('detects the CLI rather than ruling it out', () => {
    expect(read(coreSrc, 'host', 'bridge.ts')).toContain('async function detectCli(')
  })
})
