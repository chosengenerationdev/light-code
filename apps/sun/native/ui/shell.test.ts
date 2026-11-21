// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Fire Code's window, driven as WebView2 runs it: index.html, then shell.js, then the messages the
 * Rust side sends. The first test of `shell.js` here - before this it was checked by `node --check`
 * and by hand (CLAUDE.md §12z drove it in jsdom once, from a scratch file).
 *
 * Reported: after a restart some chat tabs stayed on "That link has already been used. A fresh one
 * has been printed in the terminal." The fresh link arrived, and the frame was given it - but it
 * differs from the spent one only after the `#`, and assigning such an address does not reload the
 * page, so it never left the error.
 */
const ui = __dirname
const sent: { cmd: string }[] = []

type ShellWindow = Window & { __sun: { receive: (message: unknown) => void } }

beforeEach(() => {
  sent.length = 0
  const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8')
  document.documentElement.innerHTML = html.replace(/<script src="shell.js"><\/script>/, '').replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '')
  const w = window as unknown as Record<string, unknown>
  w['ipc'] = { postMessage: (text: string) => sent.push(JSON.parse(text) as { cmd: string }) }
  w['matchMedia'] = () => ({ matches: false, addEventListener() {}, addListener() {} })
  // A classic script in WebView2, so it is run the same way here: as a global script.
  ;(0, eval)(fs.readFileSync(path.join(ui, 'shell.js'), 'utf8'))
  start()
})

const receive = (message: unknown): void => (window as unknown as ShellWindow).__sun.receive(message)
const frameOf = (key: string): HTMLIFrameElement | null => document.querySelector(`.pane[data-id="${key}"] iframe`)

function start(): void {
  const projects = [{ id: 'p1', name: 'One', path: 'D:/one', chats: [{ id: 2, name: 'Chat 2' }], configMode: 'new', configFile: 'c' }]
  receive({ type: 'init', version: 'x', projects, settings: { sleepMinutes: 30, unloadMinutes: 5, theme: 'system', accent: '#f26b1d', sidebarWidth: 264 }, accent: '#f26b1d', hasSource: false, dataFolder: 'X' })
  receive({ type: 'select', id: 'p1' })
  for (const key of ['p1', 'p1~2']) receive({ type: 'url', id: key, url: `http://127.0.0.1:5000/#t=first-${key}` })
  receive({ type: 'status', totalMemory: 0, statuses: { p1: { phase: 'running', agent: 'idle', memory: 0 }, 'p1~2': { phase: 'running', agent: 'idle', memory: 0 } } })
}

function fromPage(frame: HTMLIFrameElement, data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data: { source: 'light-code', ...data }, origin: 'http://127.0.0.1:5000', source: frame.contentWindow }))
}

describe('a fresh launch link', () => {
  it('gives a page that has no session a new frame, which always loads', () => {
    const before = frameOf('p1~2')!
    expect(before.getAttribute('src')).toBe('http://127.0.0.1:5000/#t=first-p1~2')
    receive({ type: 'url', id: 'p1~2', url: 'http://127.0.0.1:5000/#t=fresh' })
    const after = frameOf('p1~2')!
    expect(after).not.toBe(before)
    expect(after.getAttribute('src')).toBe('http://127.0.0.1:5000/#t=fresh')
    expect(document.querySelectorAll('.pane[data-id="p1~2"] iframe')).toHaveLength(1)
  })

  it('leaves a page that already has its session alone, keeping the link for its next load', () => {
    const frame = frameOf('p1')!
    fromPage(frame, { connected: true })
    receive({ type: 'url', id: 'p1', url: 'http://127.0.0.1:5000/#t=fresh' })
    expect(frameOf('p1')).toBe(frame)
    expect(frame.dataset['url']).toBe('http://127.0.0.1:5000/#t=fresh')
  })

  it('still reloads a connected page whose agent restarted on another port', () => {
    const frame = frameOf('p1')!
    fromPage(frame, { connected: true })
    receive({ type: 'url', id: 'p1', url: 'http://127.0.0.1:6000/#t=restarted' })
    expect(frameOf('p1')).not.toBe(frame)
    expect(frameOf('p1')!.getAttribute('src')).toBe('http://127.0.0.1:6000/#t=restarted')
  })
})

describe('a Browse button in a chat page', () => {
  it("asks Fire Code for a Windows dialog, and the chosen path goes back to that page", () => {
    const frame = frameOf('p1~2')!
    fromPage(frame, { pick: { purpose: 'addons:folder', kind: 'folder' } })
    expect(sent.at(-1)).toEqual({ cmd: 'pickPath', id: 'p1~2', purpose: 'addons:folder', kind: 'folder', extensions: [] })

    const delivered: unknown[] = []
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage: (message: unknown, origin: string) => delivered.push({ message, origin }) }, configurable: true })
    receive({ type: 'pathPicked', id: 'p1~2', purpose: 'addons:folder', path: 'D:/addons' })
    expect(delivered).toEqual([{ message: { source: 'sun', picked: { purpose: 'addons:folder', path: 'D:/addons' } }, origin: 'http://127.0.0.1:5000' }])
  })
})

/*
 * Reported: "Start a chat" from a monitoring alert opened a chat with nothing about the alert in it. The text went to
 * the page nested inside `ask`, where the page never looks; it must arrive as `ask: 'prefill'` with `text` beside it.
 */
describe('a chat started from a monitoring alert', () => {
  it("delivers the alert's text to the new chat's page where the page reads it", () => {
    const frame = frameOf('p1~2')!
    const delivered: { message: unknown; origin: string }[] = []
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage: (message: unknown, origin: string) => delivered.push({ message, origin }) }, configurable: true })
    fromPage(frame, { ready: true })
    receive({ type: 'prefillChat', id: 'p1~2', text: 'Help me investigate this monitoring alert' })
    expect(delivered.at(-1)?.message).toEqual({ source: 'sun', ask: 'prefill', text: 'Help me investigate this monitoring alert' })
  })
})

/*
 * Reported: a new chat "always picks and shows previous chat info", and closing should offer to
 * archive. Numbers are now never reused (Rust, state.rs); here, what the window asks and sends.
 */
describe('closing and opening chats', () => {
  const button = (text: string): HTMLButtonElement =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!

  it('asks Archive or Close and delete, and sends which', () => {
    receive({ type: 'select', id: 'p1~2' })
    document.querySelector<HTMLElement>('.tab[data-key="p1~2"] .tab-close')!.click()
    expect(sent.some((m) => m.cmd === 'closeChat')).toBe(false)
    button('Archive').click()
    expect(sent.at(-1)).toEqual({ cmd: 'closeChat', id: 'p1~2', archive: true })
    document.querySelector<HTMLElement>('.tab[data-key="p1~2"] .tab-close')!.click()
    button('Close and delete').click()
    expect(sent.at(-1)).toEqual({ cmd: 'closeChat', id: 'p1~2', archive: false })
  })

  it('offers a blank chat from + even when nothing is archived (Ctrl+T stays a quick blank chat)', () => {
    document.querySelector<HTMLElement>('.tab-new')!.click()
    expect(sent.some((m) => m.cmd === 'newChat')).toBe(false)
    ;[...document.querySelectorAll<HTMLButtonElement>('.menu button')].find((b) => b.textContent === 'New blank chat')!.click()
    expect(sent.at(-1)).toEqual({ cmd: 'newChat', id: 'p1' })
  })

  it('offers a blank chat or an archived one when some are archived', () => {
    const projects = [{ id: 'p1', name: 'One', path: 'D:/one', chats: [], archived: [{ id: 5, name: 'Release notes', archivedAt: 1 }], configMode: 'new', configFile: 'c' }]
    receive({ type: 'projects', projects })
    receive({ type: 'select', id: 'p1' })
    document.querySelector<HTMLElement>('.tab-new')!.click()
    expect(sent.some((m) => m.cmd === 'newChat')).toBe(false)
    const open = [...document.querySelectorAll<HTMLButtonElement>('.menu-row button')].find((b) => b.textContent?.includes('Release notes'))!
    open.click()
    expect(sent.at(-1)).toEqual({ cmd: 'newChat', id: 'p1', archived: 5 })
    document.querySelector<HTMLElement>('.tab-new')!.click()
    button('New blank chat').click()
    expect(sent.at(-1)).toEqual({ cmd: 'newChat', id: 'p1' })
  })
})

describe('branch chats', () => {
  const projectsWithBranch = [
    {
      id: 'p1',
      name: 'One',
      path: 'D:/one',
      configMode: 'new',
      configFile: 'c',
      chats: [
        { id: 2, name: 'Chat 2' },
        { id: 3, name: 'Hotfix work', folder: 'D:/one.worktrees/PAY-1234-add-retry', branch: 'PAY-1234-add-retry-to-the-settlement-batch-job' },
      ],
    },
  ]

  it('shows the branch under the chat name, trimmed with the full name on hover, and offers Close branch only there', () => {
    receive({ type: 'projects', projects: projectsWithBranch })
    receive({ type: 'select', id: 'p1~3' })
    const tab = document.querySelector('.tab[data-key="p1~3"]')!
    expect(tab.querySelector('.tab-name')!.textContent).toBe('Hotfix work')
    const branch = tab.querySelector('.tab-branch') as HTMLElement
    expect(branch.textContent).toBe('PAY-1234 add-retry-to-the-…')
    expect(branch.title).toContain('PAY-1234-add-retry-to-the-settlement-batch-job')
    expect(document.querySelector('.tab[data-key="p1~2"] .tab-branch')).toBeNull()

    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    const items = [...document.querySelectorAll('.menu button')].map((each) => each.textContent)
    expect(items).toContain('New chat on a branch…')
    expect(items.some((text) => text?.startsWith('Close branch'))).toBe(true)
    ;[...document.querySelectorAll('.menu button')].find((each) => each.textContent?.startsWith('Close branch'))!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(sent.at(-1)).toEqual({ cmd: 'checkBranch', id: 'p1~3' })
  })

  it('renames the chat and leaves the branch alone', () => {
    receive({ type: 'projects', projects: projectsWithBranch })
    receive({ type: 'select', id: 'p1~3' })
    const tab = document.querySelector('.tab[data-key="p1~3"]') as HTMLElement
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const input = document.querySelector('.tab-rename') as HTMLInputElement
    expect(tab.querySelector('.tab-branch')).not.toBeNull()
    input.value = 'Retry fix'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(sent.at(-1)).toEqual({ cmd: 'renameChat', id: 'p1~3', name: 'Retry fix' })
  })

  it('trims branch names exactly as Light Code does', async () => {
    const { branchLabel } = await import('../../../../packages/core/src/git/branchLabel.js')
    const shell = (window as unknown as { __sun: { branchLabel: (name: string) => string } }).__sun.branchLabel
    for (const name of ['main', 'PAY-1234-add-retry-to-the-settlement-batch-job', 'feature/a-very-long-branch-name-without-a-key', 'PAY-1234', 'ABC-1_x'.repeat(6)]) {
      expect(shell(name)).toBe(branchLabel(name))
    }
  })
})

describe('the branch on every tab, and New chat on a branch from the + button', () => {
  it('shows the codebase branch on chats working in its folder, and a branch chat its own', () => {
    receive({
      type: 'projects',
      projects: [{ id: 'p1', name: 'One', path: 'D:/one', configMode: 'new', configFile: 'c', chats: [{ id: 2, name: 'test' }, { id: 3, name: 'fix', folder: 'D:/one.worktrees/fix', branch: 'fix' }] }],
    })
    receive({ type: 'git', git: { p1: { added: 0, modified: 0, deleted: 0, branch: 'master', ahead: 0, behind: 0, upstream: false, files: [] } } })
    receive({ type: 'select', id: 'p1~2' })
    expect(document.querySelector('.tab[data-key="p1"] .tab-branch')!.textContent).toBe('master')
    expect(document.querySelector('.tab[data-key="p1~2"] .tab-branch')!.textContent).toBe('master')
    expect(document.querySelector('.tab[data-key="p1~3"] .tab-branch')!.textContent).toBe('fix')
  })

  it('opens a menu from + with a blank chat and a chat on a branch, even with nothing archived', () => {
    ;(document.querySelector('.tab-new') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const items = [...document.querySelectorAll('.menu button')].map((each) => each.textContent)
    expect(items).toEqual(['New blank chat', 'New chat on a branch…'])
    ;[...document.querySelectorAll('.menu button')][1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(sent.at(-1)).toEqual({ cmd: 'listBranches', id: 'p1' })
    expect(document.querySelector('.modal h2')!.textContent).toContain('New chat on a branch')
  })
})

describe('a new branch', () => {
  it('starts from the main branch by default, not the branch the codebase is on', () => {
    ;(document.querySelector('.tab-new') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ;[...document.querySelectorAll('.menu button')].find((b) => b.textContent === 'New chat on a branch…')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    receive({ type: 'branches', id: 'p1', branches: { local: ['feature/x', 'main'], remote: ['origin/release'], open: [], current: 'feature/x', defaultBranch: 'main' } })
    const select = document.querySelector('.branch-new select') as HTMLSelectElement
    expect(select.value).toBe('main')
    expect([...select.options].map((o) => o.textContent)).toEqual(['main (main branch)', 'feature/x (the codebase is on it)', 'origin/release'])
    ;(document.querySelector('.branch-new input') as HTMLInputElement).value = 'PAY-9-fix'
    ;[...document.querySelectorAll('.branch-new button')].find((b) => b.textContent === 'Make branch')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(sent.at(-1)).toEqual({ cmd: 'newBranchChat', id: 'p1', branch: 'PAY-9-fix', from: 'main' })
  })
})

describe('a repository with no commits yet', () => {
  it('says so instead of showing an empty list', () => {
    ;(document.querySelector('.tab-new') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ;[...document.querySelectorAll('.menu button')].find((b) => b.textContent === 'New chat on a branch…')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    receive({ type: 'branches', id: 'p1', branches: { local: [], remote: [], open: [], noCommits: true } })
    const text = document.querySelector('.modal')!.textContent ?? ''
    expect(text).toContain('has no commits yet')
    expect(text).toContain('Make a first commit')
    expect(document.querySelector('.branch-new')).toBeNull()
  })
})

describe('a branch chat in VS Code', () => {
  it('opens that chat\'s own folder from the tab menu, to run and debug the branch there', () => {
    receive({
      type: 'projects',
      projects: [{ id: 'p1', name: 'One', path: 'D:/one', configMode: 'new', configFile: 'c', chats: [{ id: 3, name: 'fix', folder: 'D:/one.worktrees/fix', branch: 'fix' }] }],
    })
    receive({ type: 'select', id: 'p1~3' })
    document.querySelector('.tab[data-key="p1~3"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    const button = [...document.querySelectorAll('.menu button')].find((b) => b.textContent === 'Open this branch in VS Code')!
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(sent.at(-1)).toEqual({ cmd: 'openVsCode', id: 'p1~3' })
  })
})

/** Asked for: export the codebases and their open chats, and import them on another computer. */
describe('moving the setup to another computer', () => {
  const items = [
    { name: 'Api', path: 'D:/code/api', exists: false, added: false, hub: null, chats: ['Main', 'Review'], hasSettings: true },
    { name: 'One', path: 'D:/one', exists: true, added: true, hub: null, chats: ['Chat 1'], hasSettings: false },
    {
      name: 'Notebooks',
      path: '',
      exists: false,
      added: false,
      hub: { url: 'https://hub.example', user: 'me', server: null, folders: ['work'], credentialLabel: 'JupyterHub me@hub', credential: null },
      chats: ['Chat 1'],
      hasSettings: false,
    },
  ]
  const button = (text: string): HTMLButtonElement =>
    [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text)) as HTMLButtonElement

  it('lists each codebase with its folder and chats, leaving one already here unticked', () => {
    receive({ type: 'setupPreview', file: 'C:/x/fire-code-setup.json', items })
    const ticks = [...document.querySelectorAll<HTMLInputElement>('input[aria-label^="Import "]')]
    expect(ticks.map((t) => t.checked)).toEqual([false, false, true]) // missing folder, already added, hub
    expect(document.body.textContent).toContain('2 chats: Main, Review')
    expect(document.body.textContent).toContain('Not found on this computer')
    expect(document.body.textContent).toContain('JupyterHub me at https://hub.example')
  })

  it('sends the folder chosen here, the hub token, and whether to use the settings', () => {
    receive({ type: 'setupPreview', file: 'C:/x/fire-code-setup.json', items })
    button('Browse').click()
    expect(sent.at(-1)).toEqual({ cmd: 'pickSetupFolder', index: 0 })
    receive({ type: 'setupFolderPicked', index: 0, path: 'E:/work/api', added: false })
    const token = document.querySelector<HTMLInputElement>('input[aria-label="Notebooks JupyterHub token"]')!
    token.value = ' tok '
    token.dispatchEvent(new Event('input'))
    button('Import 2').click()
    expect(sent.at(-1)).toEqual({
      cmd: 'importSetup',
      items: [
        { index: 0, path: 'E:/work/api', settings: true },
        { index: 2, token: 'tok', settings: false },
      ],
    })
  })
})

/*
 * Reported: Pull on a hub codebase said "Open the codebase first - git runs on the hub through its agent" while its chat
 * plainly worked, until Fire Code was restarted. Hub git went only to the first chat's page, and that page is unloaded
 * after a few idle minutes while another chat is on screen.
 */
describe('git on the hub', () => {
  const capture = (frame: HTMLIFrameElement): unknown[] => {
    const delivered: unknown[] = []
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage: (message: unknown) => delivered.push(message) }, configurable: true })
    return delivered
  }
  const pull = (): HTMLButtonElement => document.querySelector('[aria-label="Pull latest changes"]') as HTMLButtonElement

  beforeEach(() => {
    const projects = [{ id: 'p1', name: 'One', path: 'D:/one', chats: [{ id: 2, name: 'Chat 2' }], configMode: 'new', configFile: 'c', hub: { url: 'https://hub', user: 'u' } }]
    receive({ type: 'init', version: 'x', projects, settings: { sleepMinutes: 30, unloadMinutes: 5, theme: 'system', accent: '#f26b1d', sidebarWidth: 264 }, accent: '#f26b1d', hasSource: false, dataFolder: 'X' })
    receive({ type: 'status', totalMemory: 0, statuses: { p1: { phase: 'running', agent: 'idle', memory: 0 }, 'p1~2': { phase: 'running', agent: 'idle', memory: 0 } } })
    // The hub's counts, from a page: the repository has an upstream, so Pull is offered.
    fromPage(frameOf('p1~2')!, { hubGit: { op: 'status', ok: true, counts: { added: 0, modified: 0, deleted: 0, ahead: 0, behind: 1, upstream: true, branch: 'main', files: [] } } })
  })

  it("asks another chat of the codebase when the first chat's page was unloaded", () => {
    const second = frameOf('p1~2')!
    const delivered = capture(second)
    fromPage(second, { ready: true })
    // The first chat's page unloaded while idle.
    frameOf('p1')!.remove()
    expect(pull()).not.toBeNull()
    pull().click()
    expect(delivered).toContainEqual({ source: 'sun', ask: 'hubGit', op: 'pull' })
    expect(document.body.textContent).not.toContain('Open the codebase first')
  })

  it('loads an unloaded page again and asks it once it is ready, rather than refusing', () => {
    frameOf('p1')!.remove()
    frameOf('p1~2')!.remove()
    pull().click()
    const frame = frameOf('p1')!
    expect(frame).not.toBeNull()
    const delivered = capture(frame)
    expect(delivered).toEqual([])
    fromPage(frame, { ready: true })
    expect(delivered).toContainEqual({ source: 'sun', ask: 'hubGit', op: 'pull' })
  })

  it('starts a sleeping codebase to answer the button', () => {
    receive({ type: 'status', totalMemory: 0, statuses: { p1: { phase: 'sleeping', agent: 'idle', memory: 0 }, 'p1~2': { phase: 'sleeping', agent: 'idle', memory: 0 } } })
    sent.length = 0
    pull().click()
    expect(sent.filter((m) => m.cmd === 'start')).toEqual([{ cmd: 'start', id: 'p1' }])
  })
})

/*
 * Reported: "clicking + didnt carry the selected strategy in previous session". Each tab is its own agent, so the tab
 * being left is asked for its strategy, and the new tab is handed it once its page is ready.
 */
describe('a new chat from +', () => {
  it('asks the chat being left for its strategy and hands it to the new chat', () => {
    const left = frameOf('p1~2')!
    const fromLeft: unknown[] = []
    Object.defineProperty(left, 'contentWindow', { value: { postMessage: (message: unknown) => fromLeft.push(message) }, configurable: true })
    fromPage(left, { ready: true })
    receive({ type: 'select', id: 'p1~2' })
    sent.length = 0
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true }))
    expect(sent.find((m) => m.cmd === 'newChat')).toEqual({ cmd: 'newChat', id: 'p1' })
    expect(fromLeft).toContainEqual({ source: 'sun', ask: 'shareStrategy' })

    // The left chat answers; Fire Code made the new chat and selected it; its page comes up.
    const strategy = { id: 's', name: 'Review first', nodes: [], edges: [], updatedAt: 1 }
    fromPage(left, { carryStrategy: strategy })
    receive({ type: 'projects', projects: [{ id: 'p1', name: 'One', path: 'D:/one', chats: [{ id: 2, name: 'Chat 2' }, { id: 3, name: 'Chat 3' }], configMode: 'new', configFile: 'c' }] })
    receive({ type: 'select', id: 'p1~3' })
    receive({ type: 'url', id: 'p1~3', url: 'http://127.0.0.1:5000/#t=new' })
    receive({ type: 'status', totalMemory: 0, statuses: { p1: { phase: 'running', agent: 'idle', memory: 0 }, 'p1~2': { phase: 'running', agent: 'idle', memory: 0 }, 'p1~3': { phase: 'running', agent: 'idle', memory: 0 } } })
    const fresh = frameOf('p1~3')!
    const toFresh: unknown[] = []
    Object.defineProperty(fresh, 'contentWindow', { value: { postMessage: (message: unknown) => toFresh.push(message) }, configurable: true })
    fromPage(fresh, { ready: true })
    expect(toFresh).toContainEqual({ source: 'sun', ask: 'useStrategy', strategy, picks: null })
  })

  it('hands nothing over when the chat being left has no strategy', () => {
    const left = frameOf('p1~2')!
    Object.defineProperty(left, 'contentWindow', { value: { postMessage: () => undefined }, configurable: true })
    fromPage(left, { ready: true })
    receive({ type: 'select', id: 'p1~2' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true }))
    fromPage(left, { carryStrategy: null })
    receive({ type: 'projects', projects: [{ id: 'p1', name: 'One', path: 'D:/one', chats: [{ id: 2, name: 'Chat 2' }, { id: 3, name: 'Chat 3' }], configMode: 'new', configFile: 'c' }] })
    receive({ type: 'select', id: 'p1~3' })
    receive({ type: 'url', id: 'p1~3', url: 'http://127.0.0.1:5000/#t=new' })
    receive({ type: 'status', totalMemory: 0, statuses: { p1: { phase: 'running', agent: 'idle', memory: 0 }, 'p1~2': { phase: 'running', agent: 'idle', memory: 0 }, 'p1~3': { phase: 'running', agent: 'idle', memory: 0 } } })
    const fresh = frameOf('p1~3')!
    const toFresh: unknown[] = []
    Object.defineProperty(fresh, 'contentWindow', { value: { postMessage: (message: unknown) => toFresh.push(message) }, configurable: true })
    fromPage(fresh, { ready: true })
    expect(toFresh.some((m) => (m as { ask?: string }).ask === 'useStrategy')).toBe(false)
  })

  // The decision model's skill-and-tool picks are a chat's own setting too, and go with it - with or without a strategy.
  it('carries the skill-and-tool switch to the new chat, even with no strategy', () => {
    const left = frameOf('p1~2')!
    Object.defineProperty(left, 'contentWindow', { value: { postMessage: () => undefined }, configurable: true })
    fromPage(left, { ready: true })
    receive({ type: 'select', id: 'p1~2' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true }))
    fromPage(left, { carryStrategy: null, carryPicks: 'skills' })
    receive({ type: 'projects', projects: [{ id: 'p1', name: 'One', path: 'D:/one', chats: [{ id: 2, name: 'Chat 2' }, { id: 3, name: 'Chat 3' }], configMode: 'new', configFile: 'c' }] })
    receive({ type: 'select', id: 'p1~3' })
    receive({ type: 'url', id: 'p1~3', url: 'http://127.0.0.1:5000/#t=new' })
    receive({ type: 'status', totalMemory: 0, statuses: { p1: { phase: 'running', agent: 'idle', memory: 0 }, 'p1~2': { phase: 'running', agent: 'idle', memory: 0 }, 'p1~3': { phase: 'running', agent: 'idle', memory: 0 } } })
    const fresh = frameOf('p1~3')!
    const toFresh: unknown[] = []
    Object.defineProperty(fresh, 'contentWindow', { value: { postMessage: (message: unknown) => toFresh.push(message) }, configurable: true })
    fromPage(fresh, { ready: true })
    expect(toFresh).toContainEqual({ source: 'sun', ask: 'useStrategy', strategy: null, picks: 'skills' })
  })
})
