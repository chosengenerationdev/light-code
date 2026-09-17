import { describe, expect, it } from 'vitest'

import type { ToolExecutionContext } from '../tools/types.js'
import { createS3Tools, type S3Target } from './tools.js'

/**
 * Using one of several configured buckets.
 *
 * Asked for directly: somebody keeps extra connections around and wants to read or download a file
 * from a *different* bucket ad hoc, without reconfiguring anything. So a connection is a parameter
 * of the call rather than a mode of the install.
 */

const target = (id: string, label: string, contents: Record<string, string>): S3Target => ({
  id,
  label,
  bucket: `${label}-bucket`,
  client: {
    list: async () =>
      Object.keys(contents).map((key) => ({ key, size: 1, lastModified: '2026-01-01T00:00:00Z' })),
    get: async (key: string) => Buffer.from(contents[key] ?? ''),
    put: async () => undefined,
  } as unknown as S3Target['client'],
})

const context = {} as ToolExecutionContext
const toolNamed = (targets: S3Target[], name: string) =>
  createS3Tools(targets).find((tool) => tool.name === name)

describe('with several buckets configured', () => {
  const targets = [
    target('c1', 'reports', { 'q3.csv': 'from reports' }),
    target('c2', 'archive', { 'q3.csv': 'from archive' }),
  ]

  it('reads from the one named', async () => {
    const read = toolNamed(targets, 's3_read_file')
    const result = await read?.execute({ connection: 'archive', key: 'q3.csv' } as never, context)
    expect(result?.content).toBe('from archive')
  })

  it('accepts the connection id as well as the label', async () => {
    const read = toolNamed(targets, 's3_read_file')
    const result = await read?.execute({ connection: 'c1', key: 'q3.csv' } as never, context)
    expect(result?.content).toBe('from reports')
  })

  /*
   * Never resolved to the first. Reading the wrong bucket is merely wrong; uploading to it cannot
   * be undone from here, and one rule for all four tools is what keeps that true.
   */
  it('refuses rather than guessing when no connection is named', async () => {
    const read = toolNamed(targets, 's3_read_file')
    const result = await read?.execute({ key: 'q3.csv' } as never, context)
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('reports')
    expect(result?.content).toContain('archive')
  })

  it('lists the configured names when asked for one that does not exist', async () => {
    const read = toolNamed(targets, 's3_read_file')
    const result = await read?.execute({ connection: 'nope', key: 'q3.csv' } as never, context)
    expect(result?.content).toMatch(/no S3 connection called "nope"/i)
    expect(result?.content).toContain('archive')
  })

  /* The model cannot ask for a bucket it was never told about. */
  it('names every bucket in the tool description', () => {
    const read = toolNamed(targets, 's3_read_file')
    expect(read?.description).toContain('reports')
    expect(read?.description).toContain('archive')
  })
})

describe('with exactly one bucket', () => {
  const targets = [target('c1', 'reports', { 'q3.csv': 'only one' })]

  /* Asking a model to name it every time is a step it can get wrong for no benefit. */
  it('does not require the connection to be named', async () => {
    const read = toolNamed(targets, 's3_read_file')
    const result = await read?.execute({ key: 'q3.csv' } as never, context)
    expect(result?.content).toBe('only one')
  })
})

describe('with none configured', () => {
  /* Advertising tools that always fail teaches the model to keep reaching for them. */
  it('registers no tools at all', () => {
    expect(createS3Tools([])).toEqual([])
  })
})
