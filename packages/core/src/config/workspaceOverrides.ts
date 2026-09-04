import path from 'node:path'

import type { LightCodeConfig } from './schema.js'

/**
 * Settings a user may set differently per project, without a repository being able to set them.
 *
 * ## The distinction this rests on
 *
 * Invariant 5 blocks these keys in *workspace config* — the `.lightcode/config.json` that travels
 * with a cloned repository — because a hostile repo repointing your embedder would exfiltrate
 * your source the moment you opened it. That reasoning is about **who writes the value**, and it
 * says nothing about whether the value may vary by project.
 *
 * CLAUDE.md already makes that split for `approvals`: *scoped* per workspace, *stored* user-side,
 * keyed by workspace path, with the explicit warning not to collapse the two decisions. This is
 * the same mechanism generalised, because opening a second codebase on one machine and finding it
 * shares the first one's vector store, model and Python environment is simply wrong.
 *
 * ## Why an allow list rather than "anything may be overridden"
 *
 * A key added later must default to **global**. Making everything overridable would mean each new
 * setting silently gains a per-project dimension nobody designed, and the first anyone would learn
 * of it is a value not taking effect somewhere. The things genuinely absent from this list are
 * absent on purpose: `profiles`, `vectorStores`, `certDir`, `tls`, `office` and `expert` describe
 * the machine and its credentials, not the project.
 */
export const OVERRIDABLE_KEYS = [
  /** Which model answers here. A cheap one for a scratch repo, a strong one for the real work. */
  'activeProfileId',
  /** And which one writes Python tool source. */
  'programmingProfileId',
  /** Which vector store this project indexes into — the case this was asked for. */
  'activeVectorStoreId',
  /** Junior for one project, Code for another. */
  'modeId',
  'maxIterations',
  /** `docsIndex` names where this project's tool and skill documentation lives. */
  'retrieval',
  /** `indexName` and `indexPrefix` are per project; the model and width usually are not. */
  'embedder',
  /** A virtualenv belongs to a project, not to a machine. */
  'python',
  /** Read roots and the `@` exclusions are about this repository's layout. */
  'filesystem',
  /** A team's shared skill folder differs per project. */
  'skills',
  /** One repository on a slow share needs longer than another on local disk. */
  'tools',
] as const

export type OverridableKey = (typeof OVERRIDABLE_KEYS)[number]

/** What one workspace may say differently. Same shapes as the top-level keys it overrides. */
export type WorkspaceOverrides = Pick<LightCodeConfig, OverridableKey>

/**
 * The storage key for a workspace path.
 *
 * Case-folded on Windows and resolved, for the reason `approvals` learned the hard way: the same
 * folder arrives as `d:\project` or `D:\project` depending on how the window was opened, and a
 * JSON key is an exact string — so the same project looked like a different one between sessions
 * and every setting made for it silently stopped applying.
 */
export function workspaceOverrideKey(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Finds this workspace's overrides however its path happens to be spelled. */
export function overridesFor(
  stored: Record<string, WorkspaceOverrides> | undefined,
  workspaceRoot: string | undefined,
): WorkspaceOverrides | undefined {
  if (stored === undefined || workspaceRoot === undefined) return undefined
  const wanted = workspaceOverrideKey(workspaceRoot)
  for (const [key, value] of Object.entries(stored)) {
    if (workspaceOverrideKey(key) === wanted) return value
  }
  return undefined
}

/**
 * Lays a workspace's overrides over the user's defaults.
 *
 * **Shallow per key, deliberately.** A project that names its own `python.venvPath` means "this
 * project's interpreter", not "this project's interpreter and no uv path at all" — so nested
 * objects merge, and a project can override one field without restating the block. Scalars
 * replace outright, which is the only thing they can sensibly do.
 *
 * Keys outside `OVERRIDABLE_KEYS` are ignored rather than merged, so a hand-edited override of
 * something global cannot take effect through a door nobody meant to open.
 */
export function applyWorkspaceOverrides(
  config: LightCodeConfig,
  overrides: WorkspaceOverrides | undefined,
): LightCodeConfig {
  if (overrides === undefined) return config

  const result: Record<string, unknown> = { ...config }
  for (const key of OVERRIDABLE_KEYS) {
    const value = (overrides as Record<string, unknown>)[key]
    if (value === undefined) continue

    const base = (config as Record<string, unknown>)[key]
    const bothObjects =
      typeof value === 'object' && value !== null && !Array.isArray(value) &&
      typeof base === 'object' && base !== null && !Array.isArray(base)

    result[key] = bothObjects ? { ...(base as object), ...(value as object) } : value
  }
  return result as LightCodeConfig
}

/** Which settings this project has said differently, for the UI to list. */
export function describeOverrides(overrides: WorkspaceOverrides | undefined): OverridableKey[] {
  if (overrides === undefined) return []
  return OVERRIDABLE_KEYS.filter((key) => (overrides as Record<string, unknown>)[key] !== undefined)
}
