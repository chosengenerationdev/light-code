import { describe, expect, it } from 'vitest'
import { isSafeHref, looksLikeMarkdown, parseInline, parseMarkdown, type Block } from './markdown.js'

const first = (source: string): Block | undefined => parseMarkdown(source)[0]

describe('fenced code', () => {
  it('captures the body and the language', () => {
    expect(first('```ts\nconst x = 1\n```')).toEqual({ kind: 'code', language: 'ts', text: 'const x = 1' })
  })

  it('works without a language', () => {
    expect(first('```\nplain\n```')).toEqual({ kind: 'code', text: 'plain' })
  })

  /**
   * The case that truncates exactly the replies explaining markdown: a longer fence must be
   * closable only by one at least as long, or the inner ``` ends the block early.
   */
  it('lets a longer fence contain a shorter one', () => {
    const block = first('````md\n```ts\ncode\n```\n````')
    expect(block).toMatchObject({ kind: 'code' })
    expect((block as { text: string }).text).toBe('```ts\ncode\n```')
  })

  /** A stream cut mid-block should still show the code, not the backticks. */
  it('treats an unterminated fence as a code block', () => {
    expect(first('```ts\nconst x = 1')).toEqual({ kind: 'code', language: 'ts', text: 'const x = 1' })
  })

  /** Markers inside code are literal — that is the entire point of a code block. */
  it('does not format anything inside', () => {
    expect((first('```\n**not bold** and `not code`\n```') as { text: string }).text).toBe(
      '**not bold** and `not code`',
    )
  })
})

describe('blocks', () => {
  it('reads headings at each level', () => {
    expect(first('### Heading')).toMatchObject({ kind: 'heading', level: 3 })
    expect(first('# Top')).toMatchObject({ kind: 'heading', level: 1 })
  })

  it('reads both kinds of list', () => {
    expect(parseMarkdown('- one\n- two')).toMatchObject([{ kind: 'list', ordered: false, items: [[], []].map(() => expect.anything()) }])
    expect(first('1. one\n2. two')).toMatchObject({ kind: 'list', ordered: true })
  })

  it('reads a blockquote and a rule', () => {
    expect(first('> quoted')).toMatchObject({ kind: 'quote' })
    expect(first('---')).toEqual({ kind: 'rule' })
  })

  /** Most replies write a sentence and then a list, with no blank line between them. */
  it('starts a list immediately after a paragraph', () => {
    const blocks = parseMarkdown('Here they are:\n- one\n- two')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'list'])
  })

  it('keeps a paragraph together across soft line breaks', () => {
    expect(parseMarkdown('one\ntwo\n\nthree').map((block) => block.kind)).toEqual(['paragraph', 'paragraph'])
  })

  it('separates a paragraph from a following code block', () => {
    expect(parseMarkdown('Try this:\n```\nx\n```').map((block) => block.kind)).toEqual(['paragraph', 'code'])
  })
})

describe('inline', () => {
  it('reads code, bold, italic and strikethrough', () => {
    expect(parseInline('`c` **b** *i* ~~s~~').map((node) => node.kind)).toEqual([
      'code',
      'text',
      'strong',
      'text',
      'em',
      'text',
      'strike',
    ])
  })

  /** Code wins: a span of code suppresses every other marker inside it. */
  it('does not format inside inline code', () => {
    expect(parseInline('`**not bold**`')).toEqual([{ kind: 'code', text: '**not bold**' }])
  })

  it('reads a link', () => {
    expect(parseInline('[docs](https://example.com)')).toEqual([
      { kind: 'link', href: 'https://example.com', children: [{ kind: 'text', text: 'docs' }] },
    ])
  })

  it('leaves unmatched markers as literal text', () => {
    expect(parseInline('a_b')).toEqual([{ kind: 'text', text: 'a_b' }])
    expect(parseInline('half *open')).toEqual([{ kind: 'text', text: 'half *open' }])
  })
})

/**
 * Model output is untrusted text, and an `href` is the one place it reaches something
 * executable. An allowlist, so whatever scheme comes next is refused by default.
 */
describe('link safety', () => {
  it('permits http, https, mailto and relative links', () => {
    for (const href of ['https://a.example', 'http://a.example', 'mailto:a@b.com', './docs/x.md', '#anchor']) {
      expect(isSafeHref(href), href).toBe(true)
    }
  })

  it('refuses anything that could execute', () => {
    for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x']) {
      expect(isSafeHref(href), href).toBe(false)
    }
  })

  /** Degraded to text rather than dropped: the reader still sees what was written. */
  it('renders an unsafe link as plain text', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[click](javascript:alert(1))' },
    ])
  })
})

describe('looksLikeMarkdown', () => {
  it('is false for ordinary prose', () => {
    expect(looksLikeMarkdown('Just a plain sentence with no markup.')).toBe(false)
  })

  it('is true for the usual markers', () => {
    for (const text of ['# h', '- item', '1. item', '```', 'a `b`', '**b**', '[a](b)']) {
      expect(looksLikeMarkdown(text), text).toBe(true)
    }
  })
})

describe('tables', () => {
  const TABLE = '| Tool | Status |\n| --- | ---: |\n| `read_file` | ok |\n| notify | **2** |'

  it('reads the header, the rows and the cell formatting', () => {
    const block = first(TABLE) as { kind: string; head: unknown[]; rows: unknown[][] }
    expect(block.kind).toBe('table')
    expect(block.head).toHaveLength(2)
    expect(block.rows).toHaveLength(2)
    // Cells are parsed as inline markdown, so code and emphasis work inside them.
    expect(JSON.stringify(block.rows[0])).toContain('"code"')
    expect(JSON.stringify(block.rows[1])).toContain('"strong"')
  })

  it('reads column alignment from the delimiter row', () => {
    const block = first(TABLE) as { align: (string | undefined)[] }
    expect(block.align).toEqual([undefined, 'right'])
    expect((first('| a |\n| :-: |') as { align: unknown[] }).align).toEqual(['center'])
  })

  /**
   * A pipe is far more often a shell command or prose than a table, so the delimiter row is
   * what makes one — otherwise `cat x | grep y` in a sentence becomes a mangled table.
   */
  it('needs a delimiter row, so a stray pipe stays prose', () => {
    expect(first('run cat x | grep y to check')).toMatchObject({ kind: 'paragraph' })
  })

  it('separates a table from the sentence above it', () => {
    expect(parseMarkdown(`Here is the summary:\n${TABLE}`).map((block) => block.kind)).toEqual([
      'paragraph',
      'table',
    ])
  })

  it('ends the table at a blank line', () => {
    expect(parseMarkdown(`${TABLE}\n\nAfter.`).map((block) => block.kind)).toEqual(['table', 'paragraph'])
  })
})

describe('emphasis edge cases', () => {
  /** Arithmetic beside prose is hardly rare in this of all products. */
  it('does not italicise spaced asterisks', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }])
  })

  it('still italicises a normal phrase', () => {
    expect(parseInline('*really*')).toMatchObject([{ kind: 'em' }])
  })
})

describe('link targets containing parentheses', () => {
  it('keeps the whole URL', () => {
    expect(parseInline('[wiki](https://e.com/Foo_(bar))')).toEqual([
      { kind: 'link', href: 'https://e.com/Foo_(bar)', children: [{ kind: 'text', text: 'wiki' }] },
    ])
  })
})
