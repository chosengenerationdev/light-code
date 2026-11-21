import { findAnswer } from './answer.js'
import { bodyTemplate, modelIn, splitHeaders, type WebChatSetup } from './setup.js'

/**
 * The one-time capture: the user sends a unique phrase in the web chat, the page's own request carrying it is recorded
 * (`inpage.ts`), and it is turned into a setup here - shown to the user, and saved only when they approve it ("backend
 * address it finds, user should approve it is the right one to use, and only that backend address should be used").
 */

export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  status?: number
  contentType?: string
  response?: string
}

/** What the user is shown for approval. */
export interface CaptureCandidate {
  /** The backend address: the only one consultations will use once approved. */
  backend: string
  method: string
  model?: string
  /** The start of the reply read from where the answer was found, so the user can see it is the answer. */
  answerPreview: string
  /** Credential headers taken from the page each time, by name. */
  fromPage: string[]
  setup: WebChatSetup
}

/** A unique phrase to send: nothing a person would type, nothing a page would send by itself. */
export function capturePhrase(random: () => number = Math.random): string {
  return `light-code-capture-${Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0')}`
}

/**
 * The approvable setups from what was recorded - one per request that carried the phrase. A request to another site,
 * one whose body did not hold the phrase as text, or one whose reply holds no answer, is not offered; the reason is.
 */
export function candidatesFrom(found: readonly CapturedRequest[], pageUrl: string, marker: string, now = new Date()): { candidates: CaptureCandidate[]; refused: string[] } {
  const origin = new URL(pageUrl).origin
  const candidates: CaptureCandidate[] = []
  const refused: string[] = []
  for (const entry of found) {
    let url: URL
    try {
      url = new URL(entry.url)
    } catch {
      refused.push(`${entry.url}: not an address.`)
      continue
    }
    if (url.origin !== origin) {
      refused.push(`${entry.method} ${entry.url}: on another site than the web chat (${origin}), so it is not used.`)
      continue
    }
    const contentType = Object.entries(entry.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    const template = bodyTemplate(entry.body, marker, contentType)
    if (template === undefined) continue
    const answer = findAnswer(entry.response ?? '', entry.contentType, marker)
    if (answer === undefined) {
      refused.push(`${entry.method} ${url.pathname}: its reply held no answer that could be read.`)
      continue
    }
    const { plain, fromPage } = splitHeaders(entry.headers)
    const model = modelIn(entry.body)
    const setup: WebChatSetup = {
      version: 1,
      pageUrl,
      request: { path: `${url.pathname}${url.search}`, method: entry.method.toUpperCase(), headers: plain, fromPage, body: template.body, encoding: template.encoding },
      response: answer.spec,
      ...(model !== undefined ? { model } : {}),
      capturedAt: now.toISOString(),
    }
    candidates.push({
      backend: `${url.origin}${url.pathname}${url.search}`,
      method: setup.request.method,
      ...(model !== undefined ? { model } : {}),
      answerPreview: answer.answer.slice(0, 300),
      fromPage,
      setup,
    })
  }
  return { candidates, refused }
}
