export const CORE_VERSION = '0.0.0'

export type { FileSystem, FileStat, DirEntry } from './platform/filesystem.js'
export type { Terminal, TerminalProcess, TerminalRunOptions } from './platform/terminal.js'
export type { SecretStore } from './platform/secrets.js'
export type { ConfigStore, ConfigScope } from './platform/config.js'
export type { Transport } from './platform/transport.js'
export type { HttpClient, HttpRequestOptions, HttpResponse } from './platform/http.js'
export { FetchHttpClient } from './platform/http.js'

export type { LightCodeConfig } from './config/schema.js'
export { configSchema, parseConfig, ConfigValidationError } from './config/schema.js'
export { mergeScopes, USER_SCOPE_ONLY_KEYS, type ScopeMergeResult } from './config/scopes.js'
export { defaultUserConfigPath, workspaceConfigPath } from './config/paths.js'
export { ConfigManager } from './config/manager.js'
export { validateProviderForm, type FieldError } from './config/validate.js'

export { redact } from './logging/redact.js'
export { Logger, type LogLevel, type LoggerOptions } from './logging/logger.js'

export { confine, PathConfinementError, normalizeForComparison } from './fs/confine.js'
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
export { wireFormatSchema, authSchema, providerProfileSchema } from './providers/types.js'
export { resolveActiveProfile, NoActiveProfileError, ProfileNotFoundError } from './providers/registry.js'
export { ApiKeyAuthStrategy, NoAuthStrategy, createAuthStrategy } from './providers/auth/apiKey.js'
export { OpenAIProvider } from './providers/openai.js'
export { providerPresets, type ProviderPreset } from './providers/presets.js'

export { Conversation } from './agent/messages.js'
export { buildSystemPrompt } from './agent/systemPrompt.js'
export { runAgentTurn, type AgentTurnEvents, type RunAgentTurnOptions } from './agent/loop.js'
export {
  DiskTruncationStore,
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
} from './agent/protocol.js'

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
  type ToolResult,
  type ToolExecutionContext,
} from './tools/index.js'
