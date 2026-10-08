import type { ChatMessage, ChatProvider } from '../providers/types.js'
import { CONTINUE_PROMPT } from '../agent/unfinished.js'
import { estimateTokens } from './budget.js'

/**
 * History compaction — §12: "summarise oldest turns, keep the last N verbatim. Never
 * compact mid-tool-call. Preserve file paths, commands run, and decisions made."
 *
 * The hard constraint is the tool-call pairing. Every wire format rejects a request where
 * an assistant `tool_use` has no matching result, or a result has no matching call. A split
 * chosen purely by message count will land between the two roughly as often as not, so the
 * boundary is *adjusted* until it is safe — see `findSafeBoundary`.
 */

export interface CompactionOptions {
  /** Compact once the estimated prompt exceeds this fraction of the window. */
  triggerFraction?: number
  /** Keep at least this many recent messages verbatim. */
  keepRecent?: number
  /**
   * Also keep as many recent messages as fit in this many tokens, when that is more than
   * `keepRecent`. A flat count kept twelve messages whatever the window, so a 200k model was
   * summarised down to a handful of steps.
   */
  keepRecentTokens?: number
  /** Never compact below this many messages — there is nothing worth summarising. */
  minimumToCompact?: number
}

const DEFAULTS = {
  triggerFraction: 0.75,
  keepRecent: 12,
  minimumToCompact: 8,
} as const

export interface CompactionResult {
  messages: ChatMessage[]
  compacted: boolean
  /** How many messages were folded into the summary. */
  summarisedCount: number
}

/**
 * Finds an index at or before `preferred` where the history can be cut without separating
 * a tool call from its result.
 *
 * Walks *backwards* rather than forwards: moving the boundary earlier keeps more recent
 * context verbatim, whereas moving it later would silently discard turns the user just had.
 * Returns 0 when no safe cut exists, which means "do not compact" rather than "cut anyway".
 */
export function findSafeBoundary(messages: readonly ChatMessage[], preferred: number): number {
  for (let index = Math.min(preferred, messages.length); index > 0; index -= 1) {
    if (isSafeBoundary(messages, index)) return index
  }
  return 0
}

/**
 * A boundary is safe when nothing after it references a tool call from before it, and
 * nothing before it has a call whose result lands after it.
 */
function isSafeBoundary(messages: readonly ChatMessage[], index: number): boolean {
  // A `tool` message immediately after the cut would be orphaned from its call.
  const next = messages[index]
  if (next?.role === 'tool') return false

  const callIdsBefore = new Set<string>()
  for (let i = 0; i < index; i += 1) {
    const message = messages[i]
    if (message?.role === 'assistant') {
      for (const toolCall of message.toolCalls ?? []) callIdsBefore.add(toolCall.id)
    }
    if (message?.role === 'tool') callIdsBefore.delete(message.toolCallId)
  }
  // Any call left unanswered at the cut means its result is on the other side.
  return callIdsBefore.size === 0
}

/**
 * Builds the text handed to the model for summarisation. Explicit about what must survive,
 * because a generic "summarise this" reliably loses exactly the things §12 names — the
 * paths touched, the commands run, and what was decided.
 */
export function buildSummaryPrompt(messages: readonly ChatMessage[]): string {
  const transcript = messages
    .map((message) => {
      if (message.role === 'tool') return `[tool result] ${message.content}`
      // A previous summary is re-summarised from its notes; its verbatim requests are carried
      // forward separately, so they are not paraphrased a second time.
      if (isSummaryMessage(message)) return `[earlier summary] ${splitSummary(message.content).notes}`
      if (message.role === 'assistant') {
        const calls = (message.toolCalls ?? []).map((call) => `${call.name}(${call.arguments})`).join(', ')
        return `[assistant] ${message.content}${calls.length > 0 ? ` -> ${calls}` : ''}`
      }
      return `[${message.role}] ${message.content}`
    })
    .join('\n')

  return [
    'Summarise the earlier part of this coding session so it can replace the original',
    'messages without losing anything the rest of the session depends on.',
    '',
    'Preserve exactly, and do not paraphrase:',
    '- every file path that was read or modified, and what changed in each',
    '- every command that was run, verbatim, and whether it succeeded',
    '- every decision made and the reason for it',
    '- anything the user asked for that is not yet done',
    '',
    'Omit: tool output that has been superseded, exploration that led nowhere, and',
    'restatements of the same point.',
    '',
    'Write it as notes, not prose. There is no need to address anyone.',
    '',
    '--- session so far ---',
    transcript,
  ].join('\n')
}

const SUMMARY_PREFIX = '[Earlier in this session — summarised to save context]\n'
const USER_HEADER = '\n\n[What the user said in that part, verbatim, oldest first]\n'
const USER_SEPARATOR = '\n---\n'
/** Per request, and in all. The user's words are small next to tool output, and worth the room. */
const USER_MESSAGE_LIMIT = 2_000
const USER_TOTAL_LIMIT = 16_000
const OMITTED = /^\(\d+ earlier messages? omitted/

/**
 * Reported: "Light Code is missing a lot of context from the chat history". A summary paraphrases
 * what was asked, and a request paraphrased twice - compaction runs again later and summarises the
 * summary - is how "use the v2 endpoint, not v1" becomes "update the endpoint". The user's own
 * messages are short and are the part a person notices going missing, so they survive every
 * compaction word for word (clipped only when very long), newest kept when the total is too large.
 */
function splitSummary(content: string): { notes: string; userMessages: string[] } {
  const body = content.startsWith(SUMMARY_PREFIX) ? content.slice(SUMMARY_PREFIX.length) : content
  const at = body.indexOf(USER_HEADER)
  if (at < 0) return { notes: body, userMessages: [] }
  return {
    notes: body.slice(0, at),
    userMessages: body
      .slice(at + USER_HEADER.length)
      .split(USER_SEPARATOR)
      .filter((entry) => entry.trim().length > 0 && !OMITTED.test(entry)),
  }
}

function userMessagesOf(messages: readonly ChatMessage[]): string[] {
  const out: string[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (isSummaryMessage(message)) {
      out.push(...splitSummary(message.content).userMessages)
      continue
    }
    const text = message.content.trim()
    // The loop's own nudge is user-role but nobody typed it.
    if (text.length === 0 || text === CONTINUE_PROMPT) continue
    out.push(text.length > USER_MESSAGE_LIMIT ? `${text.slice(0, USER_MESSAGE_LIMIT)} …[clipped]` : text)
  }
  return out
}

function renderUserMessages(all: readonly string[]): string {
  if (all.length === 0) return ''
  const kept: string[] = []
  let size = 0
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const entry = all[index] as string
    if (size + entry.length > USER_TOTAL_LIMIT && kept.length > 0) break
    kept.unshift(entry)
    size += entry.length + USER_SEPARATOR.length
  }
  const omitted = all.length - kept.length
  const lead = omitted > 0 ? [`(${String(omitted)} earlier message${omitted === 1 ? '' : 's'} omitted for length)`] : []
  return `${USER_HEADER}${[...lead, ...kept].join(USER_SEPARATOR)}`
}

/** The earliest index whose tail still fits in `budget` tokens. */
function tailStartWithin(messages: readonly ChatMessage[], budget: number): number {
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    used += estimateTokens((messages[index] as ChatMessage).content)
    if (used > budget) return index + 1
  }
  return 0
}

/**
 * Whether a provider's error means the conversation is too long for the model.
 *
 * Every provider and gateway words it differently, and none gives a code the others share. Matched
 * loosely on purpose: compacting after a false match costs one summary request; missing a real one
 * leaves the user stuck with a chat that can never send again.
 */
export function isContextOverflow(error: string): boolean {
  return /context.{0,20}(length|window|limit)|maximum context|too many tokens|prompt is too long|input is too long|request too large|reduce the length|exceeds? (the )?(maximum|max|token)|token limit|tokens? exceed|context_length_exceeded|string_above_max_length/i.test(
    error,
  )
}

/** Recognises a summary this module produced, so repeated compaction stays idempotent. */
export function isSummaryMessage(message: ChatMessage): boolean {
  return message.role === 'user' && message.content.startsWith(SUMMARY_PREFIX)
}

export function shouldCompact(
  messages: readonly ChatMessage[],
  estimatedTokens: number,
  contextWindow: number,
  options: CompactionOptions = {},
): boolean {
  const trigger = options.triggerFraction ?? DEFAULTS.triggerFraction
  const minimum = options.minimumToCompact ?? DEFAULTS.minimumToCompact
  if (messages.length < minimum) return false
  if (contextWindow <= 0) return false
  return estimatedTokens > contextWindow * trigger
}

/**
 * Summarises the oldest turns via the provider, keeping the system prompt and the most
 * recent messages verbatim.
 *
 * **Failure leaves the history untouched.** A summarisation request can fail for the same
 * reasons the main request can, and losing the conversation because the compaction call
 * timed out would be far worse than being close to the context limit.
 */
export async function compactHistory(
  messages: readonly ChatMessage[],
  provider: ChatProvider,
  options: CompactionOptions = {},
): Promise<CompactionResult> {
  const keepRecent = options.keepRecent ?? DEFAULTS.keepRecent
  const unchanged: CompactionResult = { messages: [...messages], compacted: false, summarisedCount: 0 }

  const systemMessages = messages.filter((message) => message.role === 'system')
  const rest = messages.filter((message) => message.role !== 'system')
  if (rest.length <= keepRecent) return unchanged

  let preferred = rest.length - keepRecent
  if (options.keepRecentTokens !== undefined && options.keepRecentTokens > 0) {
    preferred = Math.min(preferred, tailStartWithin(rest, options.keepRecentTokens))
  }
  const boundary = findSafeBoundary(rest, preferred)
  if (boundary <= 0) return unchanged

  const toSummarise = rest.slice(0, boundary)
  const toKeep = rest.slice(boundary)

  let summary = ''
  try {
    for await (const chunk of provider.streamChat([{ role: 'user', content: buildSummaryPrompt(toSummarise) }])) {
      if (chunk.type === 'text') summary += chunk.text
      if (chunk.type === 'error') return unchanged
    }
  } catch {
    return unchanged
  }

  if (summary.trim().length === 0) return unchanged

  // The summary enters as a user message rather than a system one: a second system message
  // is rejected outright by Anthropic and Gemini, both of which take exactly one.
  const verbatim = renderUserMessages(userMessagesOf(toSummarise))
  const summaryMessage: ChatMessage = { role: 'user', content: `${SUMMARY_PREFIX}${summary.trim()}${verbatim}` }

  // Refuse a summary that saved nothing — a model can happily return more text than it was
  // given, and compacting into something larger is strictly worse.
  const before = toSummarise.reduce((total, message) => total + estimateTokens(message.content), 0)
  if (estimateTokens(summaryMessage.content) >= before) return unchanged

  return {
    messages: [...systemMessages, summaryMessage, ...toKeep],
    compacted: true,
    summarisedCount: toSummarise.length,
  }
}
