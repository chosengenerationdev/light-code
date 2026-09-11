import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { SecretStore } from '../platform/secrets.js'
import { isValidEnvName, pythonEnvEntries, pythonEnvSecretRef, resolvePythonEnv } from './env.js'

class FakeSecretStore implements SecretStore {
  private readonly values = new Map<string, string>()
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.values.set(k, v)
  }
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key)
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
  async clear(): Promise<void> {
    this.values.clear()
  }
  backendName(): string {
    return 'fake'
  }
}

describe('reading the declaration out of config', () => {
  it('takes a bare string as a literal value, which is what a hand-edit looks like', () => {
    expect(pythonEnvEntries({ API_HOST: 'https://internal' })).toEqual([
      { name: 'API_HOST', value: 'https://internal', secret: false },
    ])
  })

  it('takes the object form, where a secret carries no value', () => {
    expect(pythonEnvEntries({ TOKEN: { secret: true } })).toEqual([{ name: 'TOKEN', secret: true }])
  })

  /*
   * A name that is not a name would otherwise reach `spawn`, which on both platforms builds the
   * child's environment out of `NAME=value` strings. There is no error to see: the child starts
   * with an environment that is subtly not what the file says.
   */
  it('drops a name that could not be an environment variable', () => {
    expect(
      pythonEnvEntries({ 'not a name': 'x', 'A=B': 'y', _ok: 'z' }).map((e) => e.name),
    ).toEqual(['_ok'])
    expect(isValidEnvName('2FA')).toBe(false)
    expect(isValidEnvName('HTTP_PROXY')).toBe(true)
  })

  it('sorts, so the tab does not reorder itself between saves', () => {
    expect(pythonEnvEntries({ ZONE: '1', ALPHA: '2' }).map((e) => e.name)).toEqual([
      'ALPHA',
      'ZONE',
    ])
  })
})

describe('resolving the values at spawn', () => {
  it('reads a secret out of storage under its namespaced key', async () => {
    const secrets = new FakeSecretStore({ [pythonEnvSecretRef('TOKEN')]: 'real-token' })
    const resolved = await resolvePythonEnv([{ name: 'TOKEN', secret: true }], secrets)
    expect(resolved.env).toEqual({ TOKEN: 'real-token' })
    expect(resolved.missing).toEqual([])
  })

  /*
   * The alternative is passing an empty string, which produces an authentication failure inside
   * whichever library the tool uses — pointing at the tool, which is not what is wrong.
   */
  it('reports a secret with nothing behind it rather than passing an empty value', async () => {
    const resolved = await resolvePythonEnv(
      [{ name: 'TOKEN', secret: true }],
      new FakeSecretStore(),
    )
    expect(resolved.env).toEqual({})
    expect(resolved.missing).toEqual(['TOKEN'])
  })

  it('has no secrets at all when the host supplies no store', async () => {
    const resolved = await resolvePythonEnv(
      [
        { name: 'TOKEN', secret: true },
        { name: 'HOST', value: 'h', secret: false },
      ],
      undefined,
    )
    expect(resolved.env).toEqual({ HOST: 'h' })
    expect(resolved.missing).toEqual(['TOKEN'])
  })
})

/**
 * Every Python child gets the same environment, and that is checked by reading the source.
 *
 * The defect this guards against is a *missing call*: a new spawn site that builds its own
 * environment, or an existing one left behind when this changed. Nothing about the result reveals
 * it — the worker is correct, and a `uv` run quietly is not — so no test of `childEnv` can see it.
 * The same reasoning as `config/retrieval.test.ts` reading `bridge.ts`.
 */
describe('the single owner of a Python child environment', () => {
  const manager = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'manager.ts'),
    'utf8',
  )

  it('calls minimalPythonEnv in exactly one place', () => {
    const calls = manager.match(/minimalPythonEnv\(/g) ?? []
    expect(
      calls.length,
      'manager.ts builds a Python environment somewhere other than childEnv()',
    ).toBe(1)
  })

  it('builds that one place out of the user declaration as well as the session variables', () => {
    const at = manager.indexOf('private async childEnv()')
    expect(at).toBeGreaterThan(-1)
    const body = manager.slice(at, at + 600)
    expect(body).toContain('resolvePythonEnv')
    expect(body).toContain('sessionEnv')
  })

  /*
   * A worker takes its environment when it is constructed and keeps it. Without this, a saved
   * variable would apply at the next window rather than the next call — which from the outside is
   * the setting not working.
   */
  it('restarts the worker when the declaration changes', () => {
    expect(manager).toContain('this.envFingerprint')
    const at = manager.indexOf('if (fingerprint !== this.envFingerprint)')
    expect(at).toBeGreaterThan(-1)
    expect(manager.slice(at, at + 400)).toContain('await this.dispose()')
  })
})
