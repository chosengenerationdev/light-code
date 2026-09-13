import type { WireFormat } from './types.js'

/**
 * How hard a model should think, expressed once and translated per wire format.
 *
 * ## Why it is not a single parameter
 *
 * Every vendor spells this differently, and none of them accept each other's spelling:
 * OpenAI takes `reasoning_effort`, Anthropic a `thinking` block with a token budget, Gemini a
 * `thinkingConfig`, and vLLM or SGLang serving Qwen3 take `chat_template_kwargs.enable_thinking`.
 * §11 names schema translation across providers as a silent-failure source; this is the same
 * hazard with a louder failure, because an unrecognised top-level field is usually a 400 rather
 * than something quietly ignored — on *every* request, not just hard ones.
 *
 * ## Why nothing is sent unless it was asked for
 *
 * `undefined` means send nothing at all, which is exactly what every request did before this
 * existed. That is the only setting that cannot break a gateway nobody has tested against, so it
 * stays the default, and turning it on is a deliberate act against a gateway the user knows.
 *
 * ## Why the OpenAI case asks rather than guesses
 *
 * The other three wire formats are unambiguous. "OpenAI-compatible" is not: the same endpoint
 * shape is served by OpenAI itself, by vLLM, by SGLang and by a dozen corporate gateways, and
 * `reasoning_effort` and `chat_template_kwargs` are not interchangeable. Guessing would mean a
 * setting that breaks every request against half the deployments it is offered on, so the profile
 * says which — and the UI explains the choice rather than hiding it behind a heuristic.
 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

/**
 * Which parameter an OpenAI-compatible endpoint understands.
 *
 * `effort` is OpenAI's own and is what most gateways fronting reasoning models accept.
 * `qwen` is the chat-template switch vLLM and SGLang expose for Qwen3 and its relatives.
 */
export type ThinkingStyle = 'effort' | 'qwen'

export interface ThinkingSettings {
  level: ThinkingLevel
  /** Only consulted for the OpenAI wire format; the others are unambiguous. */
  style?: ThinkingStyle | undefined
}

/**
 * Token budgets for the two formats that take a number.
 *
 * Round numbers chosen to be obviously approximate rather than tuned — there is no measurement
 * behind them and pretending otherwise would invite somebody to treat them as calibrated. What
 * matters is the ordering and that `high` is generous enough to be worth choosing.
 */
const BUDGETS: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  low: 2_048,
  medium: 8_192,
  high: 24_576,
}

/**
 * Adds the right field to a request body, or nothing at all.
 *
 * Mutates the body it is given, matching how the adapters already assemble one, and returns
 * nothing so that no caller mistakes it for a pure translation it can apply twice.
 */
export function applyThinking(
  body: Record<string, unknown>,
  wireFormat: WireFormat,
  settings: ThinkingSettings | undefined,
  maxTokens?: number | undefined,
): void {
  if (settings === undefined) return

  if (wireFormat === 'anthropic') {
    if (settings.level === 'off') return
    /*
     * Anthropic requires the budget to be *less* than `max_tokens`, and rejects the request
     * otherwise. Clamped rather than trusted: the two settings are edited in different places and
     * nothing stops somebody setting a small max and a high level, which would otherwise be a 400
     * pointing at a field they had not touched.
     */
    const ceiling = maxTokens !== undefined ? Math.max(1_024, maxTokens - 1_024) : Infinity
    body.thinking = {
      type: 'enabled',
      budget_tokens: Math.min(BUDGETS[settings.level], ceiling),
    }
    return
  }

  if (wireFormat === 'gemini') {
    // Zero is how Gemini is told not to think, so `off` is a value rather than an omission.
    body.thinkingConfig = {
      thinkingBudget: settings.level === 'off' ? 0 : BUDGETS[settings.level],
    }
    return
  }

  if (settings.style === 'qwen') {
    /*
     * Qwen3's switch is on or off, and this says so rather than inventing three settings.
     *
     * vLLM does expose a `thinking_budget` alongside it on recent builds, but not on every one,
     * and a field the server does not know is a 400 — which is the whole failure this module is
     * shaped to avoid. Enabling is the part that works everywhere it is offered.
     */
    body.chat_template_kwargs = { enable_thinking: settings.level !== 'off' }
    return
  }

  // `effort`, the default for the OpenAI wire format.
  if (settings.level === 'off') return
  body.reasoning_effort = settings.level
}

/** What the UI says a level does, which differs by wire format and is worth not guessing at. */
export function describeThinking(wireFormat: WireFormat, style: ThinkingStyle | undefined): string {
  if (wireFormat === 'anthropic' || wireFormat === 'gemini') {
    return 'Sent as a thinking budget — a bigger allowance at each step up.'
  }
  return style === 'qwen'
    ? 'Sent as enable_thinking for vLLM or SGLang. Qwen3 has no levels, so anything above off ' +
        'simply switches thinking on.'
    : 'Sent as reasoning_effort, which OpenAI and most gateways fronting a reasoning model accept.'
}
