import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { consultationFromToolCall } from '../history/transcript.js'

const bridge = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host', 'bridge.ts'),
  'utf8',
)

/**
 * Whose words a tool result is, decided once.
 *
 * An answer is coloured by the specialist who gave it, and "which specialist" has to be settled
 * where the *raw* arguments are — the panel receives a formatted display string and could not read
 * a role back out of it even if it tried.
 *
 * It also has to be settled in **one** place. CLAUDE.md records what happened when the transcript
 * and the live path each decided independently what counted as a chart: a chart drawn during a
 * turn rendered as nothing and became a picture only after a reload. That was the same bug written
 * twice in one session, which is why this file reads `bridge.ts`.
 */
describe('which specialist answered', () => {
  it('recognises ask_expert as the expert, since it predates roles', () => {
    expect(consultationFromToolCall('ask_expert', '{"question":"why"}')).toBe('expert')
  })

  it('takes the role out of an ask_agent call', () => {
    expect(consultationFromToolCall('ask_agent', '{"role":"reviewer","question":"x"}')).toBe(
      'reviewer',
    )
  })

  it('normalises what the model wrote, since it types the role as free text', () => {
    expect(consultationFromToolCall('ask_agent', '{"role":"  Reviewer  "}')).toBe('reviewer')
  })

  /**
   * A call with no readable role is attributed to *nobody*, never to the expert.
   *
   * The colour exists to say who spoke. Falling back to the expert would say Claude answered when
   * something else did, and a confident misattribution is worse than none — which is the same
   * reasoning `search_codebase` uses for marking a hit that is not in this workspace.
   */
  it('attributes an unreadable role to nobody rather than to the expert', () => {
    expect(consultationFromToolCall('ask_agent', 'not json')).toBe('unknown')
    expect(consultationFromToolCall('ask_agent', '{"question":"no role"}')).toBe('unknown')
  })

  it('leaves every other tool alone, so nothing else is dressed as somebody else voice', () => {
    expect(consultationFromToolCall('read_file', '{"path":"a.ts"}')).toBeUndefined()
    expect(consultationFromToolCall('show_chart', '{}')).toBeUndefined()
  })
})

describe('the live path and the transcript agree', () => {
  /**
   * Read from the source, because the defect is a *missing call*.
   *
   * Nothing about a rendered transcript reveals that the live path derived authorship its own
   * way — until a consultation mid-turn is the wrong colour, and right again after a reload.
   */
  it('the live path asks the same function rather than testing the tool name itself', () => {
    expect(bridge).toContain('consultationFromToolCall(toolCall.name, toolCall.arguments)')
  })

  it('the live path no longer decides it by name', () => {
    // `ask_expert` as a bare string comparison is precisely the second decision that must not
    // come back: it would silently miss every `ask_agent` call.
    expect(
      bridge.includes("toolCall.name === 'ask_expert'"),
      'bridge.ts decides authorship by name again',
    ).toBe(false)
  })

  /**
   * Both the call and its result are built by the one builder.
   *
   * They were written out separately, and the *result* one omitted `consultingRole` — so a
   * consultation wore the specialist's colour while it ran and reverted to the expert's the moment
   * it finished, which is what a user saw and reported. Counting the builder's uses is what would
   * catch a third construction being written out by hand again.
   */
  it('builds every tool summary with the one builder', () => {
    const built = bridge.match(/toolCallSummary\(/g) ?? []
    expect(
      built.length,
      'a tool summary is being assembled by hand somewhere',
    ).toBeGreaterThanOrEqual(2)
    expect(
      bridge.includes('const summary: ToolCallSummary = {'),
      'a tool summary is written out literally, which is how consultingRole was dropped',
    ).toBe(false)
  })

  /**
   * And the chat is told *who* informed a reply, not merely that somebody did.
   *
   * `expertInformed` was a boolean, which was all there was to say with one expert. The chip that
   * marks an assistant message now names and colours the specialist, so the role has to travel
   * with the flag — and it is derived from one variable at each emission site, so the two cannot
   * come apart.
   */
  it('sends the role alongside the informed flag', () => {
    expect(bridge).toContain('{ expertInformed: true, informedBy }')
    expect(
      bridge.includes('let expertInformed = false'),
      'the live path tracks a boolean again, which cannot name the specialist',
    ).toBe(false)
  })
})

/**
 * Deciding authorship by tool name kept coming back, in a new place each time.
 *
 * Three surfaces have now done it: the transcript's tool block, the live path, and the working
 * indicator. Each looked local and each silently missed every `ask_agent` call — a reviewer's
 * answer rendered in no colour at all, and the indicator said "Running ask_agent" while the
 * expert's said "Consulting the expert".
 */
describe('nothing decides authorship by tool name', () => {
  const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ui', 'src')

  it.each(['Chat.tsx', 'MessageList.tsx'])('%s reads the role rather than the name', (file) => {
    const source = readFileSync(path.join(ui, file), 'utf8')
    expect(
      source.includes("=== 'ask_expert'"),
      `${file} compares the tool name instead of reading consultingRole`,
    ).toBe(false)
  })
})
