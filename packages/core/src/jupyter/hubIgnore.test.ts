import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HttpClient, HttpRequestOptions, HttpResponse } from '../platform/http.js'
import { JupyterClient } from './client.js'
import { HubIgnore } from './hubIgnore.js'
import { HubMirror } from './mirror.js'
import { hubGuidance } from './runtime.js'
import type { JupyterHubSpec } from './spec.js'

/**
 * `.hubignore`: asked for for an Angular project in a hub folder, whose build output and caches
 * should never travel. Driven through the real mirror against an in-memory Jupyter Server.
 */

const spec: JupyterHubSpec = { url: 'https://hub.example.test', user: 'ann', folders: ['projects/web'], tokenRef: 't' }

class FakeServer implements HttpClient {
  files = new Map<string, { text: string; lastModified: string }>()
  listed: string[] = []
  private clock = 0
  put(file: string, text: string): void {
    this.clock += 1
    this.files.set(file, { text, lastModified: `2026-10-16T00:00:${String(this.clock).padStart(2, '0')}Z` })
  }
  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const remote = decodeURIComponent(new URL(url).pathname.replace(/^\/user\/ann\/api\/contents\/?/, ''))
    const json = (status: number, body: unknown): HttpResponse => ({
      status,
      headers: { 'content-type': 'application/json' },
      text: async () => JSON.stringify(body),
      json: async <T>() => body as T,
      body: null,
    })
    if ((options.method ?? 'GET') === 'PUT') {
      const body = JSON.parse(options.body ?? '{}') as { type: string; content?: string }
      if (body.type === 'directory') return json(201, { type: 'directory', path: remote, last_modified: '' })
      this.put(remote, body.content ?? '')
      return json(200, { type: 'file', path: remote, last_modified: this.files.get(remote)?.lastModified })
    }
    const file = this.files.get(remote)
    if (file !== undefined) {
      return json(200, { type: 'file', name: remote.split('/').pop(), path: remote, last_modified: file.lastModified, format: 'text', content: file.text, size: file.text.length })
    }
    const children = [...this.files.entries()].filter(([p]) => p.startsWith(`${remote}/`))
    if (children.length === 0) return json(404, { message: 'No such file' })
    this.listed.push(remote)
    const direct = new Map<string, unknown>()
    for (const [p, f] of children) {
      const rest = p.slice(remote.length + 1)
      const name = rest.split('/')[0] as string
      direct.set(
        name,
        rest.includes('/')
          ? { type: 'directory', name, path: `${remote}/${name}`, last_modified: '' }
          : { type: 'file', name, path: p, last_modified: f.lastModified, size: f.text.length },
      )
    }
    return json(200, { type: 'directory', path: remote, content: [...direct.values()] })
  }
}

let root: string
let server: FakeServer
let mirror: HubMirror
const local = (rel: string): string => path.join(root, ...rel.split('/'))

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-hubignore-'))
  server = new FakeServer()
  server.put('projects/web/package.json', '{}')
  server.put('projects/web/src/main.ts', 'main')
  server.put('projects/web/dist/main.js', 'built')
  server.put('projects/web/dist/assets/logo.svg', 'svg')
  server.put('projects/web/node_modules/left-pad/index.js', 'pad')
  server.put('projects/web/.angular/cache/x', 'cache')
  server.put('projects/web/.editorconfig', 'root = true')
  server.put('projects/web/debug.log', 'log')
  mirror = new HubMirror(new JupyterClient(server, spec, async () => 'good', async () => undefined), spec, root)
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('the rules', () => {
  it('start from the built-in skips, follow gitignore syntax, and can bring a skipped file back', () => {
    const ignore = new HubIgnore().with('dist/\n*.log\n/build\n!.editorconfig\n# a comment\n', '')
    expect(ignore.ignores('dist', true)).toBe(true)
    expect(ignore.ignores('app/dist', true)).toBe(true)
    expect(ignore.ignores('dist', false)).toBe(false)
    expect(ignore.ignores('debug.log', false)).toBe(true)
    expect(ignore.ignores('build', true)).toBe(true)
    expect(ignore.ignores('app/build', true)).toBe(false)
    expect(ignore.ignores('node_modules', true)).toBe(true)
    expect(ignore.ignores('.angular', true)).toBe(true)
    expect(ignore.ignores('.editorconfig', false)).toBe(false)
    expect(ignore.ignores('src/main.ts', false)).toBe(false)
    expect(ignore.ignores('.hubignore', false)).toBe(false)
  })

  it('apply beneath the folder their file is in', () => {
    const ignore = new HubIgnore().with('dist/\n', 'apps/web')
    expect(ignore.ignores('apps/web/dist', true)).toBe(true)
    expect(ignore.ignores('apps/api/dist', true)).toBe(false)
  })
})

describe('syncing with a .hubignore', () => {
  it('without one, skips only the built-in folders and dot-files - as before', async () => {
    const result = await mirror.pull()
    expect(result.fetched.sort()).toEqual(['web/debug.log', 'web/dist/assets/logo.svg', 'web/dist/main.js', 'web/package.json', 'web/src/main.ts'])
    expect(server.listed.some((folder) => folder.includes('node_modules'))).toBe(false)
  })

  it('leaves out what the hub copy of .hubignore lists, never even listing those folders', async () => {
    server.put('projects/web/.hubignore', 'dist/\n*.log\n!.editorconfig\n')
    const result = await mirror.pull()
    expect(result.fetched.sort()).toEqual(['web/.editorconfig', 'web/.hubignore', 'web/package.json', 'web/src/main.ts'])
    expect(server.listed.some((folder) => folder.endsWith('/dist'))).toBe(false)
  })

  it('follows this machine copy first, and never saves an ignored file - not even after an edit', async () => {
    await mirror.pull()
    await fs.writeFile(local('web/.hubignore'), 'dist/\n')
    expect((await mirror.push(local('web/.hubignore'))).saved).toBe(true)
    expect(server.files.get('projects/web/.hubignore')?.text).toBe('dist/\n')

    await fs.mkdir(local('web/dist'), { recursive: true })
    await fs.writeFile(local('web/dist/new.js'), 'built here')
    const refused = await mirror.push(local('web/dist/new.js'))
    expect(refused).toMatchObject({ saved: false, ignored: true })
    expect(server.files.has('projects/web/dist/new.js')).toBe(false)
    expect((await mirror.pending()).map((p) => p.local)).toEqual([])
  })

  it('stops tracking what was synced before it was listed, deleting nothing on either side', async () => {
    await mirror.pull()
    await fs.writeFile(local('web/.hubignore'), 'dist/\n')
    await mirror.push(local('web/.hubignore'))
    server.files.delete('projects/web/dist/main.js')
    const result = await mirror.pull()
    expect(result.ignored.sort()).toEqual(['web/dist/assets/logo.svg', 'web/dist/main.js'])
    expect(result.removed).toEqual([])
    expect(await fs.readFile(local('web/dist/main.js'), 'utf8')).toBe('built')
    expect(server.files.has('projects/web/dist/assets/logo.svg')).toBe(true)
    expect(await mirror.pending()).toEqual([])
  })
})

describe('the agent', () => {
  it('is told about .hubignore, and to write one before building a Node project', () => {
    const text = hubGuidance({ label: 'JupyterHub h (ann)', mirror } as never)
    expect(text).toContain('.hubignore')
    expect(text).toMatch(/write a \.hubignore in\s+its folder FIRST/)
    expect(text).toContain('.angular/')
  })
})
