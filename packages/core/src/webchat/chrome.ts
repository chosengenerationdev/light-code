import type { RawToolResult } from '../mcp/client.js'
import { readAnswer } from './answer.js'
import { askScript, scriptResult, watchScript } from './inpage.js'
import type { WebChatSetup } from './setup.js'

/**
 * Chrome, through the user's own Chrome DevTools MCP server - called by Light Code itself, never by the agent (the
 * bridge withholds this server's tools from the agent, rule 6 in guard.ts).
 *
 * Written against chrome-devtools-mcp 1.13.0's tool reference and source, and working with older releases too:
 * - `list_pages` (and `new_page`, `select_page`) answer with a "## Pages" list, one line per tab:
 *   `3: Title (https://url) [selected]`, or `3: https://url` when the tab has no title. The number is the tab's id.
 * - `evaluate_script` takes `function` (a function declaration as text) and, from 1.x, a required `pageId` - reported:
 *   "Invalid arguments for tool evaluate_script: pageId: expected number, received undefined". Older releases had no
 *   `pageId` and ran on the selected tab; parameter names are therefore read from each tool's own schema.
 */
export interface ChromeAccess {
  server: string
  call(tool: string, args: Record<string, unknown>): Promise<RawToolResult>
  /** The tool's input schema, as the server declared it. */
  schema(tool: string): Record<string, unknown> | undefined
}

/** A Chrome DevTools MCP server among the connected ones: the first that offers both tools this needs. */
export function isChromeDevToolsServer(toolNames: readonly string[]): boolean {
  return toolNames.includes('evaluate_script') && (toolNames.includes('list_pages') || toolNames.includes('new_page'))
}

function propertyNames(schema: Record<string, unknown> | undefined): string[] {
  const properties = schema?.['properties']
  return properties !== null && typeof properties === 'object' ? Object.keys(properties as object) : []
}

export interface ChromePage {
  id: number
  url: string
  selected: boolean
}

/**
 * The tabs in a "## Pages" list. The address is the last `(…)` holding a URL when the tab has a title (titles can
 * hold brackets of their own), else the first word after the id.
 */
export function pagesIn(text: string): ChromePage[] {
  const pages: ChromePage[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s*:\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    const rest = match[2] ?? ''
    const inBrackets = [...rest.matchAll(/\((https?:\/\/[^\s)]+)\)/g)].at(-1)?.[1]
    const url = inBrackets ?? /^(https?:\/\/\S+)/.exec(rest)?.[1]
    if (url === undefined) continue
    pages.push({ id: Number(match[1]), url, selected: /\[selected\]/i.test(rest) })
  }
  return pages
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/**
 * The web chat's tab, made the one scripts run on: an open tab on the same site (the selected one first), else a new
 * tab at the page address. Never any other site. Returns its id for `evaluate_script` - undefined from an older server
 * that has no ids and runs on the selected tab.
 */
export async function selectWebChatPage(chrome: ChromeAccess, pageUrl: string): Promise<number | undefined> {
  const origin = new URL(pageUrl).origin
  const listed = await chrome.call('list_pages', {})
  const existing = listed.isError ? [] : pagesIn(listed.text).filter((page) => sameOrigin(page.url, origin))
  const chosen = existing.find((page) => page.selected) ?? existing[0]
  if (chosen !== undefined) {
    if (!chosen.selected && chrome.schema('select_page') !== undefined) {
      const names = propertyNames(chrome.schema('select_page'))
      const key = names.includes('pageId') ? 'pageId' : (names.find((name) => /idx|index|id/i.test(name)) ?? 'pageId')
      const selected = await chrome.call('select_page', { [key]: chosen.id })
      if (selected.isError) throw new Error(`Chrome could not select the web chat tab: ${selected.text.slice(0, 300)}`)
    }
    return chosen.id
  }
  const opened = await chrome.call('new_page', { url: pageUrl })
  if (opened.isError) throw new Error(`Chrome could not open ${pageUrl}: ${opened.text.slice(0, 300)}`)
  const now = pagesIn(opened.text).filter((page) => sameOrigin(page.url, origin))
  const fresh = now.find((page) => page.selected) ?? now.at(-1)
  if (fresh !== undefined) return fresh.id
  // A server that does not list pages after opening one: ask again.
  const again = await chrome.call('list_pages', {})
  const found = again.isError ? [] : pagesIn(again.text).filter((page) => sameOrigin(page.url, origin))
  return (found.find((page) => page.selected) ?? found.at(-1))?.id
}

/** Runs one script (`inpage.ts`) on the web chat's tab and returns what it returned. */
export async function runScript(chrome: ChromeAccess, source: string, pageId: number | undefined): Promise<Record<string, unknown>> {
  const names = propertyNames(chrome.schema('evaluate_script'))
  const key = names.includes('function') ? 'function' : names.includes('expression') ? 'expression' : (names[0] ?? 'function')
  const args: Record<string, unknown> = { [key]: source }
  if (names.includes('pageId')) {
    if (pageId === undefined) throw new Error('Chrome needs the web chat tab\'s id, and none was found in its list of tabs.')
    args['pageId'] = pageId
  }
  // These scripts only read and send; waiting for the page to settle first only slows them down.
  if (names.includes('waitForStableDom')) args['waitForStableDom'] = false
  const result = await chrome.call('evaluate_script', args)
  if (result.isError) throw new Error(`Chrome could not run the script: ${result.text.slice(0, 400)}`)
  const value = result.structured ?? scriptResult(result.text)
  if (value === null || typeof value !== 'object') throw new Error(`Chrome returned something unexpected: ${result.text.slice(0, 300)}`)
  return value as Record<string, unknown>
}

/** One consultation, start to finish. Throws with a sentence saying what to do when it cannot be answered. */
export async function askWebChat(chrome: ChromeAccess, setup: WebChatSetup, question: string): Promise<string> {
  const origin = new URL(setup.pageUrl).origin
  const pageId = await selectWebChatPage(chrome, setup.pageUrl)
  // Watching the page's own requests is what lets a credential header be taken from it rather than stored.
  const watched = await runScript(chrome, watchScript(origin, undefined), pageId)
  if (watched['ok'] !== true) throw new Error(String(watched['error'] ?? 'The web chat page could not be prepared.'))
  const sent = await runScript(chrome, askScript(setup, question), pageId)
  if (Array.isArray(sent['needsActivity'])) {
    throw new Error(
      `The web chat signs its requests with ${(sent['needsActivity'] as string[]).join(', ')}, which Light Code takes from the page and never stores. Send any message in the web chat tab once (or reload it), then ask again.`,
    )
  }
  if (sent['ok'] !== true) throw new Error(String(sent['error'] ?? 'The request could not be made.'))
  const status = Number(sent['status'])
  if (status === 401 || status === 403) throw new Error(`The web chat answered HTTP ${String(status)}: sign in to it again in Chrome, then ask again.`)
  if (status >= 400) throw new Error(`The web chat answered HTTP ${String(status)}: ${String(sent['text'] ?? '').slice(0, 300)}`)
  const answer = readAnswer(String(sent['text'] ?? ''), setup.response)
  if (answer === undefined || answer.trim().length === 0) {
    throw new Error('The answer was not where the capture found it - the web chat may have changed how it replies. Capture again in Settings → Agents → Web chat.')
  }
  return answer
}
