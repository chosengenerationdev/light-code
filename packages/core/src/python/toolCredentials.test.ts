import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Logger } from '../logging/logger.js'
import { redact } from '../logging/redact.js'
import type { SecretStore } from '../platform/secrets.js'
import { FileMachineApprovals } from './machineApprovals.js'
import { approveTool, hashSource, loadRegistries } from './registry.js'
import { declaredCredentials, readToolCredential } from './toolCredentials.js'
import { adaptPythonTool } from './tools.js'
import { detectBareInterpreter } from './uv.js'
import { PythonWorker } from './worker.js'
import { PYTHON_WORKER_SOURCE } from './workerSource.js'

/**
 * Fire Code: Python tools reading saved credentials, and identical tools reviewed once per machine.
 * The worker half runs against a real interpreter, because the channel is what could break.
 */

const logger = new Logger({ level: 'error', sink: () => {} })
let dir: string

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lc-cred-')))
})

afterEach(async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
})

class MemorySecrets implements SecretStore {
  constructor(private readonly values: Record<string, string>) {}
  async get(key: string): Promise<string | undefined> {
    return this.values[key]
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async clear(): Promise<void> {}
  backendName(): string {
    return 'memory'
  }
}

const credentials = async () => [
  { id: 'ldap1', label: 'Corp LDAP', kind: 'login' as const },
  { id: 'jira1', label: 'Jira token', kind: 'secret' as const },
]
const secrets = new MemorySecrets({
  'credential:ldap1#username': 'ann',
  'credential:ldap1#password': 'hunter2-long',
  'credential:jira1#value': 'jira-secret-token',
})

describe('what a tool declares', () => {
  it('reads the module-level list, quoted either way, and nothing else', () => {
    expect(declaredCredentials('__credentials__ = ["Corp LDAP", \'Jira token\']\n')).toEqual(['Corp LDAP', 'Jira token'])
    expect(declaredCredentials('__credentials__: list[str] = (\n    "A",\n    "B",\n)\n')).toEqual(['A', 'B'])
    expect(declaredCredentials('def run():\n    __credentials__ = ["Hidden"]\n')).toEqual([])
    expect(declaredCredentials('x = 1\n')).toEqual([])
  })
})

describe('giving a tool a saved credential', () => {
  const tool = async (source: string) => {
    const filePath = path.join(dir, 'reports.py')
    await fs.writeFile(filePath, source, 'utf8')
    return { filePath, hash: hashSource(source) }
  }
  const ask = (name: string, found: { filePath: string; hash: string } | undefined, caller = 'reports') =>
    readToolCredential({ name, caller, findTool: () => found, credentials, secrets })

  it('gives a declared secret, and a login as username and password', async () => {
    const t = await tool('__credentials__ = ["Corp LDAP", "jira token"]\n')
    expect(await ask('Jira token', t)).toBe('jira-secret-token')
    expect(await ask('corp ldap', t)).toEqual({ username: 'ann', password: 'hunter2-long' })
  })

  it('refuses what the tool did not declare, and says how to declare it', async () => {
    const t = await tool('__credentials__ = ["Jira token"]\n')
    await expect(ask('Corp LDAP', t)).rejects.toThrow(/did not declare "Corp LDAP".*__credentials__/)
  })

  it('refuses a tool that changed since it was approved', async () => {
    const t = await tool('__credentials__ = ["Jira token"]\n')
    await fs.writeFile(t.filePath, '__credentials__ = ["Jira token"]\nimport os\n', 'utf8')
    await expect(ask('Jira token', t)).rejects.toThrow(/changed since it was approved/)
  })

  it('refuses anything that is not a loaded tool, and an unknown credential', async () => {
    await expect(ask('Jira token', undefined, '')).rejects.toThrow(/Only an approved Python tool/)
    const t = await tool('__credentials__ = ["Nope"]\n')
    await expect(ask('Nope', t)).rejects.toThrow(/no saved credential called "Nope"/)
  })
})

describe('identical tools reviewed once per machine', () => {
  const SOURCE = '"""Shared."""\n\n\ndef run() -> str:\n    return "ok"\n'
  const described = { name: 'shared', description: 'Shared.', schema: { type: 'object', properties: {} } }
  const worker = { describe: async () => described } as unknown as PythonWorker

  it('adopts an approval made in another codebase for the same bytes only', async () => {
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    const c = path.join(dir, 'c')
    for (const folder of [a, b, c]) await fs.mkdir(folder)
    await fs.writeFile(path.join(a, 'shared.py'), SOURCE)
    await fs.writeFile(path.join(b, 'shared.py'), SOURCE)
    await fs.writeFile(path.join(c, 'shared.py'), SOURCE.replace('"ok"', '"different"'))
    const ledger = new FileMachineApprovals(path.join(dir, 'approved-tools.json'))

    // Nothing approved anywhere yet: B asks.
    expect((await loadRegistries([b], worker, logger, undefined, ledger)).issues.map((i) => i.kind)).toEqual(['unapproved'])

    // Approved in A; A's load records it for the machine.
    await approveTool(a, 'shared', SOURCE, described)
    await loadRegistries([a], worker, logger, undefined, ledger)

    const inB = await loadRegistries([b], worker, logger, undefined, ledger)
    expect(inB.tools.map((t) => t.name)).toEqual(['shared'])
    expect(inB.approvedElsewhere).toEqual(['shared'])
    // Pinned in B's own registry, so it no longer depends on the list.
    expect((await loadRegistries([b], worker, logger)).tools.map((t) => t.name)).toEqual(['shared'])

    // One different byte: a different tool, still asked about.
    expect((await loadRegistries([c], worker, logger, undefined, ledger)).issues.map((i) => i.kind)).toEqual(['unapproved'])
  })

  it('never overrides a decline', async () => {
    await fs.writeFile(path.join(dir, 'shared.py'), SOURCE)
    const ledger = new FileMachineApprovals(path.join(dir, 'approved-tools.json'))
    await ledger.add([{ hash: hashSource(SOURCE), name: 'shared' }])
    const loaded = await loadRegistries([dir], worker, logger, { shared: hashSource(SOURCE) }, ledger)
    expect(loaded.tools).toEqual([])
    expect(loaded.issues.map((i) => i.kind)).toEqual(['declined'])
  })
})

const python = await detectBareInterpreter()
const describeIfPython = python === undefined ? describe.skip : describe

describeIfPython('a real Python tool reading a credential', () => {
  it('gets the value over the worker channel, and the model never sees it', async () => {
    await fs.writeFile(path.join(dir, 'worker.py'), PYTHON_WORKER_SOURCE, 'utf8')
    const source = [
      'import light_code',
      '',
      '__credentials__ = ["Jira token"]',
      '',
      'def run() -> str:',
      '    token = light_code.credential("Jira token")',
      '    print("debug:", token)',
      '    return f"length {len(token)}, value {token}"',
      '',
    ].join('\n')
    const filePath = path.join(dir, 'reports.py')
    await fs.writeFile(filePath, source, 'utf8')
    const revealed = new Set<string>()
    const worker = new PythonWorker({
      pythonPath: (python as { path: string }).path,
      workerScript: path.join(dir, 'worker.py'),
      cwd: dir,
      env: { ...process.env },
      logger,
      timeoutMs: 20_000,
      readCredential: async (name, caller) => {
        const value = await readToolCredential({ name, caller, findTool: () => ({ filePath, hash: hashSource(source) }), credentials, secrets })
        if (typeof value === 'string') revealed.add(value)
        return value
      },
    })
    try {
      const tool = adaptPythonTool(
        { name: 'reports', description: '', schema: {}, filePath },
        { worker, redact: (text) => redact(text, [...revealed]) },
      )
      const result = await tool.execute({}, {} as never)
      expect(result.isError).toBeUndefined()
      expect(result.content).toContain('length 17')
      expect(result.content).not.toContain('jira-secret-token')
      expect(result.content).toContain('[REDACTED]')
    } finally {
      worker.dispose()
    }
  })
})
