import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { OPERATOR_GUIDE } from './generated/operatorGuide.js'
import { renderGuide } from './guideText.js'

const source = path.join(__dirname, '..', '..', '..', 'docs', 'hosting.md')

/**
 * The guide is baked into the bundle because a published tarball has no `docs/` directory — a
 * runtime read would pass every local check and fail for every real install, which is exactly how
 * a VSIX once shipped unable to activate.
 *
 * The cost of baking is that two copies exist. This is what stops them drifting.
 */
describe('the baked operator guide', () => {
  it('matches docs/hosting.md exactly', () => {
    expect(OPERATOR_GUIDE).toBe(readFileSync(source, 'utf8'))
  })

  it('actually carries the guide, not a stub', () => {
    expect(OPERATOR_GUIDE.length).toBeGreaterThan(5000)
    expect(OPERATOR_GUIDE).toContain('--trust-proxy')
    expect(OPERATOR_GUIDE).toContain('not *privileges*')
  })
})

describe('rendering it for a terminal', () => {
  /** Piped into a file or a pager far more often than read raw, so plain is the default. */
  it('emits no escape codes when the output is not a terminal', () => {
    const plain = renderGuide(false)
    expect(plain).toBe(OPERATOR_GUIDE)
    // eslint-disable-next-line no-control-regex
    expect(/\u001b\[/.test(plain)).toBe(false)
  })

  it('emphasises headings when it is', () => {
    const coloured = renderGuide(true)
    // eslint-disable-next-line no-control-regex
    expect(/\u001b\[1m/.test(coloured)).toBe(true)
  })

  /**
   * Line count and indentation are preserved because people copy commands out of this. Dropping a
   * fence would shift what a reader selects; the fence is dimmed instead of removed.
   */
  it('keeps every line, so copied commands keep their shape', () => {
    expect(renderGuide(true).split('\n')).toHaveLength(OPERATOR_GUIDE.split('\n').length)
  })

  it('leaves command lines untouched', () => {
    expect(renderGuide(true)).toContain('  --trust-proxy 10.0.0.5')
  })
})

/**
 * The bug this file was written to hold down, found only because the assertion came first.
 *
 * `docs/hosting.md` is checked out with CRLF, and `.` in a JavaScript regular expression does
 * not match a carriage return — it is a line terminator. So the heading pattern matched nothing
 * at all against the real document and the guide printed unstyled: no error, no missing content,
 * a feature that quietly did nothing. Section 16 of CLAUDE.md, in a place nobody would look.
 */
describe('line endings', () => {
  const crlf = '# Heading\r\nbody\r\n```\r\ncmd\r\n```'
  const lf = crlf.split('\r\n').join('\n')

  it('emphasises a heading in a CRLF document', () => {
    expect(renderGuide(true, crlf)).toContain('\u001b[1mHeading')
  })

  it('emphasises a heading in an LF document too', () => {
    expect(renderGuide(true, lf)).toContain('\u001b[1mHeading')
  })

  /** What is printed keeps the file's own endings, so a copied command keeps its shape. */
  it('does not change the line endings it was given', () => {
    expect(renderGuide(true, crlf).split('\r\n')).toHaveLength(crlf.split('\r\n').length)
    expect(renderGuide(true, lf)).not.toContain('\r')
  })

  it('leaves body text exactly as written', () => {
    expect(renderGuide(true, crlf)).toContain('body\r\n')
  })
})
