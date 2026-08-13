import type { ApprovableGroup, WorkspaceApprovals } from '../approval/policy.js'
import type { McpPlatform } from '../mcp/forms.js'
import type { IndexProgress, IndexResult } from '../rag/indexer.js'
import type { PythonStatus } from '../python/manager.js'
import type { McpServerConfig, McpServerState, McpToolPermission } from '../mcp/types.js'
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
 * Connection trust for a profile: an extra CA, and whether to verify the server
 * certificate at all. Not a secret — a CA path and a boolean — so it crosses the bridge
 * freely, unlike the passphrase in `CertSummary`.
 */
export interface ConnectionTlsInput {
  caFile?: string | undefined
  /** Client certificate. Absent inherits whatever is set globally. */
  certFile?: string | undefined
  keyFile?: string | undefined
  pfxFile?: string | undefined
  /** `false` means "accept any certificate". Absent means verify, which is the default. */
  rejectUnauthorized?: boolean | undefined
  /** `false` withholds the global client certificate from this one connection. */
  useGlobalClientCertificate?: boolean | undefined
}

/**
 * The Network tab: TLS material every connection inherits, plus the directory relative
 * filenames resolve against.
 *
 * Paths and booleans only. The key passphrase is a secret and travels write-only —
 * `passphrase` carries a new value up, `hasPassphrase` reports back down (invariant 7).
 */
export interface NetworkSettingsInput {
  certDir?: string | undefined
  tls: ConnectionTlsInput
  /** Absent leaves the stored passphrase untouched; empty string clears it. */
  passphrase?: string | undefined
}

export interface NetworkSettingsSummary {
  certDir?: string | undefined
  tls: ConnectionTlsInput
  hasPassphrase: boolean
  /** Reported so the UI can say where relative filenames will resolve to. */
  workspaceRoot?: string | undefined
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
  connectionTls?: ConnectionTlsInput
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
  connectionTls?: ConnectionTlsInput
}

/**
 * One rendered entry of a conversation. Shared by the live stream and a restored task, so
 * a reopened transcript looks identical to the one that was live.
 */
export type TranscriptEntry =
  /**
   * `expertInformed` marks work that followed a consultation: the model acted on advice
   * rather than reasoning alone. Worth distinguishing, because it tells you which decisions
   * to scrutinise differently — and which ones you paid for.
   */
  | { kind: 'text'; role: 'user' | 'assistant'; content: string; expertInformed?: boolean }
  /** The model's reasoning for a step. Rendered collapsed — it is context, not the answer. */
  | { kind: 'reasoning'; content: string }
  | { kind: 'tool'; toolCall: ToolCallSummary; expertInformed?: boolean }

/** Enough to render the history list without loading every transcript. */
export interface TaskListEntry {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

/** A configured OpenSearch connection, as the UI sees it. Credentials never cross (§15). */
export interface SearchConnectionSummary {
  id: string
  label: string
  url: string
  defaultIndex?: string
  caFile?: string
  rejectUnauthorized?: boolean
  hasUsername: boolean
  hasPassword: boolean
  limits?: SearchQueryLimits | undefined
}

/** Guard rails against a query that could hurt a production cluster. */
export interface SearchQueryLimits {
  maxHits?: number | undefined
  timeoutSeconds?: number | undefined
  terminateAfter?: number | undefined
  maxIndexes?: number | undefined
  defaultLookbackHours?: number | undefined
  maxFieldChars?: number | undefined
}

/** What a save carries. Empty credential fields mean "unchanged", as everywhere else. */
export interface SearchConnectionInput {
  id?: string
  label: string
  url: string
  defaultIndex?: string
  caFile?: string
  rejectUnauthorized?: boolean
  username?: string
  password?: string
  limits?: SearchQueryLimits | undefined
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
/** An image the user attached in the composer. Base64, no `data:` prefix. */
export interface ImageAttachmentInput {
  mediaType: string
  data: string
  /** Shown in the composer so the user can tell two screenshots apart. */
  name: string
}

/** Live token accounting for the context bar (§12: "instrument it"). */
export interface ContextUsage {
  system: number
  toolDefinitions: number
  history: number
  results: number
  total: number
  contextWindow: number
  /** True when these are character-based estimates rather than provider-reported. */
  estimated: boolean
  /** How many superseded file reads were dropped from this request. */
  supersededCount: number
  /** How many messages the model no longer sees verbatim. */
  compactedCount: number
  /** 0–1, when the provider reports cache figures. */
  cacheHitRate?: number
}

export type UiToHostMessage =
  | { type: 'sendMessage'; text: string; images?: ImageAttachmentInput[] }
  /** Ask the host to resolve `@` mentions for autocomplete as the user types. */
  | { type: 'requestMentionCandidates'; query: string }
  | { type: 'cancel' }
  /** Typed while a turn was running. Folded in at the next safe point in the loop. */
  | { type: 'queueMessage'; text: string }
  /** Removed before it was consumed. */
  | { type: 'unqueueMessage'; index: number }
  | { type: 'approvalResponse'; id: string; decision: ApprovalDecision }
  /** Approve *and* remember, so this exact command / this tool stops prompting here. */
  | { type: 'approvalResponseAlways'; id: string; scope: 'tool' | 'command' }
  | { type: 'rollback' }
  | { type: 'requestSettings' }
  | { type: 'requestTasks' }
  | { type: 'openTask'; id: string }
  | { type: 'deleteTask'; id: string }
  /** Start a fresh conversation; the current one is already saved. */
  | { type: 'newTask' }
  | { type: 'setMode'; modeId: string }
  | { type: 'setAutoApprove'; group: ApprovableGroup; enabled: boolean }
  | { type: 'revokeAllowedTool'; toolName: string }
  | { type: 'revokeAllowedCommand'; command: string }
  | { type: 'requestMcp' }
  /** The raw `mcpServers` JSON from the editor, validated host-side before saving. */
  | { type: 'saveMcpServers'; json: string }
  /** One server from the form editor. A `previousName` that differs means a rename. */
  | { type: 'saveMcpServer'; name: string; previousName?: string; config: McpServerConfig }
  | { type: 'deleteMcpServer'; name: string }
  /** Look on disk for the interpreter of a virtualenv, or for a venv beside a script. */
  | { type: 'probePythonEnv'; venvDir: string; script: string }
  /**
   * Open a native file or folder picker. `purpose` is opaque to the host and echoed back
   * verbatim, so one dialog serves every path field in the settings UI without the host
   * needing to know which form is open.
   */
  | { type: 'browseForPath'; purpose: string; kind: 'file' | 'folder'; extensions?: string[] }
  | { type: 'restartMcpServer'; name: string }
  | { type: 'connectMcpServer'; name: string }
  | { type: 'setMcpServerEnabled'; name: string; enabled: boolean }
  | { type: 'setMcpToolPermission'; server: string; tool: string; permission: McpToolPermission }
  | { type: 'requestProfiles' }
  | { type: 'requestSearch' }
  | { type: 'saveSearchConnection'; connection: SearchConnectionInput }
  | { type: 'deleteSearchConnection'; id: string }
  | { type: 'setActiveSearchConnection'; id: string | undefined }
  /** Fetches the index list for a connection, saved or as currently typed. */
  | { type: 'requestSearchIndexes'; connection: SearchConnectionInput }
  | { type: 'testSearchConnection'; connection: SearchConnectionInput }
  /** Indexing is user-started, never model-started: it is the largest egress in the product. */
  | { type: 'startIndexing' }
  | { type: 'cancelIndexing' }
  | { type: 'saveEmbedder'; profileId: string; model: string; dimensions: number; indexName?: string }
  /**
   * Lists models for an already-saved profile.
   *
   * Separate from `requestModels`, which rebuilds a profile from an unsaved form. Here the
   * profile is on disk with its credentials already resolved, and the UI could not
   * reconstruct it anyway — secrets are write-only across this bridge (invariant 7).
   */
  | { type: 'requestEmbedderModels'; profileId: string }
  | { type: 'requestPython' }
  | {
      type: 'setPython'
      dynamicTools: 'off' | 'on'
      uvPath?: string
      timeoutSeconds?: number
      indexUrl?: string
      offline?: boolean
    }
  | { type: 'requestNetwork' }
  | { type: 'saveNetwork'; settings: NetworkSettingsInput }
  | { type: 'requestExpert' }
  | { type: 'setExpert'; enabled: boolean; path?: string; model?: string }
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
  | { type: 'textChunk'; text: string; expertInformed?: boolean }
  /** Cumulative reasoning for the current step, same self-correcting rule as `textChunk`. */
  | { type: 'reasoningChunk'; text: string }
  | { type: 'toolCall'; toolCall: ToolCallSummary; expertInformed?: boolean }
  | { type: 'toolResult'; toolCall: ToolCallSummary; expertInformed?: boolean }
  /** Ground truth for the approval prompt — invariant 8. The UI renders only `preview`. */
  | { type: 'approvalRequest'; id: string; toolName: string; group: ToolGroup; preview: ToolPreview }
  /** A rollback point now exists; the UI can offer to undo back to it. */
  | { type: 'checkpointAvailable' }
  | { type: 'rolledBack' }
  /** Current mode plus this workspace's approval settings, for the Approvals/Modes UI. */
  | { type: 'settings'; modeId: string; approvals: WorkspaceApprovals }
  /** Server health plus the raw JSON the editor round-trips, and any spawn warnings. */
  | {
      type: 'mcp'
      servers: McpServerState[]
      json: string
      warnings: Record<string, string[]>
      /** Each server's stored entry, so the form can edit it without reparsing the JSON. */
      configs: Record<string, McpServerConfig>
      /** Decides the virtualenv interpreter path the form derives. */
      platform: McpPlatform
    }
  /** The write reached disk; the form closes on this rather than optimistically. */
  | { type: 'mcpServerSaved'; name: string }
  /**
   * What the probe found. An absent `interpreter` means nothing was found and `detail` says
   * why — the form still lets the path be typed in, so this never blocks configuring one.
   */
  | { type: 'pythonEnvProbe'; interpreter?: string; venvDir?: string; detail: string }
  /** Nothing is sent when the dialog is cancelled — a dismissed picker changes no field. */
  | { type: 'pathPicked'; purpose: string; path: string }
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
  /** Past tasks for this workspace, newest first. */
  | { type: 'tasks'; tasks: TaskListEntry[]; activeTaskId: string | undefined }
  /** Live token accounting, posted before each request. */
  | { type: 'contextUsage'; usage: ContextUsage }
  /** History was summarised; the UI says so rather than silently losing detail. */
  | { type: 'compacted'; summarisedCount: number }
  /** The queue as the host holds it — the UI renders this rather than its own copy. */
  | { type: 'queued'; messages: string[] }
  /** A queued message entered the conversation; the UI shows it as an ordinary user turn. */
  | { type: 'queuedMessageConsumed'; text: string }
  /** Workspace-relative paths matching an `@` query, for composer autocomplete. */
  | { type: 'mentionCandidates'; query: string; paths: string[] }
  /** Whether the active model accepts images, from the capability table (§9). */
  | { type: 'capabilities'; supportsVision: boolean; supportsTools: boolean; contextWindow: number }
  /** Configured OpenSearch connections, and which one is live for this session. */
  | {
      type: 'search'
      connections: SearchConnectionSummary[]
      /** Undefined means search is off — the tools are not offered at all. */
      activeConnectionId: string | undefined
    }
  /** `warning` with an empty list is normal: `_cat/indices` is often denied (§9). */
  | { type: 'searchIndexes'; indexes: { name: string; docsCount?: number; storeSize?: string }[]; warning?: string }
  | { type: 'searchTestResult'; ok: boolean; detail: string }
  /** The save reached disk. The form stays open until this arrives, so a failure keeps the typed values. */
  | { type: 'searchConnectionSaved'; id: string }
  | { type: 'network'; settings: NetworkSettingsSummary }
  | { type: 'python'; status: PythonStatus }
  /** Kept apart from `models` so the provider form and this tab cannot overwrite each other. */
  | { type: 'embedderModels'; models: string[]; warning?: string }
  | { type: 'embedderSaved' }
  | { type: 'indexProgress'; progress: IndexProgress }
  /** Exactly one of `result` or `error`. Both absent would leave the UI spinning. */
  | { type: 'indexResult'; result?: IndexResult; error?: string }
  /** Embedder settings plus what the index currently holds, for Settings → Search. */
  | {
      type: 'embedder'
      profileId?: string
      model?: string
      dimensions?: number
      /** Undefined when no folder is open, so the UI can say why indexing is unavailable. */
      indexName?: string
      /** False means it was derived from the workspace path rather than chosen. */
      indexNameIsCustom?: boolean
      indexedFiles: number
    }
  /** State of the Claude CLI expert: whether it is on, and whether it can actually run. */
  | {
      type: 'expert'
      enabled: boolean
      available: boolean
      path: string
      version?: string
      /** Why it cannot run, phrased for a human. */
      reason?: string
      model?: string
    }
  /**
   * Replaces the whole transcript — sent when a task is reopened, and on panel load to
   * restore the task that was in progress. `entries` is empty for a new task.
   */
  | { type: 'taskRestored'; taskId: string | undefined; entries: TranscriptEntry[] }
