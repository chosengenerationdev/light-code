import os from 'node:os'
import path from 'node:path'
import type { FileSystem } from '../platform/filesystem.js'

/**
 * Listing and searching without ripgrep.
 *
 * ## Why this exists
 *
 * `search_files` and recursive `list_files` used to be *unavailable* whenever ripgrep could not be
 * run, and that turned out to be common rather than exceptional: on a managed Windows machine,
 * application control or antivirus refuses programs under the user profile, which is where VS Code
 * installs extensions, and an extension update deletes the folder the previous path pointed into.
 * The model's response to "search is unavailable" was to run `rg` through `execute_command` —
 * which is not on PATH, and asks for approval every time. So the failure cost a prompt as well as
 * the search.
 *
 * ripgrep stays the first choice because it is much faster on a large tree. This is what runs when
 * it cannot, so neither tool depends on a binary for being *available* at all.
 *
 * ## What it matches of ripgrep, and what it does not
 *
 * The same exclusions (`.git`, `node_modules`), hidden files included, `.gitignore` honoured unless
 * `includeIgnored`, binary files skipped, two lines of context, and the same output shape. Patterns
 * are JavaScript regular expressions, which agree with ripgrep's on everything ordinary; a leading
 * `(?i)` is understood because models write it. `.gitignore` support covers the syntax people use —
 * negation, anchoring, directory-only rules, `*`, `**`, `?`, classes — plus `.git/info/exclude` and
 * the global excludes file at git's default location.
 */

export interface WalkOptions {
  includeIgnored: boolean
  signal?: AbortSignal | undefined
  /** Stop after this many files; the result says so. */
  maxFiles?: number
  /** Replaces git's default global excludes file. For tests, which must not read the real one. */
  globalIgnoreFile?: string
}

export interface WalkResult {
  /** Relative to the walk's root, with `/` separators. */
  files: string[]
  truncated: boolean
}

interface IgnoreRule {
  /** Directory the rule's `.gitignore` sits in, relative to the walk root ('' for the root). */
  base: string
  regex: RegExp
  negate: boolean
  dirOnly: boolean
}

const ALWAYS_SKIPPED = new Set(['.git', 'node_modules'])
const DEFAULT_MAX_FILES = 50_000
const caseFlag = process.platform === 'win32' ? 'i' : ''

/**
 * A glob in `.gitignore` syntax as a regular expression over a `/`-separated relative path.
 *
 * Exported because `filePattern` uses the same syntax (ripgrep's `-g` is gitignore-style), and
 * because both are worth testing directly.
 */
export function globToRegExp(glob: string, anchored: boolean): RegExp {
  let body = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!
    if (char === '*') {
      if (glob[index + 1] === '*') {
        const slashAfter = glob[index + 2] === '/'
        const atSegmentStart = index === 0 || glob[index - 1] === '/'
        if (atSegmentStart && slashAfter) {
          body += '(?:.*/)?'
          index += 2
        } else {
          body += '.*'
          index += 1
        }
      } else {
        body += '[^/]*'
      }
    } else if (char === '?') {
      body += '[^/]'
    } else if (char === '[') {
      const close = glob.indexOf(']', index + 2)
      if (close === -1) {
        body += '\\['
      } else {
        let inner = glob.slice(index + 1, close)
        if (inner.startsWith('!')) inner = `^${inner.slice(1)}`
        body += `[${inner.replace(/\\/g, '\\\\')}]`
        index = close
      }
    } else if (char === '{') {
      const close = glob.indexOf('}', index)
      if (close === -1) {
        body += '\\{'
      } else {
        const options = glob.slice(index + 1, close).split(',')
        body += `(?:${options.map((option) => globToRegExp(option, true).source.slice(1, -1)).join('|')})`
        index = close
      }
    } else if (char === '\\' && index + 1 < glob.length) {
      body += escapeRegExp(glob[index + 1]!)
      index += 1
    } else {
      body += escapeRegExp(char)
    }
  }
  return new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`, caseFlag)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** Parses one `.gitignore` file's text into rules scoped to `base`. */
export function parseIgnoreFile(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '')
    if (line.length === 0 || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (line.length === 0) continue
    // A slash anywhere but the end anchors the pattern to the file's own directory.
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    rules.push({ base, regex: globToRegExp(line, anchored), negate, dirOnly })
  }
  return rules
}

/** Last matching rule wins, as in git; a path outside a rule's directory is not its business. */
function isIgnored(rules: IgnoreRule[], relative: string, isDirectory: boolean): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDirectory) continue
    let scoped = relative
    if (rule.base.length > 0) {
      if (!relative.startsWith(`${rule.base}/`)) continue
      scoped = relative.slice(rule.base.length + 1)
    }
    if (rule.regex.test(scoped)) ignored = !rule.negate
  }
  return ignored
}

/**
 * Every file under `root`, depth first in name order, pruning ignored directories.
 *
 * A directory `.gitignore` excludes is not entered at all — git cannot re-include a file inside an
 * excluded directory either, and entering it would mean walking a `.venv` to discard every file.
 */
/**
 * The ignore rules that apply before any `.gitignore` is read: the user's global excludes file and
 * the repository's `.git/info/exclude`. ripgrep honours both, so leaving them out listed files
 * ripgrep never did — found by comparing the two on a real repository.
 *
 * The global file is git's default location (`$XDG_CONFIG_HOME/git/ignore`, else
 * `~/.config/git/ignore`); a `core.excludesFile` pointing elsewhere is not read, since that would
 * mean running git to ask.
 */
async function repositoryWideRules(fs: FileSystem, root: string, globalIgnoreFile: string | undefined): Promise<IgnoreRule[]> {
  const sources = [
    globalIgnoreFile ??
      path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'git', 'ignore'),
    path.join(root, '.git', 'info', 'exclude'),
  ]
  const rules: IgnoreRule[] = []
  for (const source of sources) {
    try {
      rules.push(...parseIgnoreFile(await fs.readFile(source), ''))
    } catch {
      // Absent, which is the usual case for both.
    }
  }
  return rules
}

export async function walkFiles(
  fs: FileSystem,
  root: string,
  options: WalkOptions,
): Promise<WalkResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const files: string[] = []
  const baseRules = options.includeIgnored ? [] : await repositoryWideRules(fs, root, options.globalIgnoreFile)
  const pending: { relative: string; rules: IgnoreRule[] }[] = [{ relative: '', rules: baseRules }]

  while (pending.length > 0) {
    if (options.signal?.aborted === true) break
    const { relative, rules: inherited } = pending.pop()!
    const absolute = relative.length > 0 ? path.join(root, ...relative.split('/')) : root

    let entries
    try {
      entries = await fs.readdir(absolute)
    } catch {
      // Unreadable directory: skipped, as ripgrep skips it, rather than failing the whole walk.
      continue
    }

    let rules = inherited
    if (
      !options.includeIgnored &&
      entries.some((entry) => entry.name === '.gitignore' && !entry.isDirectory)
    ) {
      try {
        const text = await fs.readFile(path.join(absolute, '.gitignore'))
        rules = [...inherited, ...parseIgnoreFile(text, relative)]
      } catch {
        // An unreadable .gitignore ignores nothing.
      }
    }

    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const subdirectories: string[] = []
    for (const entry of sorted) {
      if (ALWAYS_SKIPPED.has(entry.name)) continue
      const child = relative.length > 0 ? `${relative}/${entry.name}` : entry.name
      if (!options.includeIgnored && isIgnored(rules, child, entry.isDirectory)) continue
      // Links are neither followed nor listed, as ripgrep does by default: following one is how a
      // walk ends up in a loop, or outside the folder it was asked about.
      if (entry.isDirectory) {
        subdirectories.push(child)
      } else if (entry.isFile) {
        files.push(child)
        if (files.length >= maxFiles) return { files, truncated: true }
      }
    }
    // Reversed so the stack pops them in name order.
    for (const child of subdirectories.reverse()) pending.push({ relative: child, rules })
  }
  return { files, truncated: false }
}

export interface SearchOptions extends WalkOptions {
  pattern: string
  filePattern?: string | undefined
  contextLines?: number
  /** Output is cut here, and the result says so. */
  maxOutputChars?: number
}

export interface SearchResult {
  output: string
  truncated: boolean
}

const MAX_FILE_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024

/**
 * Compiles a model-written pattern. Throws with a readable message on an invalid one.
 *
 * `(?i)` at the start is ripgrep's case-insensitive flag and has no JavaScript equivalent in that
 * position, so it becomes the `i` flag. Unicode mode is tried first, as ripgrep is Unicode-aware,
 * and dropped only for patterns it rejects — `\-` and friends are errors there and ordinary in
 * ripgrep.
 */
export function compilePattern(pattern: string): RegExp {
  let source = pattern
  let flags = ''
  const inline = /^\(\?([a-z]+)\)/.exec(source)
  if (inline !== null) {
    source = source.slice(inline[0].length)
    if (inline[1]!.includes('i')) flags += 'i'
    if (inline[1]!.includes('s')) flags += 's'
    if (inline[1]!.includes('m')) flags += 'm'
  }
  try {
    return new RegExp(source, `${flags}u`)
  } catch {
    try {
      return new RegExp(source, flags)
    } catch (error) {
      throw new Error(
        `The search pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
}

/** Whether `filePattern` admits a file; ripgrep's `-g` semantics, including a leading `!`. */
function fileFilter(filePattern: string | undefined): (relative: string) => boolean {
  if (filePattern === undefined || filePattern.trim().length === 0) return () => true
  let glob = filePattern.trim()
  const exclude = glob.startsWith('!')
  if (exclude) glob = glob.slice(1)
  const anchored = glob.includes('/')
  const regex = globToRegExp(glob.startsWith('/') ? glob.slice(1) : glob, anchored)
  return (relative) => regex.test(relative) !== exclude
}

/**
 * Searches file contents, producing ripgrep's non-tty output: `./path:line:text` for a match,
 * `./path-line-text` for context, and `--` between groups that are not contiguous.
 */
export async function searchFiles(
  fs: FileSystem,
  root: string,
  options: SearchOptions,
): Promise<SearchResult> {
  const regex = compilePattern(options.pattern)
  const admits = fileFilter(options.filePattern)
  const context = options.contextLines ?? 2
  const maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT
  const { files, truncated: walkTruncated } = await walkFiles(fs, root, options)
  const separator = process.platform === 'win32' ? '\\' : '/'

  const chunks: string[] = []
  let size = 0
  let firstGroup = true

  for (const relative of files) {
    if (options.signal?.aborted === true) break
    if (!admits(relative)) continue
    const absolute = path.join(root, ...relative.split('/'))

    let bytes: Buffer
    try {
      const stat = await fs.stat(absolute)
      if (stat.size > MAX_FILE_BYTES) continue
      bytes = await fs.readBytes(absolute)
    } catch {
      continue
    }
    // ripgrep's own test for a binary file: a NUL byte near the start.
    if (bytes.subarray(0, 8000).includes(0)) continue

    const lines = bytes
      .toString('utf8')
      .split('\n')
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    const matched: number[] = []
    for (let index = 0; index < lines.length; index += 1) {
      regex.lastIndex = 0
      if (regex.test(lines[index]!)) matched.push(index)
    }
    if (matched.length === 0) continue

    const shown = `.${separator}${relative.split('/').join(separator)}`
    const matchSet = new Set(matched)
    let lastPrinted = -2
    for (const hit of matched) {
      const from = Math.max(0, hit - context, lastPrinted + 1)
      const to = Math.min(lines.length - 1, hit + context)
      if (from > lastPrinted + 1 && !firstGroup) chunks.push('--')
      firstGroup = false
      for (let index = from; index <= to; index += 1) {
        // The last line of a file ending in a newline is empty and is not a line ripgrep prints.
        if (index === lines.length - 1 && lines[index] === '' && !matchSet.has(index)) continue
        const line = `${shown}${matchSet.has(index) ? ':' : '-'}${index + 1}${matchSet.has(index) ? ':' : '-'}${lines[index]}`
        chunks.push(line)
        size += line.length + 1
      }
      lastPrinted = Math.max(lastPrinted, to)
      if (size > maxOutput) {
        return { output: chunks.join('\n'), truncated: true }
      }
    }
  }
  return { output: chunks.join('\n'), truncated: walkTruncated }
}
