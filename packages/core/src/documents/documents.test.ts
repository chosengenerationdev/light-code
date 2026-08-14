import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeEntities, documentKindFor, extractDocument, extractHtml, DocumentError } from './extract.js'
import { ZipArchive, ZipError } from './zip.js'

/**
 * Builds a real ZIP archive in memory.
 *
 * Written rather than checked in as a fixture: a binary blob in the repository is something
 * nobody can review, and the whole point of these tests is that the reader handles the actual
 * byte layout. Generating it here means the test states the format it expects.
 */
function buildZip(files: Record<string, string>, options: { store?: boolean } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const raw = Buffer.from(content, 'utf8')
    const stored = options.store === true
    const body = stored ? raw : deflateRawSync(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }

  const localPart = Buffer.concat(locals)
  const centralPart = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralPart.length, 12)
  eocd.writeUInt32LE(localPart.length, 16)

  return Buffer.concat([localPart, centralPart, eocd])
}

const DOCX = (body: string): Buffer =>
  buildZip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
  })

describe('ZipArchive', () => {
  it('reads a deflated entry', () => {
    const archive = ZipArchive.open(buildZip({ 'a.txt': 'hello world' }))
    expect(archive.readText('a.txt')).toBe('hello world')
  })

  /** Small entries are often stored rather than deflated, since compressing them would grow them. */
  it('reads a stored entry', () => {
    const archive = ZipArchive.open(buildZip({ 'a.txt': 'hi' }, { store: true }))
    expect(archive.readText('a.txt')).toBe('hi')
  })

  it('lists entries and reports a missing one as absent rather than throwing', () => {
    const archive = ZipArchive.open(buildZip({ 'a.txt': 'x', 'b/c.xml': '<x/>' }))
    expect(archive.names().sort()).toEqual(['a.txt', 'b/c.xml'])
    expect(archive.readText('nope.txt')).toBeUndefined()
  })

  it('refuses something that is not a ZIP', () => {
    expect(() => ZipArchive.open(Buffer.from('just some text, definitely not a zip'))).toThrow(ZipError)
  })
})

describe('extracting a Word document', () => {
  it('reads paragraphs as lines', () => {
    const buffer = DOCX('<w:p><w:r><w:t>First line</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p>')
    expect(extractDocument('report.docx', buffer).text).toBe('First line\nSecond line')
  })

  /** A paragraph split across styled runs is one sentence; joining them is the whole job. */
  it('joins runs within a paragraph', () => {
    const buffer = DOCX('<w:p><w:r><w:t>Total is </w:t></w:r><w:r><w:t xml:space="preserve">42 </w:t></w:r><w:r><w:t>today</w:t></w:r></w:p>')
    expect(extractDocument('a.docx', buffer).text).toBe('Total is 42 today')
  })

  it('turns tabs and breaks into whitespace', () => {
    const buffer = DOCX('<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>')
    expect(extractDocument('a.docx', buffer).text).toBe('A\tB\nC')
  })

  it('decodes entities', () => {
    const buffer = DOCX('<w:p><w:r><w:t>Tom &amp; Jerry &lt;3</w:t></w:r></w:p>')
    expect(extractDocument('a.docx', buffer).text).toBe('Tom & Jerry <3')
  })

  /** A `.docx` that is really something else should say so, not produce nonsense. */
  it('explains a ZIP that is not a Word document', () => {
    expect(() => extractDocument('fake.docx', buildZip({ 'hello.txt': 'x' }))).toThrow(/not a Word document/i)
  })

  it('explains a file that is not a ZIP at all', () => {
    expect(() => extractDocument('a.docx', Buffer.from('plain text'))).toThrow(DocumentError)
  })
})

describe('extracting a spreadsheet', () => {
  const workbook = (sheets: string[], rows: string, strings: string[] = []): Buffer =>
    buildZip({
      'xl/workbook.xml': `<workbook><sheets>${sheets
        .map((name, index) => `<sheet name="${name}" sheetId="${String(index + 1)}"/>`)
        .join('')}</sheets></workbook>`,
      'xl/sharedStrings.xml': `<sst>${strings.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`,
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>',
    })

  it('reads shared strings and numbers as tab-separated rows', () => {
    const buffer = workbook(
      ['Data'],
      '<row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c><c><v>7</v></c></row>',
      ['Widgets', 'Gadgets'],
    )
    expect(extractDocument('book.xlsx', buffer).text).toBe('Widgets\t42\nGadgets\t7')
  })

  it('reads an inline string', () => {
    const buffer = workbook(['Data'], '<row><c t="inlineStr"><is><t>Inline value</t></is></c></row>')
    expect(extractDocument('book.xlsx', buffer).text).toBe('Inline value')
  })

  /**
   * A workbook with twenty sheets would fill the context window in one call, so only one is
   * returned — and the names come back so the model can ask for the next by name.
   */
  it('returns one sheet at a time, naming the rest', () => {
    const buffer = workbook(['First', 'Second'], '<row><c t="s"><v>0</v></c></row>', ['Only me'])
    const result = extractDocument('book.xlsx', buffer)

    expect(result.sections).toEqual(['First', 'Second'])
    expect(result.note).toMatch(/Showing sheet "First" of 2/)
  })

  it('selects a sheet by name, case-insensitively', () => {
    const buffer = workbook(['First', 'Second'], '<row><c t="s"><v>0</v></c></row>', ['from sheet two'])
    expect(extractDocument('book.xlsx', buffer, { sheet: 'second' }).text).toBe('from sheet two')
  })

  it('names the available sheets when asked for one that does not exist', () => {
    const buffer = workbook(['First', 'Second'], '<row/>')
    expect(() => extractDocument('book.xlsx', buffer, { sheet: 'Nope' })).toThrow(/This workbook has: First, Second/)
  })
})

describe('extracting HTML', () => {
  /**
   * The important one. Stripping tags alone leaves the JavaScript and CSS behind as body
   * text, and on a real page that is usually larger than the content and complete noise.
   */
  it('removes script and style with their contents', () => {
    const html = '<html><head><style>body{color:red}</style></head><body><script>alert("x")</script><p>Real content</p></body></html>'
    const text = extractHtml(html).text
    expect(text).toBe('Real content')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('alert')
  })

  /**
   * A paragraph end and a `<br>` are each a break, so together they leave a blank line —
   * which is what the page renders too. `tidy` caps any run at one blank line, so a page
   * built from deeply nested divs does not arrive as mostly whitespace.
   */
  it('keeps block structure as line breaks', () => {
    expect(extractHtml('<p>One</p><p>Two</p>Three').text).toBe('One\nTwo\nThree')
    expect(extractHtml('<p>One</p><br/>Two').text).toBe('One\n\nTwo')
    expect(extractHtml('<div><div><div>Deep</div></div></div><p>After</p>').text).toBe('Deep\n\nAfter')
  })

  it('decodes entities', () => {
    expect(extractHtml('<p>a &amp; b &nbsp;c &#65;</p>').text).toBe('a & b  c A')
  })
})

describe('decodeEntities', () => {
  it('handles named, decimal and hex forms', () => {
    expect(decodeEntities('&amp;&#65;&#x42;')).toBe('&AB')
  })

  /** Dropping an unknown entity would corrupt the text more than showing it does. */
  it('leaves an unrecognised entity alone', () => {
    expect(decodeEntities('&unknownthing;')).toBe('&unknownthing;')
  })
})

describe('documentKindFor', () => {
  it('picks by extension, and treats anything else as text', () => {
    expect(documentKindFor('a.docx')).toBe('docx')
    expect(documentKindFor('a.XLSX')).toBe('xlsx')
    expect(documentKindFor('page.htm')).toBe('html')
    expect(documentKindFor('notes.md')).toBe('text')
  })
})
