export const CORE_VERSION = '0.0.0'

export type { FileSystem, FileStat, DirEntry } from './platform/filesystem.js'
export type { Terminal, TerminalProcess, TerminalRunOptions } from './platform/terminal.js'
export type { SecretStore } from './platform/secrets.js'
export type { ConfigStore, ConfigScope } from './platform/config.js'
export type { Transport } from './platform/transport.js'
export type { HttpClient, HttpRequestOptions, HttpResponse } from './platform/http.js'
export { FetchHttpClient, type FetchHttpClientOptions } from './platform/http.js'
export {
  bypassesProxy,
  describeProxyEnvironment,
  proxyForUrl,
  type ProxyChoice,
} from './platform/proxy.js'
export {
  resolveConnectionTls,
  TlsConfigError,
  type TlsFileSettings,
  type ResolveTlsOptions,
} from './platform/connectionTls.js'

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
export {
  PRICING_PROBE,
  describePricing,
  pricingForPrompt,
  type ExpertPricing,
} from './expert/pricing.js'
export {
  summariseSavings,
  pruneEvents,
  startOfLocalDay,
  type ExpertEvent,
  type ExpertSavings,
  type SavingsWindow,
} from './expert/savings.js'
export {
  DEFAULT_MENTION_EXCLUDES,
  mentionExcludeGlob,
  mentionExcludes,
} from './context/mentionExcludes.js'
export { compareMentionCandidates, matchesMentionQuery } from './context/mentionRanking.js'
export {
  GUIDE_STEPS,
  GUIDE_TITLE,
  GUIDE_DESCRIPTION,
  type GuideStep,
  type GuideTab,
} from './guide/steps.js'
export { mergeScopes, USER_SCOPE_ONLY_KEYS, type ScopeMergeResult } from './config/scopes.js'
export {
  applyWorkspaceOverrides,
  describeOverrides,
  overridesFor,
  workspaceOverrideKey,
  OVERRIDABLE_KEYS,
  type OverridableKey,
  type WorkspaceOverrides,
} from './config/workspaceOverrides.js'
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
export {
  resolveActiveProfile,
  NoActiveProfileError,
  ProfileNotFoundError,
} from './providers/registry.js'
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
export {
  buildCaBundle,
  buildConnectOptions,
  readNodeExtraCaCerts,
  type ConnectOptions,
} from './platform/tls.js'
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
export {
  toOpenAITools,
  toAnthropicTools,
  toGeminiTools,
  normalizeObjectSchema,
} from './providers/schema.js'
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
export {
  dropEvictedDocs,
  EVICTED_MARKER,
  FORGET_DOCS_TOOL,
  type EvictionResult,
} from './context/evict.js'
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
export { createAskAgentTool, type AskAgentParams } from './tools/askAgent.js'
export {
  AGENT_ROLES,
  allRoles,
  buildAgentPrompt,
  defaultPromptFor,
  isAgentRole,
  roleInfo,
  type AgentRole,
  type AgentRoleInfo,
} from './agents/roles.js'
export {
  availableAgents,
  budgetMatters,
  resolveTeam,
  type AgentAssignment,
  type AgentTeamConfig,
  type ResolvedAgent,
  type TeamContext,
} from './agents/team.js'
export { DEFAULT_TEAM_GUIDANCE, buildTeamGuidance } from './agents/guidance.js'
export { buildAgentBriefing, type AgentBriefingInput } from './agents/briefing.js'
export { CONSULT_MAX_STEPS, runConsultation, toolsForConsultation } from './agents/consult.js'
export { buildPlanGuidance, PLAN_LIMIT } from './agent/plan.js'
export { createRecallExpertTool, type ExpertConsultationRecord } from './tools/recallExpert.js'
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
  allAssessments,
  assessmentFor,
  forgetAssessment,
  MAX_ASSESSMENTS,
  recordAssessment,
} from './expert/assessments.js'
export { EXPERT_GUIDANCE, SEAT_FITS, unmappedProbes, type SeatFit } from './agents/seats.js'
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
export {
  OpenSearchIndexWriter,
  OWNED_INDEX_MARKER,
  type IndexedDocument,
} from './rag/opensearch/writer.js'
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
export {
  createSearchOpensearchTool,
  type SearchOpensearchParams,
} from './tools/searchOpensearch.js'
export { createSearchCodebaseTool, type SearchCodebaseParams } from './tools/searchCodebase.js'
export {
  createSearchTeamSkillsTool,
  type SearchTeamSkillsParams,
} from './tools/searchTeamSkills.js'
export { createExcelDiagnoseTool } from './tools/office.js'
export {
  createSearchMailTool,
  createMailPatternsTool,
  createOpenEmailTool,
  createMailCoverageTool,
  createMailStatsTool,
  type MailToolOptions,
} from './tools/mail.js'
export {
  findNearAnniversaries,
  findRecurrence,
  normaliseSubject,
  parseStatusTag,
  pruneOlderThan,
  since as mailSince,
  type MailRecord,
  type MailStatus,
} from './office/mailIndex.js'
export { MailStore } from './office/mailStore.js'
export {
  createScheduleFromChatTool,
  scheduleFormFields,
  triggerFromAnswers,
  type ScheduleProposal,
} from './tools/scheduleFromChat.js'
export { storeIdFor, type CorpusPurpose, type MailIndexConfig } from './config/schema.js'
export {
  syncMail,
  refreshMail,
  pruneMail,
  type MailSyncResult,
  type HarvestedMessage,
} from './office/mailSync.js'
export {
  describeTeamSkillCollision,
  findTeamSkillsNamed,
  indexTeamSkills,
  renderTeamSkillHits,
  searchTeamSkills,
  teamSkillDocument,
  teamSkillId,
  teamSkillText,
  type TeamSkillHit,
  type TeamSkillsOptions,
} from './rag/teamSkills.js'
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
  scheduleAppliesHere,
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
export {
  readTail,
  readLineWindow,
  countLines,
  formatBytes,
  SMALL_FILE_BYTES,
  type FilePart,
} from './tools/largeFile.js'
export {
  SearchLog,
  type SearchLogEntry,
  type SearchLogSource,
  type SearchObserver,
} from './rag/searchLog.js'
export {
  chunkFile,
  looksLikeText,
  DEFAULT_CHUNK_OPTIONS,
  type Chunk,
  type ChunkOptions,
} from './rag/chunk.js'
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
export {
  riskyCommandRules,
  matchRiskyCommand,
  describeRiskyMatch,
  DEFAULT_RISKY_COMMANDS,
  type RiskyCommandRule,
  type RiskyCommandMatch,
} from './approval/riskyCommands.js'
export {
  isSafeCommand,
  couldChain,
  normaliseProgram,
  DEFAULT_SAFE_COMMANDS,
  type SafeCommandOptions,
} from './approval/safeCommands.js'
export { ShadowGit, type Checkpoint } from './checkpoints/shadowGit.js'
/*
 * The plan's steps. Deliberately does NOT re-export its `Checkpoint` type: `Checkpoint` already
 * means a shadow-git snapshot here, and two unrelated things sharing a name in one barrel is how
 * an import ends up silently referring to the wrong one.
 */
export {
  parseCheckpoints,
  checkpointViews,
  pruneProgress,
  markCheckpoint,
  attributeConsultation,
  progressSummary,
  MAX_CHECKPOINTS,
  type PlanProgress,
  type CheckpointProgress,
  type CheckpointStatus,
  type CheckpointView,
} from './agent/checkpoints.js'
export { createUpdatePlanTool, createPlanProgressTool, type PlanAccess } from './tools/planTools.js'

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
  detectBareInterpreter,
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
  renderAlwaysSkills,
  renderSkillsHintForPrompt,
  parseFrontmatter,
  renderSkill,
  isValidSkillName,
  skillFileName,
  type Skill,
  type LoadedSkills,
} from './skills/index.js'
export {
  createWriteSkillTool,
  createDeleteSkillTool,
  createUseSkillFileTool,
  type SkillToolContext,
} from './skills/tools.js'
export {
  SHARE_SECTIONS,
  NEVER_SHARED,
  describeSections,
  defaultSelection,
  buildExport,
  applyImport,
  type ShareSection,
  type ShareSectionId,
  type SectionSummary,
} from './config/share.js'
export {
  listSkillFiles,
  skillFilesDir,
  renderSkillFiles,
  appendSkillFiles,
  skillFileAssetName,
  SKILL_FILE_DIR,
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_BYTES,
  type SkillFileInput,
  type StoredSkillFile,
} from './skills/files.js'

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

export {
  AGENT_TEAM_MODE,
  BUILTIN_MODES,
  CODE_MODE,
  ASK_MODE,
  DEFAULT_MODE_ID,
  findMode,
} from './modes/builtin.js'
export { toolsForMode } from './modes/resolve.js'
export {
  createCallToolTool,
  callToolParamsSchema,
  CALL_TOOL_NAME,
  type CallToolParams,
} from './tools/callTool.js'
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
  IndexingKind,
  ProbeTarget,
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
export {
  toTranscript,
  formatToolArguments,
  toolCallReason,
  CONTROL_TOOLS,
  chartFromToolCall,
  diagramFromToolCall,
  consultationFromToolCall,
  toolCallSummary,
} from './history/transcript.js'
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
  createAskUserFormTool,
  coerceFormValue,
  formFieldSchema,
  attemptCompletionTool,
  type Tool,
  type ToolGroup,
  type ToolPreview,
  type ToolResult,
  type ToolExecutionContext,
} from './tools/index.js'

export { createShowChartTool } from './tools/showChart.js'
export { createShowDiagramTool } from './tools/showDiagram.js'
export { layoutDiagram, type DiagramLayout, type PlacedNode } from './diagrams/layout.js'
export { diagramSvg, diagramDataUri, DEFAULT_PALETTE, type DiagramPalette } from './diagrams/svg.js'
export {
  diagramSpecSchema,
  DIAGRAM_MAX_NODES,
  DIAGRAM_MAX_EDGES,
  NODE_ICONS,
  NODE_SHAPES,
  NODE_TONES,
  type DiagramSpec,
} from './diagrams/types.js'
export {
  chartSpecSchema,
  chartTotals,
  CHART_TYPES,
  type ChartSpec,
  type ChartSeries,
  type ChartType,
} from './charts/types.js'
export {
  countBy,
  crossTab,
  numberOverTime,
  dailyChange,
  extractNumber,
} from './office/mailStats.js'
export {
  resolveSecretRef,
  describeSecretRef,
  describeMissingSecret,
  ENV_REF_PREFIX,
} from './providers/auth/secretRef.js'
export {
  TokenCommandAuthStrategy,
  type TokenCommandSettings,
} from './providers/auth/tokenCommand.js'
export { DatasetStore, partitionByAge } from './dataset/store.js'
export { syncDataset, clearDataset, datasetEmbedText, datasetVectorId } from './dataset/sync.js'
export {
  datasetConfigSchema,
  datasetRecordSchema,
  parseDatasetPayload,
  COLLECTOR_TOOL_GUIDANCE,
  type DatasetConfig,
  type DatasetRecord,
} from './dataset/types.js'
export { createSearchDataTool } from './tools/searchData.js'
export { mayPythonToolCall, describeNestedCall, PYTHON_CALL_DENIED } from './python/callPolicy.js'
export { checkCollector, type CollectorCheck } from './dataset/checkCollector.js'
export { createCheckCollectorTool } from './tools/checkCollectorTool.js'

/*
 * S3: a bucket as a place to read from, write to, and keep skills and Python tools in.
 *
 * Signed here rather than through a vendor SDK so every request goes out through the one
 * `HttpClient` — invariant 2, and the same trade the three vector-store clients make.
 */
export { S3Client, parseListing, type S3Connection, type S3Object } from './s3/client.js'
export { confineKey, displayKey, normalisePrefix } from './s3/keys.js'
export { resolveS3, targetById, type ResolvedS3 } from './s3/resolve.js'
export { syncFromS3, uploadToS3, type S3SyncResult } from './s3/sync.js'
export { createS3Tools, type S3Target } from './s3/tools.js'
export { mirrorFolder, type MirrorKind } from './s3/localFolder.js'
export {
  skillKeysInBucket,
  removeSkillFromBucket,
  belongsToSkill,
  type RemoveSkillResult,
} from './s3/remove.js'
