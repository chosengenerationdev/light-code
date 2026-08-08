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
export type { ApprovalDecision } from './approval/types.js'
export type { AutoApproveSettings, WorkspaceApprovals, ApprovableGroup } from './approval/policy.js'
export type { Mode } from './modes/types.js'
export { BUILTIN_MODES, CODE_MODE, ASK_MODE, DEFAULT_MODE_ID, findMode } from './modes/builtin.js'
export { providerPresets, type ProviderPreset } from './providers/presets.js'

export { validateProviderForm, type FieldError } from './config/validate.js'

export type {
  UiToHostMessage,
  HostToUiMessage,
  ProfileSummary,
  ProfileInput,
  ToolCallSummary,
} from './agent/protocol.js'
