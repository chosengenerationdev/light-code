import type { LightCodeConfig } from './schema.js'

/**
 * Dotted paths that are user-scope only (invariant 5). A hostile repo must not be able
 * to repoint credentials or executables via workspace config — this means the entire
 * `profiles` list and `activeProfileId` are restricted, not just `baseUrl`/`auth`
 * within a profile: injecting a whole new profile is just as dangerous as editing one.
 */
export const USER_SCOPE_ONLY_KEYS = [
  'profiles',
  'activeProfileId',
  'certDir',
  // The whole block, not just uvPath: toolsDir and venvPath also name where code is found
  // and run from, and dynamicTools decides whether model-authored code runs at all.
  'python',
  // Added in Phase 4. Auto-approve settings are per-workspace in behaviour but stored
  // user-side: a repo that could ship its own pre-approvals could run shell commands
  // unprompted the moment you opened it.
  'approvals',
  // `expert.path` names an executable. A workspace able to set it would run a program of
  // its choosing as soon as the panel opened — the same threat as `python.uvPath`.
  // `expert.enabled` is here too, so a repo cannot switch on paid API calls by itself.
  'expert',
  // Added for Phase 8b, and the sharpest entries on this list. A workspace able to name a
  // cluster, or repoint the embedder at a profile of its choosing, would exfiltrate
  // whatever gets indexed — and what gets indexed is the source code.
  'vectorStores',
  'activeVectorStoreId',
  'embedder',
  // Adding a trusted root is how interception becomes undetectable, and turning off
  // verification globally is worse. Neither belongs to a repository.
  'tls',
  // `retrieval.docsIndex` names where the contents of your tool and skill documentation are
  // written. Same threat as `embedder`: a workspace able to set it chooses the destination.
  'retrieval',
  // Skill folders are absolute paths that are read into the prompt and written to. A skill is
  // a prompt-injection vector whose main defence is living in the repo under code review, so
  // where that happens is the user's call. `.lightcode/skills/` is always read regardless, so
  // a project loses nothing.
  'skills',
] as const

export interface ScopeMergeResult {
  config: LightCodeConfig
  /** User-scope-only keys that were present in workspace config and ignored. */
  ignoredWorkspaceKeys: string[]
}

function getPath(obj: Record<string, unknown>, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((current, segment) => {
    if (!isPlainObject(current)) return undefined
    return current[segment]
  }, obj)
}

function deletePath(obj: Record<string, unknown>, dottedPath: string): void {
  const segments = dottedPath.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < segments.length - 1; i++) {
    const next = current[segments[i] as string]
    if (!isPlainObject(next)) return
    current = next
  }
  delete current[segments[segments.length - 1] as string]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key], value)
    } else {
      target[key] = value
    }
  }
}

/**
 * Merges user and workspace config. Workspace wins for ordinary keys, but any
 * user-scope-only key present in workspace config is dropped and reported — never
 * silently applied and never silently dropped without a trace.
 */
export function mergeScopes(
  userConfig: LightCodeConfig,
  workspaceConfig: LightCodeConfig,
): ScopeMergeResult {
  const workspaceRecord = workspaceConfig as Record<string, unknown>

  const ignoredWorkspaceKeys = USER_SCOPE_ONLY_KEYS.filter(
    (key) => getPath(workspaceRecord, key) !== undefined,
  )

  const sanitizedWorkspace = structuredClone(workspaceRecord)
  for (const key of ignoredWorkspaceKeys) {
    deletePath(sanitizedWorkspace, key)
  }

  const merged = structuredClone(userConfig as Record<string, unknown>)
  deepMerge(merged, sanitizedWorkspace)

  return { config: merged as LightCodeConfig, ignoredWorkspaceKeys }
}
