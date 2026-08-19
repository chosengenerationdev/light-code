import type { Principal } from './identity.js'

/**
 * Who may change what, when the server is shared.
 *
 * ## What this is, and the much larger thing it is not
 *
 * On a shared server every user's requests are still executed by **the service account**.
 * Locking configuration down does not change that: a non-admin can still ask the assistant to
 * run a shell command, and that command runs with the server's privileges over the server's
 * files. §14 says the real fix is one OS account or container per session, and that is still
 * not built.
 *
 * So this is **not** privilege isolation, and reading it as such would be the dangerous
 * mistake. What it *is* worth: the settings a shared deployment cannot let an individual
 * change — where the model gateway points, which MCP servers spawn, which interpreter runs
 * Python, which folders are readable. An operator who configures those once should not find
 * them repointed by whoever logged in next.
 *
 * `docs/hosting.md` still says hosting is only appropriate where every user is already trusted
 * with everything every other user can reach. That has not changed and must not be softened.
 *
 * ## Why this list, and not a general "settings" ban
 *
 * It mirrors invariant 5 almost exactly. Those keys are the ones already judged too dangerous
 * for a *workspace* to control, because they repoint credentials, name executables, or widen
 * what can be read — and a second user on a shared box is the same threat as a hostile
 * repository, arriving through a different door.
 *
 * What is deliberately *absent* is as considered as what is present: appearance, the active
 * mode, the per-chat expert budget and the message you are typing are personal, and an admin
 * has no business owning them.
 */
export type Role = 'admin' | 'user'

/**
 * Message types only an admin may send when the server is shared.
 *
 * A deny list would be wrong here: a new settings message added later must default to
 * *restricted*, not to "anyone may". So this is an allow-by-omission list that is checked
 * against a prefix rule as well — see `isAdminOnly`.
 */
export const ADMIN_ONLY_MESSAGES: readonly string[] = [
  // Credentials and where inference goes (invariant 5: `profiles`, `activeProfileId`).
  'saveProfile',
  'deleteProfile',
  'duplicateProfile',
  'setActiveProfile',
  'testConnection',
  'importConfig',
  'exportConfig',
  // Processes this machine will spawn.
  'saveMcpServer',
  'saveMcpServers',
  'deleteMcpServer',
  'duplicateMcpServer',
  'restartMcpServer',
  'connectMcpServer',
  'setMcpServerEnabled',
  'setMcpToolPermission',
  // Names an interpreter and a tools directory — `python.uvPath` is on invariant 5 for this.
  'setPython',
  'deletePythonTool',
  'approvePythonTool',
  // Names an executable that costs money to run.
  'setExpert',
  'assessJunior',
  'clearAssessment',
  // TLS trust and client identity for every outbound connection.
  'saveNetwork',
  // Where the corpus is sent, and what is embedded into it.
  'saveSearchConnection',
  'deleteSearchConnection',
  'setActiveSearchConnection',
  'saveEmbedder',
  'setDispatcher',
  'startIndexing',
  'indexDocs',
  'clearDocsIndex',
  'syncVectorStore',
  // Reading beyond the workspace, and where skills come from.
  'setReadRoots',
  'saveSkillDirs',
  'deleteSkillFile',
  // Unattended execution with a pre-granted tool list.
  'saveSchedule',
  'deleteSchedule',
  'setScheduleEnabled',
  'runScheduleNow',
  'duplicateSchedule',
  // Approvals are stored per workspace but govern what runs without asking.
  'setAutoApprove',
  'revokeAllowedTool',
  'revokeAllowedCommand',
]

const ADMIN_ONLY = new Set(ADMIN_ONLY_MESSAGES)

/**
 * Whether a message changes shared configuration.
 *
 * The explicit list is the substance; the prefix rule is the safety net. A settings message
 * added later will very likely be named `save…` or `set…` or `delete…`, and defaulting those
 * to restricted means the failure mode of forgetting to update this file is "an admin has to
 * do it", not "anyone may repoint the gateway".
 *
 * The exceptions are named individually, and each is a personal preference rather than a
 * shared setting.
 */
const PERSONAL_SETTINGS = new Set([
  'setMode',
  'setAccentColor',
  'setExpertColor',
  'setMaxIterations',
  'setTaskExpertLimits',
])

export function isAdminOnly(messageType: string): boolean {
  if (PERSONAL_SETTINGS.has(messageType)) return false
  if (ADMIN_ONLY.has(messageType)) return true
  return /^(save|set|delete|duplicate|clear|restart|connect|revoke|import|export)/.test(messageType)
}

export interface RolePolicy {
  /** Every principal is an admin when the server is not shared — there is only one person. */
  roleFor(principal: Principal): Role
  /** True when config is locked down, so the UI can say so rather than failing silently. */
  readonly shared: boolean
}

/** Local `npx light-code`: one person, who owns the machine and therefore the settings. */
export const SINGLE_USER_POLICY: RolePolicy = {
  shared: false,
  roleFor: () => 'admin',
}

/**
 * Server mode: an explicit list of administrator ids, and everyone else is a user.
 *
 * Ids rather than names, matching `Principal.id` — the immutable directory identifier. A list
 * of usernames would silently transfer administration to whoever inherits a leaver's account,
 * which is the same reasoning `Principal.id` already carries.
 *
 * An **empty list means nobody can change configuration**, which is a legitimate deployment:
 * the operator sets the config file up beside the server and the running process never writes
 * it. It is not a misconfiguration to warn about, so it is reported at startup instead.
 */
export function adminListPolicy(adminIds: readonly string[]): RolePolicy {
  const admins = new Set(adminIds)
  return {
    shared: true,
    roleFor: (principal) => (admins.has(principal.id) ? 'admin' : 'user'),
  }
}

/** What a refused message is answered with — a sentence, not a silent drop (§17). */
export function refusalFor(messageType: string): string {
  return (
    `"${messageType}" changes configuration that the administrator owns on a shared server, so ` +
    'it was not applied. Everything about your own session — chatting, editing, the mode and ' +
    'appearance — is unaffected. Ask whoever runs this server if a setting needs changing.'
  )
}
