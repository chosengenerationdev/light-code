import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HttpClient, HttpRequestOptions, HttpResponse, WebSocketConnection } from '../platform/http.js'
import { JupyterClient, encodePath } from './client.js'
import { KernelSession } from './kernel.js'
import { HubMirror } from './mirror.js'
import { localFolderNames, parseJupyterHubSpec, serverBase, type JupyterHubSpec } from './spec.js'

/**
 * JupyterHub folders (Fire Code). These run against an in-memory Jupyter Server; the same rules were
 * also verified against a real Jupyter Server 2.21 with an ipykernel kernel - see CLAUDE.md.
 */

const spec: JupyterHubSpec = { url: 'https://hub.example.test', user: 'ann', folders: ['projects/risk'], tokenRef: 't' }

/** Files keyed by path, with Jupyter's timestamps; records every request so tests can inspect them. */
class FakeServer implements HttpClient {
  files = new Map<string, { text: string; lastModified: string }>()
  requests: { url: string; options: HttpRequestOptions }[] = []
  private clock = 0
  stamp(): string {
    this.clock += 1
    return `2026-10-04T00:00:${String(this.clock).padStart(2, '0')}Z`
  }
  put(file: string, text: string): void {
    this.files.set(file, { text, lastModified: this.stamp() })
  }
  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.requests.push({ url, options })
    const parsed = new URL(url)
    const remote = decodeURIComponent(parsed.pathname.replace(/^\/user\/ann\/api\/contents\/?/, ''))
    const method = options.method ?? 'GET'
    const json = (status: number, body: unknown): HttpResponse => ({
      status,
      headers: { 'content-type': 'application/json' },
      text: async () => JSON.stringify(body),
      json: async <T>() => body as T,
      body: null,
    })
    if (options.headers?.Authorization !== 'token good') return json(403, { message: 'Forbidden' })
    if (method === 'PUT') {
      const body = JSON.parse(options.body ?? '{}') as { type: string; content?: string }
      if (body.type === 'directory') return json(201, { type: 'directory', path: remote, last_modified: this.stamp() })
      this.put(remote, body.content ?? '')
      return json(200, { type: 'file', path: remote, last_modified: this.files.get(remote)?.lastModified })
    }
    const file = this.files.get(remote)
    if (file !== undefined) {
      return json(200, { type: 'file', name: remote.split('/').pop(), path: remote, last_modified: file.lastModified, format: 'text', content: file.text, size: file.text.length })
    }
    const children = [...this.files.entries()].filter(([p]) => p.startsWith(`${remote}/`))
    if (children.length === 0) return json(404, { message: 'No such file' })
    const direct = new Map<string, unknown>()
    for (const [p, f] of children) {
      const rest = p.slice(remote.length + 1)
      const name = rest.split('/')[0] as string
      direct.set(name, rest.includes('/')
        ? { type: 'directory', name, path: `${remote}/${name}`, last_modified: '' }
        : { type: 'file', name, path: p, last_modified: f.lastModified, size: f.text.length })
    }
    return json(200, { type: 'directory', path: remote, content: [...direct.values()] })
  }
}

let root: string
let server: FakeServer
let mirror: HubMirror
let token = 'good'

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-hub-'))
  server = new FakeServer()
  server.put('projects/risk/a.py', 'a = 1\n')
  server.put('projects/risk/lib/b.py', 'b = 2\n')
  server.put('projects/risk/.ipynb_checkpoints/a-checkpoint.py', 'old')
  token = 'good'
  const client = new JupyterClient(server, spec, async () => token, async () => undefined)
  mirror = new HubMirror(client, spec, root)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const local = (rel: string): string => path.join(root, ...rel.split('/'))

describe('the settings', () => {
  it('refuses folders that overlap or climb out', () => {
    const base = { url: 'https://h', user: 'u', tokenRef: 't' }
    expect(() => parseJupyterHubSpec(JSON.stringify({ ...base, folders: ['', 'projects'] }))).toThrow(/copied twice/)
    expect(() => parseJupyterHubSpec(JSON.stringify({ ...base, folders: ['a', 'a/b'] }))).toThrow(/copied twice/)
    expect(() => parseJupyterHubSpec(JSON.stringify({ ...base, folders: ['../etc'] }))).toThrow(/climbs out/)
    expect(parseJupyterHubSpec(JSON.stringify({ ...base, folders: ['/a/b/', 'c\\d'] })).folders).toEqual(['a/b', 'c/d'])
  })

  it('names local folders after the last part, uniquely', () => {
    expect(localFolderNames(['x/risk', 'y/risk', ''])).toEqual(['risk', 'risk-2', 'home'])
  })

  it('encodes the user and each path part, so a name cannot change what is asked for', () => {
    expect(serverBase({ ...spec, user: 'a b', server: 'gpu#1' })).toBe('https://hub.example.test/user/a%20b/gpu%231/')
    expect(encodePath('a b/c?d')).toBe('a%20b/c%3Fd')
    expect(() => encodePath('a/../b')).toThrow()
  })
})

describe('keeping the copy and the hub in step', () => {
  it('copies the folder, skipping checkpoints, and sends the token only as a header', async () => {
    const result = await mirror.pull()
    expect(result.fetched.sort()).toEqual(['risk/a.py', 'risk/lib/b.py'])
    expect(await fs.readFile(local('risk/lib/b.py'), 'utf8')).toBe('b = 2\n')
    expect(server.requests.every((r) => !r.url.includes('good'))).toBe(true)
  })

  it('saves an edit, and refuses one when the hub changed meanwhile', async () => {
    await mirror.pull()
    await fs.writeFile(local('risk/a.py'), 'a = 10\n')
    expect((await mirror.push(local('risk/a.py'))).saved).toBe(true)
    expect(server.files.get('projects/risk/a.py')?.text).toBe('a = 10\n')

    server.put('projects/risk/a.py', 'a = 99  # theirs\n')
    await fs.writeFile(local('risk/a.py'), 'a = 11  # mine\n')
    const refused = await mirror.push(local('risk/a.py'))
    expect(refused.saved).toBe(false)
    expect(refused.message).toMatch(/NOT saved/)
    expect(server.files.get('projects/risk/a.py')?.text).toBe('a = 99  # theirs\n')
  })

  it('never overwrites a local edit when fetching, and reports a conflict', async () => {
    await mirror.pull()
    await fs.writeFile(local('risk/a.py'), 'mine\n')
    server.put('projects/risk/a.py', 'theirs\n')
    const result = await mirror.pull()
    expect(result.conflicts).toEqual(['risk/a.py'])
    expect(await fs.readFile(local('risk/a.py'), 'utf8')).toBe('mine\n')
  })

  it('removes a file deleted on the hub only when unchanged here', async () => {
    await mirror.pull()
    await fs.writeFile(local('risk/a.py'), 'mine\n')
    server.files.delete('projects/risk/a.py')
    server.files.delete('projects/risk/lib/b.py')
    server.put('projects/risk/c.py', 'c\n')
    const result = await mirror.pull()
    expect(result.removed).toEqual(['risk/lib/b.py'])
    expect(result.conflicts).toEqual(['risk/a.py'])
  })

  it('a refused token fails the fetch without deleting anything', async () => {
    await mirror.pull()
    token = 'expired'
    const result = await mirror.pull()
    expect(result.failed[0]?.problem).toMatch(/refused the token/)
    expect(result.removed).toEqual([])
    expect(await fs.readFile(local('risk/a.py'), 'utf8')).toBe('a = 1\n')
  })

  it('lists what is not on the hub yet', async () => {
    await mirror.pull()
    await fs.writeFile(local('risk/a.py'), 'changed\n')
    await fs.writeFile(local('risk/new.py'), 'new\n')
    await fs.rm(local('risk/lib/b.py'))
    const pending = await mirror.pending()
    expect(pending.map((p) => `${p.local}:${p.kind}`).sort()).toEqual(['risk/a.py:changed', 'risk/lib/b.py:deleted', 'risk/new.py:new'])
  })
})

/** A kernel channel scripted by the test: each sent request is answered by `respond`. */
function fakeKernel(respond: (msgId: string, emit: (type: string, content: Record<string, unknown>) => void) => void): HttpClient {
  return {
    request: async (url, options) => {
      const body = url.endsWith('/api/kernels') && options?.method === 'POST' ? { id: 'k1', name: 'python3' } : {}
      return { status: 200, headers: { 'content-type': 'application/json' }, text: async () => '', json: async <T>() => body as T, body: null }
    },
    openWebSocket: (): WebSocketConnection => {
      const listeners: ((text: string) => void)[] = []
      return {
        opened: Promise.resolve(),
        send: (text) => {
          const msgId = (JSON.parse(text) as { header: { msg_id: string } }).header.msg_id
          const emit = (type: string, content: Record<string, unknown>): void => {
            const message = JSON.stringify({ msg_type: type, parent_header: { msg_id: msgId }, content })
            setTimeout(() => listeners.forEach((l) => l(message)), 0)
          }
          respond(msgId, emit)
        },
        close: () => undefined,
        onMessage: (l) => listeners.push(l),
        onClose: () => undefined,
      }
    },
  }
}

describe('running code in the hub kernel', () => {
  it('collects output and errors, and ends when the kernel is idle', async () => {
    const http = fakeKernel((_id, emit) => {
      emit('stream', { name: 'stdout', text: 'hello\n' })
      emit('error', { ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[31mValueError\u001b[0m: bad'] })
      emit('execute_reply', { status: 'error' })
      emit('status', { execution_state: 'idle' })
    })
    const session = new KernelSession(new JupyterClient(http, spec, async () => 'good', async () => undefined), undefined)
    const output = await session.run('x', { timeoutMs: 5000 })
    expect(output.text).toBe('hello\n')
    expect(output.error).toEqual({ name: 'ValueError', value: 'bad', traceback: 'ValueError: bad' })
    expect(output.freshKernel).toBe(true)
  })

  it('says so when the kernel skipped a run, rather than showing empty output', async () => {
    const http = fakeKernel((_id, emit) => {
      emit('execute_reply', { status: 'aborted' })
      emit('status', { execution_state: 'idle' })
    })
    const session = new KernelSession(new JupyterClient(http, spec, async () => 'good', async () => undefined), undefined)
    expect((await session.run('x', { timeoutMs: 5000 })).error?.name).toBe('Skipped')
  })
})
