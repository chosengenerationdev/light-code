import { createHash } from 'node:crypto'
import path from 'node:path'

import type { Addon } from './discover.js'
import { addonSecretRef, type AddonStoredSettings } from './page.js'

/**
 * What an add-on is given when it starts, so its tools can use what the user entered on its tab.
 *
 * - **A settings file** (`LIGHT_CODE_ADDON_SETTINGS`): the values and records, without secrets. Read
 *   by the add-on whenever it needs them, so a renamed machine needs no restart.
 * - **Secrets as environment variables**, one per stored secret, named in the file. They are written
 *   as `${secret:...}` references and resolved from secret storage by the MCP client when the server
 *   starts - the same path every MCP server's secrets take - so no secret is ever written to a file.
 *   §15 allows a secret into an MCP environment when that server was configured to receive one, and a
 *   password typed on an add-on's own tab is exactly that. Saving the tab restarts the add-on.
 * - **A data folder** (`LIGHT_CODE_ADDON_DATA`) of its own, and in it `downloads`, which the agent's
 *   `read_file` reaches without asking - an add-on that fetches a file for investigation is pointless
 *   if reading it then needs a prompt.
 *
 * Only for an add-on that is enabled from the user's own settings (`runnableServers` decides that).
 */

export const SETTINGS_ENV = 'LIGHT_CODE_ADDON_SETTINGS'
export const DATA_ENV = 'LIGHT_CODE_ADDON_DATA'
export const DOWNLOADS_ENV = 'LIGHT_CODE_ADDON_DOWNLOADS'
/**
 * Set when this Light Code keeps panel-only tools from the model (`McpRegistry.callPanelTool`). An
 * add-on offers a tool that changes something only when it is set: an older Light Code would list it
 * to the model like any other.
 */
export const PANEL_TOOLS_ENV = 'LIGHT_CODE_ADDON_PANEL_TOOLS'

/** The add-on's own folder under Light Code's storage. */
export function addonDataDir(storageDir: string, addon: Pick<Addon, 'server'>): string {
  return path.join(storageDir, 'addons', addon.server)
}

export function addonDownloadsDir(storageDir: string, addon: Pick<Addon, 'server'>): string {
  return path.join(addonDataDir(storageDir, addon), 'downloads')
}

/** A variable name for one secret: stable, and saying nothing about what it holds. */
export function secretEnvName(ref: string): string {
  return `LC_SECRET_${createHash('sha256').update(ref).digest('hex').slice(0, 16).toUpperCase()}`
}

/** The file an add-on reads, as written. */
export interface DeliveredSettings {
  values: Record<string, unknown>
  records: { id: string; values: Record<string, unknown> }[]
  /** Per record id (`_` for the add-on's own fields), per secret field: the variable holding it. */
  secrets: Record<string, Record<string, string>>
}

/**
 * The file and the environment for one add-on. `stored` names the secret refs that exist in secret
 * storage: a reference to one that does not would stop the server starting at all.
 */
export function deliveryFor(
  storageDir: string,
  addon: Addon,
  settings: AddonStoredSettings | undefined,
  stored: ReadonlySet<string>,
): { file: string; contents: DeliveredSettings; env: Record<string, string> } {
  const dir = addonDataDir(storageDir, addon)
  const file = path.join(dir, 'settings.json')
  const env: Record<string, string> = {
    [SETTINGS_ENV]: file,
    [DATA_ENV]: dir,
    [DOWNLOADS_ENV]: addonDownloadsDir(storageDir, addon),
    [PANEL_TOOLS_ENV]: '1',
  }
  const secrets: DeliveredSettings['secrets'] = {}
  const secretFields = (owner: 'record' | 'page'): string[] =>
    ((owner === 'record' ? addon.page?.records?.fields : addon.page?.fields) ?? []).filter((field) => field.type === 'secret').map((field) => field.key)
  const give = (recordId: string | undefined, field: string): void => {
    const ref = addonSecretRef(addon.package, recordId, field)
    if (!stored.has(ref)) return
    const name = secretEnvName(ref)
    env[name] = `\${secret:${ref}}`
    ;(secrets[recordId ?? '_'] ??= {})[field] = name
  }
  for (const field of secretFields('page')) give(undefined, field)
  for (const record of settings?.records ?? []) for (const field of secretFields('record')) give(record.id, field)
  return { file, contents: { values: settings?.values ?? {}, records: settings?.records ?? [], secrets }, env }
}

/** Every secret ref an add-on's settings could have stored, to look up which exist. */
export function possibleSecretRefs(addon: Addon, settings: AddonStoredSettings | undefined): string[] {
  const refs: string[] = []
  for (const field of addon.page?.fields ?? []) if (field.type === 'secret') refs.push(addonSecretRef(addon.package, undefined, field.key))
  for (const record of settings?.records ?? []) {
    for (const field of addon.page?.records?.fields ?? []) if (field.type === 'secret') refs.push(addonSecretRef(addon.package, record.id, field.key))
  }
  return refs
}
