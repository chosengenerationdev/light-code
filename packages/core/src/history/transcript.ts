import { chartSpecSchema, type ChartSpec } from '../charts/types.js'
import { CALL_TOOL_NAME } from '../tools/callTool.js'
import { diagramSpecSchema, type DiagramSpec } from '../diagrams/types.js'
import { ASK_CLAUDE_TOOL, LEGACY_ASK_EXPERT_TOOL } from '../tools/askExpert.js'
import type { ToolCallSummary, TranscriptEntry } from '../agent/protocol.js'
import type { ChatMessage } from '../providers/types.js'

/**
 * Tools whose "result" is the model addressing the user rather than work performed. They
 * render as ordinary assistant text, not as collapsed tool blocks — burying the actual
 * answer behind a disclosure triangle was a real usability bug in Phase 3.
 *
 * Lives here rather than in the host so the live transcript and a restored one agree; two
 * copies of this set would eventually disagree about how a task looked.
 */
export const CONTROL_TOOLS: ReadonlySet<string> = new Set([
  'attempt_completion',
  'ask_followup_question',
])

/*
 * `show_chart` is deliberately NOT in CONTROL_TOOLS.
 *
 * A control tool's *result* is the message to the user; a chart's result is a summary for the
 * model and the picture is built from the call's arguments instead. Adding it here would print
 * that summary as assistant prose and draw nothing.
 */

/** Pretty-prints tool arguments; falls back to the raw string if it isn't JSON. */
export function formatToolArguments(raw: string): string {
  try {
    const parsed = JSON.parse(raw.length > 0 ? raw : '{}') as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      // `why` is lifted out and shown beside the tool name, so leaving it here would print it
      // twice — once as prose and once as an argument the tool never receives.
      const rest = { ...(parsed as Record<string, unknown>) }
      delete rest.why
      return JSON.stringify(rest, null, 2)
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

/** The model's stated reason for a call, if it gave one. Never inferred, never invented. */
export function toolCallReason(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw.length > 0 ? raw : '{}') as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const why = (parsed as Record<string, unknown>).why
    return typeof why === 'string' && why.trim().length > 0 ? why.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Rebuilds what the UI shows from the stored model-facing messages.
 *
 * There is deliberately no second stored representation: the display is a pure function of
 * the conversation, so a reopened task cannot disagree with what the model actually saw.
 *
 * One honest difference from the live view: oversized tool results were capped before
 * entering the conversation, so a restored transcript shows the capped text plus its
 * re-read handle rather than the full output. That is the §12 design — history references
 * the spilled result instead of duplicating it.
 */
export function toTranscript(messages: readonly ChatMessage[]): TranscriptEntry[] {
  const resultsByCallId = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'tool') resultsByCallId.set(message.toolCallId, message.content)
  }

  const entries: TranscriptEntry[] = []
  // Sticky for the rest of the task: everything after a consultation was decided with its
  // advice in context, so the mark reflects influence rather than adjacency.
  /*
   * The specialist, not a boolean.
   *
   * It was `expertInformed = true`, which was all there was to say when there was one expert.
   * With five, the chat has to name and colour whoever actually answered — and deriving the flag
   * from this rather than tracking both is what stops them disagreeing.
   */
  let informedBy: string | undefined
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'tool') continue

    if (message.role === 'user') {
      entries.push({ kind: 'text', role: 'user', content: message.content })
      continue
    }

    if (message.content.length > 0) {
      entries.push({
        kind: 'text',
        role: 'assistant',
        content: message.content,
        ...(informedBy !== undefined ? { expertInformed: true, informedBy } : {}),
      })
    }

    for (const toolCall of message.toolCalls ?? []) {
      const result = resultsByCallId.get(toolCall.id)

      /*
       * A chart is rendered from its own call, so it survives a reload for free.
       *
       * The arguments are the only copy of the data — parsed here rather than trusted, because a
       * restored transcript can contain anything a past model sent, and a chart that renders
       * misaligned data looks correct and is not.
       */
      const asChart = chartFromToolCall(toolCall.name, toolCall.arguments)
      if (asChart !== undefined) {
        entries.push(
          asChart.kind === 'chart'
            ? {
                kind: 'chart',
                chart: asChart.chart,
                ...(informedBy !== undefined ? { expertInformed: true, informedBy } : {}),
              }
            : asChart,
        )
        continue
      }

      if (CONTROL_TOOLS.has(toolCall.name)) {
        // The control tool's result *is* the message to the user.
        if (result !== undefined) entries.push({ kind: 'text', role: 'assistant', content: result })
        continue
      }

      const consulting = consultationFromToolCall(toolCall.name, toolCall.arguments)
      if (consulting !== undefined) informedBy = consulting
      entries.push({
        kind: 'tool',
        ...(informedBy !== undefined ? { expertInformed: true, informedBy } : {}),
        /*
         * Built by the one builder, so a restored transcript and a live turn cannot differ about
         * what a call looked like. A call with no matching result means the task ended mid-flight
         * — a cancel, a crash, a window closed — and leaving `result` unset renders it as
         * unfinished, which is what actually happened.
         */
        toolCall: toolCallSummary(toolCall, { result }),
      })
    }
  }
  return entries
}

/**
 * Whether a tool call is a chart, and if so which one.
 *
 * **The single owner of that question**, and it exists because there were about to be two. The
 * transcript derived charts on reload while the live turn posted an ordinary tool block, so a
 * chart drawn during a conversation appeared as a collapsed "show_chart ran" — that is, as
 * nothing — and only became a picture after a reload. Reported as exactly that.
 *
 * This is the shape CLAUDE.md calls the most expensive in the project: one fact decided in two
 * places, which drift. `charts/live.test.ts` reads `host/bridge.ts` and fails if the live path
 * ever decides it again for itself.
 *
 * Returns `undefined` for anything that is not `show_chart`, so a caller can fall through to its
 * ordinary handling.
 */
/**
 * Which specialist a tool call consults, if any.
 *
 * **One owner, for the reason the chart decision has one.** The transcript and the live path both
 * need this, and when they each decided for themselves what a chart was, a chart drawn during a
 * turn rendered as nothing — the same bug written twice in one session. `agents/colour.test.ts`
 * reads `host/bridge.ts` and fails if the live path ever decides it again.
 *
 * `ask_expert` is the expert by definition: it predates roles and is still the name everything
 * downstream refers to. `ask_agent` carries the role in its arguments.
 *
 * Returns `undefined` for anything else, so a caller falls through to its ordinary handling.
 */
/**
 * A tool call as the panel shows it.
 *
 * **One builder, because there were three and the third forgot a field.** The live path built one
 * when a call started and *another* when its result arrived, and the second omitted
 * `consultingRole` — so a consultation was the specialist's colour while it ran and reverted to
 * the expert's the moment it finished, which is precisely what a user saw and reported.
 *
 * Anything derived from the call itself belongs here. A caller supplies only what it alone knows:
 * the result, and whether it failed.
 */
export function toolCallSummary(
  call: { id: string; name: string; arguments: string },
  outcome?: { result?: string | undefined; isError?: boolean | undefined },
): ToolCallSummary {
  const why = toolCallReason(call.arguments)
  const consulting = consultationFromToolCall(call.name, call.arguments)
  return {
    id: call.id,
    name: call.name,
    arguments: formatToolArguments(call.arguments),
    ...(why !== undefined ? { why } : {}),
    ...(consulting !== undefined ? { consultingRole: consulting } : {}),
    ...(outcome?.result !== undefined ? { result: outcome.result } : {}),
    ...(outcome?.isError === true ? { isError: true } : {}),
  }
}

export function consultationFromToolCall(name: string, rawArguments: string): string | undefined {
  const call = throughDispatch(name, rawArguments)
  // Both names: the tool is `ask_claude` now, and every task saved before that holds calls
  // under the old one. Dropping the old name would quietly unlabel every stored transcript.
  if (call.name === ASK_CLAUDE_TOOL || call.name === LEGACY_ASK_EXPERT_TOOL) return 'expert'
  if (call.name !== 'ask_agent') return undefined
  const decoded = call.args
  const role =
    typeof decoded === 'object' && decoded !== null
      ? (decoded as { role?: unknown }).role
      : undefined
  /*
   * A call with an unreadable role is still a consultation, and is attributed to nobody rather
   * than to the expert. Colouring it as the expert would say Claude answered when something else
   * did — and misattribution is worse than no attribution, which is the whole reason this colour
   * exists.
   */
  return typeof role === 'string' && role.trim().length > 0 ? role.trim().toLowerCase() : 'unknown'
}

/**
 * A diagram call, seen through the dispatcher like everything else here.
 *
 * Mirrors `chartFromToolCall` deliberately rather than inventing a second route to a picture: the
 * live transcript and a reopened task must agree about what a tool call became, and two
 * derivations of that would be the split this repository keeps paying for.
 */
export function diagramFromToolCall(
  name: string,
  rawArguments: string,
): { kind: 'diagram'; diagram: DiagramSpec } | { kind: 'diagramError'; message: string } | undefined {
  const call = throughDispatch(name, rawArguments)
  if (call.name !== 'show_diagram') return undefined
  const parsed = diagramSpecSchema.safeParse(call.args)
  return parsed.success
    ? { kind: 'diagram', diagram: parsed.data }
    : {
        kind: 'diagramError',
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      }
}

export function chartFromToolCall(
  name: string,
  rawArguments: string,
): { kind: 'chart'; chart: ChartSpec } | { kind: 'chartError'; message: string } | undefined {
  const call = throughDispatch(name, rawArguments)
  if (call.name !== 'show_chart') return undefined
  const parsed = chartSpecSchema.safeParse(call.args)
  return parsed.success
    ? { kind: 'chart', chart: parsed.data }
    : { kind: 'chartError', message: parsed.error.issues.map((issue) => issue.message).join('; ') }
}

/**
 * The call a tool call actually stands for, seeing through `call_tool`.
 *
 * ## Why this is needed, and what it cost
 *
 * Reported from real use: a librarian's answer was labelled "informed by reviewer". The model had
 * routed the consultation through the dispatcher — `call_tool({name: 'ask_agent', ...})` — and the
 * loop fires `onToolCall` with the **raw** call, unwrapping only later inside `prepareToolCall`.
 * So this function saw the name `call_tool`, recognised nothing, returned `undefined`, and the
 * caller's `informedBy` kept whatever it held from the previous step. A stale label reads as a
 * fact about who did the work, which is precisely what this attribution exists to get right —
 * misattribution is worse than none.
 *
 * ## Why it is unwrapped here rather than at `onToolCall`
 *
 * Because the stored history holds the raw call too, so the restored transcript derives from the
 * same shape as the live path. Unwrapping only in the loop would fix the chat and leave a reopened
 * task still lying, which is the one-fact-in-two-places split this repository keeps paying for.
 * One owner, both readers.
 *
 * `chartFromToolCall` goes through it for the same reason: a chart drawn via the dispatcher would
 * otherwise render as nothing, which is a bug this project has already had once by another road.
 */
function throughDispatch(name: string, rawArguments: string): { name: string; args: unknown } {
  const decoded = decodeArguments(rawArguments)
  if (name !== CALL_TOOL_NAME || typeof decoded !== 'object' || decoded === null) {
    return { name, args: decoded }
  }
  const inner = decoded as { name?: unknown; arguments?: unknown }
  // A malformed wrapper is left as itself rather than guessed at: reporting it as the inner call
  // would attribute work to a role nobody named.
  if (typeof inner.name !== 'string' || inner.name.length === 0) return { name, args: decoded }
  // `call_tool`'s arguments are an object by schema, not the JSON string a provider sends.
  return { name: inner.name, args: inner.arguments ?? {} }
}

/** A tool call's arguments as an object. Providers send them as a JSON string. */
function decodeArguments(raw: string): unknown {
  try {
    return JSON.parse(raw.length > 0 ? raw : '{}')
  } catch {
    // Returned as-is so the schema reports "expected object", which is the truth: what arrived
    // was not one, and inventing an empty object here would hide why.
    return raw
  }
}
