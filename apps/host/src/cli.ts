#!/usr/bin/env node
/**
 * Replaced at build time by esbuild's `define` with the version from `package.json`.
 *
 * Declared rather than imported: the bundle has no manifest beside it to read, which is the same
 * reason the operator guide and the Python worker are inlined. The fallback is a visible string
 * rather than a plausible number, because a *wrong* version is worse than an obviously absent one
 * — the entire reason anybody asks is to find out whether they are on the copy they think.
 */
declare const __LC_VERSION__: string | undefined
const VERSION =
  typeof __LC_VERSION__ === 'string' ? __LC_VERSION__ : 'unknown (not a packaged build)'

/*
 * First, and before anything that might read a web global at import time.
 *
 * A dependency written against Node 18 that captures `fetch` or `ReadableStream` at module scope
 * would capture the absence instead, and fail later with a ReferenceError naming nothing in this
 * repository. `nodeCompat.test.ts` asserts this import stays at the top.
 */
import { installNodeCompat } from './nodeCompat.js'
import { publicAddressFor, publicLaunchUrl } from './publicUrl.js'

const compat = installNodeCompat()

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import envPaths from 'env-paths'
import { describeProxyEnvironment } from '@light-code/core'
import type { IdentityProvider } from './identity.js'
import { PythonToolIdentity, resolveIdentity } from './identityTool.js'
import { ProxyHeaderIdentity, validateTrustedProxies } from './proxyIdentity.js'
import { adminListPolicy } from './roles.js'
import { OPERATOR_GUIDE } from './generated/operatorGuide.js'
import { guidePage } from './guideHtml.js'
import { renderGuide } from './guideText.js'
import { SharedConfigStore } from './sharedConfig.js'
import { startServer } from './server.js'

/**
 * The line of a failure that actually says what went wrong.
 *
 * A Python traceback ends with the useful sentence and begins with a header; taking the first
 * line printed "The identity function failed:" and nothing else, which is a banner telling the
 * reader only that they must go and look somewhere else.
 */
function lastMeaningfulLine(problem: string): string {
  const lines = problem
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith(':'))
  return lines[lines.length - 1] ?? problem.trim()
}

/**
 * `npx light-code` — starts a local server and opens the system browser.
 *
 * Loopback and single-user by default. `--server` shares it, which changes one thing:
 * **configuration becomes read-only for everyone except the administrators named on the
 * command line**.
 *
 * **`--server` does not make multi-user hosting safe.** Every user's shell commands, MCP
 * servers and Python tools still run as *this process's* account, over this account's files.
 * Locking configuration stops a user repointing the gateway or spawning a server of their
 * choosing; it does not stop them reading anything this account can read. §14's real fix — one
 * OS account or container per session — is still not built, and `docs/hosting.md` says so in
 * those terms.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage())
    return
  }

  /*
   * The operator guide, from the terminal.
   *
   * Printed rather than opened in a browser: this is read while setting a server up, frequently
   * over SSH on a box with no browser and often piped into `less`. It is the same document as
   * `docs/hosting.md`, baked into the bundle so it exists in a published install where there is
   * no `docs/` directory at all.
   */
  if (args.includes('--guide')) {
    /*
     * A page, because a guide is something you read and a wall of markdown in a console is the
     * format people were trying to get away from.
     *
     * Written to a temp file and opened with the OS handler rather than served: no port, no
     * process left running, and it works with no network at all — which matters, because the
     * deployment this guide is written for is frequently airgapped.
     *
     * `--no-open` still prints, which is the right answer over SSH and when piping into a pager.
     */
    if (args.includes('--no-open')) {
      process.stdout.write(renderGuide(process.stdout.isTTY === true))
      process.stdout.write('\n')
      return
    }
    const file = path.join(os.tmpdir(), 'light-code-guide.html')
    await fs.writeFile(file, guidePage(OPERATOR_GUIDE), 'utf8')
    process.stdout.write(`Opening the guide: ${file}\n(--guide --no-open prints it instead.)\n`)
    openBrowser(pathToFileURL(file).href)
    return
  }

  /*
   * An unrecognised flag is reported, not ignored.
   *
   * A stale `npx` cache served a version that predated `--server`, which accepted the flag
   * silently and started in single-user mode — so the operator believed configuration was
   * locked when it was not. A flag that does nothing is worse than one that errors, and worse
   * still when the thing it was supposed to do is a restriction.
   */
  /*
   * Answered before anything else, including the unknown-flag check.
   *
   * It is the one question worth asking *because* something else went wrong, so it must work on a
   * copy too old to understand whatever else was typed.
   */
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  const unknown = args.filter((arg) => arg.startsWith('--') && !KNOWN_FLAGS.has(arg))
  if (unknown.length > 0) {
    process.stderr.write(
      `light-code: unknown option${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}\n` +
        `If you expected this to work, you may be on an older cached copy. This one is ` +
        `${VERSION}. Try:\n  npx @chosengeneration/light-code@latest --help\n`,
    )
    process.exit(2)
  }

  /*
   * `--admin` changed meaning, so the old form is an error rather than a reinterpretation.
   *
   * It used to take an id — `--admin alice` named an administrator. It is now a boolean that
   * opens the administrator's URL, and ids moved to `--admin-id`. Silently accepting the old
   * spelling would name nobody and open admin mode instead, which is the precise failure this
   * CLI already learned once with an unknown flag: something that quietly does the wrong thing
   * beats something that errors, only for the person who wrote it.
   */
  const strayAdminValue = valuesOf(args, '--admin')
  if (strayAdminValue.length > 0) {
    process.stderr.write(
      `light-code: --admin no longer takes a value.\n` +
        `  --admin           opens the administrator's interface\n` +
        `  --admin-id <id>   names an administrator (repeatable)\n` +
        `Did you mean: --admin-id ${strayAdminValue.join(' --admin-id ')}\n`,
    )
    process.exit(2)
  }

  const serverMode = args.includes('--server')
  const adminMode = args.includes('--admin')
  const adminIds = valuesOf(args, '--admin-id')
  const trustedProxies = valuesOf(args, '--trust-proxy')
  const userHeader = valueOf(args, '--user-header')
  /*
   * Who this server is running as, according to a function the operator wrote.
   *
   * Requested for an environment whose own libraries are the only thing that knows. See
   * `identityTool.ts` for why it runs here, before any session, rather than as a registered tool:
   * the tool registry lives behind per-user config, and reading the config of a user you have not
   * identified yet has no good end.
   */
  const identityTool = valueOf(args, '--identity-tool')
  const identityPython = valueOf(args, '--identity-python') ?? 'python3'
  /*
   * Where credentials come from, when the environment's own libraries hold them.
   *
   * A secret store source rather than a tool the assistant can call: the places that need a
   * credential are the gateway key, a search cluster's username and password, a certificate
   * passphrase and an MCP server's environment, and every one of those already resolves through
   * `SecretStore`. A tool the model called would put the password in the transcript.
   */
  const credentialTool = valueOf(args, '--credential-tool')
  const credentialPython = valueOf(args, '--credential-python') ?? identityPython
  const workspaceRoot = path.resolve(valueOf(args, '--workspace') ?? process.cwd())
  const dataDir = valueOf(args, '--data-dir') ?? envPaths('light-code', { suffix: '' }).data
  const port = Number.parseInt(valueOf(args, '--port') ?? '0', 10)
  /*
   * How long the launch URL lives.
   *
   * Ten seconds suits a browser that opens itself. It is far too short when the URL has to be
   * carried by hand — into another application, a remote session, a phone — which is the case
   * this exists for. Capped at ten minutes: the token rides in a URL fragment that lands in shell
   * history and terminal scrollback, so a longer window is a longer time in which somebody reading
   * that can use it before you do.
   */
  /*
   * Serves with no bearer token at all.
   *
   * Asked for, to run locally without the launch-link exchange. Origin and Host are still
   * enforced — those are what stop a page in another tab posting to 127.0.0.1, and they are not
   * what this turns off. What it does turn off is the defence against another *process* on this
   * machine driving the agent, which §3 already declines to guarantee.
   */
  const noToken = args.includes('--no-token')
  /*
   * Names and origins to answer to beyond the ones the machine can work out for itself.
   *
   * Repeatable, like `--admin-id`. Needed for anything not derivable from this machine — a
   * reverse proxy, a container alias, or the app embedding this in an iframe.
   */
  const publicUrl = valueOf(args, '--public-url')
  const allowHosts = valuesOf(args, '--allow-host')
  const allowOrigins = valuesOf(args, '--allow-origin')
  const handoffSeconds = Math.min(
    600,
    Math.max(1, Number.parseInt(valueOf(args, '--handoff-seconds') ?? '10', 10) || 10),
  )
  /*
   * Still loopback unless asked otherwise, even in server mode. `--server` is about who owns
   * the settings; exposing the port is a separate decision that has to be made explicitly,
   * because binding every interface by accident is not a mistake anyone recovers from quietly.
   */
  const bindAddress = valueOf(args, '--bind')
  // A shared server has no browser to open on the machine it runs on.
  const noOpen = args.includes('--no-open') || serverMode

  /*
   * Shared mode needs real users, and the only source of those is the proxy in front. Refusing
   * to start without a trusted address is deliberate: the alternative is a server that appears
   * to have per-user settings while resolving everyone to the same person, which would silently
   * put one user's keys in front of another and look like it was working.
   */
  let identity: IdentityProvider | undefined
  let identityProblem: string | undefined

  if (identityTool !== undefined) {
    const resolved = await resolveIdentity({ interpreter: identityPython, file: identityTool })
    if (resolved.principal !== undefined) {
      identity = new PythonToolIdentity(resolved.principal, identityTool)
    } else {
      /*
       * Started anyway, and said loudly.
       *
       * Refusing to start would be defensible, but this function reaches libraries that are not
       * always up, and a server that will not come back because a lookup was briefly unavailable
       * is a worse failure than one that comes back saying exactly what is wrong. Storage falls
       * back to the ordinary single-user path, and the banner says so, so nobody concludes their
       * settings were lost when they were written somewhere else.
       */
      identityProblem = resolved.problem
    }
  }

  if (serverMode) {
    const bad = validateTrustedProxies(trustedProxies)
    if (bad.length > 0) {
      process.stderr.write(`light-code: --trust-proxy is not an IP address: ${bad.join(', ')}
`)
      process.exit(2)
    }
    if (trustedProxies.length === 0) {
      process.stderr.write(
        'light-code: --server needs --trust-proxy <address of your reverse proxy>.\n' +
          'Users are identified by a header the proxy sets, and a header is only believable\n' +
          'from an address you name — anything that can reach this port can type one.\n',
      )
      process.exit(2)
    }
    // A shared server has many users and the proxy is the only thing that can tell them apart,
    // so it wins over a function that answers for the process as a whole.
    identity = new ProxyHeaderIdentity({
      trustedProxies,
      ...(userHeader !== undefined ? { userHeader } : {}),
    })
  }

  /*
   * The administrator's own settings, beside the per-user directories rather than inside one.
   *
   * `--admin-id` seeds the list on every start and the interface can add to it. The command line
   * wins at startup deliberately: an operator who has locked themselves out needs a way back that
   * does not require the interface they cannot reach.
   */
  const sharedConfig = new SharedConfigStore(path.join(dataDir, 'shared.json'))
  const shared = await sharedConfig.load()
  const effectiveAdminIds = [...new Set([...shared.adminIds, ...adminIds])]
  if (adminIds.length > 0 && effectiveAdminIds.length !== shared.adminIds.length) {
    await sharedConfig.save({ adminIds: effectiveAdminIds })
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  const server = await startServer({
    workspaceRoot,
    dataDir,
    clientDir: path.join(here, 'client'),
    ripgrepPath: resolveRipgrep(),
    ...(credentialTool !== undefined
      ? { credentialTool: { interpreter: credentialPython, file: credentialTool } }
      : {}),
    handoffSeconds,
    noToken,
    /*
     * A stated public address is trusted as a name and an origin.
     *
     * Otherwise `--public-url` would print a link that the server then refuses: the Host check
     * exists to catch DNS rebinding, and a proxy legitimately forwards the name the browser used.
     * Somebody who typed the address is telling us it is theirs, which is the same statement
     * `--allow-host` makes and this saves them making it twice.
     */
    allowHosts: [...allowHosts, ...trustedFromPublicUrl(publicUrl).hosts],
    allowOrigins: [...allowOrigins, ...trustedFromPublicUrl(publicUrl).origins],
    /*
     * A lapsed link is replaced rather than ending the session.
     *
     * Before this the only way back from pasting a URL a few seconds late was to stop the server
     * and start it again, losing the conversation and anything running with it. The fresh link is
     * printed to this terminal, which is where the first one was printed, so it reaches nobody it
     * had not already reached.
     *
     * Printed with a sentence, because a URL appearing on its own reads as the server having
     * restarted itself.
     */
    onHandoffLapsed: (reason) => {
      const fresh = server.newLaunchUrl?.()
      if (fresh === undefined) return
      process.stdout.write(
        `\n  That link ${reason === 'expired' ? 'expired' : 'had already been used'}. ` +
          `Here is a fresh one, good for ${String(handoffSeconds)} seconds:\n  ${fresh}\n\n`,
      )
    },
    port: Number.isNaN(port) ? 0 : port,
    ...(serverMode ? { roles: adminListPolicy(effectiveAdminIds), sharedConfig } : {}),
    ...(identity !== undefined ? { identity } : {}),
    ...(bindAddress !== undefined ? { bindAddress } : {}),
  })

  // The token is in the fragment, which the browser never sends to the server — that is
  // what makes it usable as a one-time handoff. It is single-use and expires in 10s.
  const launchUrl = `${server.url}${adminMode ? '/admin' : ''}/#t=${server.launchToken ?? ''}`
  /*
   * Where a browser can actually reach this, which on a server is rarely where it binds.
   *
   * Reported from a JupyterHub host: the banner printed 127.0.0.1, there is no browser on that
   * machine, and the only way out was the hub's proxy at `/user/<name>/proxy/<port>/` — which the
   * user had to have a script written to discover. JupyterHub tells every process it starts where
   * it lives, so this is derivable rather than something to reconstruct.
   */
  const publicAddress = publicAddressFor(new URL(server.url).port === '' ? 80 : Number(new URL(server.url).port), {
    ...(publicUrl !== undefined ? { publicUrl } : {}),
    env: process.env,
  })
  process.stdout.write(
    `\nLight Code ${VERSION}\n  workspace  ${workspaceRoot}\n  data       ${dataDir}\n  listening  ${server.url}\n`,
  )
  /* What to hand the reader: the public address when one was found, the bound one otherwise. */
  const reachableUrl =
    publicAddress === undefined
      ? noToken
        ? server.url
        : launchUrl
      : publicLaunchUrl(publicAddress, adminMode, noToken ? '' : (server.launchToken ?? ''))

  if (publicAddress !== undefined) {
    process.stdout.write(
      `  open       ${reachableUrl}
` +
        `             via ${publicAddress.source}
`,
    )
  }
  if (noToken) {
    /*
     * Printed every start rather than only when the flag is typed.
     *
     * The choice is made once and the server then listens for days. Somebody who turned this
     * on to get past a launch link on Monday is not thinking about it on Thursday, and a
     * line in the banner is the only thing that will still be in front of them.
     */
    process.stdout.write(
      `  auth       none — --no-token. Any program on this machine can drive this
` +
        `             server as you. Origin and Host are still checked, so a web page
` +
        `             cannot. Stop it when you are done.
`,
    )
  }
  /*
   * Said only when something was actually supplied, which on Node 18 and above is never.
   *
   * A line nobody needs is noise; a session behaving oddly on an old runtime should be
   * diagnosable from the banner rather than by working out which Node the user has.
   */
  if (compat.installed.length > 0) {
    process.stdout.write(
      `  node       ${compat.nodeVersion} — supplied ${String(compat.installed.length)} web global(s) Node 18 makes standard
`,
    )
  }
  /*
   * Said when the machine has a proxy configured, because that is the line that would have saved
   * a long hunt.
   *
   * Reported: every other process on a Linux server reached the gateway and this one hung.
   * `undici` ignores these variables where curl, wget and pip honour them, so we were the only
   * program going direct into a firewall that drops rather than refuses. It is honoured now — and
   * saying so on every start means the next person can see in one line which way their traffic is
   * going, instead of inferring it from a spinner.
   */
  const proxyLine = describeProxyEnvironment()
  if (proxyLine !== undefined) {
    process.stdout.write(`  proxy      ${proxyLine}\n`)
  }

  /*
   * Said on every start when a tool is configured, working or not.
   *
   * Which user your settings are filed under is not something to have to deduce, and the case
   * that matters is the one where the lookup failed: the fallback is a different directory, and
   * somebody whose configuration appears empty should be able to see why in the same place they
   * saw it come up.
   */
  if (identityTool !== undefined) {
    if (identityProblem === undefined) {
      process.stdout.write(`  user       ${identity?.describe ?? 'resolved'}\n`)
    } else {
      process.stdout.write(
        `  user       could not be resolved from ${path.basename(identityTool)} — using the ` +
          `local default\n             ${lastMeaningfulLine(identityProblem)}\n`,
      )
    }
  }

  /*
   * Said when one is configured, because "where do my passwords come from" should not have to be
   * deduced from which flags were typed. The file it names, not its contents: this line goes to a
   * terminal and frequently into a log.
   */
  if (credentialTool !== undefined) {
    process.stdout.write(
      `  secrets    ${path.basename(credentialTool)} — values stored as tool:<name> are fetched from it
`,
    )
  }

  if (serverMode) {
    const who =
      effectiveAdminIds.length === 0
        ? 'nobody — no --admin-id was given, so configuration is frozen'
        : `${String(effectiveAdminIds.length)} administrator(s)`
    process.stdout.write(`  mode       shared — settings are read-only except for ${who}\n`)
    /*
     * Printed on every start rather than left to the docs. An operator sharing this needs
     * to know that locking settings is not isolation *before* anyone else logs in.
     */
    process.stdout.write(
      `\n  Shared mode locks settings, not privileges: every user's commands run as this\n` +
        `  account, over this account's files. See docs/hosting.md before sharing it.\n`,
    )
  }
  process.stdout.write('\n')
  /*
   * Two different things to say, because the two modes hand off differently.
   *
   * Shared mode has no handoff token — the proxy authenticates every request — so printing one
   * meant printing `#t=` with nothing after it and telling the operator to paste it within ten
   * seconds. Instructions for a mechanism that is not running are worse than none: they send
   * someone looking for a token that was never minted.
   */
  if (serverMode) {
    process.stdout.write(
      `  users          ${server.url}/\n` +
        `  administrators ${server.url}/admin\n\n` +
        `Both go through your proxy. Anyone reaching /admin directly is an administrator.\n\n`,
    )
  } else {
    process.stdout.write(
      /*
       * No deadline where there is no token.
       *
       * The same flaw this file already records for shared mode, arriving through a different
       * door: printing `#t=` with nothing after it and telling somebody to paste it within ten
       * seconds sends them looking for a token that was never minted. Instructions for a
       * mechanism that is not running are worse than none.
       */
      /*
       * The *reachable* address, which on a server is not the one it binds to.
       *
       * This line is the one people copy, so printing loopback here undid the whole point of
       * working the public address out: the useful URL scrolled past above it, and the useless
       * one had the last word.
       */
      noToken
        ? `Opening ${server.url}` +
            `\n(If the browser does not open, open this \u2014 there is no time limit:)` +
            `\n${reachableUrl}\n\n`
        : `Opening ${server.url}` +
            `\n(If the browser does not open, paste this within ${String(handoffSeconds)} seconds:)` +
            `\n${reachableUrl}\n\n` +
            (handoffSeconds === 10
              ? '  Not long enough? Start with --handoff-seconds 120.\n' +
                '  If it does lapse, a fresh link is printed here \u2014 no need to restart.\n\n'
              : '  If it does lapse, a fresh link is printed here \u2014 no need to restart.\n\n'),
    )
  }

  if (!noOpen) openBrowser(noToken ? server.url : launchUrl)

  const shutdown = (): void => {
    process.stdout.write('\nStopping.\n')
    void server.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * Every flag this version understands.
 *
 * Kept beside `usage()` deliberately — the two drift the moment they live apart, and a flag
 * missing from here is rejected outright rather than quietly ignored, which is the loud
 * failure to have.
 */
const KNOWN_FLAGS = new Set([
  '--help',
  '-h',
  '--version',
  '-v',
  '--handoff-seconds',
  '--workspace',
  '--port',
  '--data-dir',
  '--no-open',
  '--no-token',
  '--public-url',
  '--allow-host',
  '--allow-origin',
  '--server',
  '--admin',
  '--admin-id',
  '--trust-proxy',
  '--user-header',
  '--identity-tool',
  '--identity-python',
  '--credential-tool',
  '--credential-python',
  '--bind',
  '--guide',
])

/** Every value given for a repeatable flag, so `--admin a --admin b` works. */
/**
 * The host and origin a stated public URL implies.
 *
 * Absent for a bare path — which is what JupyterHub gives, since the hub's own name is not
 * something this process is told. Nothing is guessed: a wrong entry here would widen the very
 * check it is meant to satisfy.
 */
function trustedFromPublicUrl(value: string | undefined): { hosts: string[]; origins: string[] } {
  if (value === undefined || !/^https?:\/\//i.test(value.trim())) return { hosts: [], origins: [] }
  try {
    const url = new URL(value.trim())
    return { hosts: [url.host], origins: [url.origin] }
  } catch {
    // Not a URL. Left alone rather than half-parsed: the flag is also used for the printed link,
    // and a value this cannot read is one the user should see verbatim and fix.
    return { hosts: [], origins: [] }
  }
}

function valuesOf(args: string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== flag) continue
    const value = args[index + 1]
    if (value !== undefined && !value.startsWith('--')) values.push(value)
  }
  return values
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  return args[index + 1]
}

/**
 * Ripgrep resolution stays in the host, never core — a top-level import of it from core
 * once shipped a VSIX that could not activate at all (§19). The require is inside a
 * function for the same reason: an import would be hoisted back to the top.
 */
function resolveRipgrep(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('@vscode/ripgrep') as { rgPath: string }).rgPath
  } catch {
    return undefined
  }
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  // `start` needs an empty title argument first, or it treats the URL as the window title.
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // Headless or no handler registered. The URL is already printed above.
  }
}

function usage(): string {
  return `light-code — a local Light Code server in your browser

Usage: light-code [options]

  --workspace <dir>   Folder to work in (default: current directory)
  --version, -v       Print the version and exit
  --port <n>          Port to bind (default: an unused one)
  --data-dir <dir>    Where config, secrets and task history live
  --no-open           Print the URL instead of launching a browser
  --no-token          Serve with no bearer token, so any request to the port is
                      accepted. Origin and Host are still checked, so a page in
                      another tab still cannot reach it — but any program running
                      as you can. For a local machine you trust.
  --handoff-seconds <n>  How long the launch link stays valid (default 10, max 600).
                      Raise it when carrying the URL by hand. It rides in the URL
                      fragment, so a longer window is longer for anyone reading
                      your scrollback to use it first.
  --server            Shared mode: configuration is read-only for everyone
                      except the administrators named below
  --admin             Open the administrator's interface (/admin) instead
  --admin-id <id>     An administrator's identity id (repeatable)
  --trust-proxy <ip>  Believe the user header from this address (repeatable).
                      Required in shared mode; without it every request is
                      refused, which is the safe direction to fail
  --user-header <h>   Header carrying the user id (default X-Forwarded-User)
  --identity-tool <f> Python file defining run() -> str, returning the current user id.
                      Settings, secrets and history are filed under whatever it returns.
  --identity-python <p>  Interpreter to run it with (default python3)
  --credential-tool <f>  Python file defining run(name) -> str or dict. A secret stored as
                      tool:<name> is fetched from it instead of being kept on disk; use
                      tool:<name>#field to pick one field of a dict.
  --credential-python <p>  Interpreter for it (defaults to --identity-python)
  --bind <address>    Interface to listen on (default: 127.0.0.1). Use 0.0.0.0 to
                      reach it from another machine; it then answers to this
                      machine's own hostname and addresses as well as localhost
  --public-url <u>    The address this is reachable at from a browser, when that is not
                      the one it binds. Printed as the link to open, and trusted as a
                      host and origin. Detected automatically under JupyterHub.
  --allow-host <h>    An extra name to answer to, e.g. a reverse proxy or a
                      container alias (repeatable)
  --allow-origin <o>  An extra origin allowed to call it, e.g. an app embedding
                      this in an iframe (repeatable)
  --guide             Open the operator guide in your browser — setting up
                      shared mode, who can change what, and what it does not
                      protect against. Add --no-open to print it instead
  -h, --help          This message

Binds 127.0.0.1 unless --bind says otherwise. Anything that can reach the port
can read your files and run commands, so it is protected by a session token the
launch URL carries once; see docs/hosting.md.

--server locks *settings*, not privileges: every user's commands still run as
this process's account, over this account's files. It is appropriate where all
users are already trusted with everything the others can reach, and nowhere
else. Read docs/hosting.md before sharing it.
`
}

void main().catch((error: unknown) => {
  process.stderr.write(`light-code: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
