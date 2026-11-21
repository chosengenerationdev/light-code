import { promises as fs } from 'node:fs'
import path from 'node:path'

import { writeFileAtomically } from '../usage/events.js'

/**
 * Consulting a model through an internal web chat - asked for: the office offers Gemini only in a web chat, "consult
 * with gemini model using chrome mcp tools", and then, firmly: "it shouldnt go outside [the organisation] at any stage ... i dont
 * want agent to go rougue to get gemini from outside office".
 *
 * Method: the user's own Chrome DevTools MCP server, attached to the user's own signed-in Chrome. Once, the page's own
 * request for a chat message is captured (the user sends a unique phrase; the request carrying it is recorded). After
 * that, `ask_web_chat` replays that request from inside the page with the question in place of the phrase - so the
 * browser sends it, with the user's session, to the internal site and nowhere else. Light Code opens no connection.
 *
 * The capture is kept for the Windows user (`<personal>/web-chat.json`), so every chat, codebase and host on the machine
 * shares one. Never a session token: headers that carry one are kept by *name* only and taken from the page at the time
 * of asking.
 */

/** Where the question goes in the captured body. */
export const QUESTION_PLACEHOLDER = '%%LIGHT_CODE_QUESTION%%'

export interface WebChatResponseSpec {
  /** `json`: one JSON document; `sse`: server-sent events of JSON; `text`: the body is the answer. */
  kind: 'json' | 'sse' | 'text'
  /** Where the answer text is inside each JSON document (keys and array indexes). */
  path?: (string | number)[]
  /** SSE only: each event adds to the answer (`delta`), or repeats it so far (`cumulative`). */
  mode?: 'delta' | 'cumulative'
}

export interface WebChatSetup {
  version: 1
  /** The chat page the user opens in Chrome, e.g. https://ai-chat.example.internal/chat. */
  pageUrl: string
  request: {
    /** Path and query on the page's own site - never another site. */
    path: string
    method: string
    /** Plain headers sent as captured (content type, accept, and the like). */
    headers: Record<string, string>
    /** Headers whose value is a credential: taken from the page's own latest request each time, never stored. */
    fromPage: string[]
    /** The captured body with the question's place marked by `QUESTION_PLACEHOLDER`. */
    body: string
    /** How the question is written into the body. */
    encoding: 'json' | 'form' | 'raw'
  }
  response: WebChatResponseSpec
  /**
   * The MCP server (by its name in Settings → MCP) dedicated to the web chat - asked for: "setup to choose the chrome mcp
   * that needs to be associated with web chat, i dont want existing chrome mcp to be disturbed". Only this one is used and
   * withheld from the assistant; any other Chrome server is left as it was.
   */
  server?: string | undefined
  /** The model the captured request named, for showing; `modelOverride` replaces it in a JSON body. */
  model?: string
  modelOverride?: string
  capturedAt: string
}

export function webChatSetupFile(personalDir: string): string {
  return path.join(personalDir, 'web-chat.json')
}

export async function readWebChatSetup(file: string): Promise<WebChatSetup | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<WebChatSetup>
    if (value.version !== 1 || typeof value.pageUrl !== 'string' || value.request === undefined || value.response === undefined) return undefined
    return value as WebChatSetup
  } catch {
    return undefined
  }
}

export async function writeWebChatSetup(file: string, setup: WebChatSetup | undefined): Promise<void> {
  if (setup === undefined) {
    await fs.rm(file, { force: true })
    return
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomically(file, JSON.stringify(setup, null, 2))
}

/** Header names whose values are credentials: never stored, read from the page's own latest request instead. */
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|x-csrf-token|x-xsrf-token|csrf-token|x-auth-token|x-api-key|api-key|x-access-token|x-id-token)$|token|secret|session|auth/i
/** Header names the browser sets itself, or that would be wrong when replayed. */
const DROPPED_HEADER = /^(content-length|host|origin|referer|connection|accept-encoding|cookie|sec-.*|user-agent)$/i

/** The headers to keep as captured, and the names to take from the page each time. */
export function splitHeaders(headers: Record<string, string>): { plain: Record<string, string>; fromPage: string[] } {
  const plain: Record<string, string> = {}
  const fromPage: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (DROPPED_HEADER.test(lower)) continue
    if (CREDENTIAL_HEADER.test(lower)) fromPage.push(lower)
    else plain[lower] = value
  }
  return { plain, fromPage }
}

/** The body as a template: the marker replaced by the placeholder, and how the question must be written into it. */
export function bodyTemplate(body: string, marker: string, contentType: string | undefined): { body: string; encoding: 'json' | 'form' | 'raw' } | undefined {
  if (!body.includes(marker)) return undefined
  const type = (contentType ?? '').toLowerCase()
  let encoding: 'json' | 'form' | 'raw' = 'raw'
  if (type.includes('json')) encoding = 'json'
  else if (type.includes('x-www-form-urlencoded')) encoding = 'form'
  else {
    try {
      JSON.parse(body)
      encoding = 'json'
    } catch {
      // Not JSON: written in as it is.
    }
  }
  return { body: body.split(marker).join(QUESTION_PLACEHOLDER), encoding }
}

/** The model a JSON body names, if any (a top-level `model`, or `model` one level down). */
export function modelIn(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as Record<string, unknown>
    if (typeof value['model'] === 'string') return value['model']
    for (const nested of Object.values(value)) {
      if (nested !== null && typeof nested === 'object' && typeof (nested as Record<string, unknown>)['model'] === 'string') return (nested as Record<string, string>)['model']
    }
  } catch {
    // Not JSON.
  }
  return undefined
}

/** The body for one question: the question written in the way the body expects, and the model replaced if asked. */
export function fillBody(setup: WebChatSetup, question: string): string {
  const written =
    setup.request.encoding === 'json' ? JSON.stringify(question).slice(1, -1) : setup.request.encoding === 'form' ? encodeURIComponent(question) : question
  let body = setup.request.body.split(QUESTION_PLACEHOLDER).join(written)
  const override = setup.modelOverride?.trim()
  if (override !== undefined && override.length > 0 && setup.request.encoding === 'json') {
    try {
      const value = JSON.parse(body) as Record<string, unknown>
      if (typeof value['model'] === 'string') {
        value['model'] = override
        body = JSON.stringify(value)
      }
    } catch {
      // Left as it is.
    }
  }
  return body
}
