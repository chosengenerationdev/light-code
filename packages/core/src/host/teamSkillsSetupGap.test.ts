import fs from 'node:fs/promises'
import url from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * From an office report: "Send my skills to the team" refused with "needs a search connection
 * and an embedding model", and both were already configured. The message was true of four
 * unrelated causes — never configured, the active connection deleted, the embedder's provider
 * profile gone stale, or the connection unreachable — and could not distinguish them, which reads
 * as "you haven't set this up" even while looking at a filled-in Settings → Search panel.
 *
 * `describeTeamSkillsSetupGap` replaces the single message with one that names the actual gap.
 * Reads the source rather than invoking `wireChatBridge` — the same choice
 * `config/retrieval.test.ts` makes for the same reason: the closure needs a large host mock to
 * run, and what would regress here is the *wiring* (a handler quietly going back to the generic
 * string), which source inspection sees directly.
 */
describe('team-skills publish and clear name the actual setup gap', () => {
  it('never falls back to the old one-size-fits-all message', async () => {
    const bridge = url.fileURLToPath(new URL('./bridge.ts', import.meta.url))
    const source = await fs.readFile(bridge, 'utf8')

    expect(source).not.toContain(
      'Publishing skills needs a search connection and an embedding model',
    )
    expect(source).not.toContain('No search connection configured.')
  })

  it('routes both handlers through the one diagnostic function', async () => {
    const bridge = url.fileURLToPath(new URL('./bridge.ts', import.meta.url))
    const source = await fs.readFile(bridge, 'utf8')

    const publish = source.slice(source.indexOf('async function handlePublishTeamSkills'))
    const clear = source.slice(source.indexOf('async function handleClearTeamSkills'))

    expect(publish.slice(0, publish.indexOf('\n\n  /**'))).toContain('describeTeamSkillsSetupGap')
    expect(clear.slice(0, 800)).toContain('describeTeamSkillsSetupGap')
  })
})
