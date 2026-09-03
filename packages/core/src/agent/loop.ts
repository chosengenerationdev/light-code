import { CONTINUE_PROMPT, looksUnfinished, MAX_CONTINUE_NUDGES } from './unfinished.js'
import { requiresApproval, type ApprovalGate } from '../approval/types.js'
import type { Checkpoint, ShadowGit } from '../checkpoints/shadowGit.js'
import { computeBreakdown, type TokenBreakdown } from '../context/budget.js'
import { compactHistory, isSummaryMessage, shouldCompact, type CompactionOptions } from '../context/compact.js'
import { dropSupersededReads } from '../context/supersede.js'
import { dropEvictedDocs } from '../context/evict.js'
import { CODE_MODE } from '../modes/builtin.js'
import { toolsForMode } from '../modes/resolve.js'
import type { Mode } from '../modes/types.js'
import type { ChatProvider, ChatStreamOptions, ImageAttachment, ToolCall } from '../providers/types.js'
import { takeWhy, toToolDefinitions } from '../tools/registry.js'
import { CALL_TOOL_NAME, callToolParamsSchema } from '../tools/callTool.js'
import type { Tool, ToolExecutionContext, ToolPreview, ToolRegistry, ToolResult } from '../tools/index.js'
import type { Conversation } from './messages.js'
import { truncateToolResult, type TruncationStore } from './truncate.js'

export interface AgentTurnEvents {
  onTextChunk(text: string): void
  /**
   * The model's own reasoning, where the provider exposes it.
   *
   * Deliberately **not** added to the conversation: it is not part of the answer, and
   * feeding a reasoning trace back as assistant content on the next turn both wastes
   * context and confuses models that did not produce it in that form.
   */
  onReasoningChunk?(text: string): void
  onToolCall(toolCall: ToolCall): void
  onToolResult(toolCall: ToolCall, result: ToolResult): void
  onDone(): void
  onError(message: string): void
  /** Fired once per task, the first time an edit is about to happen. */
  onCheckpoint?(checkpoint: Checkpoint): void
  /** Per-request token accounting for the UI (§12: "instrument it"). */
  onContextUpdate?(breakdown: TokenBreakdown, supersededCount: number, compactedCount: number): void
  /** Fired when history was summarised, so the UI can say so rather than silently losing detail. */
  onCompacted?(summarisedCount: number): void
  /** A queued message has entered the conversation; the UI moves it out of the queue. */
  onQueuedMessageConsumed?(text: string): void
  /**
   * The model announced an action, called nothing, and was asked once to go ahead.
   *
   * Reported rather than silent: an extra request was spent, and if this fires on every turn
   * the model or the prompt is at fault and the log is where that becomes visible.
   */
  onNudgedToContinue?(): void
}

export interface RunAgentTurnOptions {
  signal?: AbortSignal
  /** Default 25 — configurable per CLAUDE.md §5. */
  maxIterations?: number
  /** When provided, oversized tool results are capped and stored for re-reading (§12). */
  truncationStore?: TruncationStore
  /** Omitted means every tool runs unapproved — only valid for tests and headless runs. */
  approvalGate?: ApprovalGate
  /** Omitted means no checkpoint is taken (e.g. git unavailable). */
  shadowGit?: ShadowGit
  /** Restricts which tool groups are available. Defaults to Code (everything). */
  mode?: Mode
  /**
   * The active model's context window, from the capability table (§9). Compaction and the
   * token breakdown both need it; omitted disables both rather than guessing a size.
   */
  contextWindow?: number
  /** Overrides for when compaction triggers and how much stays verbatim. */
  compaction?: CompactionOptions
  /** Set false to disable compaction entirely for this turn. */
  compactionEnabled?: boolean
  /** Images attached to this user message. */
  images?: ImageAttachment[]
  /**
   * Pulls anything the user typed while this turn was running.
   *
   * Called at a **turn boundary inside the loop** — after a tool result has been recorded
   * and before the next model call — never mid-tool-call. Returning an empty array is the
   * normal case and costs nothing.
   */
  drainQueuedMessages?: () => string[]
}

const DEFAULT_MAX_ITERATIONS = 25
const MAX_CONSECUTIVE_MISTAKES = 3

/**
 * Builds the message list for one request: compact if the window demands it, then drop
 * superseded reads, then report the breakdown.
 *
 * Ordering matters. Compaction runs first because it can remove whole turns, and there is
 * no point superseding a read that is about to be summarised away. Superseding runs on
 * every request rather than being written back, so the full result stays in the transcript.
 */
async function prepareModelMessages(
  conversation: Conversation,
  provider: ChatProvider,
  tools: ReturnType<typeof toToolDefinitions>,
  options: RunAgentTurnOptions,
  events: AgentTurnEvents,
): Promise<ReturnType<Conversation['toModelMessages']>> {
  const contextWindow = options.contextWindow ?? 0
  let messages = conversation.toModelMessages()

  if (options.compactionEnabled !== false && contextWindow > 0) {
    const estimated = computeBreakdown(messages, tools, contextWindow).total
    if (shouldCompact(messages, estimated, contextWindow, options.compaction ?? {})) {
      const result = await compactHistory(messages, provider, options.compaction ?? {})
      if (result.compacted) {
        const summary = result.messages.find(isSummaryMessage)
        if (summary !== undefined) {
          // `summarisedCount` counts non-system messages, which is exactly what
          // `applyCompaction` measures against.
          conversation.applyCompaction(summary, conversation.compactedCount() + result.summarisedCount)
          events.onCompacted?.(result.summarisedCount)
          messages = conversation.toModelMessages()
        }
      }
    }
  }

  const superseded = dropSupersededReads(messages)
  /*
   * Eviction runs after superseding, and the order is irrelevant to the result — both replace
   * a tool message's content in place and neither reads the other's output. Kept in this order
   * because superseding is the cheaper, always-on pass.
   */
  const evicted = dropEvictedDocs(superseded.messages)
  const breakdown = computeBreakdown(evicted.messages, tools, contextWindow)
  // Reported as one number: the UI's question is "how much was dropped", and splitting
  // "superseded" from "released" would be a distinction the reader cannot act on.
  events.onContextUpdate?.(
    breakdown,
    superseded.supersededCount + evicted.evictedCount,
    conversation.compactedCount(),
  )

  return evicted.messages
}

type PreparedCall =
  | { ok: true; tool: Tool; params: Record<string, unknown>; why?: string }
  | { ok: false; result: ToolResult }

/**
 * Rewrites a `call_tool` invocation into the call it stands for.
 *
 * Done here, before anything else in `prepareToolCall`, so that the checkpoint, the approval
 * gate, mode filtering and the command allowlist downstream all see the **inner** tool. If
 * dispatch happened inside `call_tool.execute` instead, approving `call_tool` once would
 * approve every hidden tool behind it — see `tools/callTool.ts`.
 */
function unwrapDispatch(toolCall: ToolCall): { ok: true; call: ToolCall } | { ok: false; result: ToolResult } {
  if (toolCall.name !== CALL_TOOL_NAME) return { ok: true, call: toolCall }

  let outer: unknown
  try {
    outer = JSON.parse(toolCall.arguments.length > 0 ? toolCall.arguments : '{}')
  } catch (error) {
    return {
      ok: false,
      result: {
        content: `call_tool received malformed JSON arguments: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      },
    }
  }

  const parsed = callToolParamsSchema.safeParse(outer)
  if (!parsed.success) {
    return {
      ok: false,
      result: {
        content: `Invalid arguments for call_tool: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        isError: true,
      },
    }
  }

  if (parsed.data.name === CALL_TOOL_NAME) {
    // No recursion. A self-referential dispatch has no legitimate use and is the obvious way
    // to try to confuse the unwrap into producing a call the gate never inspected.
    return { ok: false, result: { content: 'call_tool cannot call itself.', isError: true } }
  }

  return {
    ok: true,
    // The id is kept so the tool result still answers the call the provider made — every
    // provider rejects a transcript with an unanswered tool call.
    call: { ...toolCall, name: parsed.data.name, arguments: JSON.stringify(parsed.data.arguments ?? {}) },
  }
}

/** Resolves and validates a tool call without running it, so approval sees real params. */
function prepareToolCall(original: ToolCall, registry: ToolRegistry, mode: Mode): PreparedCall {
  const unwrapped = unwrapDispatch(original)
  if (!unwrapped.ok) return { ok: false, result: unwrapped.result }
  const toolCall = unwrapped.call
  const viaDispatch = toolCall !== original

  const tool = registry.get(toolCall.name)
  if (tool === undefined) {
    return {
      ok: false,
      result: {
        content: viaDispatch
          ? `call_tool could not find a tool named "${toolCall.name}". Use search_docs to get the exact name.`
          : `Unknown tool "${toolCall.name}".`,
        isError: true,
      },
    }
  }

  // Defence in depth: the tool was already withheld from the system prompt, but earlier
  // turns in the history may still reference it after a mid-session mode switch.
  if (!mode.groups.includes(tool.group)) {
    return {
      ok: false,
      result: {
        content: `"${tool.name}" is not available in ${mode.name} mode.`,
        isError: true,
      },
    }
  }

  let params: unknown
  try {
    params = JSON.parse(toolCall.arguments.length > 0 ? toolCall.arguments : '{}')
  } catch (error) {
    return {
      ok: false,
      result: {
        content: `Tool "${toolCall.name}" received malformed JSON arguments: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      },
    }
  }

  /*
   * The reason comes off before validation.
   *
   * Every tool advertises `why`, and no tool declares it — so leaving it in would fail a strict
   * schema, and passing it on would send an MCP server a property it never asked for. Taken here,
   * once, on the single path from a model's call to a tool's arguments.
   */
  const { why, rest } = takeWhy((params ?? {}) as Record<string, unknown>)
  params = rest

  const parsed = tool.parametersSchema.safeParse(params)
  if (!parsed.success) {
    return {
      ok: false,
      result: {
        content: `Invalid arguments for "${toolCall.name}": ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        isError: true,
      },
    }
  }

  return { ok: true, tool, params: parsed.data as Record<string, unknown>, ...(why === undefined ? {} : { why }) }
}

interface CheckpointTracker {
  hasCheckpoint(): boolean
  markCheckpointTaken(): void
}

/**
 * Everything between "the model asked for a tool" and "it happened": validate, snapshot
 * before the first edit, ask the user, then run it. Ordering matters — validation must
 * precede approval so the preview reflects the real parameters, and the checkpoint must
 * precede execution so there is something to roll back to.
 */
async function runOneToolCall(
  toolCall: ToolCall,
  registry: ToolRegistry,
  context: ToolExecutionContext,
  options: RunAgentTurnOptions,
  events: AgentTurnEvents,
  checkpoints: CheckpointTracker,
  mode: Mode,
): Promise<ToolResult> {
  const prepared = prepareToolCall(toolCall, registry, mode)
  if (!prepared.ok) return prepared.result

  const { tool, params } = prepared

  // Snapshot before the *first* edit of the task, not before every one — CLAUDE.md §8.
  // A failed snapshot must not silently proceed: the user would think they can roll back.
  if (tool.group === 'edit' && !checkpoints.hasCheckpoint() && options.shadowGit !== undefined) {
    try {
      const checkpoint = await options.shadowGit.snapshot()
      checkpoints.markCheckpointTaken()
      events.onCheckpoint?.(checkpoint)
    } catch (error) {
      return {
        content: `Could not create a checkpoint before editing, so the edit was not attempted: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  }

  if (options.approvalGate !== undefined && requiresApproval(tool.group)) {
    let preview: ToolPreview
    try {
      preview =
        tool.preview !== undefined
          ? await tool.preview(params, context)
          : { kind: 'text', text: JSON.stringify(params, null, 2) }
    } catch (error) {
      // A preview that throws must not become an implicit approval.
      preview = { kind: 'text', text: `Could not preview this action: ${error instanceof Error ? error.message : String(error)}` }
    }

    const decision = await options.approvalGate.requestApproval({
      id: toolCall.id,
      toolName: tool.name,
      group: tool.group,
      preview,
    })

    if (decision === 'deny') {
      // Told to the model as a normal tool result rather than aborting the turn, so it can
      // choose a different approach instead of the conversation simply stopping.
      return { content: `The user denied permission to run "${tool.name}".`, isError: true }
    }
  }

  return tool.execute(params, context)
}

/**
 * Multi-step: send the user message, stream the response, execute at most one tool
 * call per assistant message, feed the result back, and repeat until the model calls
 * `attempt_completion`/`ask_followup_question`, answers in plain text, hits the
 * iteration cap, or fails consecutively on the same file. See CLAUDE.md §5.
 */
export async function runAgentTurn(
  provider: ChatProvider,
  conversation: Conversation,
  userMessage: string,
  toolRegistry: ToolRegistry,
  toolContext: ToolExecutionContext,
  events: AgentTurnEvents,
  options: RunAgentTurnOptions = {},
): Promise<void> {
  conversation.addUserMessage(userMessage, options.images)

  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const mistakeCounts = new Map<string, number>()
  let continueNudges = 0
  const mode = options.mode ?? CODE_MODE
  // Filtered before definitions are built: an excluded tool never reaches the system
  // prompt, so the model is never told it exists (§8).
  const tools = toToolDefinitions(toolsForMode(toolRegistry, mode))
  let checkpointTaken = false

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const streamOptions: ChatStreamOptions = { tools }
    if (options.signal !== undefined) streamOptions.signal = options.signal

    // What the model sees is derived per request; the conversation itself keeps the full
    // record (§12, and the Phase 6b rule that compaction must not destroy stored history).
    const modelMessages = await prepareModelMessages(conversation, provider, tools, options, events)

    let assistantText = ''
    let toolCall: ToolCall | undefined
    let streamError: string | undefined

    for await (const chunk of provider.streamChat(modelMessages, streamOptions)) {
      if (chunk.type === 'text') {
        assistantText += chunk.text
        events.onTextChunk(chunk.text)
      } else if (chunk.type === 'reasoning') {
        events.onReasoningChunk?.(chunk.text)
      } else if (chunk.type === 'toolCall') {
        // "One tool call per assistant message" (CLAUDE.md §5) — ignore extras defensively.
        if (toolCall === undefined) toolCall = chunk.toolCall
      } else if (chunk.type === 'error') {
        streamError = chunk.error
      } else if (chunk.type === 'done') {
        break
      }
    }

    if (streamError !== undefined) {
      // A late error must not discard text the model already sent this turn.
      if (assistantText.length > 0) conversation.addAssistantMessage(assistantText)
      events.onError(streamError)
      return
    }

    if (toolCall === undefined) {
      if (assistantText.length === 0) {
        events.onError(
          'The provider finished without returning any text. Check the base URL and model name, and that the endpoint supports streaming chat completions.',
        )
        return
      }

      conversation.addAssistantMessage(assistantText)

      /*
       * "I'll create the skill. Let me write something realistic." — and then nothing.
       *
       * Ending the turn on plain text is right for an answer and wrong for an announcement, and
       * the two are indistinguishable to the loop without looking at the words. A model that
       * narrates its intent and drops the tool call leaves the user staring at a promise, unable
       * to tell whether the work failed or was never attempted — which is exactly the silent
       * ending reported against every release so far.
       *
       * So it gets asked once to go ahead. `looksUnfinished` explains why a heuristic is
       * acceptable here and nowhere near the edit path.
       */
      if (continueNudges < MAX_CONTINUE_NUDGES && looksUnfinished(assistantText)) {
        continueNudges++
        conversation.addUserMessage(CONTINUE_PROMPT)
        events.onNudgedToContinue?.()
        continue
      }

      events.onDone()
      return
    }

    conversation.addAssistantMessage(assistantText, [toolCall])
    events.onToolCall(toolCall)

    const result = await runOneToolCall(toolCall, toolRegistry, toolContext, options, events, {
      hasCheckpoint: () => checkpointTaken,
      markCheckpointTaken: () => {
        checkpointTaken = true
      },
    }, mode)
    // The conversation gets the capped text; the UI event carries the full result so the
    // user still sees everything that actually happened.
    const forModel =
      options.truncationStore !== undefined
        ? (await truncateToolResult(result.content, options.truncationStore)).content
        : result.content
    conversation.addToolResultMessage(toolCall.id, forModel)
    events.onToolResult(toolCall, result)

    // Anything the user typed while this was running joins the conversation now, so the
    // model sees it before deciding its next step rather than after it has finished.
    // Here specifically: the tool result is recorded, so the call/result pair is intact and
    // no provider sees an unanswered tool_use.
    const queued = options.drainQueuedMessages?.() ?? []
    for (const message of queued) {
      conversation.addUserMessage(message)
      events.onQueuedMessageConsumed?.(message)
    }

    if (toolCall.name === 'attempt_completion' || toolCall.name === 'ask_followup_question') {
      events.onDone()
      return
    }

    if (result.path !== undefined) {
      if (result.isError === true) {
        const count = (mistakeCounts.get(result.path) ?? 0) + 1
        mistakeCounts.set(result.path, count)
        if (count >= MAX_CONSECUTIVE_MISTAKES) {
          events.onError(`Stopped after ${count} consecutive failed attempts on "${result.path}".`)
          return
        }
      } else {
        mistakeCounts.set(result.path, 0)
      }
    }
  }

  /*
   * Deliberately says the work survives. The cap exists to stop a model looping on a failing
   * edit, and hitting it during legitimate long work reads as a crash unless the message
   * says otherwise — the transcript is intact and another message resumes from here.
   */
  events.onError(
    `Stopped after ${maxIterations} steps in one turn. Nothing is lost — send another message ` +
      `(for example "continue") to carry on from here. Raise the limit in Settings → Approvals ` +
      'if this task legitimately needs more.',
  )
}
