import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { LspClient } from './client.js'
import { describeDiagnostics, LspManager } from './manager.js'

/**
 * A fake language server, spoken to over real stdio. It answers initialize and, on every didOpen or
 * didChange, publishes one diagnostic per line containing "BAD" - under a URI spelled the way pyright
 * spells it on Windows (lower-case drive, escaped colon). Matching that exact string was the bug that
 * made pyright look silent against a real install.
 */
const FAKE_SERVER = String.raw`
let buf = Buffer.alloc(0)
const send = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m })); process.stdout.write('Content-Length: ' + b.length + '\r\n\r\n'); process.stdout.write(b) }
const respell = (uri) => uri.replace(/^file:\/\/\/([A-Za-z]):/, (_, d) => 'file:///' + d.toLowerCase() + '%3A')
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c])
  for (;;) {
    const h = buf.indexOf('\r\n\r\n'); if (h < 0) return
    const n = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, h).toString())[1])
    if (buf.length < h + 4 + n) return
    const m = JSON.parse(buf.subarray(h + 4, h + 4 + n).toString()); buf = buf.subarray(h + 4 + n)
    if (m.method === 'initialize') send({ id: m.id, result: { capabilities: {} } })
    if (m.method === 'exit') process.exit(0)
    const doc = m.params && m.params.textDocument
    const text = m.method === 'textDocument/didOpen' ? doc.text : m.method === 'textDocument/didChange' ? m.params.contentChanges[0].text : undefined
    if (text !== undefined) {
      const diagnostics = text.split('\n').flatMap((l, i) => l.includes('BAD') ? [{ range: { start: { line: i, character: l.indexOf('BAD') }, end: { line: i, character: 0 } }, severity: 1, message: 'bad thing\nmore detail', code: 7 }] : [])
      send({ method: 'textDocument/publishDiagnostics', params: { uri: respell(doc.uri), diagnostics } })
    }
  }
})
`

describe('language server client', () => {
  let dir: string
  let server: string
  const clients: LspClient[] = []

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-lsp-'))
    server = path.join(dir, 'fake-server.cjs')
    await fs.writeFile(server, FAKE_SERVER)
  })
  afterAll(async () => {
    for (const c of clients) c.dispose()
    // A server just told to exit may still hold its working folder for a moment on Windows.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  it('hears diagnostics however the server spells the file URI', async () => {
    const client = new LspClient(process.execPath, [server], dir, () => {})
    clients.push(client)
    const file = path.join(dir, 'a.py')
    const first = await client.diagnose(file, 'ok\nx = BAD\n', 'python', 5000)
    expect(first).toEqual([{ line: 2, column: 5, severity: 'error', message: 'bad thing\nmore detail', code: '7' }])
    // A later version of the same file goes as didChange, and a fixed file reports nothing.
    expect(await client.diagnose(file, 'ok\n', 'python', 5000)).toEqual([])
  })

  it('starts lazily per language, reports state, and describes results tersely', async () => {
    const manager = new LspManager(dir, () => ({ servers: { python: { command: process.execPath, args: [server] } } }), dir, () => {})
    const file = path.join(dir, 'b.py')
    await fs.writeFile(file, 'BAD\n')
    expect(manager.status().find((s) => s.language === 'python')?.state).toBe('available')
    const result = await manager.diagnose(file)
    expect(result).toBeDefined()
    expect(describeDiagnostics('b.py', result!)).toContain('b.py:1:1 error: bad thing [7]')
    expect(manager.status().find((s) => s.language === 'python')?.state).toBe('running')
    // A file no server covers is not an error, just no answer.
    expect(await manager.diagnose(path.join(dir, 'notes.unknownext'))).toBeUndefined()
    manager.dispose()
  })

  it('turns a language off, and everything off', async () => {
    const one = new LspManager(dir, () => ({ servers: { python: false } }), dir, () => {})
    expect(one.status().find((s) => s.language === 'python')?.state).toBe('off')
    expect(await one.diagnose(path.join(dir, 'b.py'))).toBeUndefined()
    const all = new LspManager(dir, () => ({ enabled: false }), dir, () => {})
    expect(all.status().every((s) => s.state === 'off')).toBe(true)
  })

  it('remembers a server that will not start, so it costs one attempt', async () => {
    const manager = new LspManager(dir, () => ({ servers: { python: { command: process.execPath, args: ['-e', 'process.exit(3)'] } } }), dir, () => {})
    expect(await manager.diagnose(path.join(dir, 'b.py'))).toBeUndefined()
    expect(manager.status().find((s) => s.language === 'python')?.state).toBe('failed')
    manager.dispose()
  })
})
