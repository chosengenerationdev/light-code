import path from 'node:path'

import type { LightCodeConfig } from './schema.js'

/**
 * What this project is called, and everything derived from it.
 *
 * ## Why one module
 *
 * The name reaches four places — index names, skill frontmatter, Python tool headers and the
 * attribution on every shared chunk — and they have to agree. The recurring defect in this repo is
 * one fact decided in two places that drift (§19), so every reader asks here.
 *
 * ## Configured versus derived
 *
 * `configuredProjectName` is what the user typed; `projectName` falls back to the folder name.
 * They are different questions on purpose: labelling a new skill wants *a* name, so the folder is
 * better than nothing, but **index names change only when a name has been set** — deriving a
 * prefix from the folder would rename every existing index on upgrade and quietly re-embed it.
 */

export function configuredProjectName(config: LightCodeConfig | undefined): string | undefined {
  const name = config?.project?.name?.trim()
  return name !== undefined && name.length > 0 ? name : undefined
}

export function projectName(config: LightCodeConfig | undefined, workspaceRoot: string | undefined): string | undefined {
  const configured = configuredProjectName(config)
  if (configured !== undefined) return configured
  return workspaceRoot === undefined ? undefined : path.basename(path.resolve(workspaceRoot))
}

/**
 * A project name reduced to what an index name may hold: lowercase, digits and dashes.
 *
 * Undefined when nothing usable survives, and the caller then leaves the name unprefixed rather
 * than starting it with a stray dash.
 */
export function projectSlug(name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : undefined
}
