import { inflateSync } from 'node:zlib'

/**
 * Text out of a PDF, with no dependency.
 *
 * ## Why this is not a PDF library
 *
 * A real one — pdf.js and its relatives — is several megabytes, and every user pays that
 * download whether or not they ever open a PDF. What is wanted here is only the text, and for a
 * digitally generated PDF that is a bounded job: index the objects, find each page's content
 * stream and fonts, inflate, and read the text-showing operators.
 *
 * ## Character codes are not characters, and that is the whole difficulty
 *
 * A byte inside a PDF string is a glyph code whose meaning comes from the font. For the WinAnsi
 * and Standard encodings a code is effectively Latin-1. But every modern producer — Chromium,
 * Word, LaTeX — embeds *subset* fonts with `Identity-H` encoding, where codes are two-byte
 * indices into a font that exists only inside that file. Reading those without the font's
 * `ToUnicode` map yields confident, meaningless mojibake.
 *
 * Measured, not assumed: a page printed by Chromium came back entirely undecodable until
 * `ToUnicode` was followed. So this does follow it — objects are indexed, each page's resources
 * resolve `/F4` to a font, and the font's CMap decodes its codes.
 *
 * ## And when it still cannot
 *
 * A **quality gate** refuses to return glyph soup. A model handed mojibake will summarise it
 * confidently and be wrong, which is far worse than being told the file needs converting. The
 * same gate catches a scanned PDF, which has no text layer at all.
 */

export interface PdfExtraction {
  text: string
  pages: number
  /** Set when text was found but could not be trusted, or when there is none. */
  problem?: 'encrypted' | 'no-text-layer' | 'undecodable'
}

interface PdfObject {
  dict: string
  stream?: Buffer
}

interface PdfFont {
  /** Type0 fonts use two-byte codes; simple fonts use one. Getting this wrong halves the text. */
  twoByte: boolean
  toUnicode?: Map<number, string>
}

/* -------------------------------------------------------------------------- object indexing */

/**
 * Every `N 0 obj … endobj`, with its stream payload if it has one.
 *
 * Scanned linearly rather than through the cross-reference table. The xref is the correct route
 * and is also the fragile one — it is what an incrementally updated or slightly damaged file
 * gets wrong, and a wrong offset loses the object silently. Scanning finds objects wherever
 * they actually are.
 */
function indexObjects(buffer: Buffer): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>()
  const raw = buffer.toString('latin1')
  const header = /(\d+)\s+(\d+)\s+obj\b/g

  let match: RegExpExecArray | null
  while ((match = header.exec(raw)) !== null) {
    const number = Number(match[1])
    const bodyStart = match.index + match[0].length
    const endObj = raw.indexOf('endobj', bodyStart)
    const streamAt = raw.indexOf('stream', bodyStart)

    const hasStream = streamAt !== -1 && (endObj === -1 || streamAt < endObj)
    if (!hasStream) {
      objects.set(number, { dict: raw.slice(bodyStart, endObj === -1 ? undefined : endObj) })
      continue
    }

    let payload = streamAt + 'stream'.length
    if (buffer[payload] === 0x0d) payload++
    if (buffer[payload] === 0x0a) payload++
    const end = raw.indexOf('endstream', payload)
    if (end === -1) continue

    objects.set(number, {
      dict: raw.slice(bodyStart, streamAt),
      stream: buffer.subarray(payload, end),
    })
    header.lastIndex = end
  }

  return objects
}

/** Inflates a stream when its dictionary says so. Returns undefined for anything unreadable. */
function decodeStream(object: PdfObject): string | undefined {
  if (object.stream === undefined) return undefined
  if (/\/(DCT|JPX|CCITTFax|JBIG2)Decode\b/.test(object.dict)) return undefined
  if (!/\/FlateDecode\b/.test(object.dict)) return object.stream.toString('latin1')
  try {
    // `maxOutputLength` because a decompression bomb is a real shape of hostile file, and this
    // runs on whatever the user points it at.
    return inflateSync(object.stream, { maxOutputLength: 64 * 1024 * 1024 }).toString('latin1')
  } catch {
    // One damaged object must not cost the rest of the document.
    return undefined
  }
}

/* -------------------------------------------------------------------------------- ToUnicode */

function utf16beToString(hex: string): string {
  let out = ''
  for (let index = 0; index + 3 < hex.length + 1; index += 4) {
    const unit = hex.slice(index, index + 4)
    if (unit.length < 4) break
    out += String.fromCharCode(parseInt(unit, 16))
  }
  return out
}

/**
 * Parses a `ToUnicode` CMap: the font's own answer to "what does code 0x0003 mean?".
 *
 * Both forms appear in practice and a producer will mix them in one map — `bfchar` for isolated
 * codes and `bfrange` for runs, which is how a subset font encodes a contiguous alphabet.
 */
function parseToUnicode(cmap: string): Map<number, string> {
  const mapping = new Map<number, string>()

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      mapping.set(parseInt(pair[1] as string, 16), utf16beToString(pair[2] as string))
    }
  }

  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? ''

    // `<lo> <hi> [<a> <b> <c>]` — one destination per code in the range.
    for (const entry of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const low = parseInt(entry[1] as string, 16)
      const targets = [...(entry[3] ?? '').matchAll(/<([0-9a-fA-F]+)>/g)]
      targets.forEach((target, offset) => {
        mapping.set(low + offset, utf16beToString(target[1] as string))
      })
    }

    // `<lo> <hi> <start>` — consecutive destinations. Only the last unit increments, which is
    // all any real producer emits and all the spec guarantees.
    for (const entry of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const low = parseInt(entry[1] as string, 16)
      const high = parseInt(entry[2] as string, 16)
      const startHex = entry[3] as string
      const start = parseInt(startHex, 16)
      if (high < low || high - low > 65_535) continue
      for (let code = low; code <= high; code++) {
        const value = start + (code - low)
        const hex = value.toString(16).padStart(startHex.length, '0')
        mapping.set(code, utf16beToString(hex))
      }
    }
  }

  return mapping
}

function referencedObject(dict: string, key: string): number | undefined {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict)
  return match === null ? undefined : Number(match[1])
}

function loadFont(objects: Map<number, PdfObject>, number: number): PdfFont {
  const object = objects.get(number)
  if (object === undefined) return { twoByte: false }

  // Type0 is the composite form, and in practice always means two-byte Identity-H codes.
  const twoByte = /\/Subtype\s*\/Type0\b/.test(object.dict) || /\/Identity-H\b/.test(object.dict)

  const toUnicodeRef = referencedObject(object.dict, 'ToUnicode')
  if (toUnicodeRef === undefined) return { twoByte }
  const cmapObject = objects.get(toUnicodeRef)
  if (cmapObject === undefined) return { twoByte }
  const cmap = decodeStream(cmapObject)
  if (cmap === undefined) return { twoByte }

  return { twoByte, toUnicode: parseToUnicode(cmap) }
}

/* --------------------------------------------------------------------------- content streams */

/** `/Font << /F4 4 0 R /F5 5 0 R >>` from a resources dictionary, resolved through references. */
function fontsForResources(objects: Map<number, PdfObject>, resources: string): Map<string, PdfFont> {
  const fonts = new Map<string, PdfFont>()
  const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)
  if (fontDict === null) return fonts
  for (const entry of (fontDict[1] ?? '').matchAll(/\/([^\s/<>]+)\s+(\d+)\s+\d+\s+R/g)) {
    fonts.set(entry[1] as string, loadFont(objects, Number(entry[2])))
  }
  return fonts
}

function resourcesFor(objects: Map<number, PdfObject>, pageDict: string): string {
  const indirect = referencedObject(pageDict, 'Resources')
  if (indirect !== undefined) return objects.get(indirect)?.dict ?? ''
  const inline = /\/Resources\s*<<([\s\S]*)/.exec(pageDict)
  return inline?.[0] ?? ''
}

function contentObjectsFor(pageDict: string): number[] {
  const single = referencedObject(pageDict, 'Contents')
  if (single !== undefined) return [single]
  const array = /\/Contents\s*\[([\s\S]*?)\]/.exec(pageDict)
  if (array === null) return []
  return [...(array[1] ?? '').matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]))
}

/** Codes to text, through the active font's map when it has one. */
function decodeCodes(bytes: number[], font: PdfFont | undefined): string {
  if (font === undefined) return bytes.map((byte) => String.fromCharCode(byte)).join('')

  if (!font.twoByte) {
    return bytes
      .map((byte) => font.toUnicode?.get(byte) ?? String.fromCharCode(byte))
      .join('')
  }

  let out = ''
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const code = ((bytes[index] as number) << 8) | (bytes[index + 1] as number)
    // No map and a two-byte code means the glyph index is all there is; a replacement keeps the
    // shape of the text so the quality gate can see it is unreadable.
    out += font.toUnicode?.get(code) ?? '�'
  }
  return out
}

/** Raw bytes of a PDF literal string, with escapes applied. */
function decodeLiteralBytes(body: string): number[] {
  const out: number[] = []
  for (let index = 0; index < body.length; index++) {
    const char = body[index] as string
    if (char !== '\\') {
      out.push(char.charCodeAt(0) & 0xff)
      continue
    }
    const next = body[++index]
    if (next === undefined) break
    if (next >= '0' && next <= '7') {
      let octal = next
      while (octal.length < 3) {
        const digit = body[index + 1]
        if (digit === undefined || digit < '0' || digit > '7') break
        octal += digit
        index++
      }
      out.push(parseInt(octal, 8) & 0xff)
      continue
    }
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 }
    const mapped = simple[next]
    if (mapped !== undefined) out.push(mapped)
    // A backslash before a newline is a line continuation, not a character. Miss it and long
    // paragraphs gain stray breaks.
    else if (next === '\n') continue
    else if (next === '\r') {
      if (body[index + 1] === '\n') index++
      continue
    } else out.push(next.charCodeAt(0) & 0xff)
  }
  return out
}

function hexBytes(body: string): number[] {
  const digits = body.replace(/[^0-9a-fA-F]/g, '')
  const out: number[] = []
  for (let index = 0; index + 1 < digits.length; index += 2) {
    out.push(parseInt(digits.slice(index, index + 2), 16))
  }
  if (digits.length % 2 === 1) out.push(parseInt(`${digits.slice(-1)}0`, 16))
  return out
}

/**
 * Reads the text-showing operators out of one decompressed content stream.
 *
 * Scanned character by character rather than by regex, because a `(` inside a string is escaped
 * but a `)` inside a *nested* balanced pair is not — a regex for `\((.*?)\)` splits such a
 * string in half and drops the rest of the line.
 */
function textFromContentStream(content: string, fonts: Map<string, PdfFont>): string {
  const pieces: string[] = []
  let index = 0
  let font: PdfFont | undefined

  /** Numeric and name operands seen since the last operator. Cleared by every operator. */
  let operands: (number | string)[] = []
  /** The vertical position of the last `Tm`, so a genuine change of line can be recognised. */
  let lastY: number | undefined
  /** Inside a `TJ` array, where a large negative number stands in for a space. */
  let inArray = false

  const readLiteralBody = (): string => {
    let depth = 1
    let body = ''
    while (index < content.length) {
      const char = content[index++] as string
      if (char === '\\') {
        body += char + (content[index++] ?? '')
        continue
      }
      if (char === '(') depth++
      if (char === ')') {
        depth--
        if (depth === 0) break
      }
      body += char
    }
    return body
  }

  const newline = (): void => {
    if (pieces[pieces.length - 1] !== '\n') pieces.push('\n')
  }

  while (index < content.length) {
    const char = content[index] as string

    if (char === '(') {
      index++
      pieces.push(decodeCodes(decodeLiteralBytes(readLiteralBody()), font))
      continue
    }

    /*
     * `<<` opens a dictionary, not a hex string, and skipping only one character lands on the
     * second `<` and reads the dictionary *as* a string. `<</MCID 0 >>` then contributes the
     * hex digits C, D and 0 — a stray `Í` in the middle of the text, which is exactly what
     * appeared before this branch existed.
     */
    if (char === '<' && content[index + 1] === '<') {
      index += 2
      continue
    }

    if (char === '<') {
      const end = content.indexOf('>', index)
      if (end === -1) break
      pieces.push(decodeCodes(hexBytes(content.slice(index + 1, end)), font))
      index = end + 1
      continue
    }

    if (char === '/') {
      const name = /^\/([^\s/<>[\](){}]*)/.exec(content.slice(index)) as RegExpExecArray
      operands.push(name[1] as string)
      index += name[0].length
      continue
    }

    if (char === '-' || char === '+' || char === '.' || (char >= '0' && char <= '9')) {
      const number = /^[-+]?(?:\d*\.\d+|\d+\.?)/.exec(content.slice(index))
      if (number !== null) {
        const value = Number(number[0])
        /*
         * A very negative kern inside a `TJ` array is how many producers write a space instead
         * of emitting one. The threshold is conservative — real inter-letter kerning is an
         * order of magnitude smaller — so this cannot manufacture spaces inside words, and
         * without it those producers come out as onelongrunofwords.
         */
        if (inArray && value < -180) pieces.push(' ')
        operands.push(value)
        index += number[0].length
        continue
      }
    }

    // An operator is a run of letters, sometimes with a trailing `*` or a quote form.
    if ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === "'" || char === '"') {
      const token = /^(?:[A-Za-z]+\*?|'|")/.exec(content.slice(index)) as RegExpExecArray
      const operator = token[0]
      index += operator.length

      if (operator === 'Tf') {
        // `/F4 37.33 Tf` — the name is the operand before the size.
        const name = operands[operands.length - 2]
        if (typeof name === 'string') font = fonts.get(name)
      } else if (operator === 'Td' || operator === 'TD') {
        /*
         * **Only a vertical move is a new line.** Chromium positions every single glyph with
         * its own `Td`, so treating them all as breaks put one character on each line — which
         * is precisely what the first version of this produced.
         */
        const ty = operands[operands.length - 1]
        if (typeof ty === 'number' && ty !== 0) newline()
      } else if (operator === 'Tm') {
        // `a b c d e f Tm`: `f` is the vertical offset. A change means a new line.
        const y = operands[operands.length - 1]
        if (typeof y === 'number') {
          if (lastY !== undefined && y !== lastY) newline()
          lastY = y
        }
      } else if (operator === 'T*' || operator === "'" || operator === '"') {
        newline()
      } else if (operator === 'ET') {
        // End of a text object — a paragraph boundary in every producer seen.
        newline()
        lastY = undefined
      }

      operands = []
      continue
    }

    if (char === '[') {
      inArray = true
      index++
      continue
    }
    if (char === ']') {
      inArray = false
      index++
      continue
    }

    index++
  }

  return pieces.join('')
}

/* ------------------------------------------------------------------------------- the gateway */

/**
 * Whether extracted text is plausibly human-readable.
 *
 * A font whose codes could not be mapped yields replacement characters and high-Latin noise; a
 * scanned page yields almost nothing. Both produce output that *looks* like text to a caller
 * and is meaningless to a reader, so the ratio of ordinary characters is the gate.
 */
function isReadable(text: string): boolean {
  const stripped = text.replace(/\s/g, '')
  if (stripped.length < 16) return false
  let ordinary = 0
  for (const char of stripped) {
    const code = char.charCodeAt(0)
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0x2bff)) ordinary++
  }
  return ordinary / stripped.length > 0.85
}

/** Collapses the runs of blank lines that positioning operators inevitably produce. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function extractPdfText(buffer: Buffer, options: { maxCharacters?: number } = {}): PdfExtraction {
  if (!buffer.toString('latin1', 0, 8).startsWith('%PDF-')) {
    throw new Error('That file does not start with a PDF header, so it is not a PDF.')
  }

  /*
   * An encrypted PDF decompresses to nothing useful, and the failure would otherwise present as
   * "no text" — which sends the user looking for the wrong problem. Even an empty-password PDF,
   * which most readers open without asking, needs real decryption.
   */
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(buffer.toString('latin1', Math.max(0, buffer.length - 8192)))) {
    return { text: '', pages: 0, problem: 'encrypted' }
  }

  const objects = indexObjects(buffer)
  const limit = options.maxCharacters ?? 400_000
  const collected: string[] = []
  let pages = 0
  let total = 0

  for (const object of objects.values()) {
    if (total >= limit) break
    if (!/\/Type\s*\/Page[^s]/.test(object.dict)) continue
    pages++

    const fonts = fontsForResources(objects, resourcesFor(objects, object.dict))
    for (const contentNumber of contentObjectsFor(object.dict)) {
      const contentObject = objects.get(contentNumber)
      if (contentObject === undefined) continue
      const content = decodeStream(contentObject)
      if (content === undefined) continue
      const text = textFromContentStream(content, fonts)
      if (text.trim().length === 0) continue
      collected.push(text)
      total += text.length
    }
  }

  if (collected.length === 0) {
    return { text: '', pages, problem: 'no-text-layer' }
  }

  const text = tidy(collected.join('\n\n'))
  if (!isReadable(text)) {
    return { text: '', pages, problem: 'undecodable' }
  }

  return { text: text.slice(0, limit), pages }
}

/** What to tell the user: name the cause and a way forward, never just "failed" (§17). */
export function describePdfProblem(problem: NonNullable<PdfExtraction['problem']>, filePath: string): string {
  if (problem === 'encrypted') {
    return (
      `${filePath} is an encrypted PDF, so its text cannot be read. ` +
      'Open it in a PDF reader and save an unprotected copy, or export it to text or Word.'
    )
  }
  if (problem === 'no-text-layer') {
    return (
      `${filePath} has no text layer — it is almost certainly a scan or a set of images. ` +
      'Reading it needs OCR, which Light Code does not do. Run it through an OCR tool first, ' +
      'or configure an MCP server that can.'
    )
  }
  return (
    `${filePath} uses embedded fonts that carry no character map, so the extracted text would be ` +
    'meaningless rather than merely imperfect. Export it to text, Word or HTML and read that ' +
    'instead. This is reported rather than returned as garbled text, which would otherwise be ' +
    'summarised as if it were correct.'
  )
}
