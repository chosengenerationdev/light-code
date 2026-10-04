import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { decideFromPolicy } from '../approval/policy.js'
import { PathDenylist } from '../fs/denylist.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import { createFastFsTools } from './fastFs.js'
import type { Tool, ToolExecutionContext } from './types.js'

/**
 * The four tools against the real Rust helper, where it has been built (`cargo build --release` in
 * apps/sun/native). Skipped elsewhere - CI without Rust still runs every other test.
 */
const exe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../apps/sun/native/target/release/fire-fs.exe')

describe.skipIf(!existsSync(exe))('fire-fs tools', () => {
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

  it('copies a folder, showing the plan first, and refuses to overwrite unless asked', async () => {
    await fs.mkdir(path.join(dir, 'tree', 'sub'), { recursive: true })
    for (let i = 0; i < 30; i++) await fs.writeFile(path.join(dir, 'tree', `f${i}.txt`), String(i))
    await fs.writeFile(path.join(dir, 'tree', 'sub', 'deep.txt'), 'deep')
    const transfer = tools['transfer_files']!
    const params = { action: 'copy', items: [{ from: 'tree', to: 'tree-copy' }] }
    const preview = await transfer.preview!(params as never, context)
    expect(preview.kind === 'text' && preview.text).toContain('31 files')
    expect(existsSync(path.join(dir, 'tree-copy')), 'the plan changes nothing').toBe(false)
    expect(await run('transfer_files', params)).toContain('Copied 31 file(s)')
    expect(await fs.readFile(path.join(dir, 'tree-copy', 'sub', 'deep.txt'), 'utf8')).toBe('deep')
    expect(await run('transfer_files', params)).toContain('already exist')
    const again = await transfer.preview!({ ...params, overwrite: true } as never, context)
    expect(again.kind === 'text' && again.text).toContain('REPLACES: 31 file(s)')
  })

  it('moves by renaming, and never touches a credentials folder', async () => {
    expect(await run('transfer_files', { action: 'move', items: [{ from: 'tree-copy', to: 'moved/tree' }] })).toContain('by rename')
    expect(existsSync(path.join(dir, 'tree-copy'))).toBe(false)
    expect(existsSync(path.join(dir, 'moved', 'tree', 'sub', 'deep.txt'))).toBe(true)
    expect(await run('transfer_files', { action: 'copy', items: [{ from: '.ssh', to: 'keys' }] })).toMatch(/credentials|denied/)
  })

  it('always asks, and is never given to a schedule', () => {
    const request = { toolName: 'transfer_files', group: 'edit', preview: { kind: 'text', text: 'Copy' } }
    const allOn = { autoApprove: { read: true, edit: true, command: true, mcp: true }, allowedCommands: [], allowedTools: ['transfer_files'] }
    expect(decideFromPolicy(request as never, allOn as never)).toBeUndefined()
    expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain('transfer_files')
  })

  it('zips a folder, lists it, extracts it, and asks first for both writes', async () => {
    const archive = tools['archive_files']!
    const create = { action: 'create', archive: 'out/moved.zip', sources: ['moved'] }
    const preview = await archive.preview!(create as never, context)
    expect(preview.kind === 'text' && preview.text).toContain('31 file(s)')
    expect(await run('archive_files', create)).toContain('Created')
    expect(await run('archive_files', { action: 'list', archive: 'out/moved.zip' })).toContain('moved/tree/sub/deep.txt')
    expect(await run('archive_files', { action: 'extract', archive: 'out/moved.zip', to: 'unzipped' })).toContain('Extracted 31 file(s)')
    expect(await fs.readFile(path.join(dir, 'unzipped', 'moved', 'tree', 'sub', 'deep.txt'), 'utf8')).toBe('deep')
    expect(await run('archive_files', { action: 'list', archive: 'app.log' })).toContain('not a .zip')
    const request = { toolName: 'archive_files', group: 'edit', preview: { kind: 'text', text: 'Create' } }
    const allOn = { autoApprove: { read: true, edit: true, command: true, mcp: true }, allowedCommands: [], allowedTools: ['archive_files'] }
    expect(decideFromPolicy(request as never, allOn as never)).toBeUndefined()
  })
})
