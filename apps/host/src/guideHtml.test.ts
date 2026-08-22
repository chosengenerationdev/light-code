import { describe, expect, it } from 'vitest'

import { markdownToHtml, renderInline } from './guideHtml.js'
import { OPERATOR_GUIDE } from './generated/operatorGuide.js'

describe('inline formatting', () => {
  it('renders bold, code and links', () => {
    expect(renderInline('**bold** and `code`')).toBe('<strong>bold</strong> and <code>code</code>')
    expect(renderInline('[docs](https://example.com/x)')).toContain('<a href="https://example.com/x"')
  })

  /**
   * The bug this sentinel exists for. Indexing code spans by a bare number meant any number in the
   * prose came back wrapped in a <code> tag — and this guide is full of ports and addresses.
   */
  it('leaves numbers in prose alone', () => {
    expect(renderInline('bundles 6 binaries and binds 127.0.0.1')).toBe('bundles 6 binaries and binds 127.0.0.1')
  })

  /** A backticked span is literal — the guide has command lines where that matters. */
  it('does not format inside a code span', () => {
    expect(renderInline('`--admin **not bold**`')).toBe('<code>--admin **not bold**</code>')
  })

  it('escapes markup before anything else', () => {
    expect(renderInline('<script>alert(1)</script>')).toContain('&lt;script&gt;')
    expect(renderInline('a & b')).toContain('&amp;')
  })

  it('leaves a non-http link as text rather than making it a link', () => {
    expect(renderInline('[x](javascript:alert(1))')).not.toContain('<a ')
  })
})

describe('block rendering', () => {
  it('renders headings with ids, so a contents list can link to them', () => {
    expect(markdownToHtml('## Setting it up')).toBe('<h2 id="setting-it-up">Setting it up</h2>')
  })

  it('keeps a fenced block literal, including characters that look like markdown', () => {
    const html = markdownToHtml('```\n# not a heading\n| not | a table |\n```')
    expect(html).toContain('<pre><code>')
    expect(html).toContain('# not a heading')
    expect(html).not.toContain('<h1')
  })

  it('renders a table, dropping the alignment row', () => {
    const html = markdownToHtml('| Flag | What |\n|---|---|\n| `--server` | Shared |')
    expect(html).toContain('<th>Flag</th>')
    expect(html).toContain('<code>--server</code>')
    expect(html).not.toContain('---')
  })

  it('renders block quotes, which carry the warnings', () => {
    expect(markdownToHtml('> **It locks settings.**')).toBe('<blockquote><strong>It locks settings.</strong></blockquote>')
  })

  it('joins a wrapped bullet into one item', () => {
    const html = markdownToHtml('- one thought that happens\n  to wrap across lines\n- another')
    expect(html).toBe('<ul><li>one thought that happens to wrap across lines</li><li>another</li></ul>')
  })

  it('renders numbered steps as an ordered list', () => {
    expect(markdownToHtml('1. first\n2. second')).toBe('<ol><li>first</li><li>second</li></ol>')
  })

  it('joins wrapped paragraph lines', () => {
    expect(markdownToHtml('a line\nthat wraps')).toBe('<p>a line that wraps</p>')
  })
})

describe('the real document', () => {
  /** The renderer covers what this guide contains, which is why it can be this small. */
  it('renders without leaving markdown behind', () => {
    const html = markdownToHtml(OPERATOR_GUIDE)
    expect(html).toContain('<h1 id="running-light-code-as-a-server">')
    expect(html).toContain('<table>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<pre><code>')
    // No stray heading or table markers surviving into the output.
    expect(html).not.toMatch(/<p>#{1,6} /)
    expect(html).not.toMatch(/<p>\|/)
  })

  it('leaves no sentinel characters in the output', () => {
    expect(markdownToHtml(OPERATOR_GUIDE)).not.toContain(String.fromCharCode(0x91))
  })
})
