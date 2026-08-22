import type { ConfigStore } from '../platform/config.js'
import type { SecretStore } from '../platform/secrets.js'
import type { Transport } from '../platform/transport.js'

/**
 * Everything the chat bridge needs from its host.
 *
 * The bridge itself — profiles, MCP, search, approvals, task history, the agent loop — is
 * platform-agnostic and lives in core. What is *not* portable is narrow and collected here:
 * a handful of UI affordances a webview cannot provide itself, plus the stores whose
 * backing differs per host.
 *
 * This is §4's rule applied to the one piece that had grown around it. The bridge used to
 * live in `apps/vscode` and import `vscode` directly, which meant a second host had to
 * either fork 1,800 lines or move them. Moving them is the version where a bug gets fixed
 * once.
 */

/** A file or folder chooser. Resolving `undefined` means the user cancelled. */
export interface OpenDialogOptions {
  kind: 'file' | 'folder'
  /** Bare extensions, no dot. Advisory — a host without filtering may ignore them. */
  extensions?: string[] | undefined
  /** Where to start. Hosts that cannot honour it open wherever they like. */
  defaultPath?: string | undefined
}

/**
 * Host-provided UI and workspace queries.
 *
 * Every method must be safe to call when the host cannot honour it: a headless or
 * browser-hosted server has no native file dialog, so `showOpenDialog` returns `undefined`
 * and the user types the path instead. Nothing here may be load-bearing for correctness.
 */
export interface HostUi {
  /** Transient, dismissable. Never used to report something the UI must act on. */
  showInfo(message: string): void
  showWarning(message: string): void
  /**
   * A message with one action, resolving true when the action was taken.
   *
   * Needed by scheduled runs (§9b): a job that finds something at 3am is only useful if the
   * notification leads somewhere, and a toast with no way into the transcript makes the user
   * hunt through history for a task they cannot name.
   *
   * A `Promise<boolean>` rather than a callback so a host with no notion of an actionable
   * message can simply resolve false — the contract that no `HostUi` method may be
   * load-bearing (§19). The browser host will do exactly that until it has somewhere to put
   * one.
   */
  showActionMessage(message: string, action: string, level: 'info' | 'warning'): Promise<boolean>
  /**
   * Brings the panel to the front.
   *
   * A notification can arrive while the view is closed, and opening a task posts to a webview
   * that is not there — the click would appear to do nothing.
   */
  revealPanel(): Promise<void>
  /**
   * Shows the host's own onboarding, when it has one.
   *
   * Optional like everything else here (§19): a browser has no Get Started page, and the UI
   * simply does not offer the button rather than offering one that does nothing.
   */
  openWalkthrough?(): Promise<void>
  /**
   * Opens text in an ordinary editor tab, read-only.
   *
   * A scheduled run's transcript is a document, not a conversation to continue — you read it,
   * scroll it, search it and copy from it, all of which an editor does far better than a
   * sidebar a third the width. Markdown so the editor can preview it.
   *
   * Like every other `HostUi` method it may do nothing (§19): a host with no editor simply
   * does not open one, and no caller depends on it having happened.
   */
  openDocument(options: { title: string; content: string; language?: string }): Promise<void>
  /**
   * Opens a file on disk for editing, as opposed to `openDocument`'s in-memory copy.
   *
   * Editing a skill or a Python tool has to write back to the file, so a scratch buffer will
   * not do. Optional like every other method here: a browser host has no editor, and the tab
   * keeps showing the path so the file is still findable by hand (§19).
   */
  openFile?(filePath: string): Promise<void>
  showOpenDialog(options: OpenDialogOptions): Promise<string | undefined>
  showSaveDialog(options: { defaultName: string; extensions?: string[] | undefined }): Promise<string | undefined>
  /**
   * Workspace-relative paths matching a glob, for `@` autocomplete.
   *
   * A host with an editor's index should use it — VS Code's honours `files.exclude` for
   * free. A plain filesystem walk is an acceptable substitute.
   */
  findFiles(pattern: string, limit: number): Promise<string[]>
}

/**
 * Small persisted key-value store scoped to the current workspace *and* user.
 *
 * Only used for the active task id so far, and that use decides the scoping: a reload must
 * reopen the conversation that was in progress rather than the most recent one, and on a
 * shared server two people in the same workspace are not in the same conversation.
 */
export interface WorkspaceState {
  get(key: string): string | undefined
  set(key: string, value: string | undefined): Promise<void>
}

export interface HostServices {
  workspaceState: WorkspaceState
  transport: Transport
  secrets: SecretStore
  configStore: ConfigStore
  ui: HostUi
  /** Absolute path to the open folder, or undefined when none is. */
  workspaceRoot: string | undefined
  /** Per-user directory for tasks, spilled tool results and the user-scope config. */
  storageDir: string
  /**
   * Absolute path to a ripgrep binary, or undefined to degrade `search_files` and
   * `list_files` with a clear message.
   *
   * Supplied by the host and never resolved here: ripgrep ships one binary per platform,
   * which is a platform concern, and a top-level import of `@vscode/ripgrep` from core once
   * shipped a VSIX that could not activate at all (§19). Core must not know it exists.
   */
  ripgrepPath: string | undefined
  /** Appends one line to wherever this host shows diagnostics. */
  logSink: (line: string) => void
  /**
   * Where the in-app guide's diagrams are served from, without a trailing slash.
   *
   * Only for a host that renders the tour itself. VS Code leaves this undefined — it has
   * `openWalkthrough` and its own Get Started page, which references the same files by a path
   * the manifest already declares. Absent means the guide renders as text, which is a real
   * degradation rather than a broken one.
   */
  guideMediaBase?: string | undefined
  /**
   * Values this session makes visible to what it runs, already resolved.
   *
   * A function, read per turn, so a change applies to the next command without restarting a
   * session. Undefined in the VS Code extension: one user, their own environment, nothing to
   * resolve. The Node host supplies it because a shared server has to answer whose value wins —
   * `session/variables.ts` holds that rule and the reason it goes the way it does.
   */
  sessionEnv?: () => Record<string, string>
}
