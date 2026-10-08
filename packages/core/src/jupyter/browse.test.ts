import { describe, expect, it } from 'vitest'
import type { ToolExecutionContext } from '../tools/index.js'
import { PathDenylist } from '../fs/denylist.js'
import { createHubBrowseTool, type BrowsableHub } from './browse.js'
import type { JupyterClient, RemoteEntry } from './client.js'

/** A hub home with a folder tree and two files, served the way the Contents API answers. */
function fakeClient(): JupyterClient {
  const tree: Record<string, RemoteEntry[]> = {
    '': [
      { name: 'projects', path: 'projects', type: 'directory', lastModified: '' },
      { name: 'shared', path: 'shared', type: 'directory', lastModified: '' },
      { name: '.cache', path: '.cache', type: 'directory', lastModified: '' },
    ],
    projects: [{ name: 'risk', path: 'projects/risk', type: 'directory', lastModified: '' }],
    'projects/risk': [{ name: 'model.sql', path: 'projects/risk/model.sql', type: 'file', lastModified: '', size: 30 }],
    shared: [{ name: 'notes.txt', path: 'shared/notes.txt', type: 'file', lastModified: '', size: 12 }],
    '.cache': [{ name: 'junk.sql', path: '.cache/junk.sql', type: 'file', lastModified: '' }],
  }
  const files: Record<string, string> = { 'shared/notes.txt': 'one\ntwo\nthree', 'projects/risk/model.sql': 'select 1' }
  const writes: string[] = []
  return {
    list: async (remote: string) => tree[remote],
    stat: async (remote: string) =>
      files[remote] !== undefined
        ? { name: remote, path: remote, type: 'file', lastModified: '' }
        : tree[remote] !== undefined
          ? { name: remote, path: remote, type: 'directory', lastModified: '' }
          : undefined,
    read: async (remote: string) => ({ bytes: Buffer.from(files[remote] ?? ''), lastModified: '' }),
    write: async (remote: string) => {
      writes.push(remote)
      return ''
    },
  } as unknown as JupyterClient
}

const context = (): ToolExecutionContext => ({
  fs: {} as ToolExecutionContext['fs'],
  terminal: {} as ToolExecutionContext['terminal'],
  workspaceRoot: '/w',
  denylist: new PathDenylist(),
  readFiles: new Set(),
})

const hubs = (): BrowsableHub[] => [
  { name: 'this', label: 'the hub', client: fakeClient() },
  { name: 'analytics', label: "analytics's hub", client: fakeClient() },
]

describe('hub_browse', () => {
  it('is read only and offered only when there is a hub', () => {
    expect(createHubBrowseTool([])).toBeUndefined()
    expect(createHubBrowseTool(hubs())?.group).toBe('read')
  })

  it('lists a folder outside the copied ones', async () => {
    const tool = createHubBrowseTool(hubs())!
    const result = await tool.execute({ action: 'list', hub: 'analytics', path: '/' }, context())
    expect(result.content).toContain('projects/')
    expect(result.content).toContain('shared/')
  })

  it('finds by name, skipping hidden and cache folders', async () => {
    const tool = createHubBrowseTool(hubs())!
    const result = await tool.execute({ action: 'find', hub: 'this', name: '*.sql' }, context())
    expect(result.content).toContain('projects/risk/model.sql')
    expect(result.content).not.toContain('junk.sql')
  })

  it('reads a file with line numbers and a place to continue', async () => {
    const tool = createHubBrowseTool(hubs())!
    const result = await tool.execute({ action: 'read', hub: '@this', path: 'shared/notes.txt', limit: 2 }, context())
    expect(result.content).toContain('     1  one')
    expect(result.content).toContain('continue with offset 3')
  })

  it('refuses to climb out, and asks which hub when there are several', async () => {
    const tool = createHubBrowseTool(hubs())!
    expect((await tool.execute({ action: 'list', hub: 'this', path: '../etc' }, context())).isError).toBe(true)
    expect((await tool.execute({ action: 'list', path: '/' }, context())).content).toContain('Name the hub')
  })
})
