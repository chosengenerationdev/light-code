import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigManager } from '../config/manager.js'
import type { ConfigScope, ConfigStore } from '../platform/config.js'

/**
 * What an embedder save does to the rest of the embedder block.
 *
 * `ConfigManager.saveNow` merges **shallowly** — `{ ...existing, ...patch }` — so a patch naming
 * `embedder` replaces the whole block rather than merging into it. Anything the saving code did
 * not name is gone.
 *
 * That matters here because the block holds settings written from two different panels: the
 * indexing section owns the model and the codebase aliases, and the skills tab owns the shared
 * skills alias. A save from one must not silently erase the other's.
 */

const dirs: string[] = []

const storeIn = (dir: string): ConfigStore => ({
  read: async (scope: ConfigScope) =>
    fs.readFile(path.join(dir, `${scope}.json`), 'utf8').catch(() => undefined),
  write: async (scope: ConfigScope, contents: string) =>
    fs.writeFile(path.join(dir, `${scope}.json`), contents, 'utf8'),
  watch: () => () => {},
})

const manager = async (): Promise<ConfigManager> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-embedder-'))
  dirs.push(dir)
  return new ConfigManager(storeIn(dir))
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe('saving one part of the embedder block', () => {
  const embedder = {
    profileId: 'p',
    model: 'text-embed',
    dimensions: 768,
    indexAlias: 'my-squad',
    skillsAlias: 'my-squad-skills',
  }

  it('a shallow patch replaces the whole block, which is the hazard', async () => {
    const config = await manager()
    await config.save('user', { embedder } as never)
    await config.save('user', {
      embedder: { profileId: 'p', model: 'text-embed', dimensions: 768 },
    } as never)

    const { config: after } = await config.load()
    // Documents the mechanism rather than the intent: this is why the handler must carry
    // everything it does not mean to change.
    expect(after.embedder?.skillsAlias).toBeUndefined()
  })

  it('carrying the existing block forward keeps the other panel’s setting', async () => {
    const config = await manager()
    await config.save('user', { embedder } as never)

    const { config: before } = await config.load()
    await config.save('user', {
      embedder: { ...before.embedder, model: 'text-embed-2' },
    } as never)

    const { config: after } = await config.load()
    expect(after.embedder?.model).toBe('text-embed-2')
    expect(after.embedder?.skillsAlias).toBe('my-squad-skills')
  })
})

/**
 * The handler's own rule, read out of the source.
 *
 * Spreading the existing block fixed one bug and armed another: omitting a field used to delete it
 * for free, so a cleared box and an unsent field looked identical and both worked. With the spread
 * an omitted field survives, and clearing has to be said explicitly — otherwise emptying the index
 * name silently keeps the old one, which is the same class of defect pointing the other way.
 *
 * Asserted against the source because the distinction is between `undefined` and `''` arriving at
 * one function, which no test of the saved file can tell apart.
 */
describe('the embedder handler', () => {
  it('distinguishes an unsent field from a cleared one', async () => {
    const source = await fs.readFile(
      path.join(import.meta.dirname, 'bridge.ts'),
      'utf8',
    )
    const handler = source.slice(source.indexOf('async function handleSaveEmbedder('))
    const put = handler.slice(handler.indexOf('const put ='), handler.indexOf("put('indexName'"))
    expect(put).toContain('if (value === undefined) return')
    expect(put).toContain('else delete embedder[key]')
  })

  it('carries the stored block forward rather than rebuilding it', async () => {
    const source = await fs.readFile(
      path.join(import.meta.dirname, 'bridge.ts'),
      'utf8',
    )
    const handler = source.slice(source.indexOf('async function handleSaveEmbedder('))
    expect(handler.slice(0, handler.indexOf('put('))).toContain('...(current.embedder ?? {})')
  })
})
