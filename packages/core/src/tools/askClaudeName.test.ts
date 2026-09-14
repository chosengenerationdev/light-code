import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ASK_CLAUDE_TOOL, LEGACY_ASK_EXPERT_TOOL } from './askExpert.js'
import { consultationFromToolCall } from '../history/transcript.js'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

/**
 * The name has to say which expert it reaches.
 *
 * Reported from real use: with a profile in the expert seat and the Claude command line still
 * enabled, there were two doors to "the expert" and only one honoured the seat. `ask_agent` takes
 * a role and answers from whoever holds it; this tool always spawns Claude whatever the Agents tab
 * says. The model reached for the obvious name and the work went to Claude, silently, against the
 * user's configuration — the same shape as a capability wired to one implementation of a role that
 * has since become configurable.
 */
describe('the Claude command line is named for what it is', () => {
  it('is called ask_claude', () => {
    expect(ASK_CLAUDE_TOOL).toBe('ask_claude')
    expect(read('./askExpert.ts')).toContain('name: ASK_CLAUDE_TOOL')
  })

  it('says Claude in its description, not "a stronger expert"', () => {
    expect(read('./askExpert.ts')).toContain('Consult Claude, running as a separate command line')
  })

  /*
   * Every task saved before the rename holds calls under the old name. Matching only the new one
   * would quietly unlabel every stored transcript — attribution is the thing this feature exists
   * to get right.
   */
  it('still attributes calls stored under the old name', () => {
    expect(consultationFromToolCall(LEGACY_ASK_EXPERT_TOOL, '{}')).toBe('expert')
    expect(consultationFromToolCall(ASK_CLAUDE_TOOL, '{}')).toBe('expert')
  })

  it('leaves no prose naming the old tool to the model', () => {
    for (const file of ['../agent/systemPrompt.ts', './recallExpert.ts']) {
      expect(read(file)).not.toContain('ask_expert tool')
      expect(read(file)).not.toContain('Use ask_expert')
      expect(read(file)).not.toContain('calling ask_expert')
    }
  })

  /* A specialist consulting the expert is a loop with a bill attached. */
  it('is withheld from specialists under the new name', () => {
    expect(read('../agents/consult.ts')).toContain('ASK_CLAUDE_TOOL')
  })
})
