import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configSchema, resolveSessionVariables, toEnvironment } from '@light-code/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readVariablesFile, UserVariableStore } from './userVariables.js'
import { SharedConfigStore } from './sharedConfig.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-vars-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, contents: unknown): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify(contents, null, 2))
  return file
}

describe('a user’s own variables', () => {
  /*
   * In `variables.json`, not `config.json`. The config schema strips keys it does not know, so
   * variables kept there survive until the first unrelated save and then vanish silently.
   */
  it('are read from their own file', () => {
    const file = write('variables.json', { variables: [{ name: 'MY_TICKET', value: 'ABC-1234' }] })
    expect(readVariablesFile(file)).toEqual([{ name: 'MY_TICKET', value: 'ABC-1234' }])
  })

  it('are none when the file does not exist yet', () => {
    expect(readVariablesFile(path.join(dir, 'absent.json'))).toEqual([])
  })

  /**
   * The degradation that matters. A user hand-edits their config, breaks an unrelated key, and
   * their variables should not vanish along with it — nor should the session fail to start.
   */
  it('survive a file that is broken elsewhere', () => {
    const file = path.join(dir, 'variables.json')
    fs.writeFileSync(file, '{ "variables": [ { "name": "OK", "value": "1" } ], "profiles": NOT_JSON }')
    expect(readVariablesFile(file)).toEqual([])
  })

  it('are none when the variables key itself is the wrong shape', () => {
    expect(readVariablesFile(write('variables.json', { variables: 'nope' }))).toEqual([])
    expect(readVariablesFile(write('variables.json', { variables: [{ name: 42 }] }))).toEqual([])
  })
})

describe('the administrator’s shared store', () => {
  it('round-trips variables and administrator ids', async () => {
    const store = new SharedConfigStore(path.join(dir, 'shared.json'))
    await store.save({ variables: [{ name: 'PROXY', value: 'http://proxy:8080' }], adminIds: ['entra-alice'] })

    const reread = new SharedConfigStore(path.join(dir, 'shared.json'))
    const loaded = await reread.load()
    expect(loaded.adminIds).toEqual(['entra-alice'])
    expect(loaded.variables).toEqual([{ name: 'PROXY', value: 'http://proxy:8080' }])
  })

  it('starts empty rather than failing when there is no file', async () => {
    expect(await new SharedConfigStore(path.join(dir, 'none.json')).load()).toEqual({ variables: [], adminIds: [], profiles: [] })
  })

  /**
   * Parsed field by field on purpose: being locked out of the admin interface by a typo in an
   * unrelated list is a bad failure to design in.
   */
  it('keeps the administrator ids when the variables are malformed', async () => {
    fs.writeFileSync(path.join(dir, 'shared.json'), JSON.stringify({ adminIds: ['alice'], variables: 'broken' }))
    const loaded = await new SharedConfigStore(path.join(dir, 'shared.json')).load()
    expect(loaded.adminIds).toEqual(['alice'])
    expect(loaded.variables).toEqual([])
  })

  it('merges a partial save rather than replacing the file', async () => {
    const store = new SharedConfigStore(path.join(dir, 'shared.json'))
    await store.save({ adminIds: ['alice'], variables: [{ name: 'A', value: '1' }] })
    await store.save({ variables: [{ name: 'B', value: '2' }] })
    const loaded = await store.load()
    expect(loaded.adminIds).toEqual(['alice'])
    expect(loaded.variables).toEqual([{ name: 'B', value: '2' }])
  })
})

describe('what a session ends up handing to a command', () => {
  /** The whole feature, assembled the way the host assembles it. */
  it('gives the administrator’s value where both set one', async () => {
    const store = new SharedConfigStore(path.join(dir, 'shared.json'))
    await store.save({
      variables: [
        { name: 'REGISTRY', value: 'https://pypi.internal/simple' },
        { name: 'SHARED_ONLY', value: 'from-admin' },
      ],
    })
    const userFile = write('variables.json', {
      variables: [
        { name: 'REGISTRY', value: 'https://pypi.org/simple' },
        { name: 'MY_TICKET', value: 'ABC-1234' },
      ],
    })

    const shared = await store.load()
    const env = toEnvironment(resolveSessionVariables(shared.variables, readVariablesFile(userFile)))

    expect(env).toEqual({
      REGISTRY: 'https://pypi.internal/simple',
      SHARED_ONLY: 'from-admin',
      MY_TICKET: 'ABC-1234',
    })
  })
})

/**
 * Why the variables are not a key in `config.json`, pinned so nobody moves them back.
 *
 * `configSchema` is a zod object and strips keys it does not know. Kept in config, variables
 * would survive until the first unrelated save — changing mode, picking a colour — and then
 * vanish with no error and nothing to point at. This asserts the stripping directly, so the
 * reason is visible rather than being a claim in a comment.
 */
describe('the reason variables live in a file of their own', () => {
  it('would be silently discarded by the config schema', () => {
    const parsed = configSchema.safeParse({ modeId: 'code', variables: [{ name: 'A', value: '1' }] })
    expect(parsed.success).toBe(true)
    expect((parsed as { data: Record<string, unknown> }).data['variables']).toBeUndefined()
  })

  it('survives a round trip through its own store instead', async () => {
    const store = new UserVariableStore(path.join(dir, 'variables.json'))
    await store.save([{ name: 'A', value: '1' }])
    expect(store.read()).toEqual([{ name: 'A', value: '1' }])
  })

  it('replaces rather than merges, so removing one actually removes it', async () => {
    const store = new UserVariableStore(path.join(dir, 'variables.json'))
    await store.save([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ])
    await store.save([{ name: 'A', value: '1' }])
    expect(store.read()).toEqual([{ name: 'A', value: '1' }])
  })
})
