import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectBareInterpreter } from '@light-code/core'
import { resolveIdentity } from './identityTool.js'

/**
 * Resolving the current user from a function the operator wrote.
 *
 * Against a **real interpreter**, because what is being checked is what Python actually prints
 * and what this makes of it — a mock would be written to return exactly what the parser expects,
 * which is the one thing that cannot be assumed. The awkward cases here are all real: a library
 * that prints a banner on import, a function that falls through and returns `None`, a traceback.
 */
const python = await detectBareInterpreter()
const withPython = python === undefined ? describe.skip : describe

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-identity-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

async function toolFile(source: string): Promise<string> {
  const file = path.join(dir, 'whoami.py')
  await fs.writeFile(file, source, 'utf8')
  return file
}

function interpreter(): string {
  return (python as { path: string }).path
}

withPython('the identity function', () => {
  it('returns the id it was given', async () => {
    const file = await toolFile('def run():\n    return "u12345"\n')
    const resolved = await resolveIdentity({ interpreter: interpreter(), file })
    expect(resolved.principal).toEqual({ id: 'u12345', displayName: 'u12345' })
  })

  /**
   * The case that made the marker necessary.
   *
   * Internal libraries are frequently chatty on import — a licence notice, a deprecation, a
   * connection log. Reading "the output" would key the whole configuration directory to that
   * line, and it would look like it had worked.
   */
  it('is not confused by a library that prints on import', async () => {
    const file = await toolFile(
      'print("corp-sdk 4.2 initialised")\nimport sys\nsys.stderr.write("warning: deprecated\\n")\n\ndef run():\n    print("looking up user")\n    return "u98765"\n',
    )
    const resolved = await resolveIdentity({ interpreter: interpreter(), file })
    expect(resolved.principal?.id).toBe('u98765')
  })

  it('trims whatever whitespace comes back', async () => {
    const file = await toolFile('def run():\n    return "  u1  "\n')
    expect((await resolveIdentity({ interpreter: interpreter(), file })).principal?.id).toBe('u1')
  })

  /*
   * `str(None)` is `"None"`. A function that fell through its branches would otherwise key every
   * affected person's configuration to the same word — silently, and identically, which is worse
   * than failing.
   */
  it('refuses None rather than turning it into a user called None', async () => {
    const file = await toolFile('def run():\n    return None\n')
    const resolved = await resolveIdentity({ interpreter: interpreter(), file })
    expect(resolved.principal).toBeUndefined()
    expect(resolved.problem).toContain('None')
  })

  it('refuses an empty string, which is a directory name of nothing', async () => {
    const file = await toolFile('def run():\n    return "   "\n')
    expect((await resolveIdentity({ interpreter: interpreter(), file })).principal).toBeUndefined()
  })

  it('refuses a number, rather than quietly stringifying it', async () => {
    const file = await toolFile('def run():\n    return 42\n')
    const resolved = await resolveIdentity({ interpreter: interpreter(), file })
    expect(resolved.problem).toContain('number')
  })

  /** The traceback, not a summary: the person reading this wrote the function. */
  it('hands back the traceback when the import fails', async () => {
    const file = await toolFile(
      'import corp_sdk_that_is_not_installed\n\ndef run():\n    return "u1"\n',
    )
    const resolved = await resolveIdentity({ interpreter: interpreter(), file })
    expect(resolved.principal).toBeUndefined()
    expect(resolved.problem).toContain('ModuleNotFoundError')
  })

  it('says so when there is no run() at all', async () => {
    const file = await toolFile('def whoami():\n    return "u1"\n')
    const resolved = await resolveIdentity({ interpreter: interpreter(), file })
    expect(resolved.problem).toContain('AttributeError')
  })

  /** A function reaching something unreachable must not hold the server's startup for ever. */
  it('gives up on a function that hangs', async () => {
    const file = await toolFile('import time\n\ndef run():\n    time.sleep(30)\n    return "u1"\n')
    const resolved = await resolveIdentity({ interpreter: interpreter(), file, timeoutMs: 1500 })
    expect(resolved.principal).toBeUndefined()
    expect(resolved.problem).toContain('did not finish')
  }, 20_000)

  it('says so when the interpreter itself cannot be run', async () => {
    const file = await toolFile('def run():\n    return "u1"\n')
    const resolved = await resolveIdentity({ interpreter: 'no-such-python-anywhere', file })
    expect(resolved.principal).toBeUndefined()
    expect(resolved.problem).toBeDefined()
  })
})
