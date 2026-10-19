import fs from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { checkReadOnly, READ_ONLY_PROGRAMS } from './readonly.js'
import { findMachine, readSettings, type Machine } from './settings.js'
import { setUpKey } from './keySetup.js'
import { hostKeyId, localPathFor, SshError, SshPool } from './ssh.js'

/**
 * The Linux add-on: an MCP server Light Code and Fire Code start once it is enabled.
 *
 * Every tool takes a machine by its label from the Linux tab. Nothing here writes to a machine:
 * `run` sends only what `readonly.ts` accepts, and `download` copies one file down. Everything the
 * user typed arrives through `settings.ts`; nothing is read from anywhere else.
 */

const VERSION = '0.2.1'
type Text = { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (body: string, isError = false): Text => ({ content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) })

/** One line per machine, for tool descriptions and `machines`. */
function describe(machine: Machine): string {
  const via = machine.jumpVia !== undefined ? ` via ${machine.jumpVia}` : ''
  return `${machine.label}: ${machine.username}@${machine.host}:${String(machine.port)}${via}${machine.notes !== undefined ? ` - ${machine.notes.replace(/\s+/g, ' ')}` : ''}`
}

export function createServer(): { server: McpServer; pool: SshPool } {
  const pool = new SshPool(() => readSettings())
  const server = new McpServer({ name: 'linux', version: VERSION })
  // Labels in the descriptions: Light Code restarts the add-on when the tab is saved, so they stay current.
  const startup = readSettings()
  const labels = startup.machines.length > 0 ? startup.machines.map((m) => m.label).join(', ') : 'none set up yet'
  const machineParam = z.string().min(1).describe(`The machine's label from the Linux tab. Configured: ${labels}.`)

  const guard = async (work: () => Promise<Text>): Promise<Text> => {
    try {
      return await work()
    } catch (error) {
      return text(error instanceof SshError || error instanceof Error ? error.message : String(error), true)
    }
  }

  server.registerTool(
    'machines',
    {
      description:
        'List the Linux machines the user set up, by label, with what the user noted about each. Call this first when the user ' +
        'refers to a machine you have not seen, or to find which one runs something.',
      inputSchema: {},
    },
    async () => {
      const settings = readSettings()
      if (settings.machines.length === 0) return text('No Linux machines are set up. Ask the user to add them on the Linux tab in Light Code settings.')
      return text(settings.machines.map(describe).join('\n'))
    },
  )

  server.registerTool(
    'run',
    {
      description:
        `Run a READ-ONLY command on one of the user's Linux machines over SSH and return its output. Only programs that cannot ` +
        `change anything are accepted (${READ_ONLY_PROGRAMS.slice(0, 40).join(', ')}, and more), joined with | if needed - no ` +
        '; && > < $() or backticks. Flags that write or never end are refused (tail -f, find -delete, sort -o). Use single ' +
        'quotes for patterns. For a large log, read part of it (tail -n 500, grep -n) rather than all of it. Machines: ' +
        `${labels}.`,
      inputSchema: {
        machine: machineParam,
        command: z.string().min(1).describe('One read-only command, or several joined with |, e.g. "df -h" or "grep -n ERROR /var/log/app.log | tail -n 50".'),
        timeoutSeconds: z.number().int().positive().max(1800).optional().describe('How long it may run; the Linux tab sets the default.'),
      },
    },
    async ({ machine, command, timeoutSeconds }) =>
      guard(async () => {
        const settings = readSettings()
        const target = findMachine(settings, machine)
        const verdict = checkReadOnly(command, settings.extraCommands)
        if (!verdict.ok) return text(verdict.reason, true)
        const result = await pool.run(target, command, (timeoutSeconds ?? settings.timeoutSeconds) * 1000)
        const lines = [
          `${target.label}$ ${command}`,
          result.timedOut
            ? `Stopped after ${String(timeoutSeconds ?? settings.timeoutSeconds)} s (time limit).`
            : `Exit code ${result.code === null ? `none (${result.signal ?? 'signal'})` : String(result.code)}.`,
          ...(result.newKey !== undefined ? [`First connection to ${target.label}: its host key ${result.newKey} is now trusted.`] : []),
          ...(result.truncated ? ['Output was cut at 2 MB - narrow the command.'] : []),
          '',
          result.stdout.length > 0 ? result.stdout : '(no output)',
          ...(result.stderr.length > 0 ? ['', '--- stderr ---', result.stderr] : []),
        ]
        return text(lines.join('\n'), result.timedOut)
      }),
  )

  server.registerTool(
    'download',
    {
      description:
        "Copy one file from a Linux machine to this computer for investigation (SFTP), then read it with read_file at the path " +
        'returned. Only files, up to the size limit on the Linux tab - read part of a huge log with run instead.',
      inputSchema: {
        machine: machineParam,
        path: z.string().min(1).describe('The absolute path of the file on the machine, e.g. /var/log/app/server.log.'),
      },
    },
    async ({ machine, path: remote }) =>
      guard(async () => {
        const settings = readSettings()
        const target = findMachine(settings, machine)
        if (!remote.startsWith('/')) return text(`Give the absolute path on ${target.label}, starting with / (find it with run "ls -la <folder>").`, true)
        const local = localPathFor(settings.downloadsDir, target.label, remote)
        const { size } = await pool.download(target, remote, local, settings.maxDownloadMB * 1024 * 1024)
        return text(`Downloaded ${remote} from ${target.label} (${size.toLocaleString()} bytes) to:\n${local}\n\nRead it with read_file.`)
      }),
  )

  server.registerTool(
    'test_connection',
    {
      description: 'Check that a Linux machine can be reached and signed in to: connects and runs uname -a. Used by the Test connection button.',
      inputSchema: { label: z.string().min(1).describe("The machine's label.") },
    },
    async ({ label }) =>
      guard(async () => {
        const settings = readSettings()
        const target = findMachine(settings, label)
        pool.close(target.label)
        const started = Date.now()
        const result = await pool.run(target, 'uname -a', 20_000)
        const key = pool.knownHosts.get(hostKeyId(target))
        return text(
          [
            `Connected to ${target.label} as ${target.username} in ${String(Date.now() - started)} ms.`,
            result.stdout.trim(),
            result.newKey !== undefined ? `First connection: host key ${result.newKey} is now trusted.` : `Host key ${key ?? '?'} (as before).`,
          ].join('\n'),
        )
      }),
  )

  server.registerTool(
    'forget_host_key',
    {
      description:
        "Forget the saved host key of a Linux machine, so the next connection trusts whatever key it presents. Only when the USER " +
        'asks, after confirming the machine was rebuilt - never because a connection reported a changed key.',
      inputSchema: { label: z.string().min(1).describe("The machine's label.") },
    },
    async ({ label }) =>
      guard(async () => {
        const target = findMachine(readSettings(), label)
        const id = hostKeyId(target)
        const was = pool.knownHosts.get(id)
        pool.close(target.label)
        pool.knownHosts.set(id, undefined)
        return text(was === undefined ? `No host key was saved for ${target.label}.` : `Forgot ${target.label}'s host key ${was}. The next connection trusts the key it presents.`)
      }),
  )

  /*
   * The one tool that writes to a server, so the model never gets it: marked panel-only, and offered
   * at all only when Light Code says it keeps such tools from the model - an older one would list it.
   */
  if (process.env['LIGHT_CODE_ADDON_PANEL_TOOLS'] === '1') {
    server.registerTool(
      'setup_key',
      {
        description: 'Set up key sign-in for a machine (the "Set up SSH key" button on the Linux tab).',
        inputSchema: { label: z.string().min(1) },
        _meta: { 'lightCode/panelOnly': true },
      },
      async ({ label }) =>
        guard(async () => {
          const target = findMachine(readSettings(), label)
          const result = await setUpKey(pool, target)
          if (result.keyFile === undefined) return text(result.text, true)
          // Light Code switches the machine to the key (`recordUpdate`), as if it had been typed on the tab.
          return { ...text(result.text), structuredContent: { lightCode: { recordUpdate: { auth: 'key', keyFile: result.keyFile } } } } as Text
        }),
    )
  }

  return { server, pool }
}

/** Started by Light Code as `node dist/server.cjs`; tests import `createServer` instead. */
export async function main(): Promise<void> {
  const { server, pool } = createServer()
  fs.mkdirSync(readSettings().dataDir, { recursive: true })
  await server.connect(new StdioServerTransport())
  const stop = (): void => {
    pool.dispose()
    process.exit(0)
  }
  process.stdin.on('close', stop)
  process.on('SIGTERM', stop)
  console.error(`linux add-on ${VERSION} ready`)
}
