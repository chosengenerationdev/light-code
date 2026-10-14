import type { Tool } from './types.js'

/**
 * Built-in tools that move out of the prompt into the documentation index when one exists.
 *
 * Measured (2026-10-10): with every integration switched on, the advertised tool block was about
 * 33,000 tokens on every request - a quarter of a 128k window before the conversation starts, and most
 * of a self-hosted 32k one. Most of it is tools a given conversation never touches: Excel, Outlook,
 * Jira, Jenkins and the rest.
 *
 * **Offloaded only when a documentation index is configured** (the user's rule: "if no search indexing
 * is configured, following existing setup would be better"). Without an index `search_docs` can only
 * match names, and hiding a tool behind a name match trades context for the risk that the agent never
 * finds it. With one, the full documentation of every tool lives in the index and `search_docs` returns
 * the steps and the live schema - the prompt carries only `offloadedCatalogue`, which names every
 * hidden tool, because an agent that does not know a tool exists will not search for it.
 *
 * The prompt stays byte-stable within a session either way (§12): what is hidden depends on the
 * configuration, never on the turn.
 *
 * Kept advertised on purpose: the file, edit and command tools, the Rust file readers, asking and
 * finishing, help, charts and diagrams, planning and the expert - the tools nearly every conversation
 * reaches for. Listed here by family, so a new tool in a family is offloaded with it.
 */
export interface OffloadFamily {
  label: string
  /** What the family is for, in a few words, so the agent can tell when to look. */
  about: string
  matches: (name: string) => boolean
}

const named =
  (...names: string[]) =>
  (name: string): boolean =>
    names.includes(name)

export const OFFLOAD_FAMILIES: readonly OffloadFamily[] = [
  { label: 'Excel', about: 'open, read, trace, recalculate, write and save workbooks; read, check, write and run VBA', matches: (n) => n.startsWith('excel_') },
  {
    label: 'Outlook and mail',
    about: 'search and read mail, draft messages, open a message; the indexed mailbox and its patterns',
    matches: (n) => n.startsWith('outlook_') || n.startsWith('mail_') || n === 'open_email' || n === 'search_mail',
  },
  { label: 'Confluence', about: 'search, read and write pages, with attachments and diagrams', matches: (n) => n.startsWith('confluence_') },
  { label: 'Jira', about: 'search, read, create and update issues; project fields', matches: (n) => n.startsWith('jira_') },
  { label: 'Bitbucket', about: 'pull requests, files at a branch, comments, merge and tag', matches: (n) => n.startsWith('bitbucket_') },
  { label: 'Jenkins', about: 'jobs, builds, logs, queue, start, stop and replay a Jenkinsfile', matches: (n) => n.startsWith('jenkins_') },
  { label: 'AutoSys', about: 'job status, definitions, logs, dependencies, events and JIL', matches: (n) => n.startsWith('autosys_') },
  { label: 'JupyterHub', about: 'run code and inspect libraries on the hub, sync files, browse it', matches: (n) => n.startsWith('hub_') },
  { label: 'S3 buckets', about: 'list, read, download and upload files', matches: (n) => n.startsWith('s3_') },
  { label: 'APIs and messaging', about: 'call a REST API; open or send a Teams message', matches: named('http_request', 'teams_open_chat') },
  {
    label: 'Data and files',
    about: 'SQL, grouping and pivots over CSV/Excel/clipboard; SQLite; filter a table; copy, move and zip files',
    matches: named('dataframe', 'query_sqlite', 'query_table', 'transfer_files', 'archive_files'),
  },
  {
    label: 'Python',
    about: 'call a Python library many times in parallel; create, update, delete tools; install packages',
    matches: named('python_library', 'create_python_tool', 'update_python_tool', 'delete_python_tool', 'install_python_packages'),
  },
  {
    label: 'Search indexes and collectors',
    about: 'query an OpenSearch index directly, collected data, colleagues’ skills; data collectors',
    matches: named('search_opensearch', 'search_data', 'search_team_skills', 'create_collector_tool', 'check_collector'),
  },
  {
    label: 'Usage statistics',
    about: 'the team usage dashboard as data - who uses which skill or tool, authors, unused and duplicates; record who the user is',
    matches: named('usage_stats', 'record_user_profile'),
  },
  {
    label: 'Skills and schedules',
    about: 'copy a skill’s template file, delete a skill, schedule a prompt, export the configuration',
    matches: named('use_skill_file', 'delete_skill', 'schedule_prompt', 'light_code_export_config'),
  },
]

export function offloadFamilyOf(name: string): OffloadFamily | undefined {
  return OFFLOAD_FAMILIES.find((family) => family.matches(name))
}

export function isOffloadable(name: string): boolean {
  return offloadFamilyOf(name) !== undefined
}

/**
 * The prompt section that keeps hidden tools known: every hidden built-in by name, grouped by family,
 * and how to reach them. A few hundred tokens where the schemas were tens of thousands.
 *
 * `otherHidden` counts hidden tools outside the families (MCP servers, the user's Python tools), which
 * are too many to name and are found the same way.
 */
export function offloadedCatalogue(hidden: readonly Tool[] | readonly string[], otherHidden = 0): string | undefined {
  const names = hidden.map((tool) => (typeof tool === 'string' ? tool : tool.name))
  const lines: string[] = []
  for (const family of OFFLOAD_FAMILIES) {
    const members = names.filter((name) => family.matches(name)).sort()
    if (members.length > 0) lines.push(`- **${family.label}** (${family.about}): ${members.join(', ')}`)
  }
  if (lines.length === 0 && otherHidden === 0) return undefined
  return [
    '## More tools you have (documented in the search index)',
    'These tools are available to you but their full instructions are kept in the documentation index, not in',
    'this prompt. **Before using any of them - and before planning a multi-step job in one of these areas -',
    'call `search_docs` describing what you need to do** (for example "create a Jira issue with an attachment").',
    'It returns the relevant steps and each tool’s exact parameters. Then call the tool with',
    '`call_tool(name, arguments)`. Never guess parameters for a tool you have not looked up.',
    ...lines,
    ...(otherHidden > 0
      ? [`- **Also**: ${String(otherHidden)} more tool(s) from MCP servers and your own Python tools, found the same way with \`search_docs\`.`]
      : []),
  ].join('\n')
}
