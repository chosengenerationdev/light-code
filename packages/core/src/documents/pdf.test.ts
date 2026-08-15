import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { describePdfProblem, extractPdfText } from './pdf.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * A real PDF, not a fixture someone invented.
 *
 * `chromium-report.pdf` was printed by Edge's headless renderer, so it has everything a
 * hand-written sample would quietly omit: Flate-compressed content, subset-embedded Arial with
 * `Identity-H` encoding, per-glyph `Td` positioning and marked-content dictionaries. Every one
 * of those broke the first implementation, and none of them would have appeared in a fixture
 * written to match the parser.
 */
describe('extractPdfText against a Chromium-produced PDF', () => {
  const buffer = fs.readFileSync(path.join(here, 'fixtures', 'chromium-report.pdf'))

  it('reads the text', () => {
    const out = extractPdfText(buffer)
    expect(out.problem).toBeUndefined()
    expect(out.pages).toBe(1)
    expect(out.text).toContain('Quarterly Report')
    expect(out.text).toContain('median latency of 91 ms')
    expect(out.text).toContain('platform@example.internal')
  })

  it('decodes subset-embedded fonts through their ToUnicode map', () => {
    // Without following ToUnicode this document is entirely glyph indices and the quality gate
    // rejects the lot. The digits are the sharpest check: they are nowhere near their ASCII
    // codes in a subset font.
    expect(extractPdfText(buffer).text).toContain('41,208 requests')
  })

  it('keeps lines apart without splitting every glyph onto its own', () => {
    const lines = extractPdfText(buffer)
      .text.split('\n')
      .filter((line) => line.trim().length > 0)

    expect(lines).toContain('Alpha: nominal')
    expect(lines).toContain('Beta: degraded on the 9th')
    // Chromium emits a `Td` per glyph. Treating those as breaks produced one character per
    // line, which passed a "contains the text" check and was useless to read.
    expect(lines.every((line) => line.trim().length > 1)).toBe(true)
  })

  it('does not leak marked-content dictionaries into the text', () => {
    // `<</MCID 0 >>` read as a hex string contributes the digits C, D and 0 — a stray `Í`.
    const { text } = extractPdfText(buffer)
    expect(text).not.toContain('Í')
    expect(text).not.toContain('�')
  })

  it('honours the character limit', () => {
    expect(extractPdfText(buffer, { maxCharacters: 40 }).text.length).toBeLessThanOrEqual(40)
  })
})

/** Minimal but structurally valid documents, for the paths a real PDF cannot demonstrate. */
function buildPdf(body: string, options: { encrypted?: boolean } = {}): Buffer {
  const trailer = options.encrypted === true ? '/Encrypt 9 0 R ' : ''
  return Buffer.from(`%PDF-1.7\n${body}\ntrailer\n<</Size 9 ${trailer}/Root 1 0 R>>\n%%EOF\n`, 'latin1')
}

describe('extractPdfText failure paths', () => {
  it('refuses a file that is not a PDF at all', () => {
    expect(() => extractPdfText(Buffer.from('just some text'))).toThrow(/not a PDF/)
  })

  it('reports an encrypted document rather than reporting no text', () => {
    const out = extractPdfText(buildPdf('1 0 obj\n<</Type /Page>>\nendobj', { encrypted: true }))
    expect(out.problem).toBe('encrypted')
    expect(describePdfProblem('encrypted', 'a.pdf')).toMatch(/unprotected copy|export/i)
  })

  it('reports a page with no text layer, as a scan would be', () => {
    const out = extractPdfText(buildPdf('1 0 obj\n<</Type /Page /Contents 2 0 R>>\nendobj'))
    expect(out.problem).toBe('no-text-layer')
    expect(describePdfProblem('no-text-layer', 'a.pdf')).toMatch(/OCR/)
  })

  /**
   * The property that matters most: undecodable text is withheld, never returned.
   *
   * A model handed mojibake summarises it confidently and is wrong, which is a worse outcome
   * than being told the file needs converting.
   */
  it('withholds glyph soup instead of returning it', () => {
    const content = `BT /F1 12 Tf ${'<0003000400050006000700080009000A000B000C000D000E>Tj '.repeat(8)}ET`
    const stream = deflateSync(Buffer.from(content, 'latin1'))
    const pdf = Buffer.concat([
      Buffer.from(
        '%PDF-1.7\n1 0 obj\n<</Type /Page /Resources <</Font <</F1 3 0 R>>>> /Contents 2 0 R>>\nendobj\n' +
          '3 0 obj\n<</Type /Font /Subtype /Type0 /Encoding /Identity-H>>\nendobj\n' +
          `2 0 obj\n<</Length ${String(stream.length)} /Filter /FlateDecode>>\nstream\n`,
        'latin1',
      ),
      stream,
      Buffer.from('\nendstream\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n', 'latin1'),
    ])

    const out = extractPdfText(pdf)
    expect(out.problem).toBe('undecodable')
    expect(out.text).toBe('')
    expect(describePdfProblem('undecodable', 'a.pdf')).toMatch(/Export it to text/)
  })

  it('reads a simple font with no ToUnicode map as Latin-1', () => {
    const content = 'BT /F1 12 Tf (Server started on port 8080) Tj ET'
    const pdf = Buffer.from(
      '%PDF-1.7\n1 0 obj\n<</Type /Page /Resources <</Font <</F1 3 0 R>>>> /Contents 2 0 R>>\nendobj\n' +
        '3 0 obj\n<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>\nendobj\n' +
        `2 0 obj\n<</Length ${String(content.length)}>>\nstream\n${content}\nendstream\nendobj\n` +
        'trailer\n<</Root 1 0 R>>\n%%EOF\n',
      'latin1',
    )

    // The uncompressed, standard-font case still has to work: plenty of tooling emits it, and
    // it is the one shape where no character map is needed.
    expect(extractPdfText(pdf).text).toContain('Server started on port 8080')
  })
})
