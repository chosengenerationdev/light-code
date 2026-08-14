import { ZipArchive, ZipError } from './zip.js'

/**
 * Turning a document into text a model can read.
 *
 * All zero-dependency. `.docx` and `.xlsx` are ZIP archives of XML, and HTML is already text —
 * so a library would add megabytes to the VSIX for work that is a few hundred lines of careful
 * string handling. PDF is genuinely different and is not here: compressed content streams and
 * font-level character maps make it a real parser problem rather than a parsing chore.
 *
 * **Regex rather than an XML parser, deliberately.** These are two known, machine-generated
 * formats and only their text content is wanted. A parser would accept far more syntax, cost a
 * dependency, and still need the same format-specific walk afterwards. The failure mode of the
 * approach — odd spacing on unusual markup — is visible and harmless; the failure mode of a
 * dependency is a bigger download for everyone.
 */

export type DocumentKind = 'docx' | 'xlsx' | 'html' | 'text'

export interface ExtractedDocument {
  kind: DocumentKind
  text: string
  /** Sheet names for a workbook; absent otherwise. Lets the model ask for one by name. */
  sections?: string[]
  /** Set when content was left out, e.g. sheets beyond the requested one. */
  note?: string
}

export class DocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentError'
  }
}

/** Chosen by extension. The content is not sniffed — an `.xlsx` that is really a PDF is a lie worth surfacing. */
export function documentKindFor(filePath: string): DocumentKind {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 'xlsx'
  if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.xhtml')) return 'html'
  return 'text'
}

/** The handful of entities that actually appear in Office XML and ordinary HTML. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#160': ' ',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    const known = ENTITIES[name]
    if (known !== undefined) return known
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16)
      return Number.isNaN(code) ? whole : String.fromCodePoint(code)
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10)
      return Number.isNaN(code) ? whole : String.fromCodePoint(code)
    }
    // Left as-is rather than dropped: an unrecognised entity is information, and silently
    // deleting it would corrupt the text more than showing it does.
    return whole
  })
}

/** Collapses the runs of blank lines these formats generate, without touching indentation. */
function tidy(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------- docx

/**
 * Word stores its text in `word/document.xml` as runs inside paragraphs.
 *
 * Only three elements matter: `<w:p>` ends a paragraph, `<w:t>` holds text, and `<w:tab>` /
 * `<w:br>` are whitespace. Everything else is formatting, which a model does not need and
 * which would drown the actual content if included.
 */
export function extractDocx(buffer: Buffer): ExtractedDocument {
  const archive = ZipArchive.open(buffer)
  const xml = archive.readText('word/document.xml')
  if (xml === undefined) {
    throw new DocumentError('This is a ZIP file but not a Word document — word/document.xml is missing.')
  }

  const paragraphs: string[] = []
  for (const [, body] of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    let line = ''
    for (const [, token, content] of (body ?? '').matchAll(/<w:(t|tab|br|cr)\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:\1>)/g)) {
      if (token === 'tab') line += '\t'
      else if (token === 'br' || token === 'cr') line += '\n'
      else line += decodeEntities(content ?? '')
    }
    paragraphs.push(line)
  }

  return { kind: 'docx', text: tidy(paragraphs.join('\n')) }
}

// ---------------------------------------------------------------------------- xlsx

/** Most cell text lives once in a shared table and is referenced by index from every cell. */
function sharedStrings(archive: ZipArchive): string[] {
  const xml = archive.readText('xl/sharedStrings.xml')
  if (xml === undefined) return []
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(([, entry]) =>
    // A single `si` can hold several `<t>` runs when part of the text is styled differently;
    // taking only the first would silently truncate the cell.
    [...(entry ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(([, text]) => decodeEntities(text ?? '')).join(''),
  )
}

/** Sheet names in workbook order, so a model can name one instead of guessing an index. */
function sheetNames(archive: ZipArchive): string[] {
  const xml = archive.readText('xl/workbook.xml')
  if (xml === undefined) return []
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map(([, name]) => decodeEntities(name ?? ''))
}

function extractSheet(xml: string, strings: string[]): string[] {
  const rows: string[] = []
  for (const [, row] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const [, attributes, body] of (row ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const type = /\bt="([^"]*)"/.exec(attributes ?? '')?.[1]
      if (type === 's') {
        const index = Number.parseInt(/<v>([\s\S]*?)<\/v>/.exec(body ?? '')?.[1] ?? '', 10)
        cells.push(Number.isNaN(index) ? '' : (strings[index] ?? ''))
      } else if (type === 'inlineStr') {
        cells.push(decodeEntities(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body ?? '')?.[1] ?? ''))
      } else {
        // Numbers, dates and booleans all arrive as the raw stored value. Dates are serial
        // numbers and are left as such: guessing a format is worse than showing the number,
        // because a wrong date reads as fact.
        cells.push(decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(body ?? '')?.[1] ?? ''))
      }
    }
    // Tab-separated: compact for a context window, and unambiguous for a model to read as a
    // table. Trailing empties are dropped so a sparse sheet does not become mostly tabs.
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    if (cells.length > 0) rows.push(cells.join('\t'))
  }
  return rows
}

/**
 * `sheet` selects one by name or 1-based position. Omitted reads the first.
 *
 * Never all of them at once: a workbook with twenty sheets would blow the context window in a
 * single tool call, and the sheet names are returned so the model can ask for the next one.
 */
export function extractXlsx(buffer: Buffer, sheet?: string): ExtractedDocument {
  const archive = ZipArchive.open(buffer)
  const names = sheetNames(archive)
  if (names.length === 0) {
    throw new DocumentError('This is a ZIP file but not an Excel workbook — xl/workbook.xml is missing.')
  }

  const strings = sharedStrings(archive)
  const wanted = sheet?.trim()

  let position = 0
  if (wanted !== undefined && wanted.length > 0) {
    const byName = names.findIndex((name) => name.toLowerCase() === wanted.toLowerCase())
    const byNumber = Number.parseInt(wanted, 10)
    if (byName >= 0) position = byName
    else if (!Number.isNaN(byNumber) && byNumber >= 1 && byNumber <= names.length) position = byNumber - 1
    else throw new DocumentError(`No sheet called "${wanted}". This workbook has: ${names.join(', ')}.`)
  }

  /*
   * Worksheet parts are conventionally `sheet1.xml`, `sheet2.xml`… in workbook order. The
   * strictly correct route is workbook.xml.rels, but the convention holds for everything
   * Excel and the common writers produce, and a missing part is reported rather than guessed.
   */
  const xml = archive.readText(`xl/worksheets/sheet${String(position + 1)}.xml`)
  if (xml === undefined) {
    throw new DocumentError(`Could not read the sheet "${names[position] ?? ''}" from this workbook.`)
  }

  const rows = extractSheet(xml, strings)
  const result: ExtractedDocument = {
    kind: 'xlsx',
    text: rows.join('\n'),
    sections: names,
  }
  if (names.length > 1) {
    result.note = `Showing sheet "${names[position] ?? ''}" of ${String(names.length)}. Ask for another by name.`
  }
  return result
}

// ---------------------------------------------------------------------------- html

/**
 * HTML to readable text.
 *
 * `<script>` and `<style>` are removed **with their contents** before anything else — stripping
 * tags alone would leave the JavaScript and CSS behind as body text, which is usually larger
 * than the actual content and complete noise to a model.
 */
export function extractHtml(source: string): ExtractedDocument {
  const text = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Block-level elements become line breaks, or the whole page collapses to one line.
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')

  return { kind: 'html', text: tidy(decodeEntities(text)) }
}

// ---------------------------------------------------------------------------- dispatch

export interface ExtractOptions {
  /** Worksheet name or 1-based number, for `.xlsx` only. */
  sheet?: string
}

export function extractDocument(filePath: string, buffer: Buffer, options: ExtractOptions = {}): ExtractedDocument {
  const kind = documentKindFor(filePath)
  try {
    if (kind === 'docx') return extractDocx(buffer)
    if (kind === 'xlsx') return extractXlsx(buffer, options.sheet)
    if (kind === 'html') return extractHtml(buffer.toString('utf8'))
    return { kind: 'text', text: buffer.toString('utf8') }
  } catch (error) {
    if (error instanceof ZipError) {
      throw new DocumentError(
        `${filePath} could not be opened as ${kind === 'docx' ? 'a Word document' : 'an Excel workbook'}: ${error.message}`,
      )
    }
    throw error
  }
}
