import type { FormField } from '../tools/askUserForm.js'
import type { ExpertSavings } from '../expert/savings.js'
import type { ApprovableGroup, WorkspaceApprovals } from '../approval/policy.js'
import type { McpPlatform } from '../mcp/forms.js'
import type { IndexProgress, IndexResult } from '../rag/indexer.js'
import type { SearchLogEntry } from '../rag/searchLog.js'
import type { Schedule } from '../schedule/types.js'
import type { ExpertPricing } from '../expert/pricing.js'
import type { ResolvedVariable, SessionVariable } from '../session/variables.js'
import type { PythonStatus } from '../python/manager.js'
import type { McpServerConfig, McpServerState, McpToolPermission } from '../mcp/types.js'
import type { ApprovalDecision } from '../approval/types.js'
import type { VectorStoreKind } from '../config/schema.js'
import type { JuniorAssessment } from '../expert/assessment.js'
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
  /** Which backend it speaks. Older configs predate the field and are OpenSearch. */
  kind: VectorStoreKind
  url: string
  defaultIndex?: string
  caFile?: string
  rejectUnauthorized?: boolean
  hasUsername: boolean
  hasPassword: boolean
  limits?: SearchQueryLimits | undefined
}

/** What is saved under `python` in config, as opposed to what was resolved from it. */
export interface PythonSettings {
  dynamicTools: 'off' | 'on'
  uvPath?: string
  toolsDir?: string
  venvPath?: string
  indexUrl?: string
  offline?: boolean
  timeoutSeconds?: number
}

/**
 * One tool, as the Tools view shows it.
 *
 * `advertised` is the field that earns its place: with the dispatcher on, MCP and Python tools
 * are registered but kept out of the prompt and reached through `call_tool`. They remain fully
 * callable — hiding the *advertisement* is a prompt-size measure and never a permission — so a
 * view that did not say which were hidden would make a shorter prompt look like a shorter tool
 * list, which is the misreading the dispatcher invites.
 */
export interface ToolCatalogueEntry {
  name: string
  description: string
  group: ToolGroup
  /** Where it came from, so the view groups by the thing the user actually configures. */
  source: 'built-in' | 'mcp' | 'python'
  /** The MCP server it belongs to, when `source` is `mcp`. */
  server?: string
  /** False when it is registered but kept out of the system prompt. */
  advertised: boolean
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
  kind?: VectorStoreKind
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
  /**
   * One sentence on what this call is for, when the model supplied one.
   *
   * Every tool advertises a `why`, so the transcript can say "reading config.json — checking
   * which gateway is configured" rather than a bare name. It is the model's own account of its
   * intent, which is why it is shown *beside* the arguments and never instead of them:
   * invariant 8 is about the approval prompt showing what will happen, and a stated reason is
   * not that.
   */
  why?: string
  result?: string
  isError?: boolean
}

/** One tool as the schedule picker sees it: enough to list and group, nothing more. */
export interface ScheduleToolInfo {
  name: string
  description: string
  group: string
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
  /**
   * The filled-in form, or a dismissal.
   *
   * Values arrive as raw strings and booleans and are coerced host-side against the field
   * types: the UI validating is for the user's benefit, not the model's guarantee.
   */
  | { type: 'formResponse'; id: string; submitted: boolean; values: Record<string, string | boolean> }
  /** Approve *and* remember, so this exact command / this tool stops prompting here. */
  | { type: 'approvalResponseAlways'; id: string; scope: 'tool' | 'command' | 'folder' }
  | { type: 'rollback' }
  | { type: 'requestSettings' }
  | { type: 'setProgrammingProfile'; id: string }
  /*
   * Session variables. **Handled by the Node host, not the bridge** — whose variable wins is a
   * question only a shared server has, and the bridge is shared with the extension where it does
   * not. The shapes live here because this is where the UI's protocol is defined.
   */
  | { type: 'requestVariables' }
  /* The review queue. Administrator-only except for listing, which shows an author their own. */
  | { type: 'requestReviews' }
  | { type: 'decideReview'; id: string; approved: boolean; reason?: string }
  | { type: 'saveUserVariables'; variables: SessionVariable[] }
  | { type: 'saveAdminVariables'; variables: SessionVariable[] }
  | { type: 'saveAdminIds'; ids: string[] }
  | { type: 'requestTasks' }
  | { type: 'openTask'; id: string }
  | { type: 'deleteTask'; id: string }
  /** Start a fresh conversation; the current one is already saved. */
  | { type: 'newTask' }
  | { type: 'setMode'; modeId: string }
  | { type: 'setAutoApprove'; group: ApprovableGroup; enabled: boolean }
  | { type: 'setMaxIterations'; value: number }
  /** Folders tools may read outside the workspace. Replaces the whole list. */
  | { type: 'setReadRoots'; roots: string[] }
  /** Cosmetic; persisted in config so it survives a reload and follows the user. */
  | { type: 'setAccentColor'; value: string }
  | { type: 'setExpertColor'; value: string }
  /** Cosmetic; persisted in config so it survives a reload and follows the user. */
  | { type: 'setAccentColor'; value: string }
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
  /**
   * A timeout for one tool, in seconds. `undefined` clears it and the server's applies again.
   *
   * Per tool because a server's single number is the wrong shape for the common case: twenty
   * quick lookups and one report that takes four minutes. Raising the server-wide limit to suit
   * the slow one means a genuinely hung quick call hangs for four minutes too.
   */
  | { type: 'setMcpToolTimeout'; server: string; tool: string; seconds?: number }
  | { type: 'requestProfiles' }
  | { type: 'requestSearch' }
  | { type: 'saveSearchConnection'; connection: SearchConnectionInput }
  | { type: 'deleteSearchConnection'; id: string }
  /**
   * `forProject` stores the choice against the open workspace instead of as the default.
   *
   * Still written to *user* config, keyed by path — invariant 5 is about who writes a value, not
   * about whether it may vary by project. Without this the mechanism existed and nothing could
   * reach it, which from the outside is the same as not having it.
   */
  | { type: 'setActiveSearchConnection'; id: string | undefined; forProject?: boolean }
  /** Fetches the index list for a connection, saved or as currently typed. */
  | { type: 'requestSearchIndexes'; connection: SearchConnectionInput }
  | { type: 'testSearchConnection'; connection: SearchConnectionInput }
  /** Indexing is user-started, never model-started: it is the largest egress in the product. */
  | { type: 'startIndexing' }
  /**
   * Rebuilds the documentation index. `kind` narrows it to tools or skills only.
   *
   * Separate because the two halves change for different reasons: adding an MCP server, or
   * writing a skill. The buttons sit where each of those happens rather than in one place that
   * does both and leaves you wondering what it touched.
   */
  | { type: 'indexDocs'; kind?: 'tool' | 'skill' }
  /** Removes every per-project override, so this project follows the defaults again. */
  | { type: 'clearProjectSettings' }
  | { type: 'requestProjectSettings' }
  /** Excel and Outlook, off by default. Windows only. */
  | { type: 'setOffice'; excel: boolean; outlook: boolean }
  /**
   * Creates the standing-instructions skill and opens it, or just opens it if it exists.
   *
   * A button rather than an editor: the body is markdown the user will want to keep working on,
   * and the editor they already have is better than anything a settings panel could offer.
   */
  | { type: 'openStandingSkill' }
  /** Empties the documentation index, so nothing stale can be matched. */
  | { type: 'clearDocsIndex' }
  /** Copies this workspace's index from another store into the active one, vectors and all. */
  | { type: 'syncVectorStore'; fromId: string }
  /** Run a query by hand, exactly as the model would, to judge what the index returns. */
  | { type: 'runSearchProbe'; query: string; target: 'codebase' | 'docs' }
  | { type: 'clearSearchLog' }
  | { type: 'setDispatcher'; enabled: boolean }
  | { type: 'setSkillRetrieval'; enabled: boolean }
  | { type: 'cancelIndexing' }
  | {
      type: 'saveEmbedder'
      profileId: string
      model: string
      dimensions: number
      indexName?: string
      /** Front of every derived index name. Empty restores the default. */
      indexPrefix?: string
    }
  /**
   * Lists models for an already-saved profile.
   *
   * Separate from `requestModels`, which rebuilds a profile from an unsaved form. Here the
   * profile is on disk with its credentials already resolved, and the UI could not
   * reconstruct it anyway — secrets are write-only across this bridge (invariant 7).
   */
  | { type: 'requestEmbedderModels'; profileId: string }
  | { type: 'requestSkills' }
  | { type: 'requestSchedules' }
  /** The whole tool catalogue, for the read-only Tools view. */
  | { type: 'requestTools' }
  /** Reopen the host's onboarding. Ignored where the host has none. */
  | { type: 'openWalkthrough' }
  | { type: 'saveSchedule'; schedule: Schedule }
  | { type: 'deleteSchedule'; id: string }
  | { type: 'setScheduleEnabled'; id: string; enabled: boolean }
  | { type: 'runScheduleNow'; id: string }
  /** Restarts the timer by hand, for when it is reported as stopped. */
  /**
   * Raises or lowers the expert budget for this chat only.
   *
   * Omit both to drop back to the configured default. Deliberately not persisted: an override
   * belongs to the conversation that needed it, and a raised ceiling that quietly outlived its
   * task would be a limit nobody set.
   */
  | { type: 'setTaskExpertLimits'; maxSpendUsd?: number; maxConsultations?: number }
  /** Runs the probes through the junior, then asks the expert to grade them. Costs money. */
  | { type: 'assessJunior' }
  | { type: 'measureExpertCost' }
  | { type: 'setExpertKeepAlive'; enabled: boolean }
  | { type: 'clearExpertPricing' }
  | { type: 'clearAssessment' }
  | { type: 'restartScheduler' }
  /** Clears a schedule's remembered runs. Omit `id` to clear every schedule's. */
  | { type: 'clearScheduleRuns'; id?: string }
  /** Removes one remembered run, identified by when it started. */
  | { type: 'deleteScheduleRun'; id: string; at: number }
  /** Opens a past run's transcript in an editor tab rather than the sidebar. */
  | { type: 'openScheduleRun'; taskId: string; title: string }
  /** The user removing one directly. The model's own delete goes through the approval gate. */
  | { type: 'deleteSkillFile'; name: string }
  /** Opens a skill or Python tool file in an editor tab, where it can actually be edited. */
  | { type: 'openManagedFile'; path: string }
  | { type: 'deletePythonTool'; name: string }
  /**
   * Re-pins a hand-edited tool to its current contents.
   *
   * Editing a `.py` outside the model's own update tool leaves it refused on a hash mismatch —
   * which is the pin working as designed (§13). Without a way to say "yes, that was me", the
   * only route back is asking the model to rewrite a file the user has already fixed.
   */
  | { type: 'approvePythonTool'; name: string }
  /** Replaces the whole skills folder configuration. Empty `dir` restores the default. */
  | { type: 'saveSkillDirs'; dir: string; paths: string[] }
  | { type: 'requestPython' }
  | {
      type: 'setPython'
      dynamicTools: 'off' | 'on'
      uvPath?: string
      /** Where tools live. Empty restores `.lightcode/tools` in the workspace. */
      toolsDir?: string
      /**
       * The environment to run tools in. Empty restores automatic selection.
       *
       * Accepts a venv directory or an interpreter path — a user who knows which Python they
       * want usually has the `python.exe` to hand, not the folder two levels above it.
       */
      venvPath?: string
      timeoutSeconds?: number
      indexUrl?: string
      offline?: boolean
    }
  | { type: 'requestNetwork' }
  | { type: 'saveNetwork'; settings: NetworkSettingsInput }
  | { type: 'requestExpert' }
  | {
      type: 'setExpert'
      enabled: boolean
      path?: string
      model?: string
      maxSpendUsd?: number
      maxConsultations?: number
    }
  | { type: 'saveProfile'; profile: ProfileInput }
  | { type: 'duplicateProfile'; id: string }
  /** Copies a server entry under a new name. Secrets stay as references — see the bridge. */
  | { type: 'duplicateMcpServer'; name: string }
  | { type: 'duplicateSchedule'; id: string }
  | { type: 'deleteProfile'; id: string }
  | { type: 'setActiveProfile'; id: string; forProject?: boolean }
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
  /** A form the assistant is waiting on. Rendered in the transcript, like an approval. */
  | {
      type: 'formRequest'
      id: string
      title: string
      description?: string
      fields: FormField[]
    }
  | {
      type: 'approvalRequest'
      id: string
      toolName: string
      group: ToolGroup
      preview: ToolPreview
      alwaysScope?: 'folder'
    }
  /** A rollback point now exists; the UI can offer to undo back to it. */
  /**
   * Opens Settings on a named tab.
   *
   * Exists for the walkthrough: telling someone a setting is "in the MCP tab" is weaker
   * than putting them in it, and a guide that only describes navigation is the thing they
   * have to translate rather than follow.
   */
  | { type: 'openSettings'; tab: string }
  /**
   * Which door this session came through. **Sent only by the Node host**, never by the bridge.
   *
   * The shape lives here because this is where the UI's protocol is defined, but core stays
   * ignorant of roles deliberately: a second user is a concept only one host has, and teaching
   * the bridge about it would put it in the extension too, where it means nothing.
   */
  | {
      type: 'hostRole'
      role: 'admin' | 'user'
      shared: boolean
      displayName: string
      /**
       * Profiles the administrator provides, which this session may use but not change.
       *
       * Sent as ids rather than a flag on the profile itself: "not yours" is a fact about the
       * session, not about the profile, and the same profile is editable in the administrator's
       * own view. Without this the panel offers Edit on something whose edit is silently
       * discarded on save.
       */
      sharedProfileIds: string[]
    }
  /**
   * Both scopes, and the resolution between them.
   *
   * `resolved` is what a command will actually see: `scope` names the winner and
   * `overriddenUserValue` carries the loser, so the panel can show a user their own value beside
   * the administrator's that displaced it rather than pretending it does not exist.
   *
   * Sent only by the Node host. Its absence is what tells the UI not to offer the tab.
   */
  | {
      type: 'reviews'
      items: {
        id: string
        kind: 'python-tool' | 'skill'
        name: string
        content: string
        existingContent: string
        authorName: string
        submittedAt: number
        status: 'pending' | 'approved' | 'rejected'
        producedBy?: string
        decidedBy?: string
        reason?: string
      }[]
      /** False for an author looking at their own submissions. */
      canDecide: boolean
    }
  | {
      type: 'variables'
      user: SessionVariable[]
      admin: SessionVariable[]
      resolved: ResolvedVariable[]
      adminIds: string[]
      /** False when the administrator's half is read-only for this session. */
      canEditAdmin: boolean
    }
  | { type: 'checkpointAvailable' }
  | { type: 'rolledBack' }
  /** Current mode plus this workspace's approval settings, for the Approvals/Modes UI. */
  | {
      type: 'settings'
      modeId: string
      approvals: WorkspaceApprovals
      maxIterations: number
      accentColor: string
      expertColor: string
      /** Folders tools may read beyond the workspace. Reading only — writes stay confined. */
      readRoots: string[]
      /**
       * Which profile writes Python tool source, or absent when the chat model does.
       *
       * Reported with the rest of settings rather than with the profile list, because it is a
       * setting that happens to name a profile — the same shape as `activeProfileId`.
       */
      programmingProfileId?: string
      /** True where a different model may be nominated to write Python tool source. */
      allowProgrammingProfile: boolean
      /**
       * True when the host has onboarding of its own — VS Code's Get Started page.
       *
       * The UI needs this to decide what its guide button does, and asking the host is the only
       * honest way: `HostUi.openWalkthrough` is optional (§19), so a UI that always posted
       * `openWalkthrough` would render a button that silently does nothing everywhere it is not
       * implemented. That is exactly what shipped in 0.31.0 for the browser.
       */
      nativeGuide: boolean
      /**
       * Where the in-app guide's diagrams are served from, without a trailing slash.
       *
       * Absent means there are none, and the guide renders as text rather than as fourteen
       * broken images.
       */
      guideMediaBase?: string
    }
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
  /**
   * What the expert has cost since the current task was opened.
   *
   * `unpriced` counts consultations the CLI reported no cost for. Kept separate rather than
   * folded in as zero, so a total is never quietly incomplete while looking exact.
   */
  | {
      type: 'expertSpend'
      usd: number
      consultations: number
      unpriced: number
      /** Keep-alive pings so far. Their cost is in the total; they are not consultations. */
      keepAlives: number
      /** 0..1 against the nearer of the two per-task limits; absent when neither is set. */
      usage?: number
      /** True once the expert has stopped being available for this task. */
      exhausted?: boolean
      /** The limits in force right now, whether from Settings or a per-chat override. */
      maxSpendUsd: number
      maxConsultations: number
      /** True when this chat is overriding the configured default. */
      overridden: boolean
      /**
       * The expert's own guess at the whole task, offered with its plan.
       *
       * A guess by a model about its own future behaviour, so the UI labels it as estimated
       * and never as a quote — the spend beside it is the number that is true.
       */
      estimate?: { consultations?: number; usd?: number }
    }
  /** Every search the model ran this session, newest first. */
  | { type: 'searchLog'; entries: SearchLogEntry[] }
  /** Schedules plus every tool that currently exists, so the picker can list them all. */
  | {
      type: 'tools'
      /**
       * Whether this host can reach Excel and Outlook, and whether the user has said yes.
       *
       * `supported` is the platform answer: on anything but Windows the toggles are shown
       * disabled with the reason, rather than offered and then failing.
       */
      office: { supported: boolean; excel: boolean; outlook: boolean }
      tools: ToolCatalogueEntry[]
      /** True when the dispatcher is on, so the view can explain why some are hidden. */
      dispatcher: boolean
    }
  | {
      type: 'schedules'
      schedules: Schedule[]
      tools: ScheduleToolInfo[]
      /** Every skill, so a schedule can name the ones it needs rather than searching. */
      skills: { name: string; description: string }[]
      runningId?: string
      /**
       * Whether the timer is ticking, and when it last did.
       *
       * Shown because the failure being diagnosed here was invisible: schedules sat in the
       * list looking armed while nothing was checking them. A last-checked time is the one
       * piece of evidence that distinguishes "not due yet" from "not running".
       */
      scheduler: { running: boolean; lastTickAt?: number }
    }
  /** Result of a hand-run query. `text` is what the model would have been given. */
  | { type: 'searchProbe'; query: string; text: string; error?: string }
  /** Result of indexing the tool and skill documentation corpus. */
  | { type: 'docsIndexed'; indexed?: number; index?: string; error?: string; kind?: 'tool' | 'skill' }
  /**
   * What this project has chosen for itself, so the UI can show and clear it.
   *
   * Shown because a value that quietly differs here from everywhere else, with nothing saying
   * so, is worse than not being able to set one: the user is left wondering why the same product
   * behaves differently in two folders.
   */
  | { type: 'projectSettings'; workspaceOpen: boolean; overridden: string[] }
  /** Progress and outcome of copying one store into another. */
  | { type: 'storeSync'; running: boolean; copied?: number; error?: string; fromLabel?: string }
  /** Whether tool schemas are being kept out of the prompt, and how many are hidden. */
  | {
      type: 'dispatcher'
      enabled: boolean
      hiddenTools: number
      /** Skill summaries are retrieved rather than listed. */
      skills: boolean
      /** How many skills that affects, so the panel can say what it is trading. */
      hiddenSkills: number
      docsIndex?: string
    }
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
  | {
      type: 'python'
      /** Resolved reality: which interpreter is in use, which tools loaded, what was refused. */
      status: PythonStatus
      /**
       * What is actually saved in config, as opposed to what was resolved from it.
       *
       * Sent because the tab had no other source for its own fields and rendered them empty on
       * every mount — so a saved setting looked lost, and re-saving from empty fields would
       * have quietly cleared it. `status` cannot serve here: it reports the interpreter that
       * *won*, which is usually not the one that was typed, and is a placeholder rather than a
       * value.
       */
      settings: PythonSettings
    }
  | {
      type: 'skills'
      /**
        * `sourceDir` says which configured folder it came from — only the first is writable.
        * `always` marks a standing instruction: included in every session, in full, so the tab
        * can say so. A cost paid on every request should never be invisible.
        */
      skills: { name: string; description: string; filePath: string; sourceDir?: string; always?: boolean }[]
      /** Files that could not be offered, and why. Shown, not just logged. */
      issues: { filePath: string; detail: string }[]
      /** Where skills are written. Undefined when no folder is open, so the tab can say why. */
      skillsDir?: string
      /** Additional read-only folders, in precedence order after `skillsDir`. */
      extraDirs: string[]
    }
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
      /** The configured prefix, absent when the default is in use. */
      indexPrefix?: string
      /** What the prefix falls back to, so the field can show it as a placeholder. */
      defaultIndexPrefix: string
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
      /** Per-task ceilings. 0 means no limit. */
      maxSpendUsd: number
      maxConsultations: number
      /**
       * Whether this plan reports a per-consultation cost, once a consultation has said so.
       *
       * Undefined until then. A spend cap cannot bind on a plan that reports no cost, and a cap
       * that silently never fires is worse than no cap because it is believed.
       */
      reportsCost?: boolean
      /** What a consultation costs here, once measured. */
      pricing?: ExpertPricing
      /** Set while the measurement is running, so the button can say what it is doing. */
      measuringStep?: string
      /** Whether the cache is refreshed while a task is open. */
      keepAlive: boolean
      /** The expert's judgement of the junior, when one has been made. */
      assessment?: JuniorAssessment
      /** True while probes are running, so the tab can show progress rather than nothing. */
      assessing?: boolean
      /** How far through the probes, for the same reason. */
      assessmentStep?: string
      /**
       * What Junior mode has cost and avoided, over three windows.
       *
       * Absent only if the log could not be read. `avoidedUsd` inside it may be undefined,
       * which means unmeasured — the panel must say so rather than showing zero.
       */
      savings?: ExpertSavings
    }
  /**
   * Replaces the whole transcript — sent when a task is reopened, and on panel load to
   * restore the task that was in progress. `entries` is empty for a new task.
   */
  | { type: 'taskRestored'; taskId: string | undefined; entries: TranscriptEntry[] }
