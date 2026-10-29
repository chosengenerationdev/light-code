import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Choosing which skills go to the team pool (asked for: "some skills he can keep for himself").
 *
 * The handler lives inside the bridge, so its rules are pinned by reading it - the pattern
 * `config/retrieval.test.ts` and `labelledWrites.test.ts` use: what matters is that the selection
 * reaches both the send and the status check, which no test of either alone can see.
 */
const bridge = fs.readFileSync(path.join(__dirname, 'bridge.ts'), 'utf8')

function body(signature: string): string {
  const start = bridge.indexOf(signature)
  expect(start).toBeGreaterThan(-1)
  const next = bridge.indexOf('\n  async function ', start + signature.length)
  return bridge.slice(start, next === -1 ? undefined : next)
}

describe('sending skills to the team', () => {
  const publish = body('async function handlePublishTeamSkills(')

  it('saves the ticks it was sent before reading them', () => {
    expect(publish.indexOf('saveKeepPrivate(keepPrivateNow)')).toBeLessThan(publish.indexOf('loadSettings()'))
  })

  it('sends only the skills not kept private', () => {
    expect(publish).toContain('skills.filter((skill) => !keepPrivate.has(skill.name))')
    expect(publish).toContain('for (const skill of sending)')
  })

  it('takes back a private skill only from this machine\'s own collection, and only if it is there', () => {
    expect(publish).toContain('writer.listPaths(collection')
    expect(publish).toContain('teamSkillPath({ name })')
    expect(publish).toContain('.filter((each) => present.has(each))')
    // The collection, never an alias: an alias spans colleagues' collections.
    expect(publish).not.toMatch(/deleteInBatches\(writer, alias/)
  })

  it('reports private skills in the status check', () => {
    const status = body('async function handleTeamSkillsIndexStatus(')
    expect(status).toContain("state: sent === undefined ? 'private' : 'withdraw'")
  })

  it('is reached from the panel, with the ticks', () => {
    expect(bridge).toContain('handlePublishTeamSkills(message.keepPrivate)')
    expect(bridge).toContain("message.type === 'saveTeamSkillSelection'")
  })
})
