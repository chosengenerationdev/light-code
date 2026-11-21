import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

import type { McpServerConfig } from '../mcp/types.js'
import { findAnswer, readAnswer } from './answer.js'
import { candidatesFrom } from './capture.js'
import { chromeServerProblems, webChatAddressProblem } from './guard.js'
import { askScript, readCaptureScript, scriptResult, watchScript } from './inpage.js'
import { fillBody, type WebChatSetup } from './setup.js'
import { createAskWebChatTool } from './tool.js'

/**
 * Asked for: consult the office's web chat (Gemini) through Chrome's MCP server - and "it shouldnt go outside [the organisation] at
 * any stage ... i dont want agent to go rougue to get gemini from outside office"; "backend address it finds, user
 * should approve it ... and only that backend address should be used for future requests".
 */

const PAGE = 'https://ai-chat.example.internal/chat'
const MARKER = 'light-code-capture-0badf00d'

describe('the rules that keep it inside the organisation', () => {
  const ok = { command: 'C:/npm/chrome-devtools-mcp.cmd', args: ['--autoConnect', '--no-usage-statistics', '--no-performance-crux'] } as McpServerConfig

  it('accepts an installed server with its reporting off, attached to this PC', () => {
    expect(chromeServerProblems(ok)).toEqual([])
    expect(chromeServerProblems({ ...ok, args: [...(ok as { args: string[] }).args, '--browserUrl', 'http://127.0.0.1:9222'] } as McpServerConfig)).toEqual([])
  })

  // Reported: "npx downloads from internal artifactory of npm setup" - so npx is allowed when that is where it downloads.
  it('allows npx with a pinned version, and refuses it otherwise', () => {
    const npx = (spec: string): McpServerConfig => ({ command: 'npx', args: ['-y', spec, '--autoConnect', '--no-usage-statistics', '--no-performance-crux'] }) as McpServerConfig
    expect(chromeServerProblems(npx('chrome-devtools-mcp@1.13.0'))).toEqual([])
    expect(chromeServerProblems(npx('chrome-devtools-mcp@latest')).join(' ')).toContain('must be pinned')
    expect(chromeServerProblems(npx('chrome-devtools-mcp')).join(' ')).toContain('must be pinned')
    expect(chromeServerProblems({ command: 'uvx', args: ['x', '--no-usage-statistics', '--no-performance-crux'] } as McpServerConfig).join(' ')).toContain('downloads the package each start')
  })

  // Reported: "i already included that in the command" - arguments typed on one line arrive as one string.
  it('reads the flags however the command line was typed', () => {
    const oneLine = { command: 'npx', args: ['-y chrome-devtools-mcp@1.13.0 --autoConnect --no-usage-statistics --no-performance-crux'] } as McpServerConfig
    expect(chromeServerProblems(oneLine)).toEqual([])
    const wholeLine = { command: 'npx -y chrome-devtools-mcp@1.13.0 --autoConnect --no-usage-statistics --no-performance-crux' } as McpServerConfig
    expect(chromeServerProblems(wholeLine)).toEqual([])
    expect(chromeServerProblems({ command: 'npx', args: ['-y chrome-devtools-mcp@latest --no-usage-statistics --no-performance-crux'] } as McpServerConfig).join(' ')).toContain('must be pinned')
  })

  it('refuses a remote server, missing flags, and a Chrome elsewhere', () => {
    expect(chromeServerProblems({ url: 'https://mcp.example.com/chrome' } as McpServerConfig).join(' ')).toContain('not as a remote server')
    expect(chromeServerProblems({ command: 'chrome-devtools-mcp', args: ['--autoConnect'] } as McpServerConfig)).toEqual([
      'Its arguments must include --no-usage-statistics.',
      'Its arguments must include --no-performance-crux.',
    ])
    expect(chromeServerProblems({ ...ok, args: [...(ok as { args: string[] }).args, '--browserUrl=http://10.1.2.3:9222'] } as McpServerConfig).join(' ')).toContain('must attach to a Chrome on this PC')
  })

  // Asked for: "in my office link, ip resolves to [a public-looking range] ... can you remove this guard" - the approved
  // backend address is the boundary now; the page address only has to be a web address (no DNS lookup at all).
  it('takes any http(s) page address, whatever it resolves to', () => {
    expect(webChatAddressProblem('https://ai-chat.example.internal/chat')).toBeUndefined()
    expect(webChatAddressProblem('https://20.12.34.56/chat')).toBeUndefined()
    expect(webChatAddressProblem('ftp://ai-chat.example.internal/')).toContain('https://')
    expect(webChatAddressProblem('not an address')).toContain('not a web address')
  })
})

describe('reading the answer', () => {
  it('takes the longest text of a JSON reply, never the question', () => {
    const reply = JSON.stringify({ id: 'x', messages: [{ role: 'user', content: MARKER }], output: { text: 'Use a hash map keyed by the account id.' } })
    const found = findAnswer(reply, 'application/json', MARKER)!
    expect(found.answer).toBe('Use a hash map keyed by the account id.')
    expect(readAnswer(reply.replace('Use a hash map keyed by the account id.', 'Another answer.'), found.spec)).toBe('Another answer.')
  })

  it('adds up streamed pieces, or takes the last of a stream that repeats itself', () => {
    const delta = ['data: {"choices":[{"delta":{"content":"Use "}}]}', 'data: {"choices":[{"delta":{"content":"a map."}}]}', 'data: [DONE]'].join('\n')
    const d = findAnswer(delta, 'text/event-stream', MARKER)!
    expect(d).toMatchObject({ answer: 'Use a map.', spec: { kind: 'sse', mode: 'delta' } })
    const cumulative = ['data: {"text":"Use"}', 'data: {"text":"Use a"}', 'data: {"text":"Use a map."}'].join('\n')
    const c = findAnswer(cumulative, 'text/event-stream', MARKER)!
    expect(c).toMatchObject({ answer: 'Use a map.', spec: { kind: 'sse', mode: 'cumulative' } })
  })
})

describe('the capture: only an approved backend on the same site', () => {
  const request = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token', 'X-Client': 'web' },
    body: JSON.stringify({ model: 'gemini-pro', messages: [{ role: 'user', content: MARKER }] }),
    contentType: 'application/json',
    response: JSON.stringify({ reply: 'I do not understand that phrase.' }),
  }

  it('offers the request that carried the phrase, with the credential kept by name only', () => {
    const { candidates } = candidatesFrom([{ url: 'https://ai-chat.example.internal/api/chat?v=2', ...request }], PAGE, MARKER)
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    expect(candidate.backend).toBe('https://ai-chat.example.internal/api/chat?v=2')
    expect(candidate.model).toBe('gemini-pro')
    expect(candidate.fromPage).toEqual(['authorization'])
    expect(JSON.stringify(candidate.setup)).not.toContain('secret-token')
    expect(candidate.setup.request.headers).toEqual({ 'content-type': 'application/json', 'x-client': 'web' })
    expect(candidate.answerPreview).toBe('I do not understand that phrase.')
  })

  it('never offers a request to another site', () => {
    const { candidates, refused } = candidatesFrom([{ url: 'https://generativelanguage.googleapis.com/v1/chat', ...request }], PAGE, MARKER)
    expect(candidates).toEqual([])
    expect(refused[0]).toContain('on another site')
  })

  it('writes a question into the body safely, and the model chosen over the captured one', () => {
    const setup = candidatesFrom([{ url: 'https://ai-chat.example.internal/api/chat', ...request }], PAGE, MARKER).candidates[0]!.setup
    const body = JSON.parse(fillBody({ ...setup, modelOverride: 'gemini-ultra' }, 'Why "this"?\nLine two')) as { model: string; messages: { content: string }[] }
    expect(body.model).toBe('gemini-ultra')
    expect(body.messages[0]?.content).toBe('Why "this"?\nLine two')
  })
})

/** Runs a page script in a sandbox standing in for the chat page: its own `location`, `window` and `fetch`. */
async function inPage(source: string, page: { origin: string; fetch: (url: string, init: Record<string, unknown>) => Promise<unknown>; state?: unknown }): Promise<Record<string, unknown>> {
  const window: Record<string, unknown> = { __lcWebChat: page.state }
  const context = vm.createContext({ window, location: { origin: page.origin, href: `${page.origin}/chat` }, URL, fetch: page.fetch, JSON, Object, Array, String, Promise })
  window['fetch'] = page.fetch
  const run = vm.runInContext(`(${source})`, context) as () => Promise<Record<string, unknown>>
  return run()
}

const replyOf = (text: string, url = 'https://ai-chat.example.internal/api/chat'): unknown => ({ url, status: 200, headers: { get: () => 'application/json' }, text: async () => text })

describe('the request made in the page', () => {
  const setup: WebChatSetup = {
    version: 1,
    pageUrl: PAGE,
    request: { path: '/api/chat', method: 'POST', headers: { 'content-type': 'application/json' }, fromPage: ['authorization'], body: '{"q":"%%LIGHT_CODE_QUESTION%%"}', encoding: 'json' },
    response: { kind: 'json', path: ['reply'] },
    capturedAt: '2026-11-21T00:00:00Z',
  }

  it('goes to the approved backend only, with redirects refused and the session from the browser', async () => {
    const sent: { url: string; init: Record<string, unknown> }[] = []
    const result = await inPage(askScript(setup, 'Is "x" ok?'), {
      origin: 'https://ai-chat.example.internal',
      state: { headers: { authorization: 'Bearer from-the-page' } },
      fetch: async (url, init) => {
        sent.push({ url, init })
        return replyOf('{"reply":"Yes."}')
      },
    })
    expect(result).toMatchObject({ ok: true, status: 200, text: '{"reply":"Yes."}' })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe('https://ai-chat.example.internal/api/chat')
    expect(sent[0]?.init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'include', body: '{"q":"Is \\"x\\" ok?"}' })
    expect((sent[0]?.init['headers'] as Record<string, string>)['authorization']).toBe('Bearer from-the-page')
  })

  it('sends nothing from any other page, without the page credential, or to a path on another site', async () => {
    let calls = 0
    const counting = async (): Promise<unknown> => {
      calls += 1
      return replyOf('{}')
    }
    expect(await inPage(askScript(setup, 'q'), { origin: 'https://gemini.google.com', fetch: counting })).toMatchObject({ ok: false })
    expect(await inPage(askScript(setup, 'q'), { origin: 'https://ai-chat.example.internal', fetch: counting, state: { headers: {} } })).toMatchObject({ ok: false, needsActivity: ['authorization'] })
    const elsewhere = { ...setup, request: { ...setup.request, path: '//evil.example.com/steal' } }
    expect(await inPage(askScript(elsewhere, 'q'), { origin: 'https://ai-chat.example.internal', fetch: counting, state: { headers: { authorization: 'x' } } })).toMatchObject({ ok: false })
    expect(calls).toBe(0)
  })

  it('refuses a reply that came from another site', async () => {
    const result = await inPage(askScript(setup, 'q'), {
      origin: 'https://ai-chat.example.internal',
      state: { headers: { authorization: 'x' } },
      fetch: async () => replyOf('{}', 'https://elsewhere.example.com/x'),
    })
    expect(result).toMatchObject({ ok: false })
  })

  it('reads what the capture watcher saw, and the output of the MCP tool', async () => {
    const seen = await inPage(readCaptureScript('https://ai-chat.example.internal'), {
      origin: 'https://ai-chat.example.internal',
      fetch: async () => replyOf('{}'),
      state: { found: [{ url: 'u', response: 'r' }, { url: 'pending' }], ws: false, headers: {} },
    })
    expect(seen).toMatchObject({ ok: true, found: [{ url: 'u', response: 'r' }], pending: 1 })
    expect(scriptResult('Script ran on page and returned:\n```json\n{"ok":true}\n```')).toEqual({ ok: true })
    expect(watchScript('https://ai-chat.example.internal', MARKER)).toContain(JSON.stringify(MARKER))
  })
})

describe('ask_web_chat', () => {
  it('shows the exact text and the approved backend, and sends nothing when a rule fails', async () => {
    let asked = 0
    const tool = createAskWebChatTool({
      destination: async () => ({ backend: 'https://ai-chat.example.internal/api/chat', model: 'gemini-pro' }),
      problem: async () => 'No Chrome DevTools MCP server is connected (Settings → MCP).',
      ask: async () => {
        asked += 1
        return 'answer'
      },
    })
    const preview = await tool.preview!({ question: 'Review this function' }, {} as never)
    expect(preview).toMatchObject({ kind: 'text' })
    expect((preview as { text: string }).text).toContain('https://ai-chat.example.internal/api/chat (model gemini-pro)')
    expect((preview as { text: string }).text).toContain('Review this function')
    const result = await tool.execute({ question: 'Review this function' }, {} as never)
    expect(result).toMatchObject({ isError: true })
    expect(result.content).toContain('Nothing was sent.')
    expect(asked).toBe(0)
  })
})

describe('the wiring', () => {
  const bridge = readFileSync(path.join(import.meta.dirname, '../host/bridge.ts'), 'utf8')
  it("withholds the Chrome server's tools from the agent before they are registered, and only while it serves the web chat", () => {
    const reserve = bridge.indexOf('mcp.reserve(')
    const register = bridge.indexOf('for (const tool of mcp.enabledTools()) combined.register(tool')
    expect(reserve).toBeGreaterThan(0)
    expect(reserve).toBeLessThan(register)
    expect(bridge).toContain('if (chrome !== undefined && webChatFile !== undefined && cachedWebChat !== undefined) combined.register(createAskWebChatTool(webChatTool))')
    // Only the chosen server - any other Chrome server the user has stays as it was ("i dont want existing chrome mcp to be disturbed").
    expect(bridge).toContain('const chrome = webChatServer()\n    mcp.reserve(chrome !== undefined ? [chrome] : [])')
  })
  it('saves a capture only on the user approving it', () => {
    const saves = bridge.split('writeWebChatSetup(webChatFile, chosen.setup)').length - 1
    expect(saves).toBe(0)
    expect(bridge.split('writeWebChatSetup(webChatFile, { ...chosen.setup, server: chosenServer })').length - 1).toBe(1)
    expect(bridge.indexOf("message.type === 'confirmWebChatCapture'")).toBeLessThan(bridge.indexOf('writeWebChatSetup(webChatFile, { ...chosen.setup, server: chosenServer })'))
  })
})

// Found against the real chrome-devtools-mcp 1.13.0 (reported: "evaluate_script: pageId: expected number").
describe('Chrome as chrome-devtools-mcp 1.13.0 answers', () => {
  it('reads tab ids and addresses from the "## Pages" list, titled or not', async () => {
    const { pagesIn } = await import('./chrome.js')
    const list = ['## Pages', '1: about:blank', '2: Internal AI Chat (internal) (https://ai-chat.example.internal/chat) [selected]', '3: https://20.1.2.3/chat'].join('\n')
    expect(pagesIn(list)).toEqual([
      { id: 2, url: 'https://ai-chat.example.internal/chat', selected: true },
      { id: 3, url: 'https://20.1.2.3/chat', selected: false },
    ])
  })

  it('passes pageId to evaluate_script when the server asks for it, and fails clearly without one', async () => {
    const { runScript } = await import('./chrome.js')
    const calls: Record<string, unknown>[] = []
    const chrome = {
      server: 's',
      call: async (_tool: string, args: Record<string, unknown>) => {
        calls.push(args)
        return { text: 'Script ran on page and returned:\n```json\n{"ok":true}\n```', isError: false }
      },
      schema: () => ({ properties: { function: {}, pageId: {}, waitForStableDom: {} }, required: ['pageId'] }),
    }
    expect(await runScript(chrome, '() => ({ ok: true })', 7)).toEqual({ ok: true })
    expect(calls[0]).toEqual({ function: '() => ({ ok: true })', pageId: 7, waitForStableDom: false })
    await expect(runScript(chrome, '() => 1', undefined)).rejects.toThrow("web chat tab's id")
  })

  it('takes a reply that mentions the phrase as the answer, not some other field', () => {
    const reply = JSON.stringify({ id: 'r1', reply: `I am not sure what ${MARKER} means.` })
    expect(findAnswer(reply, 'application/json', MARKER)?.answer).toBe(`I am not sure what ${MARKER} means.`)
  })
})
