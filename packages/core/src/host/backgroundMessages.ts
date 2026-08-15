import type { HostToUiMessage } from '../agent/protocol.js'

/**
 * Messages a scheduled run must not send, because they write into the user's conversation.
 *
 * A background run borrows the shared conversation and hands it back (see `runSchedule`), so
 * anything it emits that renders as chat would overwrite what the user is looking at. These are
 * the ones that do.
 *
 * ## Why a deny list, when an allow list is usually safer
 *
 * This started as an allow list — two permitted types, everything else silent — on the
 * reasoning that a message type added later should default to silent rather than leak. That
 * reasoning was right about *chat* output and badly wrong about everything else, because
 * "everything else" is mostly **replies to things the user asked for**.
 *
 * The bug it caused: with a schedule running every minute, opening Settings during a run meant
 * the `expert` reply to `requestExpert` was dropped. The tab sat on "Checking…" and a manual
 * re-check — issued after the run had finished — worked. Nothing was broken about detection at
 * all; the answer was thrown away in transit.
 *
 * So the default is now "send", and only conversation traffic is held back. The failure modes
 * are not symmetric: a stray transcript message during a background run is a cosmetic flicker,
 * while a dropped settings reply is a control that silently never answers.
 */
export const TRANSCRIPT_MESSAGES = new Set<HostToUiMessage['type']>([
  'textChunk',
  'reasoningChunk',
  'toolCall',
  'toolResult',
  'approvalRequest',
  'done',
  'error',
  'taskRestored',
  'contextUsage',
  'compacted',
  'checkpointAvailable',
  'rolledBack',
  'queued',
  'queuedMessageConsumed',
  // The meter is scoped to the task on screen. A background run spending money against its own
  // task would otherwise show up as though it were the user's.
  'expertSpend',
])

/** Whether a message belongs to the conversation, and so must be withheld from a background run. */
export function isTranscriptMessage(type: HostToUiMessage['type']): boolean {
  return TRANSCRIPT_MESSAGES.has(type)
}
