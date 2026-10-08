import type { DiagnosticsProvider } from '../lsp/manager.js'
import type { ConfigStore } from '../platform/config.js'
import type { HttpClient } from '../platform/http.js'
import type { SecretStore } from '../platform/secrets.js'
import type { Transport } from '../platform/transport.js'
import type { DebugSessionSnapshot } from '../tools/debugSession.js'
import type { JupyterHubSpec } from '../jupyter/spec.js'
import type { CredentialSummary } from '../secrets/credentials.js'

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
  /**
   * The editor's own multi-select list of files - open ones first, the current file ticked - for
   * the composer's "Add files to context". Absolute paths; undefined when cancelled. Absent where
   * there is no editor (the browser, Fire Code), and the button is then not shown.
   */
  pickContextFiles?(): Promise<string[] | undefined>
  showSaveDialog(options: {
    defaultName: string
    extensions?: string[] | undefined
  }): Promise<string | undefined>
  /**
   * Candidate paths for an `@` mention.
   *
   * **`segment` is what the user typed, not a pattern.** It is the last path segment of the
   * query, and each host expresses it in whatever its own index speaks: the editor compiles it
   * with `mentionGlob` because `findFiles` takes a glob, the server compares strings because it
   * walks the tree itself. Handing over a glob instead made the server unpick one — stripping
   * `*` back out to recover the text — which is two representations of one fact, and the second
   * of them broke the moment the first learned about case (see `context/mentionGlob.ts`).
   *
   * Matching is expected to be **case-insensitive** and to treat the segment as literal text.
   * A host that cannot manage that will find nothing for the ordinary case of somebody typing
   * `app` at a file called `App.tsx`.
   *
   * `excludeFolders` is a list of folder names to skip at any depth, resolved by the caller from
   * config. Passed rather than read here because each host excludes differently.
   */
  findFiles(
    segment: string,
    limit: number,
    excludeFolders: readonly string[],
    /** `prefix`: names that start with the segment. With `depth`, only files that many folders down. */
    mode?: 'contains' | 'prefix',
    depth?: number,
    /** Another folder to search instead of the workspace: a sibling codebase (`siblings`). */
    root?: string,
  ): Promise<string[]>
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
  /**
   * The project's own source, zipped at build time, for "Export source code".
   *
   * Asked for by somebody who cannot reach GitHub from the office and wants to keep building this
   * product there: the archive is a folder that opens in VS Code and builds as it stands. Built
   * from the files git tracks, at package time, so it is exactly the source of this build. Absent
   * hides the button — the Node host carries its own `--export-code` instead.
   */
  sourceArchive?: { path: string; defaultName: string } | undefined
  workspaceState: WorkspaceState
  transport: Transport
  /**
   * The network egress point, when the host wants to decide it.
   *
   * Absent everywhere but the Node host, which wraps the ordinary client in a deadline: a server
   * on a network that *drops* packets rather than refusing them otherwise waits for the operating
   * system's connect timeout, and a spinner that never resolves is what the user sees. Left
   * undefined the bridge builds its own exactly as before, so a host that does not ask for this
   * is unaffected by it.
   */
  httpClient?: HttpClient
  /**
   * Whether this host offers the Excel and Outlook features at all. Defaults to yes.
   *
   * Distinct from `officeSupported()`, which answers "is this Windows". This answers "does this
   * *host* want them", and the Node host says no: it is a server, the tools attach to
   * applications running on somebody's desktop, and a mail index belongs to a person rather than
   * to a service account. Declared rather than derived because there is no service to derive it
   * from — it is a product decision, and the honest shape for one is a statement.
   *
   * Absent means offered, so the extension is unaffected.
   */
  offersOffice?: boolean
  /**
   * A real desktop notification, for a host that has one to give.
   *
   * Light Code Fire Code shows these as Windows notifications naming the codebase, so the `notify` tool
   * reaches someone who is looking at a different chat — or at nothing, during a scheduled run.
   * Called by `notify` only, never by the bridge's own status toasts: those are about the panel
   * the user is looking at, and a desktop notification for "1 tool approved" is noise.
   *
   * Absent everywhere else, so the extension keeps its own toasts and nothing changes there.
   */
  /**
   * `anywhere`: Fire Code's reach - read any drive or share, write anywhere with approval each
   * time. See `ToolExecutionContext.reach`. Absent everywhere else, so nothing changes there.
   */
  fileReach?: 'anywhere'
  /**
   * Other agents may be working in this codebase at the same time (Fire Code's chat tabs). Rollback
   * then undoes only the files this chat's edit tools changed, never the whole workspace.
   */
  sharedWorkspace?: boolean
  /**
   * The other codebases open beside this one (Fire Code), by the short name used to mention them:
   * `@payments-api:src/app.py`. The agent is told about them and may read them; writing there
   * follows the ordinary outside-the-workspace rules.
   */
  siblings?: { name: string; path: string }[]
  /**
   * This codebase's own short name in Fire Code, so `@tyj:src/main.rs` works in tyj's own chat as it
   * does in every other one. Used for mentions only - it is not another codebase.
   */
  mentionName?: string
  /**
   * This codebase is folders on a JupyterHub server (Fire Code, host `--jupyter-hub`): the workspace
   * is a local copy kept in step with them, and `hub_run`, `hub_inspect` and `hub_sync` exist.
   */
  jupyterHub?: JupyterHubSpec
  /**
   * The JupyterHub codebases beside this one (Fire Code, host `--sibling-hub name=file`), by @name,
   * for `hub_browse`: read-only looking around those hubs from any codebase. Their tokens are named
   * by secret slot, as in `jupyterHub`, and resolved from the one secret store Fire Code shares.
   */
  siblingHubs?: { name: string; spec: JupyterHubSpec }[]
  /**
   * Fire Code's saved credentials (names and kinds, never values), so a Python tool can read one it
   * declares with `light_code.credential`. Absent wherever there is no credential manager.
   */
  savedCredentials?: () => Promise<readonly CredentialSummary[]>
  /**
   * A file of Python tool code approved anywhere on this machine (Fire Code), so the identical tool
   * in another codebase is not reviewed again. See `python/machineApprovals.ts`.
   */
  machineApprovalsFile?: string
  /**
   * Shared by every chat on this codebase (Fire Code): which chat changed which file, so a rollback
   * can ask before undoing another chat's work. `chat` is how the user knows this one.
   */
  changeLedger?: { file: string; chat: string }
  /**
   * False when another process on this codebase runs its schedules: Fire Code's extra chat tabs,
   * where every chat is its own host and each would otherwise run the same nightly job.
   */
  runsSchedules?: boolean
  /** Diagnostics from the host's own language support - the extension passes VS Code's. */
  diagnostics?: DiagnosticsProvider
  /** Start installed language servers itself (Node host, Fire Code, PyCharm). Ignored when `diagnostics` is set. */
  languageServers?: boolean
  /** Path to `fire-fs`, the parallel Rust file helper; its four tools are registered only when set. */
  fastFs?: string
  desktopNotify?: (notification: { message: string; level: 'info' | 'warning'; reportPath?: string }) => void
  secrets: SecretStore
  configStore: ConfigStore
  ui: HostUi
  /** Absolute path to the open folder, or undefined when none is. */
  workspaceRoot: string | undefined
  /** Per-user directory for tasks, spilled tool results and the user-scope config. */
  storageDir: string
  /**
   * Where copies of bucket folders (skills, Python tools) are kept, when not under `storageDir`.
   * Fire Code gives every codebase and chat the same one: approving a tool is recorded in its
   * folder, so separate copies meant reviewing the same tools once per codebase.
   */
  mirrorRoot?: string
  /**
   * Where ripgrep is **right now**, or undefined to degrade `search_files` and `list_files`
   * with a clear message.
   *
   * Supplied by the host and never resolved here: ripgrep ships one binary per platform,
   * which is a platform concern, and a top-level import of `@vscode/ripgrep` from core once
   * shipped a VSIX that could not activate at all (§19). Core must not know it exists.
   *
   * ## Why this is a function, asked every turn
   *
   * It was a string resolved once at activation, with a comment claiming the answer could not
   * change while running. **It can.** A VS Code extension lives in a version-stamped folder,
   * and installing a newer build marks the old one obsolete and deletes it while the extension
   * host keeps running — so the absolute path that existed at activation stops existing, and
   * the next search fails with a raw `ENOENT` naming `rg.exe`. Reported from real use as
   * intermittent, because it needs an update mid-session and a window reload cures it.
   *
   * So the host answers per turn and may re-resolve. Same shape and same reason as
   * `sessionEnv` beside it: a fact the host owns, read when it is needed rather than copied
   * once into somewhere that cannot see it change.
   */
  ripgrepPath: () => string | undefined
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
  /**
   * Submits a Python tool or a skill for someone else to approve, rather than saving it.
   *
   * Present only where the author may not approve their own work. Absent in the extension, where
   * the person approving is the person asking — and absent for an administrator on a shared
   * server, who gets the ordinary in-chat prompt.
   */
  /**
   * Why this session may not configure a profile that runs a program, when it may not.
   *
   * Present only for a restricted session — the same shape as `submitForReview` above and for the
   * same reason. A token command runs as the account Light Code runs under, so on a shared server
   * a personal profile must not be able to introduce one: that is arbitrary execution as the
   * service account, which §14 is explicit is *not* what locking down configuration buys you.
   *
   * Absent everywhere else. In the extension there is one user who owns the machine, and on a
   * single-user host the person configuring it is the person it runs as.
   */
  executableAuthRefusal?: string

  submitForReview?: (request: {
    kind: 'python-tool' | 'skill'
    name: string
    content: string
    existingContent: string
    producedBy?: string
  }) => Promise<string>
  /**
   * Whether a *different* model may be nominated to write Python tool source.
   *
   * The mechanism lives in core because building a provider means auth strategies, TLS material
   * and the wire adapter, and duplicating that in a host to keep one feature host-only would be a
   * far worse trade. Where it is *offered* is a separate question, and this is it.
   *
   * Absent in the VS Code extension: one person, one model, and a second provider nominated for
   * code is a shared-server idea. Absent also means the config key is inert there, so a
   * hand-edited file cannot change what `create_python_tool` asks for.
   */
  allowProgrammingProfile?: boolean
  /**
   * A snapshot of the active debug session — the call stack and variables at the point it is
   * paused, plus recent console output — or undefined when nothing is being debugged.
   *
   * Absent means this host has no debug session to offer: the Node host and the browser UI have
   * no `vscode.debug` API, so `read_debug_session` is simply not registered there, the same rule
   * every other host-specific tool follows.
   */
  readDebugSession?: () => Promise<DebugSessionSnapshot | undefined>
}
