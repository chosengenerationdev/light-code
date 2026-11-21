import fs from 'node:fs/promises'
import path from 'node:path'

import { documentKindFor, extractDocument } from '../documents/extract.js'
import { confine } from '../fs/confine.js'
import type { PathDenylist } from '../fs/denylist.js'
import type { FileSystem } from '../platform/filesystem.js'
import type { ChatMessage } from '../providers/types.js'
import { walkFiles } from '../tools/nativeSearch.js'
import type { AgentWrite, ArtifactEntry, ArtifactInfo, ArtifactKind, ArtifactList } from './types.js'

export type { AgentWrite, ArtifactEntry, ArtifactInfo, ArtifactKind, ArtifactList } from './types.js'

/**
 * The files in the folder the agent is working on - its artefacts - for the panel's Files button.
 *
 * Asked for "especially for non-code bases ... where there won't be any git to show the artefacts": a
 * folder of reports, workbooks and documents has no Source Control view, so nothing else on screen says
 * what the agent made or changed. Two facts decide what this chat touched, and they are kept apart:
 *
 * - **Written by the agent** is read from the conversation's own tool calls (the file tools, Excel's
 *   create and save, copies, archives). Ground truth about *which tool* wrote it and the reason it gave.
 * - **Changed since the chat started** is the file's modified time. It also catches what a shell command,
 *   a Python tool or a macro wrote - most of the work in Auto mode - which no tool call names.
 *
 * Listing reads names, sizes and dates, plus the first few kilobytes of small text files for a one-line
 * summary. Anything more (a document's text, a workbook's sheets) is read only when a row is opened, and
 * through the same confinement and deny list as every file tool.
 */

const KINDS: Record<string, ArtifactKind> = {}
function kinds(kind: ArtifactKind, extensions: string): void {
  for (const extension of extensions.split(' ')) KINDS[extension] = kind
}
kinds('document', 'pdf docx doc rtf odt md markdown rst tex html htm')
kinds('spreadsheet', 'xlsx xlsm xlsb xls ods csv tsv')
kinds('presentation', 'pptx ppt odp key')
kinds('image', 'png jpg jpeg gif bmp svg webp ico tif tiff')
kinds('data', 'json jsonl ndjson xml yaml yml toml parquet sqlite db sqlite3 avro feather pkl pickle h5 hdf5 ini cfg conf env')
kinds('code', 'ts tsx js jsx mjs cjs py ipynb java kt kts scala go rs c h cpp hpp cc cs fs vb vba bas cls frm sql sh bash ps1 psm1 bat cmd r rb php swift m pl lua dart groovy jil')
kinds('archive', 'zip 7z tar gz tgz bz2 xz rar jar war')
kinds('email', 'msg eml')
kinds('text', 'txt log out err')

export function kindOf(name: string): ArtifactKind {
  const extension = path.extname(name).slice(1).toLowerCase()
  return KINDS[extension] ?? 'other'
}

/** Kinds whose first bytes are readable text, so a summary line can be taken from them. */
const TEXT_KINDS = new Set<ArtifactKind>(['text', 'code', 'data', 'document'])
const NOT_TEXT = new Set(['pdf', 'docx', 'doc', 'odt', 'rtf', 'parquet', 'sqlite', 'db', 'sqlite3', 'avro', 'feather', 'pkl', 'pickle', 'h5', 'hdf5'])

function isTextual(name: string): boolean {
  const extension = path.extname(name).slice(1).toLowerCase()
  if (NOT_TEXT.has(extension)) return false
  const kind = kindOf(name)
  return TEXT_KINDS.has(kind) || extension === 'csv' || extension === 'tsv'
}

/** Folders a person would not call artefacts: tools' caches, environments, version control. */
const SKIPPED_SEGMENTS = new Set(['node_modules', '__pycache__', 'venv', 'env', 'site-packages', 'bower_components'])

function skipped(relative: string): boolean {
  return relative.split('/').some((segment, index, all) => SKIPPED_SEGMENTS.has(segment) || (segment.startsWith('.') && index < all.length - 1))
}

/** Tools that write files, and the argument naming the file. */
const WRITERS: Record<string, readonly string[]> = {
  write_to_file: ['path'],
  apply_diff: ['path'],
  use_skill_file: ['destination', 'path'],
  excel_create_workbook: ['path'],
  excel_save_workbook: ['path'],
  light_code_export_config: ['path'],
}

function argumentsOf(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The key a workspace-relative path is compared by: `/` separators, and case-folded where Windows folds it. */
export function artifactKey(relative: string): string {
  const slashed = relative.replace(/\\/g, '/').replace(/^\.\//, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * The files this chat's tool calls wrote, keyed by `artifactKey` of the workspace-relative path.
 * A tool reached through `call_tool` counts as itself. Paths outside the workspace are left out: the
 * panel lists the workspace.
 */
export function agentWrites(messages: readonly ChatMessage[], root: string): Map<string, AgentWrite[]> {
  const writes = new Map<string, AgentWrite[]>()
  const add = (raw: unknown, write: AgentWrite): void => {
    if (typeof raw !== 'string' || raw.trim() === '') return
    const absolute = path.resolve(root, raw.trim())
    const relative = path.relative(root, absolute)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return
    const key = artifactKey(relative)
    writes.set(key, [...(writes.get(key) ?? []), write])
  }
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const call of message.toolCalls ?? []) {
      let name = call.name
      let args = argumentsOf(call.arguments)
      if (name === 'call_tool' && typeof args['name'] === 'string') {
        name = args['name']
        const inner = args['arguments']
        args = inner !== null && typeof inner === 'object' ? (inner as Record<string, unknown>) : {}
      }
      const why = typeof args['why'] === 'string' && args['why'].trim() !== '' ? args['why'].trim() : undefined
      const write: AgentWrite = { tool: name, ...(why !== undefined ? { why } : {}) }
      if (name === 'archive_files') {
        // Only creating one writes a file named by `archive`; extracting writes into `to`, a folder.
        if (args['action'] === 'create') add(args['archive'], write)
        continue
      }
      if (name === 'transfer_files' && Array.isArray(args['items'])) {
        for (const item of args['items']) add((item as { to?: unknown } | null)?.to, write)
        continue
      }
      const keys = WRITERS[name]
      if (keys === undefined) continue
      const value = keys.map((key) => args[key]).find((candidate) => typeof candidate === 'string')
      add(value, write)
    }
  }
  return writes
}

const SUMMARY_BYTES = 4096
const SUMMARY_CHARS = 160

/**
 * One line about a text file from its first few kilobytes: a table's columns, a document's first
 * heading, or the first line that is not boilerplate. Undefined when nothing useful is there.
 */
export function summaryFromText(name: string, head: string): string | undefined {
  const extension = path.extname(name).slice(1).toLowerCase()
  const lines = head.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (extension === 'csv' || extension === 'tsv') {
    const header = lines[0] ?? ''
    if (header.trim() === '') return undefined
    const separator = extension === 'tsv' ? '\t' : header.split(';').length > header.split(',').length ? ';' : ','
    const columns = header.split(separator).map((cell) => cell.trim().replace(/^"|"$/g, '')).filter((cell) => cell !== '')
    return clip(`${String(columns.length)} columns: ${columns.join(', ')}`)
  }
  if (extension === 'json') {
    try {
      const parsed: unknown = JSON.parse(head)
      if (Array.isArray(parsed)) return `A list of ${String(parsed.length)} item(s)`
      if (parsed !== null && typeof parsed === 'object') return clip(`Keys: ${Object.keys(parsed).join(', ')}`)
    } catch {
      // Longer than the head, or not JSON after all: fall through to the first line.
    }
  }
  const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line))
  if (heading !== undefined && (kindOf(name) === 'document' || extension === 'txt')) return clip(heading.replace(/^#+\s+/, ''))
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#!') || /^[-=*_]{3,}$/.test(line) || /^(import|from|using|package|require|#include|<\?xml|<!doctype)\b/i.test(line)) continue
    const text = line.replace(/^(\/\/+|#+|--|\/\*+|\*+|"""|'''|<!--|rem\s|;+)\s*/i, '').replace(/(\*\/|-->|"""|''')$/, '').trim()
    if (text.length < 3) continue
    return clip(text)
  }
  return undefined
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat
}

async function readHead(absolute: string, bytes: number): Promise<string> {
  const handle = await fs.open(absolute, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export interface ListArtifactsOptions {
  fs: FileSystem
  root: string
  /** When the chat started, in milliseconds. */
  since: number
  writes: Map<string, AgentWrite[]>
  /** The newest this many files are returned. */
  limit?: number
  /** The walk looks at no more than this many files. */
  maxScan?: number
}

/**
 * Every file in the workspace, newest first, at most `limit` of them - plus every file this chat's
 * tools wrote, wherever it falls in that order, so the agent's own work is never cut for being old.
 * `.gitignore` is honoured where there is one (a code base's build output stays out); version control,
 * environments and hidden folders are skipped everywhere.
 */
export async function listArtifacts(options: ListArtifactsOptions): Promise<ArtifactList> {
  const limit = options.limit ?? 400
  const walk = await walkFiles(options.fs, options.root, { includeIgnored: false, maxFiles: options.maxScan ?? 20_000 })
  const relatives = walk.files.filter((relative) => !skipped(relative))

  const stated: ArtifactEntry[] = []
  // Stat in small batches: thousands at once can exhaust handles on a network share.
  for (let i = 0; i < relatives.length; i += 64) {
    const batch = await Promise.all(
      relatives.slice(i, i + 64).map(async (relative): Promise<ArtifactEntry | undefined> => {
        try {
          const stats = await fs.stat(path.join(options.root, ...relative.split('/')))
          const created = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs
          const writes = options.writes.get(artifactKey(relative))
          return {
            path: relative,
            name: path.posix.basename(relative),
            kind: kindOf(relative),
            size: stats.size,
            modified: stats.mtimeMs,
            created,
            changedThisChat: stats.mtimeMs >= options.since,
            newThisChat: created >= options.since,
            ...(writes !== undefined ? { writes } : {}),
          }
        } catch {
          return undefined
        }
      }),
    )
    for (const entry of batch) if (entry !== undefined) stated.push(entry)
  }

  stated.sort((a, b) => b.modified - a.modified)
  const kept = stated.slice(0, limit)
  for (const entry of stated.slice(limit)) if (entry.writes !== undefined || entry.changedThisChat) kept.push(entry)

  await Promise.all(
    kept.map(async (entry) => {
      if (!isTextual(entry.name) || entry.size === 0 || entry.size > 20 * 1024 * 1024) return
      try {
        const summary = summaryFromText(entry.name, await readHead(path.join(options.root, ...entry.path.split('/')), SUMMARY_BYTES))
        if (summary !== undefined) entry.summary = summary
      } catch {
        // Unreadable now (locked, removed): listed without a summary.
      }
    }),
  )
  return { root: options.root, since: options.since, files: kept, scanned: relatives.length, truncated: walk.truncated }
}

const PREVIEW_CHARS = 2_000
const PREVIEW_LINES = 40

/**
 * The details shown when a row is opened. Confined to the workspace and refused for a denied path,
 * like every file tool: the path arrives from the panel, and "the panel would not send that" is not a
 * boundary.
 */
export async function describeArtifact(root: string, relative: string, denylist: PathDenylist, writes?: AgentWrite[]): Promise<ArtifactInfo> {
  const absolute = await confine(path.resolve(root, relative), root)
  if (await denylist.isDenied(absolute)) throw new Error(`${relative} is on the deny list, so it is not read.`)
  const stats = await fs.stat(absolute)
  if (!stats.isFile()) throw new Error(`${relative} is not a file.`)
  const name = path.basename(absolute)
  const kind = kindOf(name)
  const facts: string[] = []
  let preview: string | undefined

  const documentKind = documentKindFor(absolute)
  if (documentKind !== 'text' && stats.size <= 50 * 1024 * 1024) {
    try {
      const document = extractDocument(absolute, await fs.readFile(absolute))
      if (document.sections !== undefined && document.sections.length > 0) {
        facts.push(`${String(document.sections.length)} sheet(s): ${document.sections.slice(0, 12).join(', ')}${document.sections.length > 12 ? ', …' : ''}`)
      }
      preview = document.text.slice(0, PREVIEW_CHARS)
      if (document.note !== undefined) facts.push(document.note)
    } catch (error) {
      facts.push(`Its content could not be read here: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else if (isTextual(name) && stats.size <= 5 * 1024 * 1024) {
    const text = await fs.readFile(absolute, 'utf8')
    const lines = text.split(/\r?\n/)
    const count = text.endsWith('\n') ? lines.length - 1 : lines.length
    facts.push(`${count.toLocaleString('en-GB')} line(s)`)
    const extension = path.extname(name).slice(1).toLowerCase()
    if (extension === 'csv' || extension === 'tsv') {
      facts.push(`${Math.max(0, count - 1).toLocaleString('en-GB')} data row(s)`)
      const summary = summaryFromText(name, lines[0] ?? '')
      if (summary !== undefined) facts.push(summary)
    }
    preview = lines.slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS)
  } else if (kind === 'image') {
    facts.push('A picture')
  } else if (isTextual(name)) {
    facts.push('Too large to preview here')
  }

  return {
    path: relative.replace(/\\/g, '/'),
    kind,
    size: stats.size,
    modified: stats.mtimeMs,
    created: stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs,
    facts,
    ...(preview !== undefined && preview.trim() !== '' ? { preview } : {}),
    ...(writes !== undefined ? { writes } : {}),
  }
}
