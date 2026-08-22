import { describe, expect, it } from 'vitest'

import { buildCodeGenerationPrompt, unwrapFencedSource } from './codeGenerator.js'

describe('what the programming provider is asked for', () => {
  it('states the conventions that make a tool loadable as requirements', () => {
    const prompt = buildCodeGenerationPrompt({ toolName: 'parse_report', specification: 'Read a CSV and total column B.' })
    // Each of these is the difference between a tool that loads and one that does not.
    expect(prompt).toContain('`run`')
    expect(prompt).toContain('Annotate every parameter')
    expect(prompt).toContain('module docstring')
    expect(prompt).toContain('Args:')
    expect(prompt).toContain('PEP 723')
  })

  it('carries the name and the requirement', () => {
    const prompt = buildCodeGenerationPrompt({ toolName: 'parse_report', specification: 'Read a CSV and total column B.' })
    expect(prompt).toContain('parse_report')
    expect(prompt).toContain('Read a CSV and total column B.')
  })

  /**
   * A model that explains its work produces a file that will not parse, and stripping prose
   * afterwards means guessing where the code starts.
   */
  it('asks for the file and nothing else', () => {
    const prompt = buildCodeGenerationPrompt({ toolName: 'x', specification: 'y' })
    expect(prompt).toContain('Return the file and nothing else')
  })

  /** An update should be a change rather than a rewrite, which needs the current file. */
  it('includes the existing source when there is one', () => {
    const prompt = buildCodeGenerationPrompt({
      toolName: 'parse_report',
      specification: 'Also total column C.',
      existingSource: 'def run(path: str) -> int:\n    return 0\n',
    })
    expect(prompt).toContain('This tool already exists')
    expect(prompt).toContain('def run(path: str) -> int:')
  })

  it('says nothing about an existing file when creating', () => {
    expect(buildCodeGenerationPrompt({ toolName: 'x', specification: 'y' })).not.toContain('already exists')
  })
})

describe('a fence the model added anyway', () => {
  /**
   * The prompt asks for bare source and models usually comply. The exception is common enough
   * that writing ```python into a .py file — a syntax error on line one — is the worse outcome.
   */
  it('is removed when it wraps the whole answer', () => {
    expect(unwrapFencedSource('```python\ndef run() -> int:\n    return 1\n```')).toBe('def run() -> int:\n    return 1\n')
    expect(unwrapFencedSource('```\ndef run() -> int:\n    return 1\n```')).toBe('def run() -> int:\n    return 1\n')
    expect(unwrapFencedSource('```py\nx = 1\n```')).toBe('x = 1\n')
  })

  it('leaves bare source exactly as it is', () => {
    const source = 'def run() -> int:\n    return 1\n'
    expect(unwrapFencedSource(source)).toBe(source)
  })

  /**
   * The conservative half, and the one that matters. A fence inside a docstring is content, and
   * cutting there would mangle a file that was otherwise correct.
   */
  it('leaves a fence that does not wrap the whole answer alone', () => {
    const withDocstringFence = '"""Parses a report.\n\nExample:\n    ```\n    run("a.csv")\n    ```\n"""\ndef run(path: str) -> int:\n    return 0\n'
    expect(unwrapFencedSource(withDocstringFence)).toBe(withDocstringFence)
  })

  it('leaves an unterminated fence alone rather than guessing', () => {
    const unterminated = '```python\ndef run() -> int:\n    return 1\n'
    expect(unwrapFencedSource(unterminated)).toBe(unterminated)
  })

  it('is not fooled by something that only looks like a fence', () => {
    const notAFence = '``` this is prose\ndef run(): ...\n```'
    expect(unwrapFencedSource(notAFence)).toBe(notAFence)
  })

  it('handles an empty answer without throwing', () => {
    expect(unwrapFencedSource('')).toBe('')
    expect(unwrapFencedSource('```')).toBe('```')
  })
})
