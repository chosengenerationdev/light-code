import fs from 'node:fs/promises'
import url from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * `requestTeamSkillsIndexStatus` / `handleTeamSkillsIndexStatus`: a live green/red check of
 * which currently loaded skills have a matching document in the team collection.
 *
 * Read the source rather than invoking `wireChatBridge`, for the reason `config/retrieval.test.ts`
 * and `teamSkillsSetupGap.test.ts` both give: the closure needs a large host mock to run, and what
 * would regress here is the *wiring* — a message the UI can send with no handler, or a check that
 * silently disagrees with what `handlePublishTeamSkills` actually sends — which source inspection
 * sees directly.
 */
describe('the team-skills index status check', () => {
  it('is reachable from the message the UI actually sends', async () => {
    const bridge = url.fileURLToPath(new URL('./bridge.ts', import.meta.url))
    const source = await fs.readFile(bridge, 'utf8')

    expect(source).toContain("message.type === 'requestTeamSkillsIndexStatus'")
    expect(source).toContain('handleTeamSkillsIndexStatus')
  })

  /**
   * Reported from real use: someone whose skills live entirely in an S3-synced folder published
   * successfully and then saw "nothing authored on this machine yet". The status check used to
   * filter to skills with no bucket `sourceDir`, on the reasoning that "indexed" should mean "you
   * authored it" — but `handlePublishTeamSkills` was never given that same restriction, so a
   * bucket-sourced skill could be genuinely published and still be structurally excluded from
   * ever being reported as indexed. It must check the same set publish sends, whatever that set
   * is, or the two can disagree exactly like this again.
   */
  it('checks the same skills publish actually sends, with no filtering by source', async () => {
    const bridge = url.fileURLToPath(new URL('./bridge.ts', import.meta.url))
    const source = await fs.readFile(bridge, 'utf8')

    const body = source.slice(source.indexOf('async function handleTeamSkillsIndexStatus'))
    const scoped = body.slice(0, body.indexOf('\n  function skillsIndexName'))

    expect(scoped).toContain('skills.map((skill)')
    expect(scoped).not.toContain('mirrorForDir')
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
