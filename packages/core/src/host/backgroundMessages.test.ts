import { describe, expect, it } from 'vitest'

import { isTranscriptMessage, TRANSCRIPT_MESSAGES } from './backgroundMessages.js'

describe('what a background run may send', () => {
  it('withholds everything that renders into the conversation', () => {
    for (const type of ['textChunk', 'reasoningChunk', 'toolCall', 'toolResult', 'done', 'taskRestored'] as const) {
      expect(isTranscriptMessage(type)).toBe(true)
    }
  })

  /**
   * The bug this exists to prevent, in one test.
   *
   * These are *replies to things the user asked for*. With a schedule running every minute,
   * opening Settings during a run meant the answer was thrown away in transit and the tab sat
   * on "Checking…" — which looked like broken CLI detection and was nothing of the kind.
   */
  it('lets replies to the user reach the UI, even mid-run', () => {
    for (const type of [
      'expert',
      'settings',
      'profiles',
      'mcp',
      'python',
      'skills',
      'schedules',
      'search',
      'capabilities',
      'models',
      'pathPicked',
      'tasks',
      'network',
      'embedder',
    ] as const) {
      expect(isTranscriptMessage(type)).toBe(false)
    }
  })

  /**
   * An approval prompt is conversation, and an unattended run has nobody to answer it anyway —
   * `ScheduledApprovalGate` denies rather than asking. Letting one through would put a prompt
   * in front of the user for work they did not start.
   */
  it('withholds approval prompts', () => {
    expect(isTranscriptMessage('approvalRequest')).toBe(true)
  })

  /** The cost meter is scoped to the task on screen, not to whatever is running in the background. */
  it('withholds the expert spend meter', () => {
    expect(isTranscriptMessage('expertSpend')).toBe(true)
  })

  /**
   * A guard on the shape of the decision rather than on its contents. The set is small and
   * specific on purpose: if it starts growing towards "most messages", the deny list has
   * drifted back into being an allow list and the original bug is due to return.
   */
  it('stays small, because the default is to send', () => {
    expect(TRANSCRIPT_MESSAGES.size).toBeLessThan(20)
  })
})
