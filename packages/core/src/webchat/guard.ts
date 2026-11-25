import { isPackageRunnerCommand, stdioCommandLine, type McpServerConfig } from '../mcp/types.js'

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
   * The program and arguments exactly as the server is started with them (`stdioCommandLine`, the same function the MCP
   * client uses): several options on one line are split there, so they are read split here. Before, the check and the
   * launch disagreed both ways round - once the check read a line as several flags the server then ignored, once it
   * refused a line the person had typed as they meant it.
   */
  const { command, args } = stdioCommandLine({ command: record.command, args: record.args ?? [] })
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


/** The version of chrome-devtools-mcp the web chat was tested against end to end; used when a fix must pin one. */
export const TESTED_CHROME_MCP = 'chrome-devtools-mcp@1.13.0'

/**
 * The server entry with what the web chat needs added, for the panel's "Fix it for me": options typed on one line split
 * one per line, the reporting-off flags added, `--autoConnect` added when it attaches to no Chrome (so it uses the
 * person's own, signed-in Chrome rather than starting another), and an unpinned npx package pinned to the tested
 * version. Undefined when it cannot be fixed this way (a remote server, another package runner, a Chrome elsewhere).
 */
export function fixChromeServer(config: McpServerConfig | undefined): McpServerConfig | undefined {
  if (config === undefined) return undefined
  const record = config as { command?: string; args?: string[]; url?: string }
  if (typeof record.url === 'string' || typeof record.command !== 'string') return undefined
  const line = stdioCommandLine({ command: record.command, args: record.args ?? [] })
  const args = [...line.args]
  const runner = line.command.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (runner === 'npx' || runner === 'npx.cmd') {
    const spec = npxPackage(args)
    if (spec === undefined) return undefined
    if (!isPinned(spec)) {
      if (!/^chrome-devtools-mcp(@[^@]*)?$/.test(spec)) return undefined
      args[args.indexOf(spec)] = TESTED_CHROME_MCP
    }
    if (!args.includes('-y') && !args.includes('--yes')) args.unshift('-y')
  } else if (isPackageRunnerCommand(line.command)) {
    return undefined
  }
  // Which Chrome it uses is left as it was: that is the person's choice ("Which Chrome", `withChromeMode`), and
  // --autoConnect only works once remote debugging is switched on in their Chrome.
  for (const flag of REQUIRED_CHROME_FLAGS) if (!args.includes(flag)) args.push(flag)
  const fixed = { ...(config as object), command: line.command, args } as McpServerConfig
  return chromeServerProblems(fixed).length === 0 ? fixed : undefined
}

const AUTO_CONNECT = /^--?(autoConnect|auto-connect)(=true)?$/
const NAMES_CHROME = /^--?(browserUrl|browser-url|u|wsEndpoint|ws-endpoint|w)(=|$)/

/**
 * Which Chrome the server uses: `own` - the person's own Chrome (`--autoConnect`; Chrome 144+, with remote debugging
 * switched on at chrome://inspect/#remote-debugging); `started` - a Chrome the server opens itself, on a profile of its
 * own that keeps the sign-in (only one copy of the server at a time); `address` - a Chrome named by address.
 */
export function chromeMode(config: McpServerConfig | undefined): 'own' | 'started' | 'address' | undefined {
  const record = config as { command?: string; args?: string[] } | undefined
  if (record === undefined || typeof record.command !== 'string') return undefined
  const { args } = stdioCommandLine({ command: record.command, args: record.args ?? [] })
  if (args.some((arg) => NAMES_CHROME.test(arg))) return 'address'
  return args.some((arg) => AUTO_CONNECT.test(arg)) ? 'own' : 'started'
}

/** The entry set to use the person's own Chrome or one it starts (`chromeMode`); arguments split one per line. */
export function withChromeMode(config: McpServerConfig, mode: 'own' | 'started'): McpServerConfig | undefined {
  const record = config as { command?: string; args?: string[] }
  if (typeof record.command !== 'string' || chromeMode(config) === 'address') return undefined
  const line = stdioCommandLine({ command: record.command, args: record.args ?? [] })
  const args = line.args.filter((arg) => !AUTO_CONNECT.test(arg))
  if (mode === 'own') args.push('--autoConnect')
  return { ...(config as object), command: line.command, args } as McpServerConfig
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
