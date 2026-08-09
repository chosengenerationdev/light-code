import type { ChatMessage, ToolDefinition } from '../providers/types.js'

/**
 * Per-request token accounting — §12's "instrument it".
 *
 * **These are estimates, and the UI must say so.** A real tokeniser means shipping
 * `tiktoken` (a WASM blob per encoding) or one per provider family, and the number would
 * still be wrong for any gateway that rewrites the prompt. The purpose here is proportion:
 * seeing that tool results are 70% of the window is what tells you where to look, and a
 * 10% error does not change that conclusion.
 *
 * Where a provider reports real usage, those numbers replace the estimate — see
 * `applyReportedUsage`.
 */

/**
 * Deliberately crude: ~4 characters per token is the widely-used approximation for English
 * source-heavy text. Tuned pessimistically (rounding up) so the bar never tells a user they
 * have room they do not have.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

export interface TokenBreakdown {
  /** The system prompt. */
  system: number
  /** Tool definitions — the front of the prompt, and the part caching depends on. */
  toolDefinitions: number
  /** User and assistant turns, excluding tool results. */
  history: number
  /** Tool results, which §12 notes dominate and scale worst. */
  results: number
  total: number
  /** From the profile's model capabilities; used for the "% of window" reading. */
  contextWindow: number
  /** True when the numbers are estimated rather than reported by the provider. */
  estimated: boolean
}

export function computeBreakdown(
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
  contextWindow: number,
): TokenBreakdown {
  let system = 0
  let history = 0
  let results = 0

  for (const message of messages) {
    if (message.role === 'system') {
      system += estimateTokens(message.content)
      continue
    }
    if (message.role === 'tool') {
      results += estimateTokens(message.content)
      continue
    }

    history += estimateTokens(message.content)
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls ?? []) {
        history += estimateTokens(toolCall.name) + estimateTokens(toolCall.arguments)
      }
    }
    if (message.role === 'user') {
      // A rough constant per image. Providers differ enormously (Anthropic bills by tile
      // area, Gemini by a flat rate), so this is a placeholder that keeps images from
      // reading as free rather than a serious estimate.
      history += (message.images?.length ?? 0) * 1_000
    }
  }

  const toolDefinitions = tools.reduce(
    (total, tool) =>
      total + estimateTokens(tool.name) + estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.parameters ?? {})),
    0,
  )

  return {
    system,
    toolDefinitions,
    history,
    results,
    total: system + toolDefinitions + history + results,
    contextWindow,
    estimated: true,
  }
}

/**
 * Usage as reported by the provider, when it reports any. Only a total and cache figures
 * are available — no provider breaks usage down the way `computeBreakdown` does — so this
 * corrects the total and leaves the proportions estimated.
 */
export interface ReportedUsage {
  inputTokens?: number
  outputTokens?: number
  /** Anthropic and OpenAI both report these; Gemini does not. */
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface CacheStats {
  /** Fraction of input tokens served from cache, 0–1. Undefined when nothing was reported. */
  hitRate: number | undefined
  readTokens: number
  writeTokens: number
}

/**
 * §12 asks for cache hit rate to be surfaced, because a collapse in it is the symptom of
 * something mutating the static prefix — and that is otherwise invisible until the bill
 * arrives.
 */
export function computeCacheStats(usage: ReportedUsage | undefined): CacheStats {
  const readTokens = usage?.cacheReadTokens ?? 0
  const writeTokens = usage?.cacheWriteTokens ?? 0
  const input = usage?.inputTokens ?? 0
  const denominator = input + readTokens

  return {
    hitRate: denominator > 0 ? readTokens / denominator : undefined,
    readTokens,
    writeTokens,
  }
}

export function applyReportedUsage(breakdown: TokenBreakdown, usage: ReportedUsage | undefined): TokenBreakdown {
  const reportedInput = usage?.inputTokens
  if (reportedInput === undefined) return breakdown

  // Scale the estimated parts so they still sum to the reported total. The split stays an
  // estimate; the total becomes exact.
  const estimatedTotal = breakdown.total
  const trueTotal = reportedInput + (usage?.cacheReadTokens ?? 0)
  if (estimatedTotal === 0) return { ...breakdown, total: trueTotal, estimated: false }

  const scale = trueTotal / estimatedTotal
  return {
    system: Math.round(breakdown.system * scale),
    toolDefinitions: Math.round(breakdown.toolDefinitions * scale),
    history: Math.round(breakdown.history * scale),
    results: Math.round(breakdown.results * scale),
    total: trueTotal,
    contextWindow: breakdown.contextWindow,
    estimated: false,
  }
}
