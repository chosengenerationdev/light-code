import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * Line endings normalised, because these files are CRLF on this platform and an assertion
 * carrying a bare newline silently matches nothing — the same trap as the `--guide` markdown
 * renderer, where a regex quietly produced no headings at all.
 */
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

/**
 * The setting has to be reachable, not merely implemented.
 *
 * `thinking.ts` shipped complete and correct, with a doc comment saying "the profile says which —
 * and the UI explains the choice rather than hiding it behind a heuristic". No such control
 * existed: the level and the style were config-file-only, so the per-seat override in the Agents
 * tab could ask for thinking while nothing could say *how this endpoint spells it*. Setting a
 * Qwen3 seat to think would then send `reasoning_effort` and 400 every request.
 *
 * That is the shape CLAUDE.md names three times — a mechanism a release ahead of any way to reach
 * it is, from outside, the same as not having it. These read the source because the defect is a
 * missing connection, which no test of the module that works can see.
 */
describe('thinking is reachable from the panel', () => {
  const form = read('../../../ui/src/settings/ProviderForm.tsx')

  it('offers the level in the provider form', () => {
    expect(form).toContain('ariaLabel="Thinking level"')
  })

  /*
   * The load-bearing half. "OpenAI-compatible" is not one thing: OpenAI takes `reasoning_effort`,
   * vLLM and SGLang serving Qwen3 take `chat_template_kwargs.enable_thinking`, and neither
   * accepts the other. Without this control the style is whatever the default happens to be.
   */
  it('offers the parameter style, naming both spellings', () => {
    expect(form).toContain('ariaLabel="Thinking parameter"')
    expect(form).toContain('reasoning_effort')
    expect(form).toContain('enable_thinking')
  })

  /*
   * Only the OpenAI wire format is ambiguous. Offering the choice against Anthropic or Gemini
   * would be a control that reads as though it did something.
   */
  it('asks only where the spelling is genuinely ambiguous', () => {
    expect(form).toContain("wireFormat === 'openai' && thinkingLevel !== ''")
  })

  /*
   * Sending nothing is what every request did before this existed, and the only setting that
   * cannot break a gateway nobody has tested against. A form defaulting to a level would change
   * how somebody's working profile behaves without their asking.
   */
  it('defaults to sending nothing at all', () => {
    // Matched loosely on whitespace: prettier owns the line breaks and they say nothing about the
    // property asserted, which is that an unset level contributes no `thinking` at all.
    expect(form).toMatch(/thinkingLevel === ''\s*\?\s*\{\}/)
  })
})

describe('the round trip', () => {
  const bridge = read('../host/bridge.ts')

  it('saves what the form sent', () => {
    expect(bridge).toContain('if (input.thinking !== undefined) saved.thinking = input.thinking')
  })

  /*
   * And reports it back, or the form opens blank over a configured profile and the next save
   * silently clears it — the defect the Python tab hit, where fields rendered empty and reads as
   * data loss.
   */
  it('reports it back so the form opens on what is configured', () => {
    expect(bridge).toContain('summary.thinking = profile.thinking')
  })
})
