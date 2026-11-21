import { isPackageRunnerCommand, type McpServerConfig } from '../mcp/types.js'

/**
 * The rules that keep a web-chat consultation inside the organisation - asked for: "it shouldnt go outside [the organisation] at any stage,
 * please make sure of it even if we are going to use chrome mcp, i dont want agent to go rougue to get gemini from
 * outside office". Each is checked before every consultation, not only at setup; any one failing means nothing is
 * sent, and the reason is said.
 *
 * 1. The Chrome DevTools MCP server runs on this PC, never as a remote (URL) server. From an installed copy, or with
 *    npx with a pinned version (asked for: "npx downloads from internal artifactory") so no unreviewed version slips in;
 *    the registry npx downloads from is shown to the user. Other package runners are refused.
 * 2. It runs with its own reporting off: `--no-usage-statistics` (usage statistics to Google) and
 *    `--no-performance-crux` (page addresses to Google's CrUX service).
 * 3. It attaches only to a Chrome on this PC (`--browserUrl` / `--wsEndpoint` on loopback, or `--autoConnect`).
 * 4. The web chat page is the address the user typed, and consultations go only to the backend address they approved
 *    (rule 5). An earlier rule refused any host resolving to a public IP; it was removed at the user's request - the
 *    office's internal sites resolve to a range that looks public but is theirs - leaving the approved address as
 *    the boundary.
 * 5. (In the page) the request goes to that same site only, with redirects refused, and the reply must come from it.
 * 6. (In the bridge) the agent is never given the Chrome server's own tools - it cannot navigate Chrome anywhere; the
 *    only way to Chrome is `ask_web_chat`, which only replays the captured request.
 */

export const REQUIRED_CHROME_FLAGS = ['--no-usage-statistics', '--no-performance-crux'] as const

/** The package an npx command runs (`chrome-devtools-mcp@1.13.0`), skipping npx's own options. */
export function npxPackage(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (arg === '-p' || arg === '--package') return args[i + 1]
    if (arg.startsWith('--package=')) return arg.slice('--package='.length)
    if (arg.startsWith('-')) continue
    return arg
  }
  return undefined
}

/** A package spec with an exact version (`name@1.2.3`), not `@latest`, a range, or none. */
export function isPinned(spec: string): boolean {
  return /^(@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(spec)
}

/**
 * What is wrong with a Chrome DevTools MCP server entry for the web chat; empty when it may be used.
 */
export function chromeServerProblems(config: McpServerConfig | undefined): string[] {
  if (config === undefined) return ['No Chrome DevTools MCP server is configured.']
  const record = config as { command?: string; args?: string[]; url?: string }
  if (typeof record.url === 'string' || typeof record.command !== 'string') return ['The Chrome DevTools MCP server must run on this PC (a command), not as a remote server at a URL.']
  const problems: string[] = []
  /*
   * The command line as the shell will see it - reported: the flags were "already included" and still reported missing.
   * The MCP form keeps one argument per line, so arguments typed on one line (or the whole line typed as the command)
   * arrive as one string, which Windows re-splits when it starts the server. Read the same way here.
   */
  const words = commandWords([record.command, ...(record.args ?? [])].join(' '))
  const command = words[0] ?? record.command
  const args = words.slice(1)
  const runner = command.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (runner === 'npx' || runner === 'npx.cmd') {
    const spec = npxPackage(args)
    if (spec === undefined || !isPinned(spec)) {
      problems.push(`With npx the version must be pinned (e.g. chrome-devtools-mcp@1.13.0, not ${spec ?? 'no version'}), so an unreviewed new version is never run.`)
    }
  } else if (isPackageRunnerCommand(command)) {
    problems.push(`It is started with ${command}, which downloads the package each start. Use npx (with a pinned version and the organisation's registry) or an installed copy.`)
  }
  for (const flag of REQUIRED_CHROME_FLAGS) if (!args.includes(flag)) problems.push(`Its arguments must include ${flag}.`)
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    const inline = /^--?(browserUrl|browser-url|u|wsEndpoint|ws-endpoint|w)=(.+)$/.exec(arg)
    const value = inline?.[2] ?? (/^--?(browserUrl|browser-url|u|wsEndpoint|ws-endpoint|w)$/.test(arg) ? args[i + 1] : undefined)
    if (value === undefined) continue
    try {
      const host = new URL(value).hostname.replace(/^\[|\]$/g, '')
      if (!isLoopback(host)) problems.push(`It must attach to a Chrome on this PC; ${value} is not.`)
    } catch {
      problems.push(`${value} is not an address of a Chrome on this PC.`)
    }
  }
  return problems
}

/** A command line split into words the way a shell does: on spaces, keeping "quoted parts" together. */
export function commandWords(line: string): string[] {
  const words: string[] = []
  for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3] ?? '')
  return words
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

/** Why a web chat page address cannot be used, or undefined: it must be an http(s) web address. */
export function webChatAddressProblem(pageUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(pageUrl)
  } catch {
    return `${pageUrl} is not a web address.`
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The web chat address must start with https:// (or http://).'
  return undefined
}
