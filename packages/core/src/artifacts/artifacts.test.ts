import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PathDenylist } from '../fs/denylist.js'
import { NodeFileSystem } from '../platform/node/filesystem.js'
import type { ChatMessage } from '../providers/types.js'
import { agentWrites, artifactKey, describeArtifact, kindOf, listArtifacts, summaryFromText } from './artifacts.js'

let root: string

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lc-artifacts-')))
  await fs.mkdir(path.join(root, 'reports'), { recursive: true })
  await fs.mkdir(path.join(root, '.venv', 'lib'), { recursive: true })
  await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true })
  await fs.writeFile(path.join(root, 'old.txt'), 'An old note\n')
  const past = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  await fs.utimes(path.join(root, 'old.txt'), past, past)
  await fs.writeFile(path.join(root, 'reports', 'sales.csv'), 'Region,Product,Revenue\nNorth,Widget,10\nSouth,Gadget,20\n')
  await fs.writeFile(path.join(root, 'reports', 'summary.md'), '---\ntitle: x\n---\n\n# Quarterly summary\n\nText.\n')
  await fs.writeFile(path.join(root, '.venv', 'lib', 'site.py'), 'x = 1\n')
  await fs.writeFile(path.join(root, 'node_modules', 'x', 'index.js'), '1\n')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const call = (name: string, args: Record<string, unknown>): ChatMessage => ({ role: 'assistant', content: '', toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }] })

describe('agentWrites', () => {
  it('reads which tool wrote which file, with its reason, from the conversation', () => {
    const writes = agentWrites(
      [
        call('write_to_file', { path: 'reports/summary.md', content: '#', why: 'Write the summary' }),
        call('call_tool', { name: 'excel_create_workbook', arguments: { path: 'out/Book.xlsx' } }),
        call('transfer_files', { action: 'copy', items: [{ from: 'a.txt', to: 'copies/a.txt' }] }),
        call('archive_files', { action: 'create', archive: 'all.zip', sources: ['reports'] }),
        call('archive_files', { action: 'extract', archive: 'other.zip', to: 'unpacked' }),
        call('read_file', { path: 'old.txt' }),
        call('write_to_file', { path: path.join(os.tmpdir(), 'outside.txt'), content: '' }),
      ],
      root,
    )
    expect(writes.get(artifactKey('reports/summary.md'))).toEqual([{ tool: 'write_to_file', why: 'Write the summary' }])
    expect(writes.get(artifactKey('out/Book.xlsx'))).toEqual([{ tool: 'excel_create_workbook' }])
    expect(writes.has(artifactKey('copies/a.txt'))).toBe(true)
    expect(writes.has(artifactKey('all.zip'))).toBe(true)
    expect(writes.has(artifactKey('other.zip'))).toBe(false)
    expect(writes.has(artifactKey('old.txt'))).toBe(false)
    expect([...writes.keys()].some((key) => key.includes('outside'))).toBe(false)
  })
})

describe('listArtifacts', () => {
  it('lists newest first, marks this chat, and leaves environments and packages out', async () => {
    const since = Date.now() - 60_000
    const writes = agentWrites([call('write_to_file', { path: 'reports/summary.md', content: '', why: 'Summarise' })], root)
    const list = await listArtifacts({ fs: new NodeFileSystem(), root, since, writes })
    const paths = list.files.map((entry) => entry.path)
    expect(paths).toContain('reports/sales.csv')
    expect(paths.at(-1)).toBe('old.txt')
    expect(paths.some((p) => p.includes('.venv') || p.includes('node_modules'))).toBe(false)

    const summary = list.files.find((entry) => entry.path === 'reports/summary.md')!
    expect(summary.writes?.[0]?.why).toBe('Summarise')
    expect(summary.changedThisChat).toBe(true)
    expect(summary.summary).toBe('Quarterly summary')
    expect(list.files.find((entry) => entry.path === 'reports/sales.csv')?.summary).toBe('3 columns: Region, Product, Revenue')
    const old = list.files.find((entry) => entry.path === 'old.txt')!
    expect(old.changedThisChat).toBe(false)
    expect(old.writes).toBeUndefined()
  })

  it('keeps the agent\'s own files even past the limit', async () => {
    const writes = agentWrites([call('write_to_file', { path: 'old.txt', content: '' })], root)
    const list = await listArtifacts({ fs: new NodeFileSystem(), root, since: Date.now(), writes, limit: 1 })
    expect(list.files.map((entry) => entry.path)).toContain('old.txt')
  })
})

describe('describeArtifact', () => {
  it('counts lines and rows of a table and shows its start', async () => {
    const info = await describeArtifact(root, 'reports/sales.csv', new PathDenylist())
    expect(info.facts).toContain('3 line(s)')
    expect(info.facts).toContain('2 data row(s)')
    expect(info.preview).toContain('North,Widget,10')
  })

  it('refuses a path outside the folder, and one on the deny list', async () => {
    await expect(describeArtifact(root, '../outside.txt', new PathDenylist())).rejects.toThrow()
    const denylist = new PathDenylist()
    await denylist.add(path.join(root, 'old.txt'))
    await expect(describeArtifact(root, 'old.txt', denylist)).rejects.toThrow(/deny list/)
  })
})

describe('summaries and kinds', () => {
  it('skips boilerplate to find a line that says something', () => {
    expect(summaryFromText('run.py', '#!/usr/bin/env python\nimport os\n"""Builds the monthly report."""\n')).toBe('Builds the monthly report.')
    expect(summaryFromText('data.json', '{"region": "North", "total": 3}')).toBe('Keys: region, total')
    expect(summaryFromText('empty.txt', '\n\n')).toBeUndefined()
  })

  it('names the kinds people have in a folder of work', () => {
    expect(kindOf('Q3.xlsx')).toBe('spreadsheet')
    expect(kindOf('deck.pptx')).toBe('presentation')
    expect(kindOf('mail.msg')).toBe('email')
    expect(kindOf('job.jil')).toBe('code')
    expect(kindOf('thing.unknown')).toBe('other')
  })
})
