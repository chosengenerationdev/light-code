import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { projectName, projectSlug } from '../config/project.js'
import { deriveIndexName } from './indexNaming.js'
import { copyBookkeeping, copyIndex, hasDocuments, planIndexRenames } from './renameIndexes.js'
import type { VectorDocument, VectorIndexWriter } from './vectorStore.js'

/**
 * A project name leads every derived index name, and existing indexes move to the new names by
 * copying — never by embedding the repository again.
 */

function memoryStore(collections: Record<string, VectorDocument[]>) {
  const aliases: [string, string][] = []
  const writer = {
    ensureCollection: async (name: string) => {
      collections[name] ??= []
    },
    ensureAlias: async (collection: string, alias: string) => {
      aliases.push([collection, alias])
    },
    upsert: async (name: string, documents: readonly VectorDocument[]) => {
      collections[name] = [...(collections[name] ?? []), ...documents]
    },
    scan: async (name: string, options?: { cursor?: unknown; pageSize?: number }) => {
      const all = collections[name] ?? []
      const start = typeof options?.cursor === 'number' ? options.cursor : 0
      const end = start + (options?.pageSize ?? 256)
      return { documents: all.slice(start, end), ...(end < all.length ? { next: end } : {}) }
    },
  } as unknown as VectorIndexWriter
  return { writer, collections, aliases }
}

const doc = (id: string): VectorDocument => ({ id, text: id, path: `${id}.ts`, startLine: 1, endLine: 2, vector: [0.1, 0.2], owner: 'ana', project: 'light-code' })

describe('project names', () => {
  it('falls back to the folder, and reduces to something an index name may hold', () => {
    expect(projectName(undefined, path.join('D:', 'work', 'payments-api'))).toBe('payments-api')
    expect(projectName({ project: { name: 'Payments Core' } } as never, 'D:/x')).toBe('Payments Core')
    expect(projectSlug('Payments Core (EU)')).toBe('payments-core-eu')
    expect(projectSlug('***')).toBeUndefined()
  })

  it('leads the derived name, and changes nothing else in it', () => {
    const base = deriveIndexName({ owner: 'ana', workspaceRoot: 'D:/work/pay' })
    const named = deriveIndexName({ owner: 'ana', workspaceRoot: 'D:/work/pay', project: 'payments' })
    expect(named).toBe(`payments-${base}`)
  })
})

describe('moving indexes to their project names', () => {
  it('plans only the names that change', () => {
    expect(
      planIndexRenames({
        codebase: { legacy: 'lc-ana-1', current: 'pay-lc-ana-1' },
        docs: { legacy: 'lc-ana-1-docs', current: 'pay-lc-ana-1-docs' },
        // A name the user typed comes back identical, and is theirs.
        skills: { legacy: 'team-skills', current: 'team-skills' },
      }),
    ).toEqual([
      { kind: 'codebase', from: 'lc-ana-1', to: 'pay-lc-ana-1' },
      { kind: 'docs', from: 'lc-ana-1-docs', to: 'pay-lc-ana-1-docs' },
    ])
  })

  it('copies every page, labels each document, attaches the aliases, and leaves the old index', async () => {
    const store = memoryStore({ old: Array.from({ length: 5 }, (_, index) => doc(`d${String(index)}`)) })
    const progress: number[] = []
    const copied = await copyIndex({
      writer: store.writer,
      from: 'old',
      to: 'new',
      dimensions: 2,
      project: 'Payments',
      aliases: ['team-code'],
      pageSize: 2,
      onProgress: (count) => progress.push(count),
    })
    expect(copied).toBe(5)
    expect(progress).toEqual([2, 4, 5])
    expect(store.collections['new']?.map((entry) => entry.project)).toEqual(Array(5).fill('Payments'))
    expect(store.collections['new']?.[0]?.vector).toEqual([0.1, 0.2])
    expect(store.collections['old']).toHaveLength(5)
    expect(store.aliases).toEqual([['new', 'team-code']])
  })

  it('knows an index that does not exist has nothing to move', async () => {
    const store = memoryStore({ full: [doc('a')] })
    expect(await hasDocuments(store.writer, 'full')).toBe(true)
    expect(await hasDocuments(store.writer, 'missing')).toBe(false)
  })

  describe('bookkeeping', () => {
    const dirs: string[] = []
    afterEach(() => {
      for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    it('copies the manifests for the old name to the new one, and only those', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-manifests-'))
      dirs.push(dir)
      fs.writeFileSync(path.join(dir, 'lc-1@store.json'), '{"files":1}')
      fs.writeFileSync(path.join(dir, 'lc-1@store.docs.tools.json'), '{}')
      // The docs index of the same base must not be mistaken for the codebase's.
      fs.writeFileSync(path.join(dir, 'lc-1-docs@store.json'), '{}')
      // Something already written for the new name is its own record and stays.
      fs.writeFileSync(path.join(dir, 'pay-lc-1@store.docs.tools.json'), '{"kept":true}')

      const copied = await copyBookkeeping(dir, 'lc-1', 'pay-lc-1', 'store')
      expect(copied).toEqual(['pay-lc-1@store.json'])
      expect(fs.readFileSync(path.join(dir, 'pay-lc-1@store.json'), 'utf8')).toBe('{"files":1}')
      expect(fs.readFileSync(path.join(dir, 'pay-lc-1@store.docs.tools.json'), 'utf8')).toBe('{"kept":true}')
      expect(fs.existsSync(path.join(dir, 'lc-1@store.json'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'pay-lc-1-docs@store.json'))).toBe(false)
    })
  })
})
