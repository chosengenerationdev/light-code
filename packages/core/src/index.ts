export const CORE_VERSION = '0.0.0'

export type { FileSystem, FileStat, DirEntry } from './platform/filesystem.js'
export type { Terminal, TerminalProcess, TerminalRunOptions } from './platform/terminal.js'
export type { SecretStore } from './platform/secrets.js'
export type { ConfigStore, ConfigScope } from './platform/config.js'
export type { Transport } from './platform/transport.js'
export type { HttpClient, HttpRequestOptions, HttpResponse } from './platform/http.js'
export { FetchHttpClient } from './platform/http.js'
export { resolveConnectionTls, TlsConfigError, type TlsFileSettings, type ResolveTlsOptions } from './platform/connectionTls.js'

export type { LightCodeConfig } from './config/schema.js'
export { configSchema, parseConfig, ConfigValidationError } from './config/schema.js'
export {
  resolveSessionVariables,
  toEnvironment,
  isValidVariableName,
  sessionVariableSchema,
  sessionVariablesSchema,
  type SessionVariable,
  type ResolvedVariable,
  type VariableScope,
} from './session/variables.js'
export {
  buildCodeGenerationPrompt,
  unwrapFencedSource,
  type CodeGenerator,
  type CodeGenerationRequest,
  type CodeGenerationResult,
} from './python/codeGenerator.js'
export {
  describeSubmission,
  type ReviewRequest,
  type ReviewDecision,
  type ReviewKind,
} from './review/types.js'
export { GUIDE_STEPS, GUIDE_TITLE, GUIDE_DESCRIPTION, type GuideStep, type GuideTab } from './guide/steps.js'
export { mergeScopes, USER_SCOPE_ONLY_KEYS, type ScopeMergeResult } from './config/scopes.js'
export { defaultUserConfigPath, workspaceConfigPath } from './config/paths.js'
export { ConfigManager } from './config/manager.js'
export { validateProviderForm, type FieldError } from './config/validate.js'

export { redact } from './logging/redact.js'
export { Logger, type LogLevel, type LoggerOptions } from './logging/logger.js'

export { confine, PathConfinementError, normalizeForComparison } from './fs/confine.js'
export { normalizeWindowsPath } from './fs/windowsPath.js'
export { PathDenylist } from './fs/denylist.js'

export type {
  WireFormat,
  Auth,
  ProviderProfile,
  AuthStrategy,
  ChatMessage,
  StreamChunk,
  ChatStreamOptions,
  ChatProvider,
} from './providers/types.js'
export {
  wireFormatSchema,
  authSchema,
  providerProfileSchema,
  certConfigSchema,
  apigeeMtlsSettingsSchema,
  type CertConfigInput,
  type ApigeeMtlsSettingsInput,
} from './providers/types.js'
export { resolveActiveProfile, NoActiveProfileError, ProfileNotFoundError } from './providers/registry.js'
export { ApiKeyAuthStrategy, NoAuthStrategy } from './providers/auth/apiKey.js'
export {
  createAuthStrategy,
  createCertLoader,
  AuthConfigError,
  type AuthStrategyContext,
} from './providers/auth/factory.js'
export {
  ApigeeMtlsAuthStrategy,
  ApigeeAuthError,
  describeTlsError,
  defaultTokenUrl,
  type ApigeeMtlsSettings,
} from './providers/auth/apigeeMtls.js'
export { buildCaBundle, buildConnectOptions, readNodeExtraCaCerts, type ConnectOptions } from './platform/tls.js'
export {
  loadCerts,
  checkExpiry,
  assertCertDirOutsideWorkspace,
  CertError,
  type CertConfig,
  type LoadedCerts,
  type ExpiryWarning,
} from './providers/auth/certs.js'
export {
  listModels,
  lookupModelCapabilities,
  resolveModelCapabilities,
  type ModelCapabilities,
  type ModelCapabilityOverrides,
  type ListModelsResult,
} from './providers/models.js'
export {
  testConnection,
  type TestConnectionResult,
  type TestStepResult,
  type TestStepName,
} from './providers/testConnection.js'
export { OpenAIProvider } from './providers/openai.js'
export { AnthropicProvider, toAnthropicMessages } from './providers/anthropic.js'
export { GeminiProvider, toGeminiContents } from './providers/gemini.js'
export { createChatProvider } from './providers/factory.js'
export { toOpenAITools, toAnthropicTools, toGeminiTools, normalizeObjectSchema } from './providers/schema.js'
export { providerPresets, type ProviderPreset } from './providers/presets.js'

export {
  estimateTokens,
  computeBreakdown,
  computeCacheStats,
  applyReportedUsage,
  type TokenBreakdown,
  type CacheStats,
  type ReportedUsage,
} from './context/budget.js'
export { dropSupersededReads, type SupersedeResult } from './context/supersede.js'
export { dropEvictedDocs, EVICTED_MARKER, FORGET_DOCS_TOOL, type EvictionResult } from './context/evict.js'
export { createForgetDocsTool, type ForgetDocsParams } from './tools/forgetDocs.js'
export {
  parseMentions,
  resolveMentions,
  attachMentions,
  type ResolvedMention,
  type MentionContext,
} from './context/mentions.js'
export {
  compactHistory,
  shouldCompact,
  findSafeBoundary,
  buildSummaryPrompt,
  isSummaryMessage,
  type CompactionOptions,
  type CompactionResult,
} from './context/compact.js'

export { Conversation } from './agent/messages.js'
export { buildSystemPrompt, type SystemPromptOptions } from './agent/systemPrompt.js'
export {
  detectClaudeCli,
  consultExpert,
  type ClaudeCliInfo,
  type ExpertAnswer,
} from './expert/claudeCli.js'
export { createAskExpertTool, type AskExpertParams } from './tools/askExpert.js'
export { buildExpertBriefing, type BriefingInput } from './expert/briefing.js'
export { extractEstimate, ESTIMATE_INSTRUCTION, type ExpertEstimate } from './expert/estimate.js'
export {
  ASSESSMENT_PROBES,
  assessmentForBriefing,
  buildAssessmentQuestion,
  type JuniorAssessment,
  type ProbeResult,
} from './expert/assessment.js'
export {
  checkExpertBudget,
  describeExpertBudget,
  expertBudgetUsage,
  type ExpertLimits,
  type ExpertSpend,
} from './expert/budget.js'
export {
  OpenSearchClient,
  OpenSearchError,
  isSafeIndexName,
  type OpenSearchConnection,
  type IndexInfo,
  type SearchHit,
  type SearchResult,
} from './rag/opensearch/client.js'
export {
  buildSearchQuery,
  selectQueryFields,
  summariseHit,
  checkIndexBreadth,
  resolveQueryLimits,
  DEFAULT_QUERY_LIMITS,
  type QueryLimits,
} from './rag/opensearch/query.js'
export { OpenSearchIndexWriter, OWNED_INDEX_MARKER, type IndexedDocument } from './rag/opensearch/writer.js'
export {
  VectorStoreError,
  type VectorDocument,
  type VectorMatch,
  type VectorSearcher,
  type VectorSearchOptions,
  type VectorIndexWriter,
  type VectorStoreConnection,
} from './rag/vectorStore.js'
export { createVectorSearcher, createVectorIndexWriter } from './rag/vectorStoreFactory.js'
export { syncVectorStores, describeSyncMismatch, type SyncResult } from './rag/syncStores.js'
export { Embedder, EmbedderError, type EmbedderConfig } from './rag/embedder.js'
export { createSearchOpensearchTool, type SearchOpensearchParams } from './tools/searchOpensearch.js'
export { createSearchCodebaseTool, type SearchCodebaseParams } from './tools/searchCodebase.js'
export {
  scheduleSchema,
  schedulesSchema,
  scheduleTriggerSchema,
  riskyGroupsIn,
  skillsForSchedule,
  ALWAYS_AVAILABLE_TO_SCHEDULES,
  MAX_REMEMBERED_RUNS,
  type ScheduleRun,
  type Schedule,
  type Schedules,
  type ScheduleTrigger,
} from './schedule/types.js'
export { nextFireTime, isDue, describeTrigger, describeNextRun } from './schedule/timing.js'
export {
  filterToolsForSchedule,
  NEVER_AVAILABLE_TO_SCHEDULES,
  registryForSchedule,
  ScheduledApprovalGate,
  scheduledRunGuidance,
} from './schedule/runner.js'
export { createNotifyTool, type NotifyParams, type NotifyOptions } from './tools/notify.js'
export {
  extractDocument,
  extractDocx,
  extractXlsx,
  extractHtml,
  documentKindFor,
  decodeEntities,
  DocumentError,
  type ExtractedDocument,
  type DocumentKind,
} from './documents/extract.js'
export { ZipArchive, ZipError } from './documents/zip.js'
export { readTail, readLineWindow, countLines, formatBytes, SMALL_FILE_BYTES, type FilePart } from './tools/largeFile.js'
export { SearchLog, type SearchLogEntry, type SearchLogSource, type SearchObserver } from './rag/searchLog.js'
export { chunkFile, looksLikeText, DEFAULT_CHUNK_OPTIONS, type Chunk, type ChunkOptions } from './rag/chunk.js'
export {
  indexWorkspace,
  chunkSignatureFor,
  IndexingCancelledError,
  type IndexManifest,
  type IndexProgress,
  type IndexResult,
  type IndexerOptions,
} from './rag/indexer.js'
export {
  vectorStoreSchema,
  embedderConfigSchema,
  retrievalConfigSchema,
  dispatcherEnabled,
  skillRetrievalEnabled,
  skillsConfigSchema,
  vectorStoreTls,
  type VectorStoreConfig,
  type RetrievalConfig,
  type SkillsConfig,
} from './config/schema.js'

export {
  AlwaysApproveGate,
  requiresApproval,
  type ApprovalGate,
  type ApprovalRequest,
  type ApprovalDecision,
} from './approval/types.js'
export {
  PolicyApprovalGate,
  decideFromPolicy,
  isApprovableGroup,
  type ApprovableGroup,
  type AutoApproveSettings,
  type WorkspaceApprovals,
} from './approval/policy.js'
export { isCommandAllowlisted, addToAllowlist, removeFromAllowlist } from './approval/commands.js'
export { ShadowGit, type Checkpoint } from './checkpoints/shadowGit.js'

export { McpRegistry, type McpRegistryEvents } from './mcp/registry.js'
export { McpConnection, interpolateSecrets } from './mcp/client.js'
export {
  isStdioServer,
  isPackageRunnerCommand,
  namespacedToolName,
  parseNamespacedToolName,
  mcpServersSchema,
  type McpServerConfig,
  type McpServersConfig,
  type McpServerState,
  type McpServerStatus,
  type McpToolState,
  type McpToolPermission,
  type StdioServerConfig,
  type HttpServerConfig,
} from './mcp/types.js'
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

export {
  detectUv,
  ensureVenv,
  minimalPythonEnv,
  venvPythonPath,
  UvError,
  type UvInfo,
} from './python/uv.js'
export {
  PythonWorker,
  PythonWorkerError,
  type WorkerToolDescription,
  type WorkerCallResult,
  type PythonWorkerOptions,
} from './python/worker.js'
export {
  loadSkills,
  renderSkillsForPrompt,
  renderSkillsHintForPrompt,
  parseFrontmatter,
  renderSkill,
  isValidSkillName,
  skillFileName,
  type Skill,
  type LoadedSkills,
} from './skills/index.js'
export { createWriteSkillTool, createDeleteSkillTool, type SkillToolContext } from './skills/tools.js'

export { PythonManager, type PythonStatus, type PythonManagerOptions } from './python/manager.js'
export {
  createCreatePythonTool,
  createUpdatePythonTool,
  createDeletePythonTool,
  adaptPythonTool,
  type PythonToolContext,
} from './python/tools.js'
export {
  loadRegistry,
  approveTool,
  forgetTool,
  hashSource,
  isValidToolName,
  toolFileName,
  describeIssue,
  writeRegistryFile,
  REGISTRY_FILE,
  PYTHON_TOOL_PREFIX,
  type RegisteredTool,
  type RegistryFile,
  type LoadedRegistry,
  type ToolLoadIssue,
} from './python/registry.js'

export { BUILTIN_MODES, CODE_MODE, ASK_MODE, DEFAULT_MODE_ID, findMode } from './modes/builtin.js'
export { toolsForMode } from './modes/resolve.js'
export { createCallToolTool, callToolParamsSchema, CALL_TOOL_NAME, type CallToolParams } from './tools/callTool.js'
export {
  createSearchDocsTool,
  runDocsSearch,
  renderDocsMatches,
  type SearchDocsParams,
  type SearchDocsOptions,
} from './tools/searchDocs.js'
export {
  buildDocCorpus,
  docEntryId,
  parseDocEntryId,
  schemaForTool,
  toolDocText,
  skillDocText,
  toolDocEntry,
  skillDocEntry,
  type DocEntry,
  type DocEntryKind,
} from './rag/toolDocs.js'
export type { Mode } from './modes/types.js'
export { runAgentTurn, type AgentTurnEvents, type RunAgentTurnOptions } from './agent/loop.js'
export {
  DiskTruncationStore,
  RecordingTruncationStore,
  truncateToolResult,
  type TruncationStore,
  type TruncationResult,
} from './agent/truncate.js'
export type {
  UiToHostMessage,
  HostToUiMessage,
  ProfileSummary,
  ProfileInput,
  ToolCallSummary,
  TranscriptEntry,
  TaskListEntry,
  ContextUsage,
  ImageAttachmentInput,
  ConnectionTlsInput,
  NetworkSettingsInput,
  NetworkSettingsSummary,
  SearchConnectionSummary,
  ToolCatalogueEntry,
  SearchConnectionInput,
  SearchQueryLimits,
} from './agent/protocol.js'

export { wireChatBridge, type ChatBridge } from './host/bridge.js'
export type { HostServices, HostUi, OpenDialogOptions, WorkspaceState } from './host/services.js'
export { NodeFileSystem } from './platform/node/filesystem.js'
export { NodeTerminal } from './platform/node/terminal.js'
export { JsonTaskStore } from './platform/node/taskStore.js'

export { taskSummary, type Task, type TaskSummary, type TaskStore } from './history/types.js'
export { deriveTitle } from './history/titles.js'
export { toTranscript, formatToolArguments, CONTROL_TOOLS } from './history/transcript.js'
export { redactTask, redactMessage } from './history/redactTask.js'

export {
  ToolRegistry,
  createDefaultToolRegistry,
  createReadToolResultTool,
  readFileTool,
  listFilesTool,
  searchFilesTool,
  writeToFileTool,
  applyDiffTool,
  executeCommandTool,
  askFollowupQuestionTool,
  attemptCompletionTool,
  type Tool,
  type ToolGroup,
  type ToolPreview,
  type ToolResult,
  type ToolExecutionContext,
} from './tools/index.js'
