import { z } from 'zod'
import type { Tool } from '../tools/index.js'
import type { JupyterClient, RemoteEntry } from './client.js'

/**
 * `hub_browse`: look around a JupyterHub server *outside* the folders a codebase copies - list a
 * folder, find files by name, read one - without copying anything or changing anything.
 *
 * Asked for in two steps: "can other codebases in fire code use token from existing jupyterhub
 * project to explore the files outside the currently added folder?", then "please add browse hub
 * tool too". So it is offered in a hub codebase for its own hub, and in every other Fire Code
 * codebase for each hub codebase beside it, named by that codebase's @name.
 *
 * - **Read only, by construction.** It has list, find and read; no write, rename or delete exists
 *   here to be reached. Editing stays with the hub codebase, where edits are diffed, approved,
 *   saved with conflict checks and covered by rollback.
 * - **The token never leaves the client.** Fire Code names it by its secret-store slot; it is read
 *   per call and sent only to that hub, in a header (see `client.ts`).
 * - **Bounded.** A find walks breadth-first and stops at a fixed number of folders; a read is cut at
 *   a fixed size and says where to continue. A hub home can hold millions of files.
 */

export interface BrowsableHub {
  /** How the model names it: the codebase's @name, or "this" for a hub codebase's own hub. */
  name: string
  label: string
  client: JupyterClient
}

const MAX_LISTED = 500
const MAX_FOLDERS_WALKED = 400
const MAX_FOUND = 200
const READ_LINES = 2_000
const READ_CHARS = 200_000
/** Never walked into by `find`: build output, caches and virtualenvs, which are noise at any depth. */
const SKIPPED = new Set(['node_modules', '.git', '__pycache__', '.ipynb_checkpoints', '.venv', 'venv', '.cache', '.local', '.conda'])

const schema = z.object({
  action: z.enum(['list', 'find', 'read']),
  hub: z.string().optional().describe('Which hub, when there are several: its codebase name as listed in the description.'),
  path: z
    .string()
    .optional()
    .describe('A path on the hub from your home folder there, "/"-separated; empty or "/" for the home folder itself.'),
  name: z.string().optional().describe('For find: part of a file or folder name, or a glob such as "*.sql" (case-insensitive).'),
  offset: z.number().int().min(1).optional().describe('For read: the first line to show (from 1).'),
  limit: z.number().int().min(1).max(READ_LINES).optional().describe(`For read: how many lines (at most ${String(READ_LINES)}).`),
})

function cleanPath(input: string | undefined): string | { error: string } {
  const parts = (input ?? '').replace(/\\/g, '/').split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.includes('..')) return { error: 'A hub path cannot climb out with "..": give it from your home folder on the hub.' }
  return parts.join('/')
}

function matcher(pattern: string): (name: string) => boolean {
  const lower = pattern.toLowerCase()
  if (!/[*?]/.test(lower)) return (name) => name.toLowerCase().includes(lower)
  const regex = new RegExp(`^${lower.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return (name) => regex.test(name.toLowerCase())
}

function describeEntry(entry: RemoteEntry): string {
  const size = entry.size !== undefined && entry.type !== 'directory' ? `  ${formatSize(entry.size)}` : ''
  return `${entry.type === 'directory' ? `${entry.name}/` : entry.name}${size}${entry.lastModified ? `  ${entry.lastModified.slice(0, 16).replace('T', ' ')}` : ''}`
}

function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${String(bytes)} B`
}

export function createHubBrowseTool(hubs: readonly BrowsableHub[]): Tool | undefined {
  if (hubs.length === 0) return undefined
  const names = hubs.map((hub) => `"${hub.name}" (${hub.label})`).join(', ')
  return {
    name: 'hub_browse',
    group: 'read',
    description:
      `Look around a JupyterHub server beyond the folders copied here, read only: "list" a folder, "find" files by name ` +
      `under a folder, or "read" a text file (line-numbered, with offset/limit). Paths are from your home folder on the ` +
      `hub. Nothing is copied or changed. Hubs: ${names}.` +
      (hubs.length > 1 ? ' Name one with hub.' : ''),
    parametersSchema: schema,
    async preview(params) {
      const p = params as z.infer<typeof schema>
      return { kind: 'text', text: `${p.action} ${p.path ?? '/'}${p.name !== undefined ? ` for "${p.name}"` : ''} on ${pick(hubs, p.hub)?.label ?? 'the hub'}` }
    },
    async execute(params, context) {
      const p = params as z.infer<typeof schema>
      const hub = pick(hubs, p.hub)
      if (hub === undefined) return { content: `Name the hub: one of ${names}.`, isError: true }
      const where = cleanPath(p.path)
      if (typeof where !== 'string') return { content: where.error, isError: true }
      const shown = where.length > 0 ? where : 'your home folder'
      try {
        if (p.action === 'list') {
          const entries = await hub.client.list(where, context.signal)
          if (entries === undefined) return { content: `Nothing at ${shown} on ${hub.label}.`, isError: true }
          if (entries.length === 1 && entries[0]?.path === where && entries[0].type !== 'directory') {
            return { content: `${shown} is a file: ${describeEntry(entries[0])}. Use "read" to see it.` }
          }
          const sorted = [...entries].sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name))
          const lines = sorted.slice(0, MAX_LISTED).map(describeEntry)
          const more = sorted.length > MAX_LISTED ? `\n… and ${String(sorted.length - MAX_LISTED)} more` : ''
          return { content: `${shown} on ${hub.label} (${String(entries.length)} entries):\n${lines.join('\n')}${more}` }
        }

        if (p.action === 'find') {
          if (p.name === undefined || p.name.trim().length === 0) return { content: 'Give name: part of a file name, or a glob like "*.sql".', isError: true }
          const matches = matcher(p.name.trim())
          const found: string[] = []
          const queue = [where]
          let walked = 0
          while (queue.length > 0 && walked < MAX_FOLDERS_WALKED && found.length < MAX_FOUND) {
            if (context.signal?.aborted === true) break
            const folder = queue.shift() as string
            walked++
            const entries = await hub.client.list(folder, context.signal).catch(() => undefined)
            for (const entry of entries ?? []) {
              if (entry.type === 'directory') {
                if (!SKIPPED.has(entry.name) && !entry.name.startsWith('.')) queue.push(entry.path)
              }
              if (matches(entry.name) && found.length < MAX_FOUND) found.push(entry.type === 'directory' ? `${entry.path}/` : entry.path)
            }
          }
          const cut =
            queue.length > 0
              ? `\n(Stopped after ${String(walked)} folders${found.length >= MAX_FOUND ? ` and ${String(MAX_FOUND)} matches` : ''}; search a narrower path for the rest.)`
              : ''
          if (found.length === 0) return { content: `Nothing named like "${p.name}" under ${shown} on ${hub.label}.${cut}` }
          return { content: `Under ${shown} on ${hub.label}, named like "${p.name}":\n${found.join('\n')}${cut}` }
        }

        if (where.length === 0) return { content: 'Give path: the file to read.', isError: true }
        const stat = await hub.client.stat(where, context.signal)
        if (stat === undefined) return { content: `Nothing at ${where} on ${hub.label}.`, isError: true }
        if (stat.type === 'directory') return { content: `${where} is a folder. Use "list".`, isError: true }
        const { bytes } = await hub.client.read(where, context.signal)
        if (bytes.subarray(0, 8_000).includes(0)) return { content: `${where} is not a text file (${formatSize(bytes.length)}).`, isError: true }
        const all = bytes.toString('utf8').slice(0, 20_000_000).split(/\r?\n/)
        const start = (p.offset ?? 1) - 1
        let used = 0
        const lines: string[] = []
        for (let index = start; index < all.length && lines.length < (p.limit ?? READ_LINES); index++) {
          const line = `${String(index + 1).padStart(6)}  ${all[index] ?? ''}`
          if (used + line.length > READ_CHARS) break
          used += line.length + 1
          lines.push(line)
        }
        const last = start + lines.length
        const rest = last < all.length ? `\n(Lines ${String(start + 1)}-${String(last)} of ${String(all.length)}; continue with offset ${String(last + 1)}.)` : ''
        return { content: `${where} on ${hub.label}:\n${lines.join('\n')}${rest}` }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

function pick(hubs: readonly BrowsableHub[], name: string | undefined): BrowsableHub | undefined {
  if (name === undefined || name.trim().length === 0) return hubs.length === 1 ? hubs[0] : undefined
  const wanted = name.trim().replace(/^@/, '').replace(/:$/, '').toLowerCase()
  return hubs.find((hub) => hub.name.toLowerCase() === wanted)
}
