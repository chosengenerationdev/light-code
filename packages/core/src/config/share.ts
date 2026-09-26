import type { LightCodeConfig } from './schema.js'

/**
 * Sharing a configuration with the rest of a team.
 *
 * Requested in those terms: *"user should be able to export all his config so that his team can
 * reuse it by importing it, secrets can be left blank so that team members can update that alone
 * by themselves"*, with a chooser on the way out and a summary on the way in.
 *
 * ## Why a section list rather than "the whole file"
 *
 * Export already existed and wrote the entire config. That is the wrong default for a file
 * somebody sends to a colleague, for two separate reasons:
 *
 * - **Some of it is about this machine, not this team.** `certDir`, `filesystem.readRoots` and
 *   `python.venvPath` name paths on one person's disk. Imported wholesale they either fail or,
 *   worse, silently point at nothing.
 * - **Some of it is nobody else's business.** Schedules are somebody's working day; the workspace
 *   overrides are their projects, by absolute path.
 *
 * A section list turns both into a decision the exporter makes, visibly, rather than a surprise
 * the importer discovers.
 *
 * ## What is never exportable, and why it is not merely unticked
 *
 * `approvals` is **absent from this list entirely** rather than offered and left off. It records
 * which shell commands have been approved in which workspace — importing somebody's would
 * pre-approve commands on your machine that you have never read, which is exactly the hole
 * invariant 5 closes against a hostile repository, reached through a file a colleague sent you.
 * A checkbox saying so would be a checkbox somebody eventually ticks.
 *
 * `identity` is absent for a smaller reason that is still a real one: it labels everything this
 * machine writes to a shared index, and importing a colleague's would attribute your work to
 * them, silently and unverifiably (§12e).
 *
 * ## Secrets
 *
 * Nothing here strips secret *values*, because there are none to strip: the config file has only
 * ever held references (§15). What it does is *name* the references a section carries, so the
 * export can say "the importer will need to enter three API keys" and the import can say which.
 * That is the "secrets left blank" half of the request, and it was already half-built — import
 * reconciled a missing `apiKeyRef` down to `none`. This extends the same idea to the other two
 * places a reference hides: vector store credentials and S3 keys.
 */

export type ShareSectionId =
  | 'profiles'
  | 'mcpServers'
  | 'search'
  | 'agents'
  | 'skills'
  | 'python'
  | 'office'
  | 'mail'
  | 's3'
  | 'confluence'
  | 'datasets'
  | 'schedules'
  | 'tools'
  | 'commands'
  | 'network'
  | 'workspace'
  | 'appearance'

export interface ShareSection {
  id: ShareSectionId
  label: string
  /** What it is, in one line, for somebody deciding whether to send it. */
  description: string
  /** Top-level config keys it owns. A key belongs to exactly one section. */
  keys: readonly (keyof LightCodeConfig)[]
  /**
   * Names paths on one particular machine.
   *
   * Not a reason to withhold it — a team with the same standard build genuinely wants to share an
   * interpreter path — but a reason to say so beside the checkbox, because the failure mode is a
   * setting that looks present and points at nothing.
   */
  machineSpecific?: boolean
  /** Off unless the exporter says otherwise. See `machineSpecific` and the schedules entry. */
  offByDefault?: boolean
  /**
   * Dotted paths removed from this section on the way out.
   *
   * For a value that is *within* a section somebody genuinely wants to share, but which names
   * **this person** rather than the team. The search section is the whole reason this exists:
   * everything about where the cluster is and how text is embedded has to match across a team,
   * and the index names have to differ, and they live under the same two keys.
   *
   * Stripping rather than splitting the section, because "share your search setup except the
   * three names identifying you" is one decision, and a chooser offering it as two would invite
   * taking half of it.
   */
  strip?: readonly string[]
  /** Said beside the checkbox, so what `strip` removes is not a silent omission. */
  stripNote?: string
}

/**
 * The sections, in the order the panel shows them.
 *
 * Ordered by how likely a team is to want it, not alphabetically: the first three are the whole
 * point of the feature — where inference goes, which tools exist, and what is indexed.
 */
export const SHARE_SECTIONS: readonly ShareSection[] = [
  {
    id: 'profiles',
    label: 'Providers',
    description: 'Gateways, models and wire formats. API keys are not included.',
    keys: ['profiles', 'activeProfileId', 'programmingProfileId'],
  },
  {
    id: 'mcpServers',
    label: 'MCP servers',
    description: 'Server commands and URLs. Any secret values stay behind their references.',
    keys: ['mcpServers'],
  },
  {
    id: 'search',
    label: 'Search and indexing',
    description: 'Vector stores, the embedder, and the dispatcher settings.',
    keys: ['vectorStores', 'activeVectorStoreId', 'embedder', 'retrieval'],
    /*
     * The names that identify *this person's* collections, and they are the one part of a search
     * setup that must differ across a team.
     *
     * §12g's rule is that everyone publishes to their **own** collection: sharing one would make
     * every person's re-index disturb everyone else's, and would leave nothing to attribute a hit
     * to. But the natural thing to send a colleague is "my search settings", and these sit inside
     * that — so an export carrying them would quietly point the importer at the exporter's own
     * index, and the symptom is somebody's skills vanishing when a colleague reindexes.
     *
     * `skillsAlias` and `indexAlias` are deliberately *not* stripped: those are the team names,
     * and they are the whole point of sending this.
     */
    strip: ['embedder.indexName', 'retrieval.skillsIndex', 'retrieval.docsIndex'],
    stripNote:
      'The index names identifying you are left out — everyone needs their own. The aliases, ' +
      'the store and the embedding model are included, and those must match.',
  },
  {
    id: 'agents',
    label: 'Agents and expert',
    description: 'Specialist roles and their prompts, and which model holds each seat.',
    keys: ['agents', 'expert'],
  },
  {
    id: 'skills',
    label: 'Skills folders',
    description: 'Where skills are read from and written to. Not the skills themselves.',
    keys: ['skills'],
    machineSpecific: true,
  },
  {
    id: 'python',
    label: 'Python tools',
    description: 'uv, the tools folder, the package index, and declared environment variables.',
    keys: ['python'],
    machineSpecific: true,
  },
  {
    id: 'office',
    label: 'Excel and Outlook',
    description: 'Whether the Office tools are offered at all.',
    keys: ['office'],
  },
  {
    id: 'mail',
    label: 'Mail indexing',
    description: 'Which Outlook folders are indexed, and how long they are kept.',
    keys: ['mail'],
    // One person's mailbox folders. Sharing them is meaningful only on a shared mailbox.
    offByDefault: true,
  },
  {
    id: 's3',
    label: 'Buckets',
    description: 'S3 connections and the folders skills and tools are mirrored to.',
    keys: ['s3'],
  },
  {
    id: 'confluence',
    label: 'Confluence',
    description: 'The Confluence site and default space the assistant writes pages to.',
    keys: ['confluence'],
  },
  {
    id: 'datasets',
    label: 'Custom data',
    description: 'Dataset definitions.',
    keys: ['datasets'],
  },
  {
    id: 'schedules',
    label: 'Schedules',
    description: 'Unattended prompts, their cadence, and the tools each one may use.',
    keys: ['schedules'],
    /*
     * Off by default, and this one is worth being deliberate about. A schedule carries an
     * allowlist of tools that run with nobody watching, bound to a workspace path that will not
     * exist on the importing machine. Somebody who means to share one can; nobody should acquire
     * one by accident.
     */
    offByDefault: true,
  },
  {
    id: 'tools',
    label: 'Tool timeouts',
    description: 'The global tool timeout and any per-tool limits.',
    keys: ['tools'],
  },
  {
    id: 'commands',
    label: 'Risky commands',
    description: 'Commands that always ask, whatever else is switched on.',
    keys: ['commands'],
    /*
     * Shareable, unlike `approvals`, and the asymmetry is the point. Importing somebody's
     * *approvals* removes gates on your machine — which is why it is in `NEVER_SHARED`. Importing
     * their risky-command rules can only add prompts, so "here is what our team always reviews" is
     * exactly the kind of thing worth sending, and it fails safe if it is wrong.
     */
  },
  {
    id: 'network',
    label: 'TLS and certificates',
    description: 'The CA, client certificate and certificate folder. Paths, never key material.',
    keys: ['tls', 'certDir'],
    machineSpecific: true,
  },
  {
    id: 'workspace',
    label: 'Workspace behaviour',
    description: 'Mode, step cap, folders tools may read, and folders hidden from the @ picker.',
    keys: ['modeId', 'maxIterations', 'filesystem'],
    machineSpecific: true,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Accent colour, expert colour, and light or dark.',
    keys: ['ui'],
  },
]

/**
 * Config keys no section owns, so nothing can be shared by having been forgotten.
 *
 * The export is built from `SHARE_SECTIONS`, so a key added to the schema and to no section is
 * simply never exported — which is the safe direction. This list exists so `share.test.ts` can
 * tell "deliberately excluded" from "nobody has looked at this yet", and fail on the second.
 */
export const NEVER_SHARED: readonly (keyof LightCodeConfig)[] = [
  /*
   * Which shell commands have been approved, keyed by workspace path. Importing somebody else's
   * would pre-approve commands on this machine that nobody here has read — invariant 5's exact
   * threat, arriving through a file a colleague sent rather than through a repository.
   */
  'approvals',
  /*
   * Per-project settings keyed by absolute path. They would land on paths that do not exist here,
   * and where a path did happen to match they would silently redirect that project.
   */
  'workspaces',
  // Labels everything this machine writes to a shared index. Importing one attributes your work
  // to somebody else, and nothing downstream would ever question it (§12e).
  'identity',
]

export interface SectionSummary {
  id: ShareSectionId
  label: string
  description: string
  /** Whether this config has anything at all under those keys. */
  present: boolean
  /** "3 providers", "2 MCP servers" — what the panel shows beside the checkbox. */
  detail: string
  machineSpecific?: boolean
  offByDefault?: boolean
  /** What this section deliberately leaves out, when it leaves anything out. */
  stripNote?: string
  /**
   * Secret references this section carries.
   *
   * Names, never values — there are no values here to leak (§15). Shown on export as "the
   * importer will have to enter these", and on import as "enter these before it will work".
   */
  secretRefs: string[]
}

function has(config: LightCodeConfig, key: keyof LightCodeConfig): boolean {
  const value = config[key]
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/** A plural-safe count, because "1 providers" reads as a bug in the panel. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${String(n)} ${n === 1 ? singular : plural}`
}

/**
 * What a section holds, for the chooser.
 *
 * Counted from the config rather than described in the section table, because the number is the
 * part somebody actually decides on — "Providers" is a category and "3 providers, 2 needing keys"
 * is a decision.
 */
function detailFor(section: ShareSection, config: LightCodeConfig): string {
  switch (section.id) {
    case 'profiles':
      return count((config.profiles ?? []).length, 'provider')
    case 'mcpServers':
      return count(Object.keys(config.mcpServers ?? {}).length, 'server')
    case 'search': {
      const stores = Object.keys(config.vectorStores ?? {}).length
      const embedder = config.embedder === undefined ? '' : ', embedder'
      return `${count(stores, 'store')}${embedder}`
    }
    case 'agents':
      return count(Object.keys(config.agents?.roles ?? {}).length, 'role')
    case 's3':
      return count((config.s3?.connections ?? []).length, 'connection')
    case 'confluence':
      return config.confluence?.baseUrl ?? 'not set up'
    case 'datasets':
      return count((config.datasets ?? []).length, 'dataset')
    case 'commands':
      return count((config.commands?.risky ?? []).length, 'rule')
    case 'schedules':
      return count(Object.keys(config.schedules ?? {}).length, 'schedule')
    case 'mail':
      return count((config.mail?.folders ?? []).length, 'folder')
    case 'skills':
      return count(
        (config.skills?.dir === undefined ? 0 : 1) + (config.skills?.paths ?? []).length,
        'folder',
      )
    default:
      return section.keys.filter((key) => has(config, key)).length > 0 ? 'set' : 'not set'
  }
}

/**
 * The secret references a section carries, so both ends can name what has to be re-entered.
 *
 * Enumerated explicitly rather than by walking the object for `*Ref` keys. A walk would be shorter
 * and would silently start reporting any future field whose name happened to end that way, while
 * silently missing one that did not — and this text is what somebody acts on, so being wrong in
 * either direction is worse than being long.
 */
function secretRefsFor(section: ShareSection, config: LightCodeConfig): string[] {
  const refs: string[] = []
  switch (section.id) {
    case 'profiles':
      for (const profile of config.profiles ?? []) {
        if (profile.auth.type === 'apiKey') refs.push(`${profile.label}: API key`)
        else if (profile.auth.type === 'apigeeMtls') refs.push(`${profile.label}: client secret`)
        if (profile.tls?.passphraseRef !== undefined) refs.push(`${profile.label}: key passphrase`)
      }
      break
    case 'search':
      for (const [id, store] of Object.entries(config.vectorStores ?? {})) {
        if (store.passwordRef !== undefined) refs.push(`${store.label || id}: password`)
      }
      /*
       * The embedder has no key of its own - it names a *profile*, and that profile's key is
       * already listed under Providers. Saying it twice would send somebody looking for a
       * credential that does not exist.
       */
      break
    case 's3':
      for (const connection of config.s3?.connections ?? []) {
        refs.push(`${connection.label}: secret access key`)
      }
      break
    case 'confluence':
      // Everyone brings their own: a token publishes under the name of whoever it belongs to.
      if (config.confluence?.tokenRef !== undefined) refs.push('Confluence: personal access token')
      break
    case 'network':
      if (config.tls?.passphraseRef !== undefined) refs.push('Global client key: passphrase')
      break
    case 'python':
      for (const [name, entry] of Object.entries(config.python?.env ?? {})) {
        // A plain string is a literal value and carries no reference; only the object form can
        // say `secret: true`, which is the one that lives in secret storage (§15).
        if (typeof entry === 'object' && entry.secret === true) refs.push(`Python env: ${name}`)
      }
      break
    default:
      break
  }
  return refs
}

/** Every section, described against a particular config. Sections with nothing in them included. */
export function describeSections(config: LightCodeConfig): SectionSummary[] {
  return SHARE_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    description: section.description,
    present: section.keys.some((key) => has(config, key)),
    detail: detailFor(section, config),
    secretRefs: secretRefsFor(section, config),
    ...(section.machineSpecific === true ? { machineSpecific: true } : {}),
    ...(section.offByDefault === true ? { offByDefault: true } : {}),
    ...(section.stripNote !== undefined ? { stripNote: section.stripNote } : {}),
  }))
}

/** What the chooser starts with: everything present, minus the ones that have to be asked for. */
export function defaultSelection(config: LightCodeConfig): ShareSectionId[] {
  return describeSections(config)
    .filter((section) => section.present && section.offByDefault !== true)
    .map((section) => section.id)
}

/**
 * The config to write out: only the selected sections' keys.
 *
 * Built by *copying in* what was chosen rather than deleting what was not. A delete-based version
 * would export any key nobody had thought about, which over the life of the schema means the
 * default drifts towards sharing everything — the opposite of what this exists for.
 */
export function buildExport(
  config: LightCodeConfig,
  selected: readonly ShareSectionId[],
): LightCodeConfig {
  const chosen = new Set(selected)
  const exported: Record<string, unknown> = {}
  for (const section of SHARE_SECTIONS) {
    if (!chosen.has(section.id)) continue
    for (const key of section.keys) {
      if (has(config, key)) exported[key] = config[key]
    }
    for (const path of section.strip ?? []) stripPath(exported, path)
  }
  return exported as LightCodeConfig
}

/**
 * Removes one dotted path from the export, copying on the way down.
 *
 * The copy is not incidental. `buildExport` assigns whole config values by reference, so deleting
 * in place would edit **the live configuration** — the export would work and the exporter would
 * quietly lose their own index name, discovering it the next time they indexed. Each level is
 * cloned only where something is actually being removed, so an untouched section still costs
 * nothing.
 *
 * A path that is not there is not an error: a section legitimately strips a key the exporter never
 * set, which is the ordinary case.
 */
function stripPath(target: Record<string, unknown>, path: string): void {
  const [head, ...rest] = path.split('.')
  if (head === undefined) return
  const value = target[head]
  if (value === undefined || value === null) return

  if (rest.length === 0) {
    delete target[head]
    return
  }
  if (typeof value !== 'object') return
  const copy = { ...(value as Record<string, unknown>) }
  stripPath(copy, rest.join('.'))
  target[head] = copy
}

/**
 * The config to save after an import: the existing one, with the selected sections replaced.
 *
 * **Replaced, not merged.** Merging a list — profiles, schedules, S3 connections — has no answer
 * to "is this the same entry as that one", and any answer it invented would either duplicate
 * everything on a second import or overwrite an entry the two happened to share an id for. A
 * section is a unit: take theirs or keep yours.
 *
 * Keys the incoming file does not have are **removed** from a selected section, for the same
 * reason. Half-taking a section would leave a state neither person has ever run.
 */
export function applyImport(
  existing: LightCodeConfig,
  imported: LightCodeConfig,
  selected: readonly ShareSectionId[],
): LightCodeConfig {
  const chosen = new Set(selected)
  const merged: Record<string, unknown> = { ...existing }
  for (const section of SHARE_SECTIONS) {
    if (!chosen.has(section.id)) continue
    for (const key of section.keys) {
      if (has(imported, key)) merged[key] = imported[key]
      else delete merged[key]
    }
    /*
     * Whatever is stripped on the way out is *preserved* on the way in, and the symmetry is the
     * point rather than tidiness.
     *
     * A section is replaced whole, so importing a colleague's search settings would otherwise
     * delete the importer's own index name along with everything else — and their collection
     * would silently be re-derived from the workspace hash, orphaning the index they had already
     * built. Neither direction may touch the names that identify a person.
     */
    for (const path of section.strip ?? []) {
      carryPath(existing as Record<string, unknown>, merged, path)
    }
  }
  return merged as LightCodeConfig
}

/** Copies one dotted path from `from` into `to`, copying on the way down as `stripPath` does. */
function carryPath(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  path: string,
): void {
  const [head, ...rest] = path.split('.')
  if (head === undefined) return
  const source = from[head]

  if (rest.length === 0) {
    // Absent in the original stays absent: carrying `undefined` across would write the key.
    if (source !== undefined) to[head] = source
    return
  }
  if (typeof source !== 'object' || source === null) return

  const target = to[head]
  const copy = typeof target === 'object' && target !== null ? { ...(target as Record<string, unknown>) } : {}
  carryPath(source as Record<string, unknown>, copy, rest.join('.'))
  // Only written back when something was actually carried, so an import that brought no
  // `retrieval` at all does not gain an empty one.
  if (Object.keys(copy).length > 0) to[head] = copy
}
