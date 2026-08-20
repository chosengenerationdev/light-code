import { describe, expect, it } from 'vitest'

import { looksUnfinished } from './unfinished.js'

/**
 * The observed case, from a real session: asked to create a skill, the model replied
 * "I'll create a dummy skill for testing. Let me make something generic but realistic." and the
 * turn ended having called nothing. This is the test that would have caught it.
 */
describe('an announcement with nothing behind it', () => {
  it('recognises the reply that started this', () => {
    expect(looksUnfinished("I'll create a dummy skill for testing. Let me make something generic but realistic.")).toBe(
      true,
    )
  })

  it.each([
    'Let me check the config file.',
    "I'll read the file first.",
    'I will start by listing the directory.',
    "I'm going to search for the handler.",
    'Now I need to look at the schema.',
    'First, I will read the existing tests.',
    'Here is the plan:',
    "Let's begin with the provider.",
  ])('recognises %j', (text) => {
    expect(looksUnfinished(text)).toBe(true)
  })
})

describe('replies that are genuinely finished', () => {
  it.each([
    'That file is the configuration loader; it reads the JSON and validates it against the schema.',
    'Yes — the CA is merged with the public roots rather than replacing them.',
    'There are three profiles configured: gateway, local, and deepseek.',
    'No skills are recorded in this workspace yet.',
  ])('leaves %j alone', (text) => {
    expect(looksUnfinished(text)).toBe(false)
  })

  /**
   * The most common closing line there is, and it opens exactly like an announcement. Without
   * the exception it would earn a pointless extra request on almost every conversational turn.
   */
  it.each([
    'Let me know if you want anything else.',
    "I'll be happy to take a look at the other one too.",
    "I'll wait for your answer before touching anything.",
  ])('does not mistake %j for an announcement', (text) => {
    expect(looksUnfinished(text)).toBe(false)
  })

  /**
   * A question is the model asking the *user* something, and answering it is their job.
   * `ask_followup_question` exists so a real question is a tool call rather than prose.
   */
  it('never nudges a question, however it opens', () => {
    expect(looksUnfinished('Let me know — should I use the internal mirror or PyPI?')).toBe(false)
    expect(looksUnfinished("I'll do either. Which would you prefer?")).toBe(false)
  })

  /** A preamble is short. A considered answer that opens with "I'll" is not one. */
  it('leaves a long answer alone even when it opens like an announcement', () => {
    const long =
      "I'll explain how this works. " +
      'The loader reads the file, validates it against the zod schema, and merges the two scopes. '.repeat(6)
    expect(long.length).toBeGreaterThan(400)
    expect(looksUnfinished(long)).toBe(false)
  })

  it('ignores an empty or whitespace reply, which the loop reports as an error instead', () => {
    expect(looksUnfinished('')).toBe(false)
    expect(looksUnfinished('   \n  ')).toBe(false)
  })

  /**
   * The forward-looking opening is only meaningful on the *last* sentence: a reply that starts
   * by narrating and then delivers the answer is finished.
   */
  it('scores the last sentence, not the first', () => {
    expect(looksUnfinished("I'll read the file. It defines three exported helpers.")).toBe(false)
  })
})
