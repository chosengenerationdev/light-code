import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfigManager } from '@light-code/core'
import { FileConfigStore } from './session.js'

/**
 * The same properties `config/manager.test.ts` pins, against a real filesystem.
 *
 * That test uses an in-memory store, which cannot show whether a rename actually replaces a
 * file on this platform or whether the backup lands where the reader looks for it. Both are
 * the sort of thing that is obviously right until it is run on Windows.
 */
let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-config-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const storeFor = (): FileConfigStore => new FileConfigStore(path.join(dir, 'config.json'), undefined)

describe('config on disk', () => {
  it('leaves no temporary files behind', async () => {
    const manager = new ConfigManager(storeFor())
    await manager.save('user', { modeId: 'code' })

    const entries = await fs.readdir(dir)
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(entries).toContain('config.json')
    expect(entries).toContain('config.json.bak')
  })

  it('recovers a half-written file from the backup and keeps the damaged copy', async () => {
    const manager = new ConfigManager(storeFor())
    await manager.save('user', { modeId: 'code', activeProfileId: 'gateway' })

    // Exactly what an interrupted write leaves: valid JSON up to the point it stopped.
    await fs.writeFile(path.join(dir, 'config.json'), '{"modeId":"code","activeProf', 'utf8')

    const manager2 = new ConfigManager(storeFor())
    const { config } = await manager2.load()
    expect(config.activeProfileId).toBe('gateway')

    const recovery = manager2.takeRecovery()
    expect(recovery?.scope).toBe('user')
    expect(recovery?.quarantinedTo).toBeDefined()
    // The broken file is kept. Someone whose config broke should get to see what broke.
    const entries = await fs.readdir(dir)
    expect(entries.some((name) => name.includes('.corrupt-'))).toBe(true)

    // And the live file is usable again, so the next save is not building on rubble.
    await manager2.save('user', { maxIterations: 40 })
    const reread = await new ConfigManager(storeFor()).load()
    expect(reread.config).toMatchObject({ modeId: 'code', activeProfileId: 'gateway', maxIterations: 40 })
  })

  it('keeps every change when saves overlap', async () => {
    const manager = new ConfigManager(storeFor())
    await Promise.all([
      manager.save('user', { modeId: 'code' }),
      manager.save('user', { activeProfileId: 'gateway' }),
      manager.save('user', { maxIterations: 40 }),
      manager.save('user', { ui: { accentColor: '#123456' } }),
    ])

    const { config } = await new ConfigManager(storeFor()).load()
    expect(config).toMatchObject({
      modeId: 'code',
      activeProfileId: 'gateway',
      maxIterations: 40,
      ui: { accentColor: '#123456' },
    })
  })
})
