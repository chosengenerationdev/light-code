import { describe, expect, it } from 'vitest'

import { ConfigManager } from './manager.js'
import type { ConfigScope, ConfigStore } from '../platform/config.js'

/**
 * The config file is the one piece of state whose loss is felt everywhere at once.
 *
 * A real user's `config.json` was corrupted while the junior assessment was being saved, and
 * the symptoms were "the expert is no longer detected", "my approvals are being asked again"
 * and "my skills are gone" — three separate-looking reports from one broken file, which only
 * a human editing JSON could repair. These tests pin the two causes and the recovery.
 */

/** A store that writes into memory, with a settable delay so overlap can be forced. */
class FakeStore implements ConfigStore {
  files: Partial<Record<ConfigScope, string>> = {}
  backups: Partial<Record<ConfigScope, string>> = {}
  quarantined: string[] = []
  writeDelayMs = 0

  async read(scope: ConfigScope): Promise<string | undefined> {
    return this.files[scope]
  }

  async write(scope: ConfigScope, contents: string): Promise<void> {
    if (this.writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs))
    this.files[scope] = contents
    // Mirrors the real stores: the backup is what was last written successfully, so it exists
    // from the first save rather than the second.
    this.backups[scope] = contents
  }

  async readBackup(scope: ConfigScope): Promise<string | undefined> {
    return this.backups[scope]
  }

  async quarantine(scope: ConfigScope): Promise<string | undefined> {
    this.quarantined.push(scope)
    delete this.files[scope]
    return `${scope}.corrupt`
  }

  watch(): () => void {
    return () => undefined
  }
}

describe('concurrent saves', () => {
  /**
   * The lost update. `save` reads, merges, then writes, with an await in between — so two
   * calls in flight together both read the old contents and the second overwrites the first.
   * Saving the assessment while the expert tab saves its measured price is exactly this.
   */
  it('do not discard each other’s changes', async () => {
    const store = new FakeStore()
    store.writeDelayMs = 5
    const manager = new ConfigManager(store)

    await Promise.all([
      manager.save('user', { modeId: 'code' }),
      manager.save('user', { activeProfileId: 'gateway' }),
      manager.save('user', { maxIterations: 40 }),
    ])

    const saved = JSON.parse(store.files.user ?? '{}') as Record<string, unknown>
    expect(saved.modeId).toBe('code')
    expect(saved.activeProfileId).toBe('gateway')
    expect(saved.maxIterations).toBe(40)
  })

  it('keep working after one of them fails', async () => {
    const store = new FakeStore()
    const manager = new ConfigManager(store)

    // maxIterations must be positive, so this one is rejected by the schema.
    await expect(manager.save('user', { maxIterations: -1 })).rejects.toThrow()
    await manager.save('user', { modeId: 'ask' })

    expect(JSON.parse(store.files.user ?? '{}')).toMatchObject({ modeId: 'ask' })
  })
})

describe('a config file that will not parse', () => {
  it('is recovered from the last good copy, and moved aside rather than deleted', async () => {
    const store = new FakeStore()
    const manager = new ConfigManager(store)
    await manager.save('user', { modeId: 'code', activeProfileId: 'gateway' })

    // A half-written file, which is what an interrupted write leaves behind.
    store.files.user = '{"modeId":"code","activeProf'

    const { config } = await manager.load()
    expect(config.activeProfileId).toBe('gateway')
    expect(store.quarantined).toEqual(['user'])

    const recovery = manager.takeRecovery()
    expect(recovery?.scope).toBe('user')
    expect(recovery?.quarantinedTo).toBe('user.corrupt')
    // Announced once. A recovery reported on every load would be noise, not information.
    expect(manager.takeRecovery()).toBeUndefined()
  })

  it('leaves the live file readable again, so the next save is not building on rubble', async () => {
    const store = new FakeStore()
    const manager = new ConfigManager(store)
    await manager.save('user', { modeId: 'code' })
    store.files.user = 'not json at all'

    await manager.load()
    await manager.save('user', { activeProfileId: 'second' })

    expect(JSON.parse(store.files.user ?? '{}')).toMatchObject({ modeId: 'code', activeProfileId: 'second' })
  })

  it('still fails when there is no good copy to fall back to', async () => {
    const store = new FakeStore()
    store.files.user = '{ broken'
    await expect(new ConfigManager(store).load()).rejects.toThrow(/not valid JSON/)
  })

  /**
   * A hand-edit that parses but breaks a rule is a mistake the user just made in a file they
   * are looking at. Silently reverting it to an older copy would hide their own change from
   * them — worse help than an error naming the field.
   */
  it('does not silently revert a hand-edit that merely fails validation', async () => {
    const store = new FakeStore()
    const manager = new ConfigManager(store)
    await manager.save('user', { modeId: 'code' })

    store.files.user = '{"maxIterations": -5}'
    await expect(manager.load()).rejects.toThrow(/failed validation/)
    expect(store.quarantined).toEqual([])
  })
})
