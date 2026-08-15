import { describe, expect, it } from 'vitest'

import { tokenize, type TokenKind } from './highlight.js'

/** The kinds assigned to each occurrence of `needle`, so a test can name what it means. */
function kindsOf(source: string, needle: string, language?: string): TokenKind[] {
  return tokenize(source, language)
    .filter((token) => token.text === needle)
    .map((token) => token.kind)
}

/** Round-tripping matters more than any single colour: highlighting must not eat characters. */
function reassembles(source: string, language?: string): boolean {
  return tokenize(source, language)
    .map((token) => token.text)
    .join('') === source
}

describe('tokenize', () => {
  it('never loses or reorders a character', () => {
    const samples = [
      'def f(x):\n    return x + 1  # add\n',
      'const a = `tpl ${b} end`; // note\n',
      "SELECT * FROM t WHERE a = 'x' -- c\n",
      '<!-- html --><div class="a">hi</div>',
      'no code at all, just prose',
      '',
      'unterminated "string',
      '/* unterminated block',
    ]
    for (const sample of samples) {
      expect(reassembles(sample)).toBe(true)
      expect(reassembles(sample, 'python')).toBe(true)
    }
  })

  it('colours Python keywords, strings, numbers and comments', () => {
    expect(kindsOf('def go():', 'def', 'python')).toEqual(['keyword'])
    expect(kindsOf('x = 42', '42', 'python')).toEqual(['number'])
    const tokens = tokenize('x = "hi"  # note', 'python')
    expect(tokens.some((token) => token.kind === 'string' && token.text === '"hi"')).toBe(true)
    expect(tokens.some((token) => token.kind === 'comment' && token.text === '# note')).toBe(true)
  })

  /**
   * The one thing highlighting has to get right. A `#` inside a string must not start a
   * comment, or the rest of the line changes colour and reads as dead code.
   */
  it('does not start a comment inside a string', () => {
    const tokens = tokenize('url = "https://x/#frag"  # real', 'python')
    expect(tokens.filter((token) => token.kind === 'comment')).toHaveLength(1)
    expect(tokens.find((token) => token.kind === 'comment')?.text).toBe('# real')
  })

  it('does not start a string inside a comment', () => {
    const tokens = tokenize("// it's fine\nconst a = 1", 'javascript')
    expect(tokens.filter((token) => token.kind === 'string')).toHaveLength(0)
  })

  it('handles escaped quotes', () => {
    const tokens = tokenize('a = "he said \\"hi\\" ok"', 'javascript')
    expect(tokens.find((token) => token.kind === 'string')?.text).toBe('"he said \\"hi\\" ok"')
  })

  it('handles Python triple-quoted strings across lines', () => {
    const source = 'x = """\nline one\nline two\n"""\ny = 1'
    const tokens = tokenize(source, 'python')
    const string = tokens.find((token) => token.kind === 'string')
    expect(string?.text).toContain('line two')
    // The code after the string must not be swallowed by it.
    expect(kindsOf(source, '1', 'python')).toEqual(['number'])
  })

  /**
   * A stray quote must not colour the remainder of the block. Single-quoted strings do not
   * span lines in most languages, so the scan stops at the newline.
   */
  it('stops an unterminated string at the end of its line', () => {
    const tokens = tokenize("a = 'oops\nb = 2", 'javascript')
    expect(kindsOf("a = 'oops\nb = 2", '2', 'javascript')).toEqual(['number'])
    expect(tokens.find((token) => token.kind === 'string')?.text).toBe("'oops")
  })

  /** The requirement: an unknown language still gets highlighted, not left plain. */
  it('highlights a language it has never heard of', () => {
    const tokens = tokenize('function foo() { return "x" } // c', 'brainfuck-flavoured-nonsense')
    expect(tokens.some((token) => token.kind === 'keyword')).toBe(true)
    expect(tokens.some((token) => token.kind === 'string')).toBe(true)
    expect(tokens.some((token) => token.kind === 'comment')).toBe(true)
  })

  it('highlights with no language given at all', () => {
    const tokens = tokenize('if (x) { return 1 } # done')
    expect(tokens.some((token) => token.kind === 'keyword')).toBe(true)
    expect(tokens.some((token) => token.kind === 'comment')).toBe(true)
  })

  it('knows common fence aliases', () => {
    expect(kindsOf('def f():', 'def', 'py')).toEqual(['keyword'])
    expect(kindsOf('const a = 1', 'const', 'ts')).toEqual(['keyword'])
    expect(kindsOf('echo hi', 'echo', 'bash')).toEqual(['keyword'])
  })

  it('treats SQL keywords case-insensitively', () => {
    expect(kindsOf('SELECT a FROM t', 'SELECT', 'sql')).toEqual(['keyword'])
    expect(kindsOf('select a from t', 'select', 'sql')).toEqual(['keyword'])
  })

  /** `--` is a comment in SQL and an operator elsewhere; the profile decides. */
  it('uses the language profile for comment syntax', () => {
    expect(tokenize('a -- note', 'sql').some((token) => token.kind === 'comment')).toBe(true)
    expect(tokenize('a-- ; b = 1', 'javascript').some((token) => token.kind === 'comment')).toBe(false)
  })

  it('does not treat a digit inside an identifier as a number', () => {
    expect(tokenize('utf8mode = 1', 'python').filter((token) => token.kind === 'number')).toHaveLength(1)
  })

  it('leaves JSON without inventing comments', () => {
    // `//` inside a URL is the case that catches a naive implementation.
    const tokens = tokenize('{"url": "https://x/a"}', 'json')
    expect(tokens.filter((token) => token.kind === 'comment')).toHaveLength(0)
  })
})
