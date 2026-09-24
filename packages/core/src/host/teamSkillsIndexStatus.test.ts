import fs from 'node:fs/promises'
import url from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * `requestTeamSkillsIndexStatus` / `handleTeamSkillsIndexStatus`: a live green/red check of
 * which locally-authored skills currently have a matching document in the team collection.
 *
 * Read the source rather than invoking `wireChatBridge`, for the reason `config/retrieval.test.ts`
 * and `teamSkillsSetupGap.test.ts` both give: the closure needs a large host mock to run, and what
 * would regress here is the *wiring* — a message the UI can send with no handler, or a handler
 * that forgot to exclude bucket-mirrored skills — which source inspection sees directly.
 */
describe('the team-skills index status check', () => {
  it('is reachable from the message the UI actually sends', async () => {
    const bridge = url.fileURLToPath(new URL('./bridge.ts', import.meta.url))
    const source = await fs.readFile(bridge, 'utf8')

    expect(source).toContain("message.type === 'requestTeamSkillsIndexStatus'")
    expect(source).toContain('handleTeamSkillsIndexStatus')
  })

  /**
   * "Indexed" is a question about *your* publishing of a skill, not about a copy of somebody
   * else's you merely hold — the same distinction `handlePublishTeamSkills` itself does not make
   * (§the team-skills duplication conversation), which is exactly why this one has to.
   */
  it('excludes bucket-mirrored skills before reporting status', async () => {
    const bridge = url.fileURLToPath(new URL('./bridge.ts', import.meta.url))
    const source = await fs.readFile(bridge, 'utf8')

    const body = source.slice(source.indexOf('async function handleTeamSkillsIndexStatus'))
    const scoped = body.slice(0, body.indexOf('\n  function skillsIndexName'))

    expect(scoped).toContain('mirrorForDir(skill.sourceDir) === undefined')
  })

  /**
   * The actual bug this test would have caught: `listPaths` returns the `path` field, never
   * `id`. `teamSkillId` is per-owner (it is what keeps two people's upserts from colliding), but
   * checking a listed path against it compares a value nothing sends back — every skill reads as
   * "not indexed" regardless of whether it was ever published. Reported from real use: publish
   * ran, "Check status" still showed every skill red.
   */
  it('checks against the path listPaths actually returns, never the per-owner id', async () => {
    const bridge = url.fileURLToPath(new URL('./bridge.ts', import.meta.url))
    const source = await fs.readFile(bridge, 'utf8')

    const body = source.slice(source.indexOf('async function handleTeamSkillsIndexStatus'))
    const scoped = body.slice(0, body.indexOf('\n  function skillsIndexName'))

    expect(scoped).toContain('teamSkillPath(skill)')
    expect(scoped).not.toContain('teamSkillId(')
  })
})
