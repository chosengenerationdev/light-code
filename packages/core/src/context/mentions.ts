import path from 'node:path'
import { confine } from '../fs/confine.js'
import type { PathDenylist } from '../fs/denylist.js'
import type { FileSystem } from '../platform/filesystem.js'

/**
 * `@`-mentions: the user names a file or folder in the composer and its contents are
 * attached to the message.
 *
 * This is *not* a tool. The user chose these paths explicitly, so there is nothing for the
 * model to decide and nothing to approve — the content simply becomes part of what they
 * said. That distinction is why it lives here rather than as another read tool.
 *
 * The same confinement and deny-list rules still apply. A user can type any path, and
 * `@../../../.ssh/id_rsa` must fail exactly as `read_file` would — the mention path is
 * user-supplied text, not a capability.
 */

/** Matches `@path`, allowing quotes so paths with spaces work: `@"src/my file.ts"`. */
const MENTION_PATTERN = /@(?:"([^"]+)"|([^\s@]+))/g

/** Directory listings are a map, not a dump — one level, capped. */
const MAX_DIRECTORY_ENTRIES = 200
/** Per-file cap. A mention that pulls in a 2MB bundle would swamp the window. */
const MAX_FILE_CHARS = 100_000

export interface ResolvedMention {
  /** The text the user typed, without the `@`. */
  raw: string
  kind: 'file' | 'directory' | 'error'
  /** Workspace-relative, normalised. */
  relativePath: string
  content: string
}

export interface MentionContext {
  fs: FileSystem
  workspaceRoot: string
  denylist?: PathDenylist
}

/** Extracts mention targets in the order they appear, de-duplicated. */
export function parseMentions(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const target = match[1] ?? match[2]
    if (target === undefined || target.length === 0) continue
    // Trailing punctuation is almost always sentence structure, not part of the path.
    const cleaned = target.replace(/[.,;:!?)]+$/, '')
    if (cleaned.length > 0 && !found.includes(cleaned)) found.push(cleaned)
  }
  return found
}

async function resolveOne(raw: string, context: MentionContext): Promise<ResolvedMention> {
  const absolute = path.isAbsolute(raw) ? raw : path.join(context.workspaceRoot, raw)
  const relativePath = path.relative(context.workspaceRoot, absolute).split(path.sep).join('/')

  let confined: string
  try {
    // Same rule as every path-taking tool: resolve symlinks, then compare (§16).
    confined = await confine(absolute, context.workspaceRoot)
  } catch {
    return {
      raw,
      kind: 'error',
      relativePath,
      content: `Could not attach "${raw}": it is outside the workspace.`,
    }
  }

  if (context.denylist !== undefined && (await context.denylist.isDenied(confined))) {
    return { raw, kind: 'error', relativePath, content: `Could not attach "${raw}": that path is not readable.` }
  }

  try {
    const stat = await context.fs.stat(confined)
    if (stat.isDirectory) {
      const entries = await context.fs.readdir(confined)
      const names = entries.map((entry) => (entry.isDirectory ? `${entry.name}/` : entry.name)).sort()
      const shown = names.slice(0, MAX_DIRECTORY_ENTRIES)
      const suffix = names.length > shown.length ? `\n… and ${names.length - shown.length} more` : ''
      return {
        raw,
        kind: 'directory',
        relativePath,
        content: `${shown.join('\n')}${suffix}`,
      }
    }

    const text = await context.fs.readFile(confined)
    const content = text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n… [truncated]` : text
    return { raw, kind: 'file', relativePath, content }
  } catch (error) {
    return {
      raw,
      kind: 'error',
      relativePath,
      content: `Could not attach "${raw}": ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function resolveMentions(text: string, context: MentionContext): Promise<ResolvedMention[]> {
  const targets = parseMentions(text)
  const resolved: ResolvedMention[] = []
  for (const target of targets) resolved.push(await resolveOne(target, context))
  return resolved
}

/**
 * Appends resolved mentions to the user's message.
 *
 * Appended rather than substituted in place, so the message the user typed stays legible —
 * "explain @src/auth.ts" reads as a question, not as a wall of source with a question
 * buried at the front.
 */
export function attachMentions(text: string, mentions: readonly ResolvedMention[]): string {
  if (mentions.length === 0) return text

  const blocks = mentions.map((mention) => {
    if (mention.kind === 'error') return mention.content
    const label = mention.kind === 'directory' ? 'Directory listing' : 'File'
    return `${label}: ${mention.relativePath}\n\`\`\`\n${mention.content}\n\`\`\``
  })

  return `${text}\n\n--- Attached by the user ---\n${blocks.join('\n\n')}`
}
