import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { candidatesFrom, capturePhrase, type CapturedRequest } from './capture.js'
import { askWebChat, runScript, selectWebChatPage, type ChromeAccess } from './chrome.js'
import { readCaptureScript, typePhraseScript, watchScript } from './inpage.js'

/**
 * The web chat against the real thing: chrome-devtools-mcp@1.13.0 (the version reported failing - "evaluate_script:
 * pageId: expected number, received undefined"), a real headless Chrome, and a stand-in web chat on loopback whose page
 * signs its requests with a token, as many internal chat apps do.
 *
 * Needs Chrome installed and npm reachable, so it runs only when asked: `LC_CHROME_E2E=1 pnpm vitest run chromeReal`.
 */

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app'].find((p) => existsSync(p))
const run = process.env['LC_CHROME_E2E'] === '1' && CHROME !== undefined

const PAGE_HTML = `<!doctype html><html><head><title>Internal AI Chat (internal)</title></head><body>
<h1>Chat</h1><textarea id="box" style="width:600px;height:60px"></textarea><div id="out"></div>
<script>
const TOKEN = 'Bearer page-token-123'
async function send(text) {
  const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: TOKEN }, body: JSON.stringify({ model: 'gemini-pro', messages: [{ role: 'user', content: text }] }) })
  const j = await r.json()
  document.getElementById('out').textContent = j.reply
}
document.getElementById('box').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(e.target.value) } })
</script></body></html>`

let site: Server
let siteUrl = ''
const seen: { authorization?: string; body: string }[] = []
let client: Client
let chrome: ChromeAccess

beforeAll(async () => {
  if (!run) return
  site = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/api/chat') {
        seen.push({ ...(request.headers.authorization !== undefined ? { authorization: request.headers.authorization } : {}), body: raw })
        if (request.headers.authorization !== 'Bearer page-token-123') {
          response.writeHead(401).end('{"error":"sign in"}')
          return
        }
        const body = JSON.parse(raw) as { model: string; messages: { content: string }[] }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ id: 'r1', reply: `Echo from ${body.model}: ${body.messages.at(-1)?.content ?? ''}` }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(PAGE_HTML)
    })
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', () => resolve()))
  siteUrl = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}/chat`
  const windows = process.platform === 'win32'
  const args = ['-y', 'chrome-devtools-mcp@1.13.0', '--headless', '--isolated', '--no-usage-statistics', '--no-performance-crux', `--executablePath=${CHROME ?? ''}`]
  const transport = new StdioClientTransport({ command: windows ? 'cmd' : 'npx', args: windows ? ['/c', 'npx', ...args] : args, stderr: 'ignore' })
  client = new Client({ name: 'light-code-test', version: '0' })
  await client.connect(transport)
  const tools = (await client.listTools()).tools
  chrome = {
    server: 'chrome-webchat',
    call: async (tool, toolArgs) => {
      const result = (await client.callTool({ name: tool, arguments: toolArgs })) as { content?: { type: string; text?: string }[]; isError?: boolean }
      return { text: (result.content ?? []).map((part) => part.text ?? '').join('\n'), isError: result.isError === true }
    },
    schema: (tool) => tools.find((entry) => entry.name === tool)?.inputSchema as Record<string, unknown> | undefined,
  }
}, 180_000)

afterAll(async () => {
  if (!run) return
  await client?.close().catch(() => undefined)
  await new Promise<void>((resolve) => site.close(() => resolve()))
})

describe.skipIf(!run)('the web chat through the real chrome-devtools-mcp 1.13.0 and Chrome', () => {
  it('requires pageId on evaluate_script, as reported', () => {
    const schema = chrome.schema('evaluate_script') as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties)).toContain('pageId')
  })

  it('opens the page, captures with "Send it for me", and answers through the approved backend only', async () => {
    const origin = new URL(siteUrl).origin
    const pageId = await selectWebChatPage(chrome, siteUrl)
    expect(typeof pageId).toBe('number')

    // The capture, as the bridge runs it.
    const phrase = capturePhrase()
    expect(await runScript(chrome, watchScript(origin, phrase), pageId)).toMatchObject({ ok: true })
    expect(await runScript(chrome, typePhraseScript(origin, phrase), pageId)).toMatchObject({ ok: true })
    let found: CapturedRequest[] = []
    for (let i = 0; i < 40 && found.length === 0; i += 1) {
      const read = await runScript(chrome, readCaptureScript(origin), pageId)
      found = (read['found'] as CapturedRequest[] | undefined) ?? []
      if (found.length === 0) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const { candidates } = candidatesFrom(found, siteUrl, phrase)
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    expect(candidate.backend).toBe(`${origin}/api/chat`)
    expect(candidate.model).toBe('gemini-pro')
    expect(candidate.fromPage).toEqual(['authorization'])
    expect(JSON.stringify(candidate.setup)).not.toContain('page-token-123')

    // A consultation: the token comes from the page, the question is written in, the answer read back.
    const answer = await askWebChat(chrome, candidate.setup, 'Is "this" fine?\nTwo lines.')
    expect(answer).toBe('Echo from gemini-pro: Is "this" fine?\nTwo lines.')
    expect(seen.at(-1)?.authorization).toBe('Bearer page-token-123')

    // Asked again: the open tab is found and reused, not a new one opened.
    const before = (await chrome.call('list_pages', {})).text.split('\n').filter((line) => line.includes(origin)).length
    expect(await askWebChat(chrome, candidate.setup, 'again')).toBe('Echo from gemini-pro: again')
    const after = (await chrome.call('list_pages', {})).text.split('\n').filter((line) => line.includes(origin)).length
    expect(after).toBe(before)
  }, 180_000)
})

/*
 * Reported: "POST <url> on another site than the web chat ... so it is not used" - the chat's backend is on another site.
 * Such a chat is used through its window: typed in, the answer read from the page's own reply. A stand-in page on one
 * origin whose backend is on another, with the conversation id in the path.
 */
let api: Server
let apiOrigin = ''
let windowPage: Server
let windowPageUrl = ''

const WINDOW_HTML = (apiBase: string): string => `<!doctype html><html><head><title>Internal AI Chat</title></head><body>
<textarea id="box"></textarea><div id="out"></div>
<script>
const CONVERSATION = '8f3a9c2e41d7b6a0'
async function send(text) {
  document.getElementById('box').value = ''
  const line = document.createElement('div'); line.textContent = 'You: ' + text; document.getElementById('out').appendChild(line)
  const r = await fetch('${apiBase}/v2/conversations/' + CONVERSATION + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gemini-pro', content: text }) })
  const j = await r.json()
  const reply = document.createElement('div'); reply.textContent = 'Bot: ' + j.message.text; document.getElementById('out').appendChild(reply)
}
document.getElementById('box').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(e.target.value) } })
</script></body></html>`

describe.skipIf(!run)('a web chat whose backend is on another site, through its window', () => {
  beforeAll(async () => {
    api = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
      request.on('end', () => {
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST', Connection: 'close' }
        if (request.method === 'OPTIONS') {
          response.writeHead(204, cors).end()
          return
        }
        const body = JSON.parse(raw) as { model: string; content: string }
        response.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ id: 'm-42', message: { role: 'assistant', text: `${body.model} says: ${body.content}` } }))
      })
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()))
    apiOrigin = `http://127.0.0.1:${String((api.address() as AddressInfo).port)}`
    windowPage = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', Connection: 'close' })
      response.end(WINDOW_HTML(apiOrigin))
    })
    await new Promise<void>((resolve) => windowPage.listen(0, '127.0.0.1', () => resolve()))
    windowPageUrl = `http://127.0.0.1:${String((windowPage.address() as AddressInfo).port)}/`
  })

  afterAll(() => {
    api.closeAllConnections()
    api.close()
    windowPage.closeAllConnections()
    windowPage.close()
  })

  it('captures it, asks the other site directly, and through the chat window by typing', async () => {
    const { askThroughWindow } = await import('./chrome.js')
    const origin = new URL(windowPageUrl).origin
    const pageId = await selectWebChatPage(chrome, windowPageUrl)
    const phrase = capturePhrase()
    expect(await runScript(chrome, watchScript(origin, phrase), pageId)).toMatchObject({ ok: true })
    expect(await runScript(chrome, typePhraseScript(origin, phrase), pageId)).toMatchObject({ ok: true })
    let found: CapturedRequest[] = []
    for (let i = 0; i < 40 && found.length === 0; i += 1) {
      found = ((await runScript(chrome, readCaptureScript(origin), pageId))['found'] as CapturedRequest[] | undefined) ?? []
      if (found.length === 0) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const { candidates } = candidatesFrom(found, windowPageUrl, phrase)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ window: true, backend: `${apiOrigin}/v2/conversations/8f3a9c2e41d7b6a0/messages` })
    const setup = candidates[0]!.setup
    expect(setup.method).toBe('replay')

    // Primary way: straight to the approved address on the other site, from inside the page, as the page sends it.
    expect(await askWebChat(chrome, setup, 'What is 1 + 1?')).toBe('gemini-pro says: What is 1 + 1?')

    const read = await askThroughWindow(chrome, setup, 'What is 2 + 2?', { timeoutMs: 60_000 })
    expect(read).toEqual({ answer: 'gemini-pro says: What is 2 + 2?', from: 'reply' })

    // A reply from a path that is not the approved one is never taken: the screen is read instead.
    const elsewhere = { ...setup, backendUrl: `${apiOrigin}/v2/other/8f3a9c2e41d7b6a0/messages` }
    const fromScreen = await askThroughWindow(chrome, elsewhere, 'And 3 + 3?', { timeoutMs: 60_000, quietMs: 1500 })
    expect(fromScreen.from).toBe('screen')
    expect(fromScreen.answer).toContain('gemini-pro says: And 3 + 3?')
  }, 180_000)
})
