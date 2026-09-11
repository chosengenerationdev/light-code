import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = readFileSync(path.join(here, 'App.tsx'), 'utf8')
const bridge = readFileSync(path.join(here, '..', '..', 'core', 'src', 'host', 'bridge.ts'), 'utf8')

/**
 * The Agents tab has to be *told* what to render, and three things had to ask.
 *
 * Reported, all at once, and all one defect: "I don't see option to setup roles", "providers are
 * already setup, it still says it's not done", and "claude was not detected". The panel had its
 * initial empty state and nothing ever replaced it.
 *
 * This is the shape CLAUDE.md names as the most expensive here — a decision that never reaches its
 * owner. `postAgents` was correct, the message was correct, the panel was correct, and nobody
 * called it. No test of `postAgents` can see that, so these read the source instead, exactly as
 * `config/retrieval.test.ts` reads `bridge.ts` for the same reason.
 */
describe('the Agents tab gets its state', () => {
  it('is asked for when the panel mounts', () => {
    expect(app).toContain("props.transport.post({ type: 'requestAgents' }")
  })

  /**
   * And again once the Claude probe has answered.
   *
   * Detection spawns a process. The panel asks for its state on mount, which is *before* that
   * process has replied, so the first answer always says Claude is absent — and without a second
   * push nothing ever corrects it on a machine where it is installed.
   */
  it('is sent again when detection finishes, not only when it is asked for', () => {
    const at = bridge.indexOf('async function detectCli(')
    expect(at, 'detection no longer has one owner').toBeGreaterThan(-1)
    expect(bridge.slice(at, at + 1400)).toContain('postAgents()')
  })

  /**
   * And detection must not be gated on the *old* expert feature being switched on.
   *
   * It was: the probe only ran when `expert.enabled` was true, which was right while the expert
   * *was* the feature and wrong the moment Agents offered Claude as one choice among several.
   * Somebody who had never turned the old feature on was told Claude was absent on a machine
   * where it is installed — exactly as reported.
   */
  it('detects Claude for the tab without the old expert flag being on', () => {
    const at = bridge.indexOf('async function postAgents(')
    expect(at).toBeGreaterThan(-1)
    expect(bridge.slice(at, at + 1200)).toContain('detectCli(')
  })

  /**
   * And whenever the list of models a role could be given changes.
   *
   * A provider added and then not offered in the picker reads as the tab being broken, which is
   * precisely how this was reported.
   */
  it('is refreshed wherever the profile list is', () => {
    const profilePosts = bridge.match(/await postProfiles\(\)/g) ?? []
    const agentPosts = bridge.match(/await postAgents\(\)/g) ?? []
    expect(profilePosts.length).toBeGreaterThan(0)
    expect(
      agentPosts.length,
      'a profile list is posted somewhere that does not also refresh the agents',
    ).toBeGreaterThanOrEqual(profilePosts.length)
  })

  /** The handler has to exist at the other end, or the request is shouted into a void. */
  it('is answered by the bridge', () => {
    expect(bridge).toContain("message.type === 'requestAgents'")
  })
})
