import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { SecretStore } from '../platform/secrets.js'
import { pythonEnvEntries, pythonEnvSecretRef, resolvePythonEnv } from './env.js'
import { detectBareInterpreter, minimalPythonEnv } from './uv.js'
import { PythonWorker } from './worker.js'
import { PYTHON_WORKER_SOURCE } from './workerSource.js'

/**
 * Declared variables reaching a real Python process, and nothing else reaching it with them.
 *
 * Against a real interpreter rather than a mock, because the question is what `os.environ` holds
 * inside the child — which is decided by `spawn`, not by anything this repository can assert about
 * itself. The allowlist half is the reason it is worth the second and a half: a feature whose job
 * is to put variables into that environment is exactly the one that could quietly widen it.
 */
const python = await detectBareInterpreter()
const withPython = python === undefined ? describe.skip : describe

const store: SecretStore = {
  get: async (key) => (key === pythonEnvSecretRef('API_TOKEN') ? 'tok-real' : undefined),
  set: async () => {},
  delete: async () => {},
  clear: async () => {},
  backendName: () => 'fake',
}

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

withPython('a real Python tool', () => {
  it('is given the declared variables, including one held as a secret', async () => {
    // Planted so the allowlist assertion below cannot pass by the variable simply not existing.
    process.env.OPENAI_API_KEY = 'sk-planted-should-not-be-visible'
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-env-'))
    await fs.writeFile(path.join(dir, 'worker.py'), PYTHON_WORKER_SOURCE, 'utf8')
    const tool = path.join(dir, 'peek.py')
    await fs.writeFile(
      tool,
      'import os\n\n\ndef run() -> dict:\n    """Reports what the tool can see."""\n' +
        '    return {k: os.environ.get(k) for k in ("API_HOST", "API_TOKEN", "OPENAI_API_KEY")}\n',
      'utf8',
    )

    const resolved = await resolvePythonEnv(
      pythonEnvEntries({ API_HOST: 'https://internal', API_TOKEN: { secret: true } }),
      store,
    )
    const worker = new PythonWorker({
      pythonPath: (python as { path: string }).path,
      workerScript: path.join(dir, 'worker.py'),
      cwd: dir,
      // Composed exactly as `PythonManager.childEnv` composes it; a test in `env.test.ts` reads
      // `manager.ts` and fails if any spawn site stops going through that one owner.
      env: minimalPythonEnv(resolved.env),
      logger: silent as never,
      timeoutMs: 20_000,
    })
    cleanup = () => {
      worker.dispose()
      delete process.env.OPENAI_API_KEY
    }

    const call = await worker.call('peek', tool, {}, { reload: true })

    expect(call.result).toEqual({
      API_HOST: 'https://internal',
      API_TOKEN: 'tok-real',
      // §13: declaring variables must not become a way for model-authored code to read the keys
      // this environment has always withheld.
      OPENAI_API_KEY: null,
    })
  }, 40_000)
})
