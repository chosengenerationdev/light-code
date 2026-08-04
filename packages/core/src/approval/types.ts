import type { ToolGroup, ToolPreview } from '../tools/types.js'

export interface ApprovalRequest {
  /** Correlates the request with the user's answer across the transport. */
  id: string
  toolName: string
  group: ToolGroup
  /** Ground truth only — see `ToolPreview` and invariant 8. */
  preview: ToolPreview
}

export type ApprovalDecision = 'approve' | 'deny'

/**
 * Asks the user whether a tool may run. Implemented at the host boundary because the
 * answer comes from the UI; core only depends on this interface, so the Node host (§14)
 * can supply its own without touching the loop.
 */
export interface ApprovalGate {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>
}

/**
 * Approves everything without asking. Exists for tests and for the headless autonomous
 * runs planned in Phase 9b — **not** a user-facing setting. Per-category auto-approve
 * (CLAUDE.md §8) is Phase 4's job and ships with every toggle off.
 */
export class AlwaysApproveGate implements ApprovalGate {
  async requestApproval(): Promise<ApprovalDecision> {
    return 'approve'
  }
}

/**
 * `always`-group tools are control flow, not actions: `attempt_completion` and
 * `ask_followup_question` perform no work and have nothing to approve.
 */
export function requiresApproval(group: ToolGroup): boolean {
  return group !== 'always'
}
