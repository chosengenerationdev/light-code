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
import { createPythonLibraryTool } from './pythonLibrary.js'
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

  describe('query_sqlite', () => {
    // node:sqlite is the application here: an ordinary read-write connection that stays open.
    type Writer = { exec(sql: string): void; close(): void }
    let writer: Writer | undefined
    beforeAll(async () => {
      const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (file: string) => Writer }
      writer = new DatabaseSync(path.join(dir, 'app.db'))
      writer.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, region TEXT, amount REAL, note TEXT)')
      const values = Array.from({ length: 20_000 }, (_, i) => `('${['North', 'South'][i % 2] ?? ''}', ${String(i % 10)}, '${i === 12_345 ? 'urgent refund' : 'ok'}')`)
      writer.exec(`BEGIN; INSERT INTO orders (region, amount, note) VALUES ${values.join(',')}; COMMIT;`)
    })
    afterAll(() => writer?.close())

    it('describes the schema with row counts, and says it took no locks', async () => {
      const out = await run('query_sqlite', { action: 'schema', path: 'app.db' })
      expect(out).toContain('TABLE orders (20000 rows)')
      expect(out).toContain('lock-free')
    })

    it('groups a table across parallel ranges, agreeing with SQL', async () => {
      const out = await run('query_sqlite', { action: 'scan', path: 'app.db', table: 'orders', groupBy: ['region'], aggregates: [{ fn: 'sum', column: 'amount' }], sort: [{ column: 'region' }] })
      expect(out).toContain('| North | 40000 |')
      expect(out).toContain('| South | 50000 |')
      expect(out).toMatch(/Read in \d+ parallel ranges/)
      const sql = await run('query_sqlite', { action: 'query', path: 'app.db', sql: 'SELECT sum(amount) FROM orders WHERE region = ?', params: ['North'] })
      expect(sql).toContain('| 40000 |')
    })

    it('finds text anywhere', async () => {
      expect(await run('query_sqlite', { action: 'search', path: 'app.db', text: 'URGENT' })).toContain('orders rowid 12346 . note: urgent refund')
    })

    it('refuses to write, and never creates a database', async () => {
      const write = await tools['query_sqlite']!.execute({ action: 'query', path: 'app.db', sql: 'DELETE FROM orders' } as never, context)
      expect(write.isError).toBe(true)
      expect(write.content).toContain('Only reading')
      const missing = await tools['query_sqlite']!.execute({ action: 'schema', path: 'nope.db' } as never, context)
      expect(missing.isError).toBe(true)
      expect(existsSync(path.join(dir, 'nope.db'))).toBe(false)
    })

    it('joins a SQLite query with records the agent already has', async () => {
      const out = await run('dataframe', {
        action: 'sql',
        sources: [
          { name: 'orders', path: 'app.db', sqlite: { sql: 'SELECT region, amount FROM orders' } },
          { name: 'managers', rows: [{ region: 'North', manager: 'Ann' }, { region: 'South', manager: 'Bob' }] },
        ],
        sql: 'SELECT m.manager, SUM(o.amount) AS total FROM orders o JOIN managers m USING (region) GROUP BY m.manager ORDER BY m.manager',
      })
      expect(out).toMatch(/\| Ann \| \d+ \|/)
      expect(out).toMatch(/\| Bob \| \d+ \|/)
    })

    it('reads a large saved tool result by handle and joins it, with no retyping', async () => {
      const payload = JSON.stringify({ results: Array.from({ length: 500 }, (_, i) => ({ region: i % 2 === 0 ? 'North' : 'South', qty: 1 })) })
      const withSaved = Object.fromEntries(
        createFastFsTools(exe, undefined, { readResult: async (handle) => (handle === 'saved-1' ? payload : undefined) }).map((t) => [t.name, t]),
      )
      const result = await withSaved['dataframe']!.execute(
        {
          action: 'sql',
          sources: [
            { name: 'trades', result: 'saved-1' },
            { name: 'heads', rows: [{ region: 'North', head: 'Ann' }, { region: 'South', head: 'Bob' }] },
          ],
          sql: 'SELECT h.head, SUM(t.qty) AS n FROM trades t JOIN heads h USING (region) GROUP BY h.head ORDER BY h.head',
        } as never,
        context,
      )
      expect(result.content).toContain('| Ann | 250 |')
      expect(result.content).toContain('| Bob | 250 |')
      const missing = await withSaved['dataframe']!.execute({ action: 'describe', sources: [{ name: 't', result: 'nope' }] } as never, context)
      expect(missing.isError).toBe(true)
      // Built in stages: a named step is a table the final query can alias, which a WITH step cannot be.
      const staged = await withSaved['dataframe']!.execute(
        {
          action: 'sql',
          sources: [
            { name: 'trades', result: 'saved-1' },
            { name: 'heads', rows: [{ region: 'North', head: 'Ann' }] },
          ],
          steps: [{ name: 'per_region', sql: 'SELECT region, SUM(qty) AS n FROM trades GROUP BY region' }],
          sql: "SELECT p.region, p.n, COALESCE(h.head, 'none') AS head FROM per_region p LEFT JOIN heads h ON p.region = h.region ORDER BY p.region",
        } as never,
        context,
      )
      expect(staged.content).toContain('| North | 250 | Ann |')
      expect(staged.content).toContain('| South | 250 | none |')
    })

    it('lets the application keep writing while it reads', async () => {
      await run('query_sqlite', { action: 'scan', path: 'app.db', table: 'orders', aggregates: [{ fn: 'count' }] })
      expect(() => writer?.exec("INSERT INTO orders (region, amount, note) VALUES ('North', 1, 'after')")).not.toThrow()
    })
  })

  it('runs a library function many times across Python processes, in order', async () => {
    await fs.mkdir(path.join(dir, 'lib'), { recursive: true })
    await fs.writeFile(path.join(dir, 'lib', 'fakeprice.py'), "print('banner')\ndef price(notional, rate=0.05):\n    return notional * rate\n")
    const tool = createPythonLibraryTool({
      exe,
      launch: async () => ({ interpreter: 'python', env: { PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '' } }),
    })
    const preview = await tool.preview?.({ action: 'call', module: 'fakeprice', folders: ['lib'], function: 'price', calls: [{ args: [100] }] }, context)
    expect(JSON.stringify(preview)).toContain('RUN fakeprice.price 1 times')
    const result = await tool.execute(
      { action: 'call', module: 'fakeprice', folders: ['lib'], function: 'price', calls: [{ args: [100] }, { args: [200], kwargs: { rate: 0.1 } }], workers: 2 },
      context,
    )
    expect(result.isError, result.content).toBeUndefined()
    expect(result.content).toContain('1. 5')
    expect(result.content).toContain('2. 20')
    const listed = await tool.execute({ action: 'list', module: 'fakeprice', folders: ['lib'] }, context)
    expect(listed.content).toContain('price(notional, rate=0.05)')
  }, 60_000)

  it('analyses CSV with SQL and pivot, keeping a messy column as text and saying so', async () => {
    await fs.writeFile(path.join(dir, 'trades.csv'), 'desk,ccy,amount,note\nrates,USD,"1,000",a\nrates,EUR,5,b\nfx,USD,7,n/a\nfx,USD,(3),x\n')
    await fs.writeFile(path.join(dir, 'desks.csv'), 'desk,head\nrates,Ann\nfx,Bob\n')
    const described = await run('dataframe', { action: 'describe', sources: [{ name: 'trades', path: 'trades.csv' }] })
    expect(described).toContain('amount: i64')
    const joined = await run('dataframe', {
      action: 'sql',
      sources: [{ name: 'trades', path: 'trades.csv' }, { name: 'desks', path: 'desks.csv' }],
      sql: 'SELECT d.head, SUM(t.amount) AS total FROM trades t JOIN desks d USING (desk) GROUP BY d.head ORDER BY d.head',
    })
    expect(joined).toContain('| Ann | 1005 |')
    expect(joined).toContain('| Bob | 4 |')
    const wide = await run('dataframe', { action: 'sql', sources: [{ name: 'trades', path: 'trades.csv' }], pivot: { index: ['desk'], columns: 'ccy', values: 'amount' } })
    expect(wide).toContain('| desk | EUR | USD |')
    expect(wide).toContain('| fx |  | 4 |')
  })

  it('greps several roots with context, reads UTF-16, and names what it could not read', async () => {
    await fs.mkdir(path.join(dir, 'logs'), { recursive: true })
    await fs.writeFile(path.join(dir, 'logs', 'app.txt'), 'start\nERROR timeout in auth\nend\n')
    // A Windows export: UTF-16LE with its byte-order mark, which a plain byte search misses.
    await fs.writeFile(path.join(dir, 'logs', 'export.csv'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('id,state\n7,ERROR timeout\n', 'utf16le')]))
    const out = await run('grep_files', { pattern: 'error timeout', roots: ['logs', path.join(dir, 'no-such-folder')], context: 1 })
    expect(out).toContain('app.txt (1 match)')
    expect(out).toContain('  2:  ERROR timeout in auth')
    expect(out).toContain('  1-  start')
    expect(out).toContain('export.csv (1 match)')
    expect(out).toContain('could not be read')
    expect(out).toContain('no-such-folder')
    const filtered = await run('grep_files', { pattern: 'timeout', roots: ['logs'], names: ['*.txt'], filesOnly: true })
    expect(filtered).toContain('app.txt: 1 match')
    expect(filtered).not.toContain('export.csv')
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
