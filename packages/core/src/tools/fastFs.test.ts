import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PathDenylist } from '../fs/denylist.js'
import { createFastFsTools } from './fastFs.js'
import type { Tool, ToolExecutionContext } from './types.js'

/**
 * The four tools against the real Rust helper, where it has been built (`cargo build --release` in
 * apps/sun/native). Skipped elsewhere - CI without Rust still runs every other test.
 */
const exe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../apps/sun/native/target/release/sun-fs.exe')

describe.skipIf(!existsSync(exe))('sun-fs tools', () => {
  let dir: string
  let tools: Record<string, Tool>
  let context: ToolExecutionContext

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-fastfs-'))
    const log = Array.from({ length: 50_000 }, (_, i) => `${i % 1000 === 0 ? 'ERROR' : 'INFO'} line ${i + 1}`).join('\n')
    await fs.writeFile(path.join(dir, 'app.log'), `${log}\n`)
    const rows = Array.from({ length: 10_000 }, (_, i) => `${['North', 'South'][i % 2] ?? ''},${i % 10}`).join('\n')
    await fs.writeFile(path.join(dir, 'sales.csv'), `region,amount\n${rows}\n`)
    await fs.writeFile(path.join(dir, 'a.txt'), 'same content here')
    await fs.writeFile(path.join(dir, 'b.txt'), 'same content here')
    await fs.mkdir(path.join(dir, '.ssh'))
    await fs.writeFile(path.join(dir, '.ssh', 'id_rsa.txt'), 'secret')
    tools = Object.fromEntries(createFastFsTools(exe).map((t) => [t.name, t]))
    context = { workspaceRoot: dir, denylist: new PathDenylist(), readFiles: new Set(), reach: 'anywhere' } as unknown as ToolExecutionContext
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const run = async (name: string, params: object): Promise<string> => {
    const result = await tools[name]!.execute(params as never, context)
    return result.content
  }

  it('inspects a big log and counts its lines', async () => {
    expect(await run('big_file', { action: 'inspect', path: 'app.log' })).toContain('50000 lines')
  })

  it('searches the whole file with real line numbers', async () => {
    const out = await run('big_file', { action: 'search', path: 'app.log', pattern: '^ERROR', limit: 100 })
    expect(out).toContain('1001> ERROR line 1001')
    expect(out).toContain('50 matches')
  })

  it('reads a window and the end', async () => {
    expect(await run('big_file', { action: 'lines', path: 'app.log', fromLine: 40_000, count: 2 })).toContain('40000\tINFO line 40000')
    expect(await run('big_file', { action: 'tail', path: 'app.log', count: 1 })).toBe('INFO line 50000')
  })

  it('groups and sums a CSV', async () => {
    const out = await run('query_table', { path: 'sales.csv', groupBy: ['region'], aggregates: [{ fn: 'sum', column: 'amount' }], sort: [{ column: 'region' }] })
    expect(out).toContain('| North | 20000 |')
    expect(out).toContain('| South | 25000 |')
  })

  it('finds duplicates and never walks into a credentials folder', async () => {
    expect(await run('find_files', { action: 'duplicates', roots: ['.'], minSizeBytes: 1 })).toMatch(/2 copies/)
    const found = await run('find_files', { roots: ['.'], includeHidden: true })
    expect(found).toContain('app.log')
    expect(found).not.toContain('id_rsa')
  })

  it('reads several files at once and counts them as read', async () => {
    const out = await run('read_many_files', { files: [{ path: 'a.txt' }, { path: 'sales.csv', lines: 2 }] })
    expect(out).toContain('same content here')
    expect(out).toContain('region,amount')
    expect(context.readFiles.size).toBe(2)
  })
})
