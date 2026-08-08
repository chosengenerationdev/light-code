import type { ApprovableGroup, WorkspaceApprovals } from '../approval/policy.js'
import type { McpServerState, McpToolPermission } from '../mcp/types.js'
import type { ApprovalDecision } from '../approval/types.js'
import type { WireFormat } from '../providers/types.js'
import type { ToolGroup, ToolPreview } from '../tools/types.js'

/**
 * Non-secret Apigee settings, safe to send toward the UI. Note the absence of the secret.
 *
 * Optional fields are explicitly `| undefined` throughout this file: these values come
 * from zod `.optional()` schemas, which under `exactOptionalPropertyTypes` produce exactly
 * that, and a form field cleared to empty legitimately sends `undefined`.
 */
export interface ApigeeSummary {
  tokenUrl?: string | undefined
  grantType?: string | undefined
  clientId?: string | undefined
  scope?: string | undefined
  tokenHeaderName?: string | undefined
  tokenHeaderPrefix?: string | undefined
  tokenPath?: string | undefined
  expiresInPath?: string | undefined
  fallbackExpirySeconds?: number | undefined
  refreshSkewSeconds?: number | undefined
}

/** Cert *paths* are not secrets (§15) — only the passphrase is, and it never crosses. */
export interface CertSummary {
  certDir?: string | undefined
  certFile?: string | undefined
  keyFile?: string | undefined
  pfxFile?: string | undefined
  caFile?: string | undefined
}

export interface ModelCapabilityInput {
  contextWindow?: number | undefined
  supportsVision?: boolean | undefined
  supportsTools?: boolean | undefined
}

/**
 * Never carries a secret value — invariant 7. The `has*` booleans only say whether one is
 * set, so the UI can render "Set — replace?" without ever round-tripping the value.
 */
export interface ProfileSummary {
  id: string
  label: string
  wireFormat: WireFormat
  baseUrl: string
  model: string
  authType: 'none' | 'apiKey' | 'apigeeMtls'
  hasApiKey: boolean
  hasClientSecret: boolean
  hasCertPassphrase: boolean
  apigee?: ApigeeSummary
  certs?: CertSummary
  modelCapabilities?: ModelCapabilityInput
}

/**
 * What a save carries from the form: `id` undefined means "create new". Every secret field
 * empty means "no change" — the UI cannot send back a value it was never given.
 */
export interface ProfileInput {
  id?: string
  label: string
  wireFormat: WireFormat
  baseUrl: string
  model: string
  authType: 'none' | 'apiKey' | 'apigeeMtls'
  apiKey: string
  apigee?: ApigeeSummary
  /** Write-only, like `apiKey`. */
  clientSecret?: string
  certs?: CertSummary
  /** Write-only. */
  certPassphrase?: string
  modelCapabilities?: ModelCapabilityInput
}

/** One line per step of load-certs → get-token → list-models (§10). */
export interface TestConnectionStep {
  step: 'certificates' | 'token' | 'models'
  status: 'ok' | 'failed' | 'skipped'
  detail: string
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
  | { type: 'requestMcp' }
  /** The raw `mcpServers` JSON from the editor, validated host-side before saving. */
  | { type: 'saveMcpServers'; json: string }
  | { type: 'restartMcpServer'; name: string }
  | { type: 'connectMcpServer'; name: string }
  | { type: 'setMcpServerEnabled'; name: string; enabled: boolean }
  | { type: 'setMcpToolPermission'; server: string; tool: string; permission: McpToolPermission }
  | { type: 'requestProfiles' }
  | { type: 'saveProfile'; profile: ProfileInput }
  | { type: 'duplicateProfile'; id: string }
  | { type: 'deleteProfile'; id: string }
  | { type: 'setActiveProfile'; id: string }
  /**
   * Fetch the provider's catalogue for the profile currently *in the form* — which may be
   * unsaved — so the user can pick a model before committing. Secrets stay host-side: the
   * form sends its id (for a saved profile's stored secret) plus whatever it has typed.
   */
  | { type: 'requestModels'; profile: ProfileInput }
  | { type: 'testConnection'; profile: ProfileInput }
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
  /** Server health plus the raw JSON the editor round-trips, and any spawn warnings. */
  | { type: 'mcp'; servers: McpServerState[]; json: string; warnings: Record<string, string[]> }
  | { type: 'mcpSaveError'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'profiles'; profiles: ProfileSummary[]; activeProfileId: string | undefined }
  | { type: 'profileSaved' }
  /**
   * `warning` set with an empty `models` is the normal case for a gateway that doesn't
   * publish a catalogue — the UI shows it beside a still-usable free-text field (§9).
   */
  | { type: 'models'; models: string[]; warning?: string }
  | { type: 'testConnectionResult'; ok: boolean; steps: TestConnectionStep[] }
