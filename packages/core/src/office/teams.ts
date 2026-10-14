import { spawn } from 'node:child_process'

import { z } from 'zod'

import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'

/**
 * `teams_open_chat`: a Teams chat with a colleague, opened with the message already typed - and, only
 * when the user asks for it, sent with an Enter keypress.
 *
 * Asked for as "inform a team member about the pull request", with the Graph API ruled out. New Teams
 * exposes no COM or other automation, so the local route is Teams' own `msteams:` deep link: the
 * installed client opens a chat with the named people, under the signed-in user, with the compose box
 * filled in.
 *
 * Asking it to message someone means send (the user's correction: "it should just send it"); only a
 * request for a draft leaves Send to the user. The approval prompt still says it will send.
 *
 * **Sending is a keypress, and that is why it is fenced the way it is** (asked for directly: "when I
 * tell it to, it should be able to send the event"). A synthesised key goes to whatever window has
 * focus, not to Teams. The deep link opens Teams asynchronously, Windows may refuse to bring it to the
 * front, and an Enter that lands in a terminal runs whatever is typed there. So `send` is its own
 * parameter, the approval preview says in capitals that Enter will be pressed, and the keypress happens
 * only after a Teams window has been the foreground window, unchanged, for a settling period - and is
 * still the same window immediately before the key goes down. Anything else presses nothing and says
 * so. What it cannot know is whether Teams kept the message text; the result says to check.
 *
 * **The link never reaches the network from here.** It is handed to the operating system's protocol
 * handler (`explorer.exe <link>`, no shell, so nothing in the message can become a command), and
 * `msteams:` belongs to the Teams client. The keypress script is fixed text with no model input in it,
 * passed as `-EncodedCommand`. Light Code opens no connection (invariant 2 is untouched).
 */

/** How long a deep link can get before Windows or Teams truncates it, with margin. */
const MAX_LINK_LENGTH = 2000

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/

const schema = z.object({
  to: z.array(z.string()).min(1).max(20).describe('Email addresses (their Teams sign-in names) of the people to message. One person opens a one-to-one chat; several open a group chat.'),
  message: z.string().min(1).describe('The message to put in the compose box, e.g. the pull request title and link. Plain text.'),
  topic: z.string().optional().describe('Group chats only: a name for a new group chat.'),
  send: z
    .boolean()
    .optional()
    .describe('Press Enter in Teams to send it. True whenever the user asked you to message, send, tell or inform someone; omit only when they asked for a draft to send themselves.'),
})
type Params = z.infer<typeof schema>

/** The `msteams:` link for these people and this message, or why there cannot be one. */
export function teamsChatLink(params: Params): { link: string } | { problem: string } {
  const people = params.to.map((person) => person.trim()).filter((person) => person.length > 0)
  const bad = people.filter((person) => !EMAIL.test(person))
  if (people.length === 0) return { problem: 'Nobody to message: give at least one email address.' }
  if (bad.length > 0) return { problem: `Not an email address: ${bad.join(', ')}. Teams finds people by their sign-in email.` }
  const query = new URLSearchParams({ users: people.join(','), message: params.message })
  if (params.topic !== undefined && params.topic.trim().length > 0 && people.length > 1) query.set('topicName', params.topic.trim())
  // URLSearchParams writes spaces as "+", which Teams shows literally; %20 is read as a space.
  const link = `msteams:/l/chat/0/0?${query.toString().replace(/\+/g, '%20')}`
  if (link.length > MAX_LINK_LENGTH) {
    return { problem: `The message is too long for a Teams link (${String(link.length)} characters; about ${String(MAX_LINK_LENGTH)} fit). Shorten it - a title and a link are enough.` }
  }
  return { link }
}

/** What happened to the Enter keypress. */
export type EnterOutcome = 'sent' | 'not-foreground' | 'lost-focus' | 'failed'

export interface TeamsToolOptions {
  /** Hands a link to the operating system. Replaced in tests. */
  open?: (link: string) => Promise<void>
  /** Presses Enter in Teams once it is safely in front. Replaced in tests. */
  pressEnter?: () => Promise<{ outcome: EnterOutcome; detail?: string }>
}

function openWithWindows(link: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // explorer.exe passes a URL to its protocol handler. An argument, never a shell command line.
    const child = spawn('explorer.exe', [link], { windowsHide: true, detached: true, stdio: 'ignore' })
    child.once('error', (error) => reject(new Error(`Could not start explorer.exe to open Teams: ${error.message}`)))
    // explorer exits 1 even when it opened the link, so its exit code says nothing.
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Teams' process names: new Teams, then classic. Lower case, as the script compares them. */
const TEAMS_PROCESSES = ['ms-teams', 'teams']
/** How long Teams must have been in front, unchanged, before Enter: long enough for the chat to load. */
const SETTLE_MS = 2500
/** How long to wait for Teams to come to the front at all. */
const WAIT_SECONDS = 20

/**
 * The keypress, in Windows PowerShell. Fixed text: nothing the model wrote is in it. Pure ASCII, for
 * the reason §12c records (a BOM-less script is read as ANSI). `$dry` makes it report instead of press.
 */
export function enterScript(options: { dry?: boolean; waitSeconds?: number } = {}): string {
  return [
    `$dry = ${options.dry === true ? '$true' : '$false'}`,
    `$names = @(${TEAMS_PROCESSES.map((name) => `'${name}'`).join(', ')})`,
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class LcTeamsKeys {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
    '}',
    '"@',
    'function Get-ForegroundName {',
    '  $h = [LcTeamsKeys]::GetForegroundWindow()',
    '  $p = [uint32]0',
    '  [void][LcTeamsKeys]::GetWindowThreadProcessId($h, [ref]$p)',
    "  try { return (Get-Process -Id $p -ErrorAction Stop).ProcessName.ToLower() } catch { return '' }",
    '}',
    `$deadline = (Get-Date).AddSeconds(${String(options.waitSeconds ?? WAIT_SECONDS)})`,
    '$since = $null',
    '$window = [IntPtr]::Zero',
    '$ready = $false',
    '$last = ""',
    'while ((Get-Date) -lt $deadline) {',
    '  $h = [LcTeamsKeys]::GetForegroundWindow()',
    '  $last = Get-ForegroundName',
    '  if ($names -contains $last) {',
    '    if ($since -eq $null -or $h -ne $window) { $since = Get-Date; $window = $h }',
    `    elseif (((Get-Date) - $since).TotalMilliseconds -ge ${String(SETTLE_MS)}) { $ready = $true; break }`,
    '  } else { $since = $null }',
    '  Start-Sleep -Milliseconds 200',
    '}',
    'if (-not $ready) { Write-Output ("LC-ENTER:not-foreground:" + $last); exit 0 }',
    // Checked again immediately before the key goes down: the person may have clicked away.
    'if ([LcTeamsKeys]::GetForegroundWindow() -ne $window -or -not ($names -contains (Get-ForegroundName))) { Write-Output "LC-ENTER:lost-focus"; exit 0 }',
    'if ($dry) { Write-Output "LC-ENTER:sent:dry"; exit 0 }',
    '[LcTeamsKeys]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)',
    '[LcTeamsKeys]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero)',
    'Write-Output "LC-ENTER:sent"',
  ].join('\r\n')
}

/** Runs `enterScript` and reads the result behind its marker, never off the rest of the output. */
export function runEnterScript(script: string = enterScript()): Promise<{ outcome: EnterOutcome; detail?: string }> {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')))
    const timer = setTimeout(() => child.kill(), (WAIT_SECONDS + 20) * 1000)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ outcome: 'failed', detail: `Could not start PowerShell: ${error.message}` })
    })
    child.once('close', () => {
      clearTimeout(timer)
      const match = /LC-ENTER:([a-z-]+)(?::([^\r\n]*))?/.exec(out)
      const outcome = match?.[1]
      if (outcome === 'sent' || outcome === 'not-foreground' || outcome === 'lost-focus') {
        resolve({ outcome, ...(match?.[2] !== undefined && match[2].length > 0 ? { detail: match[2] } : {}) })
      } else {
        resolve({ outcome: 'failed', detail: err.trim().split(/\r?\n/)[0] ?? 'no result' })
      }
    })
  })
}

function describeEnter(result: { outcome: EnterOutcome; detail?: string }, people: string): string {
  switch (result.outcome) {
    case 'sent':
      return (
        `Opened the chat with ${people} and pressed Enter in Teams to send the message. A keypress cannot ` +
        'confirm delivery: tell the user it was sent from their Teams, and to glance at the chat if it matters.'
      )
    case 'not-foreground':
      return (
        `Opened the chat with ${people} with the message typed in, but Teams did not come to the front in time ` +
        `(the window in front was ${result.detail !== undefined && result.detail.length > 0 ? `"${result.detail}"` : 'something else'}), ` +
        'so Enter was NOT pressed - pressing it anywhere else could send it to the wrong window. The message is ' +
        'NOT sent; tell the user to press Send in Teams.'
      )
    case 'lost-focus':
      return (
        `Opened the chat with ${people}, but focus moved away from Teams just before sending, so Enter was NOT ` +
        'pressed. The message is NOT sent; tell the user to press Send in Teams.'
      )
    case 'failed':
      return (
        `Opened the chat with ${people} with the message typed in, but the keypress could not be made ` +
        `(${result.detail ?? 'unknown error'}). The message is NOT sent; tell the user to press Send in Teams.`
      )
  }
}

export function createTeamsOpenChatTool(options: TeamsToolOptions = {}): Tool<Params> {
  const open = options.open ?? openWithWindows
  const pressEnter = options.pressEnter ?? (() => runEnterScript())
  return {
    name: 'teams_open_chat',
    group: 'command',
    description:
      'Send a Microsoft Teams message to one or more colleagues - e.g. to tell a reviewer about a pull ' +
      'request. When the user asks you to message, send, tell, ping or inform someone, set send: true: the ' +
      'chat opens with the message typed and Enter is pressed once Teams is in front (it refuses to press ' +
      'anywhere else). Leave send out only when the user asked for a draft or to prepare/open the message ' +
      'for them to send. People are named by email address. Needs the Teams desktop app installed and ' +
      'signed in. Always shown to the user first.',
    parametersSchema: schema,

    async preview(params): Promise<ToolPreview> {
      const built = teamsChatLink(params)
      return {
        kind: 'text',
        text: [
          `Open a Teams chat with: ${params.to.join(', ')}`,
          ...(params.topic !== undefined && params.to.length > 1 ? [`Group chat name: ${params.topic}`] : []),
          params.send === true
            ? 'AND SEND IT: once Teams is in front, Enter is pressed to send this message:'
            : 'The message below is typed in for you; nothing is sent until you press Send in Teams.',
          '',
          params.message,
          ...(params.send === true ? ['', 'Leave Teams in front for a few seconds; if anything else takes focus, nothing is pressed.'] : []),
          ...('problem' in built ? ['', `WILL BE REFUSED: ${built.problem}`] : []),
        ].join('\n'),
      }
    },

    async execute(params): Promise<ToolResult> {
      const built = teamsChatLink(params)
      if ('problem' in built) return { content: built.problem, isError: true }
      try {
        await open(built.link)
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
      const people = params.to.join(', ')
      if (params.send === true) {
        const result = await pressEnter()
        return { content: describeEnter(result, people), ...(result.outcome === 'sent' ? {} : { isError: true }) }
      }
      return {
        content:
          `Asked Teams to open a chat with ${people} with the message typed in. The user sends it ` +
          'themselves - do not say it was sent. If Teams did not open, the Teams desktop app may not be ' +
          'installed or signed in; offer an Outlook draft instead.',
      }
    },
  }
}
