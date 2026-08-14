/**
 * Just enough markdown for what a model actually writes.
 *
 * ## Why a parser and not a library
 *
 * Every markdown library produces an HTML *string*, which means `dangerouslySetInnerHTML`, which
 * means a sanitiser to stop model output injecting markup — two dependencies and a security
 * surface, to render text.
 *
 * This produces a small tree instead, and the renderer turns it into React elements. React
 * escapes text by construction, so **there is no injection surface to sanitise**: a response
 * containing `<script>` renders those characters, because they are never parsed as markup at
 * any point. That is a stronger guarantee than sanitising, and it costs no dependency.
 *
 * ## Deliberately incomplete
 *
 * Fenced code, inline code, bold, italic, strikethrough, headings, both kinds of list,
 * blockquotes, rules, links and tables. Not footnotes, not nested lists — rare in an
 * assistant's reply and each a disproportionate amount of parser. Anything unrecognised falls
 * through as literal text, which is the correct failure: the words are still readable.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'strike'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

export type Align = 'left' | 'center' | 'right'

export type Block =
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'heading'; level: number; content: Inline[] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'quote'; content: Inline[] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][]; align: (Align | undefined)[] }
  | { kind: 'rule' }

/**
 * Schemes a link may use.
 *
 * Model output is untrusted text, and `javascript:` in an `href` is script execution on click.
 * An allowlist rather than a denylist: `data:`, `vbscript:` and whatever comes next are all
 * refused by default rather than each needing to be remembered.
 */
const SAFE_SCHEME = /^(https?:|mailto:)/i

export function isSafeHref(href: string): boolean {
  const trimmed = href.trim()
  // Relative links have no scheme and cannot execute, so they are fine.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true
  return SAFE_SCHEME.test(trimmed)
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(\S+)?\s*$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const UNORDERED = /^ {0,3}[-*+]\s+(.*)$/
const ORDERED = /^ {0,3}\d+[.)]\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
/** A row is anything with a pipe in it; the delimiter row is what makes it a table. */
const TABLE_ROW = /^ {0,3}\|?(.*\|.*?)\|?\s*$/
const TABLE_DELIMITER = /^ {0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    const fence = FENCE.exec(line)
    if (fence !== null) {
      /*
       * The closing fence must be at least as long as the opening one, which is what lets a
       * block containing ``` be written with ````. Getting this wrong truncates exactly the
       * responses that are explaining markdown.
       */
      const marker = fence[1] ?? '```'
      const body: string[] = []
      index += 1
      while (index < lines.length) {
        const candidate = lines[index] ?? ''
        const closing = FENCE.exec(candidate)
        if (closing !== null && (closing[1] ?? '').length >= marker.length && (closing[2] ?? '') === '') break
        body.push(candidate)
        index += 1
      }
      // An unterminated fence still yields a code block: a truncated stream is common, and
      // showing the code is better than showing the backticks.
      index += 1
      blocks.push({
        kind: 'code',
        text: body.join('\n'),
        ...(fence[2] !== undefined ? { language: fence[2] } : {}),
      })
      continue
    }

    if (line.trim().length === 0) {
      index += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, content: parseInline(heading[2] ?? '') })
      index += 1
      continue
    }


    /*
     * A table needs the delimiter row to be recognised at all — a line containing a pipe is
     * far more often prose or a shell command than a table, and treating it as one would
     * mangle both.
     */
    const delimiter = lines[index + 1]
    if (TABLE_ROW.test(line) && delimiter !== undefined && TABLE_DELIMITER.test(delimiter)) {
      const cells = (row: string): string[] =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim())

      const head = cells(line).map((cell) => parseInline(cell))
      const align = cells(delimiter).map((spec): Align | undefined => {
        const left = spec.startsWith(':')
        const right = spec.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        if (left) return 'left'
        return undefined
      })

      index += 2
      const rows: Inline[][][] = []
      while (index < lines.length) {
        const candidate = lines[index] ?? ''
        if (candidate.trim().length === 0 || !TABLE_ROW.test(candidate)) break
        rows.push(cells(candidate).map((cell) => parseInline(cell)))
        index += 1
      }

      blocks.push({ kind: 'table', head, rows, align })
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] ?? '')
        if (match === null) break
        quoted.push(match[1] ?? '')
        index += 1
      }
      blocks.push({ kind: 'quote', content: parseInline(quoted.join('\n')) })
      continue
    }

    const isOrdered = ORDERED.test(line)
    if (isOrdered || UNORDERED.test(line)) {
      const items: Inline[][] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const match = (isOrdered ? ORDERED : UNORDERED).exec(current)
        if (match === null) break
        items.push(parseInline(match[1] ?? ''))
        index += 1
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    /*
     * A paragraph runs until a blank line or the start of another block. Checking those
     * starters is what stops a list immediately after a sentence being swallowed into it —
     * which is how most replies are actually written.
     */
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (
        current.trim().length === 0 ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        RULE.test(current) ||
        QUOTE.test(current) ||
        UNORDERED.test(current) ||
        ORDERED.test(current) ||
        // A table's own header line looks like prose, so the delimiter beneath it is what
        // ends the paragraph — the same test the table branch uses to recognise one.
        (TABLE_ROW.test(current) && TABLE_DELIMITER.test(lines[index + 1] ?? ''))
      ) {
        break
      }
      paragraph.push(current)
      index += 1
    }
    blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join('\n')) })
  }

  return blocks
}

/**
 * `code` first: a span of code suppresses every other marker inside it, as it must.
 *
 * Two details the obvious version gets wrong:
 *
 * **Emphasis may not begin or end with a space.** Without that, `2 * 3 * 4` italicises " 3 " —
 * and arithmetic beside prose is hardly rare in this of all products. A cheap approximation of
 * CommonMark's flanking rules that fixes the case which actually appears.
 *
 * **A link target may contain one level of parentheses.** `alert(1)` and `Foo_(disambiguation)`
 * are both common, and stopping at the first `)` truncates the URL — which for an unsafe scheme
 * also means the safety check inspects the wrong string.
 */
const EMPHASIS = String.raw`\S(?:[\s\S]*?\S)?`
// `(` must be excluded from the plain run as well as `)`. Allowing it let the greedy first
// part swallow the opening paren, so the nested-paren alternation never fired and the URL
// was truncated one character short with the closing paren left behind as text.
const HREF = String.raw`[^()\s]*(?:\([^()\s]*\)[^()\s]*)*`
const INLINE = new RegExp(
  [
    String.raw`(` + '`' + String.raw`+)([\s\S]*?)\1`,
    String.raw`\[([^\]]*)\]\((` + HREF + String.raw`)\)`,
    String.raw`(\*\*|__)(` + EMPHASIS + String.raw`)\5`,
    String.raw`(~~)(` + EMPHASIS + String.raw`)\7`,
    String.raw`(\*|_)(` + EMPHASIS + String.raw`)\9`,
  ].join('|'),
)

export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  let rest = source

  while (rest.length > 0) {
    const match = INLINE.exec(rest)
    if (match === null || match.index === undefined) break

    if (match.index > 0) out.push({ kind: 'text', text: rest.slice(0, match.index) })

    if (match[1] !== undefined) {
      // A leading and trailing space is stripped so `` ` `` renders a backtick, per CommonMark.
      out.push({ kind: 'code', text: (match[2] ?? '').replace(/^ (.*) $/, '$1') })
    } else if (match[4] !== undefined) {
      const href = match[4]
      const children = parseInline(match[3] ?? '')
      // An unsafe scheme degrades to plain text rather than being dropped: the reader should
      // still see what was written, just not be able to click it.
      out.push(isSafeHref(href) ? { kind: 'link', href, children } : { kind: 'text', text: match[0] })
    } else if (match[5] !== undefined) {
      out.push({ kind: 'strong', children: parseInline(match[6] ?? '') })
    } else if (match[7] !== undefined) {
      out.push({ kind: 'strike', children: parseInline(match[8] ?? '') })
    } else if (match[9] !== undefined) {
      out.push({ kind: 'em', children: parseInline(match[10] ?? '') })
    }

    rest = rest.slice(match.index + match[0].length)
  }

  if (rest.length > 0) out.push({ kind: 'text', text: rest })
  return out
}

/** True when the text contains anything worth parsing, so plain replies skip the work. */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n) {0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)|[`*_~]|\[[^\]]*\]\(/.test(text)
}
