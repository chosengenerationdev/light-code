import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeFileAtomically } from '../usage/events.js'
import type { McpToolDescriptor } from './client.js'

/**
 * What each MCP server offered the last time any session of this codebase connected to it, so a session
 * starting now can offer the same tools at once and connect in the background.
 *
 * Reported: after a crash, or waking a codebase that had gone to sleep, a Fire Code chat took minutes before
 * it would answer - every chat is its own host process, and each one waited for every MCP server to start
 * and list its tools before its first reply. The servers themselves cannot be shared between processes (a
 * stdio server is a child of the process that talks to it), but what they offer can be: one file per
 * codebase, written by whichever session last connected, read by every session that starts.
 *
 * An entry is used only while the server's connection settings are unchanged (`signature`), and only for
 * the advertised list. A call still goes to a live connection - it waits for the server to finish starting
 * - and once the server answers its own list replaces the remembered one.
 */
export interface McpToolCache {
  read(): Promise<Record<string, McpToolCacheEntry>>
  write(server: string, entry: McpToolCacheEntry): Promise<void>
}

export interface McpToolCacheEntry {
  /** `connectionSignature` of the server entry the list came from. */
  signature: string
  tools: McpToolDescriptor[]
  /** When the list was read, ISO. */
  at: string
}

const MAX_SERVERS = 200

function parse(text: string): Record<string, McpToolCacheEntry> {
  const out: Record<string, McpToolCacheEntry> = {}
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return out
  }
  if (raw === null || typeof raw !== 'object') return out
  const servers = (raw as { servers?: unknown }).servers
  if (servers === null || typeof servers !== 'object') return out
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const entry = value as Partial<McpToolCacheEntry>
    if (typeof entry.signature !== 'string' || !Array.isArray(entry.tools)) continue
    const tools = entry.tools.filter(
      (tool): tool is McpToolDescriptor =>
        tool !== null && typeof tool === 'object' && typeof (tool as McpToolDescriptor).name === 'string' && typeof (tool as McpToolDescriptor).description === 'string',
    )
    out[name] = { signature: entry.signature, tools, at: typeof entry.at === 'string' ? entry.at : '' }
  }
  return out
}

/**
 * The cache as one JSON file. Several hosts write it (every chat of a codebase), so a write reads the file
 * again, changes one server, and replaces the file whole - two hosts writing at once lose at most one
 * server's newer list, which the next connection writes again.
 */
export function fileMcpToolCache(file: string): McpToolCache {
  let writing: Promise<void> = Promise.resolve()
  const read = async (): Promise<Record<string, McpToolCacheEntry>> => {
    try {
      return parse(await fs.readFile(file, 'utf8'))
    } catch {
      return {}
    }
  }
  return {
    read,
    write(server, entry) {
      writing = writing.then(async () => {
        const servers = await read()
        servers[server] = entry
        const names = Object.keys(servers)
        if (names.length > MAX_SERVERS) {
          names.sort((a, b) => (servers[a]?.at ?? '').localeCompare(servers[b]?.at ?? ''))
          for (const name of names.slice(0, names.length - MAX_SERVERS)) delete servers[name]
        }
        await writeFileAtomically(file, JSON.stringify({ version: 1, servers }))
      }).catch(() => undefined)
      return writing
    },
  }
}

export const MCP_TOOL_CACHE_FILE = 'mcp-tools.json'

export function mcpToolCacheFile(dir: string): string {
  return path.join(dir, MCP_TOOL_CACHE_FILE)
}
