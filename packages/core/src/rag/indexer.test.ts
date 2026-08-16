import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathDenylist } from '../fs/denylist.js'
import { chunkFile, looksLikeText } from './chunk.js'
import { indexWorkspace, type IndexManifest } from './indexer.js'
import type { Embedder } from './embedder.js'
import type { VectorDocument, VectorIndexWriter } from './vectorStore.js'

describe('chunkFile', () => {
  const lines = (count: number): string => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n')

  it('produces one chunk for a short file, with a 1-based inclusive range', () => {
    const chunks = chunkFile(lines(10))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 10 })
  })

  /**
   * The reason overlap exists: a function whose signature ends one window and whose body
   * starts the next matches poorly in both. With overlap it appears intact in at least one.
   */
  it('overlaps consecutive windows', () => {
    const chunks = chunkFile(lines(200), { windowLines: 60, overlapLines: 15 })
    expect(chunks.length).toBeGreaterThan(1)
    const first = chunks[0]
    const second = chunks[1]
    expect(second?.startLine).toBeLessThanOrEqual(first?.endLine ?? 0)
    expect(second?.startLine).toBe(46)
  })

  it('covers the whole file, ending on the last line', () => {
    const chunks = chunkFile(lines(200), { windowLines: 60, overlapLines: 15 })
    expect(chunks[chunks.length - 1]?.endLine).toBe(200)
  })

  /**
   * A minified bundle is one line of megabytes. A line window alone would sail past it and
   * hand the whole thing to the embedding endpoint, which rejects it — or bills for it.
   */
  it('caps a single enormous line by characters', () => {
    const chunks = chunkFile('x'.repeat(10_000), { maxChars: 1_000 })
    expect(chunks.length).toBe(10)
    expect(Math.max(...chunks.map((chunk) => chunk.text.length))).toBeLessThanOrEqual(1_000)
  })

  it('drops whitespace-only windows rather than paying to embed them', () => {
    expect(chunkFile('\n\n   \n\n')).toEqual([])
  })

  /** Otherwise the content hash differs per checkout and every file reindexes (§7, §16). */
  it('chunks a CRLF file identically to the same file with LF endings', () => {
    expect(chunkFile('a\r\nb\r\nc')).toEqual(chunkFile('a\nb\nc'))
  })
})

describe('looksLikeText', () => {
  it('accepts source and rejects anything with a NUL', () => {
    expect(looksLikeText('const x = 1')).toBe(true)
    expect(looksLikeText('PK\0\0binary')).toBe(false)
  })
})

describe('indexWorkspace', () => {
  let root: string
  let written: VectorDocument[]
  let deleted: string[]
  let listPathsCalls = 0
  let manifest: IndexManifest

  const embedder = {
    model: 'embed-1',
    dimensions: 3,
    embedBatch: async (texts: readonly string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    embed: async () => [0.1, 0.2, 0.3],
  } as unknown as Embedder

  // Typed as the interface, not the OpenSearch class — which is the point of the seam:
  // the indexer never needed OpenSearch, only these three calls.
  const writer: VectorIndexWriter = {
    kind: 'opensearch',
    ensureCollection: async () => {},
    upsert: async (_collection: string, documents: readonly VectorDocument[]) => {
      written.push(...documents)
    },
    deleteByPaths: async (_collection: string, paths: readonly string[]) => {
      deleted.push(...paths)
    },
    // Copying between stores is a separate operation; the indexer never scans.
    scan: async () => ({ documents: [] }),
    // The workspace indexer diffs against its manifest and never calls this; the docs corpus
    // has no manifest and does. Present to satisfy the interface, and asserted unused below.
    listPaths: async () => {
      listPathsCalls += 1
      return []
    },
  }

  const blank = (): IndexManifest => ({ model: 'embed-1', dimensions: 3, chunkSignature: 'null', files: {} })

  async function run(overrides: Partial<Parameters<typeof indexWorkspace>[0]> = {}) {
    return indexWorkspace({
      workspaceRoot: root,
      index: 'lc-index',
      embedder,
      writer,
      denylist: new PathDenylist(),
      manifest,
      saveManifest: async (next) => {
        manifest = next
      },
      ...overrides,
    })
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-index-'))
    written = []
    deleted = []
    manifest = blank()
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  const write = (relative: string, content: string): Promise<void> =>
    fs
      .mkdir(path.dirname(path.join(root, relative)), { recursive: true })
      .then(() => fs.writeFile(path.join(root, relative), content, 'utf8'))

  /**
   * The workspace indexer has a manifest and diffs against it locally. Enumerating the whole
   * collection every run would be a needless round trip over a corpus that can be enormous —
   * only the documentation corpus, which has no manifest, needs to ask.
   */
  it('never enumerates the collection, because the manifest already says what is there', async () => {
    await write('src/app.ts', 'code')
    await run()
    expect(listPathsCalls).toBe(0)
  })

  it('indexes source files and records where each chunk came from', async () => {
    await write('src/app.ts', 'export function hello() { return 1 }')
    const result = await run()

    expect(result.filesIndexed).toBe(1)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ path: 'src/app.ts', startLine: 1, vector: [0.1, 0.2, 0.3] })
  })

  /**
   * The rule that makes indexing safe at all. Without it, indexing is a second route around
   * the deny list — and the payload does not stay local, it goes to the embedding endpoint.
   */
  it('never embeds a deny-listed file', async () => {
    await write('src/app.ts', 'code')
    // A .json on purpose: an indexable extension, so this genuinely exercises the deny-list
    // check rather than being filtered out earlier by the type allowlist. A cloud
    // service-account key is exactly this shape.
    await write('secrets/service-account.json', '{"private_key":"-----BEGIN PRIVATE KEY-----"}')

    const denylist = new PathDenylist()
    await denylist.add(path.join(root, 'secrets'))
    const result = await run({ denylist })

    expect(written.map((doc) => doc.path)).toEqual(['src/app.ts'])
    expect(result.skipReasons['on the deny list']).toBe(1)
  })

  /** Proves the previous test is not passing by accident: without the deny list, it indexes. */
  it('would have embedded that file if it were not deny-listed', async () => {
    await write('secrets/service-account.json', '{"private_key":"-----BEGIN PRIVATE KEY-----"}')
    await run()
    expect(written.map((doc) => doc.path)).toEqual(['secrets/service-account.json'])
  })

  it('never embeds an ignored file', async () => {
    await write('src/app.ts', 'code')
    // .ts so the type allowlist does not skip it first — the ignore rule has to be what
    // catches it, which is the thing under test.
    await write('src/generated.ts', 'export const SECRET = "sk-live-not-a-real-key"')

    const result = await run({ isIgnored: (relative) => relative === 'src/generated.ts' })

    expect(written.map((doc) => doc.path)).toEqual(['src/app.ts'])
    expect(result.skipReasons.gitignored).toBe(1)
  })

  /** Plain text, frequently not gitignored, and the likeliest file in any repo to hold a key. */
  it('never embeds a .env even when nothing ignores it', async () => {
    await write('.env', 'API_KEY=sk-live-not-a-real-key')
    await run()
    expect(written).toHaveLength(0)
  })

  it('skips lockfiles, binaries and unknown types', async () => {
    await write('src/app.ts', 'code')
    await write('pnpm-lock.yaml', 'lockfile contents')
    await write('logo.png', 'PNG\0\0binary')
    await write('data.bin', 'whatever')

    await run()
    expect(written.map((doc) => doc.path)).toEqual(['src/app.ts'])
  })

  it('does not descend into node_modules or .git', async () => {
    await write('src/app.ts', 'code')
    await write('node_modules/dep/index.js', 'module.exports = 1')
    await write('.git/config', '[core]')

    await run()
    expect(written.map((doc) => doc.path)).toEqual(['src/app.ts'])
  })

  describe('incremental runs', () => {
    it('skips a file whose content has not changed', async () => {
      await write('src/app.ts', 'code')
      await run()
      written = []

      const result = await run()
      expect(written).toHaveLength(0)
      expect(result.skipReasons['unchanged since last index']).toBe(1)
    })

    /**
     * Replaced wholesale rather than diffed: line numbers shift when a file changes, so a
     * surviving stale chunk would keep matching and cite a range that no longer says that.
     */
    it('deletes a changed file before rewriting it', async () => {
      await write('src/app.ts', 'code')
      await run()
      await write('src/app.ts', 'different code')
      deleted = []

      await run()
      expect(deleted).toContain('src/app.ts')
    })

    it('removes a file that has been deleted from the workspace', async () => {
      await write('src/app.ts', 'code')
      await write('src/gone.ts', 'code')
      await run()
      await fs.rm(path.join(root, 'src/gone.ts'))
      deleted = []

      const result = await run()
      expect(deleted).toEqual(['src/gone.ts'])
      expect(result.filesRemoved).toBe(1)
    })

    /**
     * Vectors from two different models are not comparable. Mixing them silently produces a
     * corpus that returns confident nonsense, so everything is reindexed instead.
     */
    it('reindexes everything when the embedding model changes', async () => {
      await write('src/app.ts', 'code')
      await run()
      written = []
      manifest = { ...manifest, model: 'a-different-model' }

      await run()
      expect(written).toHaveLength(1)
    })

    it('reindexes everything when the chunk shape changes', async () => {
      await write('src/app.ts', 'code')
      await run()
      written = []
      manifest = { ...manifest, chunkSignature: 'something-else' }

      await run()
      expect(written).toHaveLength(1)
    })
  })

  it('reports why nothing was indexed, so an empty run is diagnosable', async () => {
    await write('logo.png', 'PNG\0\0binary')
    const result = await run()

    expect(result.filesIndexed).toBe(0)
    expect(Object.keys(result.skipReasons).length).toBeGreaterThan(0)
  })
})
