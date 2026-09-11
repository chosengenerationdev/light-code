import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectBareInterpreter, type SecretStore } from '@light-code/core'
import { ToolBackedSecretStore, fetchCredential } from './credentialTool.js'

/**
 * Credentials from a function the operator wrote, reached through the secret store.
 *
 * Against a real interpreter, for the same reason the identity function is: what is being checked
 * is what Python prints and what this makes of it. The awkward cases are the ones that matter —
 * a dict without the field asked for, a value that came back empty, a library that prints on
 * import — because each of them, answered with an empty string, produces "your credentials are
 * wrong" from the gateway and sends somebody to check a password that was never sent.
 */
const python = await detectBareInterpreter()
const withPython = python === undefined ? describe.skip : describe

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-cred-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

async function credentialFile(source: string): Promise<string> {
  const file = path.join(dir, 'creds.py')
  await fs.writeFile(file, source, 'utf8')
  return file
}

function interpreter(): string {
  return (python as { path: string }).path
}

/** The store underneath: holds pointers and ordinary secrets alike. */
class MemoryStore implements SecretStore {
  constructor(private readonly values = new Map<string, string>()) {}
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
    return 'memory'
  }
}

const DICT_SOURCE =
  'def run(name):\n' +
  '    return {"opensearch": {"username": "svc_reader", "password": "pw-123"},\n' +
  '            "gateway": {"token": "gw-token"}}[name]\n'

withPython('fetching one credential', () => {
  it('returns a plain string as the whole secret', async () => {
    const file = await credentialFile('def run(name):\n    return "sk-live-abc"\n')
    const result = await fetchCredential({ interpreter: interpreter(), file }, 'tool:gateway')
    expect(result.value).toBe('sk-live-abc')
  })

  it('takes the field named after the hash', async () => {
    const file = await credentialFile(DICT_SOURCE)
    const options = { interpreter: interpreter(), file }
    expect((await fetchCredential(options, 'tool:opensearch#username')).value).toBe('svc_reader')
    expect((await fetchCredential(options, 'tool:opensearch#password')).value).toBe('pw-123')
  })

  /** So the usual shapes work without anybody having to look up which word this expects. */
  it('finds the secret under any of the usual names when no field is given', async () => {
    const file = await credentialFile(DICT_SOURCE)
    expect(
      (await fetchCredential({ interpreter: interpreter(), file }, 'tool:gateway')).value,
    ).toBe('gw-token')
  })

  it('names the fields that exist when the one asked for does not', async () => {
    const file = await credentialFile(DICT_SOURCE)
    const result = await fetchCredential(
      { interpreter: interpreter(), file },
      'tool:opensearch#apikey',
    )
    expect(result.value).toBeUndefined()
    expect(result.problem).toContain('username')
    expect(result.problem).toContain('password')
  })

  it('is not confused by a library that prints on import', async () => {
    const file = await credentialFile(
      'print("vault client 2.0")\n\ndef run(name):\n    return "the-secret"\n',
    )
    expect((await fetchCredential({ interpreter: interpreter(), file }, 'tool:x')).value).toBe(
      'the-secret',
    )
  })

  /**
   * The traceback is deliberately *not* passed through, unlike the identity function's.
   *
   * A credential lookup that fails often does so with the value in its hands — a library echoing
   * what it received, an assertion printing a comparison — and this string is on its way to a user
   * interface and a log.
   */
  it('does not repeat what a failing lookup printed', async () => {
    const file = await credentialFile(
      'def run(name):\n    raise RuntimeError("bad password: hunter2 for " + name)\n',
    )
    const result = await fetchCredential({ interpreter: interpreter(), file }, 'tool:gateway')
    expect(result.value).toBeUndefined()
    expect(result.problem).toBeDefined()
    expect(result.problem).not.toContain('hunter2')
    // It still names which credential, which is what makes it findable.
    expect(result.problem).toContain('gateway')
  })

  it('refuses an empty value rather than sending one', async () => {
    const file = await credentialFile('def run(name):\n    return ""\n')
    const result = await fetchCredential({ interpreter: interpreter(), file }, 'tool:gateway')
    expect(result.value).toBeUndefined()
  })

  it('gives up on a lookup that hangs', async () => {
    const file = await credentialFile('import time\n\ndef run(name):\n    time.sleep(30)\n')
    const result = await fetchCredential(
      { interpreter: interpreter(), file, timeoutMs: 1500 },
      'tool:x',
    )
    expect(result.problem).toContain('did not finish')
  }, 20_000)
})

withPython('the store in front of it', () => {
  it('resolves a pointer and passes an ordinary secret straight through', async () => {
    const file = await credentialFile(DICT_SOURCE)
    const inner = new MemoryStore(
      new Map([
        ['profile:gw:apiKey', 'tool:gateway'],
        ['profile:other:apiKey', 'typed-in-by-hand'],
      ]),
    )
    const store = new ToolBackedSecretStore(inner, { interpreter: interpreter(), file })

    expect(await store.get('profile:gw:apiKey')).toBe('gw-token')
    // Mixed deployments are the normal case: a key typed into the interface beside one from a vault.
    expect(await store.get('profile:other:apiKey')).toBe('typed-in-by-hand')
  })

  /**
   * The secrets file holds a pointer, never the password.
   *
   * That is a stronger position than the file store can offer on its own, whatever its
   * permissions are — there is simply nothing in it to read.
   */
  it('stores the pointer verbatim rather than resolving it on the way in', async () => {
    const file = await credentialFile(DICT_SOURCE)
    const inner = new MemoryStore()
    const store = new ToolBackedSecretStore(inner, { interpreter: interpreter(), file })

    await store.set('profile:gw:apiKey', 'tool:gateway')
    expect(await inner.get('profile:gw:apiKey')).toBe('tool:gateway')
  })

  it('reports a failure and answers undefined, rather than an empty secret', async () => {
    const file = await credentialFile('def run(name):\n    raise KeyError(name)\n')
    const problems: string[] = []
    const store = new ToolBackedSecretStore(
      new MemoryStore(new Map([['k', 'tool:missing']])),
      { interpreter: interpreter(), file },
      (problem) => problems.push(problem),
    )

    expect(await store.get('k')).toBeUndefined()
    expect(problems[0]).toContain('missing')
  })

  it('says which backend is active, both halves of it', async () => {
    const file = await credentialFile(DICT_SOURCE)
    const store = new ToolBackedSecretStore(new MemoryStore(), { interpreter: interpreter(), file })
    expect(store.backendName()).toContain('memory')
    expect(store.backendName()).toContain('credential function')
  })
})
