import type { LightCodeConfig } from './schema.js'

/**
 * Dotted paths that are user-scope only (invariant 5). A hostile repo must not be able
 * to repoint credentials or executables via workspace config.
 */
export const USER_SCOPE_ONLY_KEYS = ['provider.baseUrl', 'auth', 'certDir', 'python.uvPath'] as const

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
