import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { decideFromPolicy } from '../approval/policy.js'
import type { ApprovalRequest } from '../approval/types.js'
import { declaresAlwaysAsk } from './declaredCredentials.js'
import { detectBareInterpreter, minimalPythonEnv } from './uv.js'
import { PythonWorker } from './worker.js'
import { PYTHON_WORKER_SOURCE } from './workerSource.js'

/*
 * Two controls on Python tools, asked for together: a tool that must always ask before it runs, for
 * everyone who has it; and functions no tool may use at all.
 */

describe('a tool that always asks', () => {
  it('is declared in the tool file, and only at module level', () => {
    expect(declaresAlwaysAsk('"""Doc."""\n__always_ask__ = True\n\ndef run(): pass\n')).toBe(true)
    expect(declaresAlwaysAsk('__always_ask__: bool = True\n')).toBe(true)
    expect(declaresAlwaysAsk('__always_ask__ = False\n')).toBe(false)
    expect(declaresAlwaysAsk('def run():\n    __always_ask__ = True\n')).toBe(false)
    expect(declaresAlwaysAsk('# __always_ask__ = True\n')).toBe(false)
  })

  it('asks every time, whatever is auto-approved or always-allowed', () => {
    const request: ApprovalRequest = { id: '1', toolName: 'py__report', group: 'command', preview: { kind: 'text', text: 'run' }, alwaysAsk: true }
    const approvals = { autoApprove: { command: true }, allowedTools: ['py__report'] } as never
    expect(decideFromPolicy(request, approvals)).toBeUndefined()
    // The same tool without the declaration is covered by the grants as before.
    expect(decideFromPolicy({ ...request, alwaysAsk: false }, approvals)).toBe('approve')
  })

  it('reaches the approval request from the tool, and the prompt offers no "Always allow"', () => {
    const loop = fs.readFileSync(path.join(__dirname, '..', 'agent', 'loop.ts'), 'utf8')
    expect(loop).toContain("...(tool.alwaysAsk === true ? { alwaysAsk: true } : {}),")
    const gate = fs.readFileSync(path.join(__dirname, '..', 'host', 'approvalGate.ts'), 'utf8')
    expect(gate).toContain('request.alwaysAsk === true ||')
  })
})

const python = await detectBareInterpreter()
const withPython = python === undefined ? describe.skip : describe
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

withPython('banned calls, in the real worker', () => {
  it('refuses a tool that uses one through an alias, naming the line, and runs one that does not', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lc-banned-'))
    await fsp.writeFile(path.join(dir, 'worker.py'), PYTHON_WORKER_SOURCE, 'utf8')
    const bad = path.join(dir, 'bad.py')
    await fsp.writeFile(bad, '"""Bad."""\nimport os as o\n\n\ndef run() -> int:\n    return o.system("echo hi")\n', 'utf8')
    const good = path.join(dir, 'good.py')
    await fsp.writeFile(good, '"""Good."""\nimport os\n\n\ndef run() -> str:\n    # os.system is only mentioned here\n    return os.path.join("a", "b")\n', 'utf8')
    const worker = new PythonWorker({
      pythonPath: (python as { path: string }).path,
      workerScript: path.join(dir, 'worker.py'),
      cwd: dir,
      // As PythonManager.childEnv composes it: the list goes last, after anything declared.
      env: minimalPythonEnv({ LIGHT_CODE_BANNED_CALLS: JSON.stringify(['os.system', 'subprocess']) }),
      logger: silent as never,
      timeoutMs: 20_000,
    })
    cleanup = () => worker.dispose()
    await expect(worker.call('bad', bad, {}, { reload: true })).rejects.toThrow(/banned.*line 6: os\.system/s)
    await expect(worker.validate('bad', bad)).rejects.toThrow(/banned/)
    expect((await worker.call('good', good, {}, { reload: true })).result).toMatch(/a.b/)
  }, 40_000)

  it('is set last in the worker environment, where python.env cannot replace it', () => {
    const manager = fs.readFileSync(path.join(__dirname, 'manager.ts'), 'utf8')
    const env = manager.slice(manager.indexOf('private async childEnv('))
    expect(env.indexOf('...resolved.env,')).toBeLessThan(env.indexOf('LIGHT_CODE_BANNED_CALLS: JSON.stringify(this.bannedCalls)'))
  })
})
