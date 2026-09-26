/**
 * The browser/webview-safe subset of core's public API. packages/ui MUST import from
 * this entry point, never the main one — the main entry's barrel pulls in Node-only
 * modules (`node:fs`, `node:path`, ...) transitively, which breaks esbuild's browser
 * bundle for the webview even when those specific exports go unused, since bundler
 * tree-shaking through a multi-layer barrel isn't reliable enough to depend on.
 * Nothing exported here may import from `node:*` or any platform implementation.
 */
export type { Transport } from './platform/transport.js'

export type { WireFormat, Auth, ProviderProfile } from './providers/types.js'
export type { ToolGroup, ToolPreview } from './tools/types.js'
// Type-only, so nothing from the tool's implementation reaches the webview bundle. The UI
// needs the field shape to render a form and nothing else.
export type { FormField } from './tools/askUserForm.js'
export type { ApprovalDecision } from './approval/types.js'
export type { AutoApproveSettings, WorkspaceApprovals, ApprovableGroup } from './approval/policy.js'
export type { Mode } from './modes/types.js'
/* The progress panel renders these; the plan itself never crosses as anything but its text. */
export type { CheckpointView, CheckpointStatus } from './agent/checkpoints.js'
/* A value, not a type: the Agents tab states the cap before a save can fail on it. */
export { CUSTOM_ROLE_LIMIT } from './agents/roles.js'
export { BUILTIN_MODES, CODE_MODE, ASK_MODE, DEFAULT_MODE_ID, findMode } from './modes/builtin.js'
export type {
  McpServerConfig,
  McpServerState,
  McpServerStatus,
  McpServersConfig,
  McpToolState,
  McpToolPermission,
} from './mcp/types.js'
// Value exports, so they must be browser-safe: forms.ts is pure string manipulation with
// no node imports. See the Phase 2b note about what may cross into packages/ui.
export {
  BLANK_MCP_FORM,
  fromMcpServerForm,
  toMcpServerForm,
  validateMcpServerForm,
  venvPython,
  venvPythonCandidates,
  VENV_DIR_NAMES,
  type McpPlatform,
  type McpServerForm,
  type McpServerKind,
} from './mcp/forms.js'
export { providerPresets, type ProviderPreset } from './providers/presets.js'
/* Pure formatting over a measured figure, so it is safe in the browser bundle. */
export { describePricing, type ExpertPricing } from './expert/pricing.js'
export type { ExpertSavings, SavingsWindow } from './expert/savings.js'
/*
 * The guided tour's content. Pure strings, which is what makes it safe here — and the reason it
 * lives in core at all is that two hosts render it: VS Code as `contributes.walkthroughs`, the
 * browser as a view of its own. Two copies of onboarding prose is two copies that go stale.
 */
// Pure data and a pure merge, so it is safe in the browser bundle. The UI needs the same
// precedence rule the server applies, or it would show a value that is not the one in force.
export {
  resolveSessionVariables,
  isValidVariableName,
  type SessionVariable,
  type ResolvedVariable,
  type VariableScope,
} from './session/variables.js'
export {
  GUIDE_STEPS,
  GUIDE_TITLE,
  GUIDE_DESCRIPTION,
  type GuideStep,
  type GuideTab,
} from './guide/steps.js'

export { validateProviderForm, type FieldError } from './config/validate.js'

/**
 * Pure lookup over a static table — no `node:*`, so the webview can show a model's context
 * window as it is typed without a round trip to the host.
 */
export {
  lookupModelCapabilities,
  resolveModelCapabilities,
  type ModelCapabilities,
} from './providers/models.js'

export type {
  UiToHostMessage,
  HostToUiMessage,
  IndexingKind,
  ProbeTarget,
  TokenCommandInput,
  ProfileSummary,
  ProfileInput,
  ToolCallSummary,
  ApigeeSummary,
  CertSummary,
  ModelCapabilityInput,
  ConnectionTlsInput,
  NetworkSettingsInput,
  NetworkSettingsSummary,
  TestConnectionStep,
  PythonSettings,
  PythonEnvVariable,
  AgentRoleState,
  SearchConnectionSummary,
  ToolCatalogueEntry,
  SearchConnectionInput,
  SearchQueryLimits,
  TranscriptEntry,
  TaskListEntry,
  ContextUsage,
  ImageAttachmentInput,
  ConfluenceSettingsView,
} from './agent/protocol.js'

/** Type-only: the UI needs the backend names for its picker, not the schema that validates them. */
export type { CommandRules, VectorStoreKind } from './config/schema.js'
/*
 * The built-in command rules, so the panel can *show* them.
 *
 * Values rather than types, which is a deliberate addition to this file (see its header): the
 * alternative is the UI carrying its own copy of both lists, and one fact in two places is the
 * defect this repository has paid for more than any other. Somebody deciding what to add needs to
 * see what is already covered, and a summary sentence is not that.
 */
export { DEFAULT_SAFE_COMMANDS } from './approval/safeCommands.js'
export { DEFAULT_RISKY_COMMANDS, type RiskyCommandRule } from './approval/riskyCommands.js'
export type { JuniorAssessment, ProbeResult } from './expert/assessment.js'
/*
 * The diagram feature, browser side: the spec type, the layout and the serialiser.
 *
 * Value exports, so they go through this file deliberately rather than by accident — importing
 * them from the bare package would pull core's barrel and with it `node:fs`.
 */
export { layoutDiagram, type DiagramLayout } from './diagrams/layout.js'
export { diagramSvg, diagramDataUri, DEFAULT_PALETTE, type DiagramPalette } from './diagrams/svg.js'
export { diagramSpecSchema, type DiagramSpec } from './diagrams/types.js'

// Type-only, so nothing from indexer.ts (which imports node:fs) reaches the bundle.
export type { IndexProgress, IndexResult } from './rag/indexer.js'
// Type-only: SearchLog itself is host state, but the entries cross the bridge.
export type { SearchLogEntry, SearchLogSource } from './rag/searchLog.js'
/*
 * Schedules. `timing.ts` and the `riskyGroupsIn` helper are pure date and array work with no
 * platform dependency, so the settings tab can compute "next run" and the risk warning
 * itself rather than round-tripping to the host for a countdown that ticks every 30 seconds.
 */
export type { Schedule, ScheduleTrigger, Schedules, ScheduleRun } from './schedule/types.js'
export { riskyGroupsIn } from './schedule/types.js'
export { describeTrigger, describeNextRun, nextFireTime, isDue } from './schedule/timing.js'
export type { ScheduleToolInfo } from './agent/protocol.js'
export type { PythonStatus } from './python/manager.js'

export {
  chartTotals,
  CHART_TYPES,
  type ChartSpec,
  type ChartSeries,
  type ChartType,
} from './charts/types.js'
export type { DatasetConfig, DatasetRecord } from './dataset/types.js'

/*
 * Alias text helpers.
 *
 * Deliberately through here rather than from the bare package: `packages/ui` importing a *value*
 * from core's barrel pulls in `node:fs` and friends and breaks the webview bundle, which is what
 * this second entry point exists to prevent. `rag/aliases.ts` imports only a type, so it is safe.
 *
 * They live beside the parser that reads them back, so the panel and the search cannot disagree
 * about what "a, b" means.
 */
export {
  formatAliases,
  parseAliases,
  codebaseAliases,
  skillAliases,
  aliasProblem,
  MAX_ALIASES,
} from './rag/aliases.js'

/*
 * How large a picture is drawn. One vocabulary for charts, diagrams and whatever comes next —
 * see `display/size.ts` for why it is a word rather than a pixel count.
 */
export {
  DISPLAY_SIZES,
  DISPLAY_WIDTHS,
  DEFAULT_DISPLAY_SIZE,
  displayMaxWidth,
  type DisplaySize,
} from './display/size.js'
