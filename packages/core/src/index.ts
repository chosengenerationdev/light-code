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

export { redact } from './logging/redact.js'
export { Logger, type LogLevel, type LoggerOptions } from './logging/logger.js'

export { confine, PathConfinementError } from './fs/confine.js'
export { PathDenylist } from './fs/denylist.js'
