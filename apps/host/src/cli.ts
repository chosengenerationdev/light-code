#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import envPaths from 'env-paths'
import { startServer } from './server.js'

/**
 * `npx light-code` — starts a local server and opens the system browser.
 *
 * Single user, loopback only. Multi-user hosting behind SSO is a different entry point
 * with a different identity provider; see `docs/hosting.md` for why that is not just a
 * flag on this one.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage())
    return
  }

  const workspaceRoot = path.resolve(valueOf(args, '--workspace') ?? process.cwd())
  const dataDir = valueOf(args, '--data-dir') ?? envPaths('light-code', { suffix: '' }).data
  const port = Number.parseInt(valueOf(args, '--port') ?? '0', 10)
  const noOpen = args.includes('--no-open')

  const here = path.dirname(fileURLToPath(import.meta.url))
  const server = await startServer({
    workspaceRoot,
    dataDir,
    clientDir: path.join(here, 'client'),
    ripgrepPath: resolveRipgrep(),
    port: Number.isNaN(port) ? 0 : port,
  })

  // The token is in the fragment, which the browser never sends to the server — that is
  // what makes it usable as a one-time handoff. It is single-use and expires in 10s.
  const launchUrl = `${server.url}/#t=${server.launchToken ?? ''}`
  process.stdout.write(`\nLight Code\n  workspace  ${workspaceRoot}\n  data       ${dataDir}\n  listening  ${server.url}\n\n`)
  process.stdout.write(`Opening ${server.url}\n(If the browser does not open, paste this within 10 seconds:)\n${launchUrl}\n\n`)

  if (!noOpen) openBrowser(launchUrl)

  const shutdown = (): void => {
    process.stdout.write('\nStopping.\n')
    void server.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
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
  -h, --help          This message

Binds 127.0.0.1 only. Anything on this machine that can reach the port can
read your files and run commands, so it is protected by a session token the
launch URL carries once; see docs/hosting.md.
`
}

void main().catch((error: unknown) => {
  process.stderr.write(`light-code: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
