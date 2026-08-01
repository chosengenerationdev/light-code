/** Shared by packages/ui and apps/vscode so both sides agree on the wire shape. */
export type UiToHostMessage =
  | { type: 'sendMessage'; text: string }
  | { type: 'cancel' }
  | { type: 'requestProfile' }
  | { type: 'saveProfile'; baseUrl: string; model: string; apiKey: string }

export type HostToUiMessage =
  /**
   * `text` is the FULL accumulated response so far, not just the latest delta.
   * `postMessage` delivery isn't guaranteed — sending cumulative state makes each
   * message self-correcting, so one dropped message doesn't corrupt everything after it.
   */
  | { type: 'textChunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  /** `apiKey` never appears here — invariant 7. `hasApiKey` only says whether one is set. */
  | { type: 'profile'; baseUrl: string; model: string; hasApiKey: boolean }
  | { type: 'profileSaved' }
