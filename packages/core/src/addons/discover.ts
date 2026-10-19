import fs from 'node:fs/promises'
import path from 'node:path'

import type { McpServersConfig } from '../mcp/types.js'
import { addonPageSchema, type AddonPage } from './page.js'

/**
 * Add-ons: separate Node apps that give Light Code and Fire Code more tools once installed.
 *
 * Asked for directly: "make fire-code and light-code extendable, where i can create separate addon
 * node apps, when they are installed, fire-code and light-code should get more tools to use".
 *
 * ## An add-on is an MCP server with a label on it
 *
 * The package says so in its `package.json` - `"lightCode": { "addon": { "main": "server.js" } }` -
 * and `main` is an MCP server over stdio. That is the whole contract, and it was chosen over a
 * plugin API loaded into the host for reasons that are each decisive on their own:
 *
 * - **Out of process.** Code loaded into the host could make network calls past the one
 *   `HttpClient` (invariant 2), read the secret store, and take every chat down when it crashed.
 *   A separate process can do none of that to us, and it dies alone.
 * - **Everything already applies.** An MCP tool goes through the approval gate, per-tool
 *   Always/Ask/Never, timeouts, deny rules, namespacing and the dispatcher - none of which an
 *   in-process API would have had on day one.
 * - **Authors write against a published SDK** (`@modelcontextprotocol/sdk`), not against a Light
 *   Code interface that would have to stay stable for them.
 *
 * ## Installed is not enabled
 *
 * Finding a package is not permission to run it: anything installed globally with that label would
 * otherwise start the moment a panel opened. Enabling one writes an ordinary `mcpServers` entry
 * (tagged with the package and the version enabled), so the MCP tab, the JSON editor and export
 * treat it like any other server. When the installed version later differs from the one enabled,
 * it stays off until it is enabled again - an update is new code, and new code is looked at first.
 */

/** What an add-on's own `package.json` says, once checked. */
export interface Addon {
  /** The npm package name, e.g. `light-code-addon-weather` or `@team/weather`. */
  package: string
  version: string
  displayName: string
  description?: string
  /** The package folder. */
  dir: string
  /** The MCP server script, inside `dir`. */
  main: string
  args: string[]
  /** The MCP server name it is enabled under: tools appear as `<server>__<tool>`. */
  server: string
  /** Its icon, as an SVG `data:` URI - shown on its settings tab. */
  icon?: string
  /** Its own settings tab (`page.ts`), when it declares one. Shown only while it is installed. */
  page?: AddonPage
  /** Why a declared page or icon could not be used; the add-on still works without them. */
  pageProblem?: string
}

/** A package that carries the label but cannot be used, and why - shown rather than hidden. */
export interface AddonProblem {
  dir: string
  package?: string
  problem: string
}

/** What `mcpServers[name].addon` records: which package, and which version was enabled. */
export interface AddonTag {
  package: string
  version: string
}

/**
 * Where installed add-ons are looked for when nothing else is configured: npm's global folder,
 * which is where `npm i -g` puts them. On Windows that is `%APPDATA%\npm\node_modules`; elsewhere
 * `<prefix>/lib/node_modules`, with the prefix from npm's own variable or beside this Node.
 */
export function defaultAddonFolders(
  env: NodeJS.ProcessEnv,
  execPath: string,
  platform: NodeJS.Platform,
  /** The user's own `.npmrc`, whose `prefix=` is what `npm config set prefix` changes. */
  npmrc?: string,
): string[] {
  const folders: string[] = []
  const configured = npmrc
    ?.split(/\r?\n/)
    .map((line) => /^\s*prefix\s*=\s*(.+?)\s*$/.exec(line)?.[1])
    .find((value) => value !== undefined)
    ?.replace(/^["']|["']$/g, '')
  // npm's variable is set only when Light Code was started by npm; the .npmrc line is there always.
  const prefixes = [env['npm_config_prefix'] ?? env['NPM_CONFIG_PREFIX'], configured].filter((p): p is string => p !== undefined && p.length > 0)
  if (platform === 'win32') {
    for (const prefix of prefixes) folders.push(path.join(expandWindows(prefix, env), 'node_modules'))
    if (env['APPDATA'] !== undefined) folders.push(path.join(env['APPDATA'], 'npm', 'node_modules'))
    // nvm-windows and some installers keep global packages beside node.exe. Inside VS Code the runtime
    // is the editor, whose folder holds no npm packages and is skipped.
    if (path.basename(execPath).toLowerCase() === 'node.exe') folders.push(path.join(path.dirname(execPath), 'node_modules'))
  } else {
    for (const prefix of prefixes) folders.push(path.join(prefix.replace(/^~(?=\/|$)/, env['HOME'] ?? '~'), 'lib', 'node_modules'))
    folders.push(path.join(path.dirname(path.dirname(execPath)), 'lib', 'node_modules'))
  }
  return [...new Set(folders.map((folder) => path.resolve(folder)))]
}

/** `%APPDATA%` and `${APPDATA}` in an .npmrc value. */
function expandWindows(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%|\$\{([^}]+)\}/g, (whole, a: string | undefined, b: string | undefined) => env[a ?? b ?? ''] ?? whole)
}

/** `@team/light-code-addon-weather` -> `addon-weather`: short, and unlikely to meet a server someone named. */
export function addonServerName(pkg: string): string {
  const bare = pkg.replace(/^@[^/]+\//, '').replace(/^(light-code|lightcode|fire-code)-addon-/i, '')
  const slug = bare.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return `addon-${slug.length > 0 ? slug : 'unnamed'}`
}

/**
 * Reads one folder's label, or says why it cannot be used. `undefined` when it carries no label at
 * all - an ordinary package, which is not a problem worth reporting.
 */
export async function readAddon(dir: string): Promise<Addon | AddonProblem | undefined> {
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse((await fs.readFile(path.join(dir, 'package.json'), 'utf8')).replace(/^\uFEFF/, '')) as Record<string, unknown>
  } catch {
    return undefined
  }
  const label = (manifest['lightCode'] as Record<string, unknown> | undefined)?.['addon']
  if (label === undefined) return undefined
  const pkg = typeof manifest['name'] === 'string' ? manifest['name'] : path.basename(dir)
  const fail = (problem: string): AddonProblem => ({ dir, package: pkg, problem })
  if (label === null || typeof label !== 'object' || Array.isArray(label)) {
    return fail('"lightCode.addon" in package.json must be an object, e.g. { "main": "server.js" }.')
  }
  const fields = label as Record<string, unknown>
  const version = typeof manifest['version'] === 'string' ? manifest['version'] : '0.0.0'
  const mainField = typeof fields['main'] === 'string' ? fields['main'] : typeof manifest['main'] === 'string' ? manifest['main'] : undefined
  if (mainField === undefined) return fail('No server script: set "lightCode.addon.main" to the MCP server file.')
  // Inside the package and nowhere else: the label is what we run, so it may not point elsewhere.
  const main = path.resolve(dir, mainField)
  const relative = path.relative(dir, main)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return fail(`"${mainField}" is outside the package folder.`)
  try {
    if (!(await fs.stat(main)).isFile()) return fail(`${mainField} is not a file.`)
  } catch {
    return fail(`${mainField} does not exist - was the package built?`)
  }
  const args = Array.isArray(fields['args']) ? fields['args'].filter((arg): arg is string => typeof arg === 'string') : []
  const displayName = typeof fields['displayName'] === 'string' && fields['displayName'].trim().length > 0 ? fields['displayName'].trim() : pkg
  const description =
    typeof fields['description'] === 'string' ? fields['description'] : typeof manifest['description'] === 'string' ? manifest['description'] : undefined
  const extras = await readPageAndIcon(dir, fields)
  return {
    package: pkg,
    version,
    displayName,
    ...(description !== undefined ? { description } : {}),
    dir,
    main,
    args,
    server: addonServerName(pkg),
    ...extras,
  }
}

const ICON_MAX_BYTES = 64 * 1024

/**
 * The declared settings page and icon. Either may be missing or broken without costing the add-on
 * its tools - a page that does not parse is reported, not fatal. Files must be inside the package.
 */
async function readPageAndIcon(dir: string, fields: Record<string, unknown>): Promise<{ icon?: string; page?: AddonPage; pageProblem?: string }> {
  const out: { icon?: string; page?: AddonPage; pageProblem?: string } = {}
  const inside = (relative: string): string | undefined => {
    const full = path.resolve(dir, relative)
    const rel = path.relative(dir, full)
    return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : full
  }
  const problems: string[] = []
  if (typeof fields['icon'] === 'string') {
    const file = inside(fields['icon'])
    try {
      if (file === undefined) throw new Error('is outside the package folder')
      const bytes = await fs.readFile(file)
      const text = bytes.toString('utf8')
      if (bytes.length > ICON_MAX_BYTES) throw new Error('is larger than 64 KB')
      if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) throw new Error('is not an SVG file')
      // An <img> never runs an SVG's script, and the panel shows it only as an <img>.
      out.icon = `data:image/svg+xml;base64,${bytes.toString('base64')}`
    } catch (error) {
      problems.push(`icon ${String(fields['icon'])} ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let declared: unknown = fields['settings']
  if (typeof declared === 'string') {
    const file = inside(declared)
    try {
      if (file === undefined) throw new Error('is outside the package folder')
      declared = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
    } catch (error) {
      problems.push(`settings ${String(fields['settings'])} ${error instanceof Error ? error.message : String(error)}`)
      declared = undefined
    }
  }
  if (declared !== undefined) {
    const parsed = addonPageSchema.safeParse(declared)
    if (parsed.success) {
      const page = parsed.data
      const keys = page.records?.fields.map((field) => field.key) ?? []
      if (page.records !== undefined && !keys.includes(page.records.keyField)) problems.push(`settings: keyField "${page.records.keyField}" is not one of its fields`)
      else out.page = page
    } else {
      problems.push(`settings: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    }
  }
  if (problems.length > 0) out.pageProblem = problems.join('. ')
  return out
}

/**
 * Every labelled package in these folders. A folder may be an add-on itself (one being written) or
 * hold packages (`node_modules`, scopes included). The first folder to provide a package name wins,
 * as on a PATH. Never throws: an unreadable folder is skipped.
 */
export async function discoverAddons(folders: readonly string[]): Promise<{ addons: Addon[]; problems: AddonProblem[] }> {
  const addons: Addon[] = []
  const problems: AddonProblem[] = []
  const seen = new Set<string>()
  const consider = async (dir: string): Promise<void> => {
    const found = await readAddon(dir)
    if (found === undefined) return
    if ('problem' in found) {
      problems.push(found)
      return
    }
    if (seen.has(found.package)) return
    seen.add(found.package)
    addons.push(found)
  }
  for (const folder of folders) {
    const before = addons.length + problems.length
    await consider(folder)
    if (addons.length + problems.length > before) continue
    let entries: string[]
    try {
      entries = await fs.readdir(folder)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.')) continue
      const full = path.join(folder, entry)
      if (entry.startsWith('@')) {
        let scoped: string[]
        try {
          scoped = await fs.readdir(full)
        } catch {
          continue
        }
        for (const name of scoped.sort()) await consider(path.join(full, name))
      } else {
        await consider(full)
      }
    }
  }
  return { addons, problems }
}

/** The `mcpServers` entry enabling an add-on writes. Kept settings of an earlier entry survive. */
export function addonServerEntry(addon: Addon, previous?: McpServersConfig[string]): McpServersConfig[string] {
  const kept: Record<string, unknown> = {}
  if (previous !== undefined && 'command' in previous) {
    for (const key of ['env', 'disabledTools', 'deny', 'timeout', 'toolTimeouts'] as const) {
      if ((previous as Record<string, unknown>)[key] !== undefined) kept[key] = (previous as Record<string, unknown>)[key]
    }
  }
  return {
    ...kept,
    // Informative only: `runnableServers` runs the package from wherever it is installed on this
    // machine, with this host's own runtime, so the entry works in a settings file VS Code and
    // Fire Code share, and in one imported from a colleague.
    command: 'node',
    args: [addon.main, ...addon.args],
    cwd: addon.dir,
    addon: { package: addon.package, version: addon.version },
  } as McpServersConfig[string]
}

export type AddonState =
  /** Installed, not enabled. */
  | 'available'
  | 'enabled'
  /** Enabled at another version: off until enabled again. */
  | 'updated'

/** How each installed add-on stands against the configured servers. */
export function addonState(addon: Addon, servers: McpServersConfig): AddonState {
  const tag = tagOf(servers[addon.server])
  if (tag === undefined || tag.package !== addon.package) return 'available'
  return tag.version === addon.version ? 'enabled' : 'updated'
}

/** Enabled add-ons whose package is no longer installed: their server stays off, and says why. */
export function missingAddons(addons: readonly Addon[], servers: McpServersConfig): { server: string; tag: AddonTag }[] {
  const installed = new Set(addons.map((addon) => addon.package))
  return Object.entries(servers)
    .map(([server, entry]) => ({ server, tag: tagOf(entry) }))
    .filter((row): row is { server: string; tag: AddonTag } => row.tag !== undefined && !installed.has(row.tag.package))
}

function tagOf(entry: McpServersConfig[string] | undefined): AddonTag | undefined {
  const tag = (entry as { addon?: unknown } | undefined)?.addon as Partial<AddonTag> | undefined
  return typeof tag?.package === 'string' && typeof tag.version === 'string' ? { package: tag.package, version: tag.version } : undefined
}

/**
 * The server set to actually start: an add-on entry runs only at the version it was enabled at
 * and only while installed, and `node` means this host's own runtime - inside VS Code that is the
 * editor's Electron, told to behave as Node, so an add-on works with no Node on PATH.
 */
export function runnableServers(
  servers: McpServersConfig,
  addons: readonly Addon[],
  runtime: { execPath: string; electron: boolean },
  /**
   * Servers the workspace's own config names. Enabling an add-on is the user's act: a repository
   * writing an entry tagged with an installed add-on's name must not switch it on.
   */
  repositoryServers: readonly string[] = [],
  /** What this add-on is given besides its entry: its settings file, data folder, secrets (`delivery.ts`). */
  extraEnv: (addon: Addon) => Record<string, string> = () => ({}),
): McpServersConfig {
  const out: McpServersConfig = {}
  for (const [name, entry] of Object.entries(servers)) {
    const tag = tagOf(entry)
    if (tag === undefined || !('command' in entry)) {
      out[name] = entry
      continue
    }
    const installed = addons.find((addon) => addon.package === tag.package)
    if (installed === undefined || installed.version !== tag.version || repositoryServers.includes(name)) {
      out[name] = { ...entry, disabled: true }
      continue
    }
    // Run from where it is installed *here*: the entry may have been written on another machine,
    // or by VS Code beside a Fire Code whose npm folder differs. The package decides, not the path.
    const env = { ...(entry.env ?? {}), ...extraEnv(installed), ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
    out[name] = {
      ...entry,
      command: runtime.execPath,
      args: [installed.main, ...installed.args],
      cwd: installed.dir,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    }
  }
  return out
}
