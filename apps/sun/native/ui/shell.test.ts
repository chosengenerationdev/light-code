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
