import type { ApprovableGroup, WorkspaceApprovals } from '../approval/policy.js'
import type { ApprovalDecision } from '../approval/types.js'
import type { WireFormat } from '../providers/types.js'
import type { ToolGroup, ToolPreview } from '../tools/types.js'

/** Never carries a secret value — invariant 7. `hasApiKey` only says whether one is set. */
export interface ProfileSummary {
  id: string
  label: string
  wireFormat: WireFormat
  baseUrl: string
  model: string
  hasApiKey: boolean
}

/** What a save comes from the form: `id` undefined means "create new". `apiKey` empty means "no change". */
export interface ProfileInput {
  id?: string
  label: string
  wireFormat: WireFormat
  baseUrl: string
  model: string
  apiKey: string
}

/** A tool invocation and its outcome, rendered inline in the chat transcript. */
export interface ToolCallSummary {
  id: string
  name: string
  /** Pretty-printed arguments — ground truth, not the model's description of them (invariant 8). */
  arguments: string
  result?: string
  isError?: boolean
}

/** Shared by packages/ui and apps/vscode so both sides agree on the wire shape. */
export type UiToHostMessage =
  | { type: 'sendMessage'; text: string }
  | { type: 'cancel' }
  | { type: 'approvalResponse'; id: string; decision: ApprovalDecision }
  /** Approve *and* remember, so this exact command / this tool stops prompting here. */
  | { type: 'approvalResponseAlways'; id: string; scope: 'tool' | 'command' }
  | { type: 'rollback' }
  | { type: 'requestSettings' }
  | { type: 'setMode'; modeId: string }
  | { type: 'setAutoApprove'; group: ApprovableGroup; enabled: boolean }
  | { type: 'revokeAllowedTool'; toolName: string }
  | { type: 'revokeAllowedCommand'; command: string }
  | { type: 'requestProfiles' }
  | { type: 'saveProfile'; profile: ProfileInput }
  | { type: 'duplicateProfile'; id: string }
  | { type: 'deleteProfile'; id: string }
  | { type: 'setActiveProfile'; id: string }
  | { type: 'exportConfig' }
  | { type: 'importConfig' }

export type HostToUiMessage =
  /**
   * `text` is the FULL accumulated response so far, not just the latest delta.
   * `postMessage` delivery isn't guaranteed — sending cumulative state makes each
   * message self-correcting, so one dropped message doesn't corrupt everything after it.
   */
  | { type: 'textChunk'; text: string }
  | { type: 'toolCall'; toolCall: ToolCallSummary }
  | { type: 'toolResult'; toolCall: ToolCallSummary }
  /** Ground truth for the approval prompt — invariant 8. The UI renders only `preview`. */
  | { type: 'approvalRequest'; id: string; toolName: string; group: ToolGroup; preview: ToolPreview }
  /** A rollback point now exists; the UI can offer to undo back to it. */
  | { type: 'checkpointAvailable' }
  | { type: 'rolledBack' }
  /** Current mode plus this workspace's approval settings, for the Approvals/Modes UI. */
  | { type: 'settings'; modeId: string; approvals: WorkspaceApprovals }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'profiles'; profiles: ProfileSummary[]; activeProfileId: string | undefined }
  | { type: 'profileSaved' }
