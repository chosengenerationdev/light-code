/**
 * A small, language-agnostic syntax highlighter.
 *
 * ## Why not a real one
 *
 * highlight.js is a few hundred kilobytes and Shiki ships a WebAssembly grammar engine plus
 * theme JSON. Both would be the largest thing in a 1.5 MB webview bundle, for colouring text
 * that is usually a dozen lines long. And neither could use the editor's own colours, because
 * VS Code does not expose TextMate token colours to a webview at all — so a real highlighter
 * would come with its *own* theme and look wrong beside the editor rather than merely plain.
 *
 * ## What this does instead
 *
 * Tokenises the things every language shares — comments, strings, numbers, keywords,
 * punctuation — with a per-family profile for the parts that differ. That covers the reason
 * highlighting helps at all: telling code from prose, finding where a string ends, spotting a
 * comment. It will not resolve a type name or a template expression, and it does not try.
 *
 * **Unknown languages still get highlighted**, which is the requirement. An unrecognised fence
 * falls back to a profile that accepts every comment syntax and the union of the keyword sets:
 * `def` never appears in JavaScript and `func` never in Python, so a union over-matches far
 * less than it looks like it should.
 *
 * ## Colours
 *
 * From `--vscode-debugTokenExpression-*`, which the debug console uses and which *is* exposed
 * to webviews and does track the theme. Not a perfect match for the editor's grammar colours,
 * but theme-aware and correct in light, dark and high-contrast without a palette of our own.
 */

export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'punctuation'

export interface Token {
  text: string
  kind: TokenKind
}

interface Profile {
  /** Sequences that start a comment running to end of line. */
  lineComments: string[]
  /** Paired block comment delimiters. */
  blockComments: [string, string][]
  /** Quote characters that start a string. */
  quotes: string[]
  /** Triple-quoted strings, as Python and a few others use. */
  tripleQuotes: boolean
  keywords: Set<string>
}

const C_LIKE = [
  'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public',
  'return', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while',
  'yield', 'async', 'await', 'true', 'false', 'type', 'readonly', 'satisfies', 'as', 'keyof',
]

const PYTHON = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'False', 'try', 'while',
  'with', 'yield', 'self', 'match', 'case',
]

const SHELL = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac',
  'function', 'return', 'export', 'local', 'echo', 'cd', 'set', 'unset', 'source',
]

const SQL = [
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create',
  'table', 'drop', 'alter', 'join', 'inner', 'left', 'right', 'outer', 'on', 'group', 'by',
  'order', 'having', 'limit', 'union', 'distinct', 'as', 'and', 'or', 'not', 'null', 'index',
]

const OTHER = ['fn', 'func', 'impl', 'struct', 'trait', 'mut', 'use', 'pub', 'match', 'end', 'def', 'module', 'require']

function profile(keywords: string[], overrides: Partial<Profile> = {}): Profile {
  return {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    quotes: ['"', "'", '`'],
    tripleQuotes: false,
    keywords: new Set(keywords),
    ...overrides,
  }
}

const HASH = { lineComments: ['#'], blockComments: [] as [string, string][] }

const PROFILES: Record<string, Profile> = {
  javascript: profile(C_LIKE),
  typescript: profile(C_LIKE),
  java: profile(C_LIKE),
  csharp: profile(C_LIKE),
  cpp: profile(C_LIKE),
  c: profile(C_LIKE),
  go: profile([...C_LIKE, 'func', 'defer', 'chan', 'go', 'range', 'struct', 'map', 'nil']),
  rust: profile([...C_LIKE, 'fn', 'impl', 'trait', 'mut', 'pub', 'use', 'match', 'crate', 'Some', 'None']),
  json: profile(['true', 'false', 'null'], { lineComments: [], blockComments: [], quotes: ['"'] }),
  python: profile(PYTHON, { ...HASH, tripleQuotes: true }),
  shell: profile(SHELL, HASH),
  powershell: profile([...SHELL, 'param', 'begin', 'process'], HASH),
  yaml: profile(['true', 'false', 'null'], { ...HASH, quotes: ['"', "'"] }),
  toml: profile(['true', 'false'], HASH),
  ruby: profile([...PYTHON, 'end', 'do', 'unless', 'elsif', 'nil'], HASH),
  sql: profile(SQL, { lineComments: ['--'], blockComments: [['/*', '*/']], quotes: ['"', "'"] }),
  html: profile([], { lineComments: [], blockComments: [['<!--', '-->']], quotes: ['"', "'"] }),
  css: profile([], { lineComments: [], blockComments: [['/*', '*/']], quotes: ['"', "'"] }),
  /**
   * Everything unrecognised. Accepts every comment syntax and the union of the keyword sets —
   * over-matching much less in practice than it appears, since the vocabularies barely overlap.
   */
  default: profile([...C_LIKE, ...PYTHON, ...SHELL, ...OTHER], {
    lineComments: ['//', '#', '--'],
    blockComments: [
      ['/*', '*/'],
      ['<!--', '-->'],
    ],
    tripleQuotes: true,
  }),
}

/** Fence labels people actually type, mapped to a profile. */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  py3: 'python',
  python3: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  console: 'shell',
  ps1: 'powershell',
  pwsh: 'powershell',
  yml: 'yaml',
  rb: 'ruby',
  rs: 'rust',
  golang: 'go',
  'c++': 'cpp',
  cs: 'csharp',
  htm: 'html',
  xml: 'html',
  scss: 'css',
  postgres: 'sql',
  psql: 'sql',
}

export function profileFor(language: string | undefined): Profile {
  const key = (language ?? '').trim().toLowerCase()
  return PROFILES[ALIASES[key] ?? key] ?? (PROFILES.default as Profile)
}

const IDENTIFIER_START = /[A-Za-z_$]/
const IDENTIFIER_PART = /[A-Za-z0-9_$]/
const PUNCTUATION = /[{}[\]()<>;,.:?!&|+\-*/%=~^@]/

/**
 * Splits source into coloured tokens.
 *
 * Single pass, character by character. A regex-per-token-type approach would be shorter and
 * would also colour the inside of strings and comments, which is the one thing highlighting
 * has to get right — a `#` inside a string must not start a comment.
 */
export function tokenize(source: string, language?: string): Token[] {
  const rules = profileFor(language)
  const tokens: Token[] = []
  let plain = ''

  const flush = (): void => {
    if (plain.length > 0) {
      tokens.push({ text: plain, kind: 'plain' })
      plain = ''
    }
  }
  const push = (text: string, kind: TokenKind): void => {
    flush()
    tokens.push({ text, kind })
  }

  let index = 0
  while (index < source.length) {
    const rest = source.slice(index)

    const block = rules.blockComments.find((pair) => rest.startsWith(pair[0]))
    if (block !== undefined) {
      const close = source.indexOf(block[1], index + block[0].length)
      // An unterminated block comment runs to the end — which is what the compiler sees too.
      const end = close === -1 ? source.length : close + block[1].length
      push(source.slice(index, end), 'comment')
      index = end
      continue
    }

    const line = rules.lineComments.find((marker) => rest.startsWith(marker))
    if (line !== undefined) {
      const newline = source.indexOf('\n', index)
      const end = newline === -1 ? source.length : newline
      push(source.slice(index, end), 'comment')
      index = end
      continue
    }

    const quote = rules.quotes.find((character) => rest.startsWith(character))
    if (quote !== undefined) {
      const triple = rules.tripleQuotes && rest.startsWith(quote.repeat(3))
      const delimiter = triple ? quote.repeat(3) : quote
      let cursor = index + delimiter.length
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (source.startsWith(delimiter, cursor)) {
          cursor += delimiter.length
          break
        }
        // A single-quoted string does not span lines in most languages; stopping at the
        // newline keeps one unbalanced quote from colouring the rest of the file.
        if (!triple && source[cursor] === '\n') break
        cursor++
      }
      push(source.slice(index, Math.min(cursor, source.length)), 'string')
      index = Math.min(cursor, source.length)
      continue
    }

    const character = source[index] as string

    if (/[0-9]/.test(character) && !IDENTIFIER_PART.test(source[index - 1] ?? ' ')) {
      let cursor = index
      while (cursor < source.length && /[0-9a-fA-FxXoObB._]/.test(source[cursor] as string)) cursor++
      push(source.slice(index, cursor), 'number')
      index = cursor
      continue
    }

    if (IDENTIFIER_START.test(character)) {
      let cursor = index
      while (cursor < source.length && IDENTIFIER_PART.test(source[cursor] as string)) cursor++
      const word = source.slice(index, cursor)
      if (rules.keywords.has(word) || rules.keywords.has(word.toLowerCase())) push(word, 'keyword')
      else plain += word
      index = cursor
      continue
    }

    if (PUNCTUATION.test(character)) {
      push(character, 'punctuation')
      index++
      continue
    }

    plain += character
    index++
  }

  flush()
  return tokens
}

/**
 * Theme colours per token kind.
 *
 * `--vscode-debugTokenExpression-*` is the one family of syntax-ish colours VS Code exposes to
 * a webview. Each has a fallback for a theme that does not define it, so nothing renders as
 * the browser default black on a dark background.
 */
export const TOKEN_COLORS: Record<TokenKind, string | undefined> = {
  plain: undefined,
  comment: 'var(--vscode-descriptionForeground)',
  string: 'var(--vscode-debugTokenExpression-string, var(--vscode-charts-orange))',
  number: 'var(--vscode-debugTokenExpression-number, var(--vscode-charts-green))',
  keyword: 'var(--vscode-debugTokenExpression-name, var(--vscode-charts-blue))',
  punctuation: 'var(--vscode-descriptionForeground)',
}
