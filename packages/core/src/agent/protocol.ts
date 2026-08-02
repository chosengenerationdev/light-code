import type { WireFormat } from '../providers/types.js'

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
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'profiles'; profiles: ProfileSummary[]; activeProfileId: string | undefined }
  | { type: 'profileSaved' }
