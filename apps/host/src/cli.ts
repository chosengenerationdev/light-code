#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import envPaths from 'env-paths'
import { adminListPolicy } from './roles.js'
import { startServer } from './server.js'

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

  const serverMode = args.includes('--server')
  const adminIds = valuesOf(args, '--admin')
  const workspaceRoot = path.resolve(valueOf(args, '--workspace') ?? process.cwd())
  const dataDir = valueOf(args, '--data-dir') ?? envPaths('light-code', { suffix: '' }).data
  const port = Number.parseInt(valueOf(args, '--port') ?? '0', 10)
  /*
   * Still loopback unless asked otherwise, even in server mode. `--server` is about who owns
   * the settings; exposing the port is a separate decision that has to be made explicitly,
   * because binding every interface by accident is not a mistake anyone recovers from quietly.
   */
  const bindAddress = valueOf(args, '--bind')
  // A shared server has no browser to open on the machine it runs on.
  const noOpen = args.includes('--no-open') || serverMode

  const here = path.dirname(fileURLToPath(import.meta.url))
  const server = await startServer({
    workspaceRoot,
    dataDir,
    clientDir: path.join(here, 'client'),
    ripgrepPath: resolveRipgrep(),
    port: Number.isNaN(port) ? 0 : port,
    ...(serverMode ? { roles: adminListPolicy(adminIds) } : {}),
    ...(bindAddress !== undefined ? { bindAddress } : {}),
  })

  // The token is in the fragment, which the browser never sends to the server — that is
  // what makes it usable as a one-time handoff. It is single-use and expires in 10s.
  const launchUrl = `${server.url}/#t=${server.launchToken ?? ''}`
  process.stdout.write(
    `\nLight Code\n  workspace  ${workspaceRoot}\n  data       ${dataDir}\n  listening  ${server.url}\n`,
  )
  if (serverMode) {
    const who =
      adminIds.length === 0
        ? 'nobody — no --admin was given, so configuration is frozen'
        : `${String(adminIds.length)} administrator(s)`
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
  process.stdout.write(`Opening ${server.url}\n(If the browser does not open, paste this within 10 seconds:)\n${launchUrl}\n\n`)

  if (!noOpen) openBrowser(launchUrl)

  const shutdown = (): void => {
    process.stdout.write('\nStopping.\n')
    void server.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/** Every value given for a repeatable flag, so `--admin a --admin b` works. */
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
  --port <n>          Port to bind (default: an unused one)
  --data-dir <dir>    Where config, secrets and task history live
  --no-open           Print the URL instead of launching a browser
  --server            Shared mode: configuration is read-only for everyone
                      except the administrators named below
  --admin <id>        An administrator's identity id (repeatable)
  --bind <address>    Interface to listen on (default: 127.0.0.1)
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
