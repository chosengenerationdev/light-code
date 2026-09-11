import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectBareInterpreter } from './uv.js'
import { PythonWorker } from './worker.js'
import { PYTHON_CALL_DENIED, mayPythonToolCall } from './callPolicy.js'
import { PYTHON_WORKER_SOURCE } from './workerSource.js'

/**
 * One Python tool calling another, or an MCP tool.
 *
 * Requested directly. The transport is the interesting half: the worker is otherwise a strict
 * request/response loop, so a call going *up* the pipe while a tool is still running is the one
 * frame that is not an answer to something the host asked. That is worth exercising against a
 * real interpreter rather than a mock, because what could break — a reply read by the wrong
 * waiter, a deadlock, a frame the host treats as a response — is precisely what a mock would be
 * written not to do.
 */
let dir: string
let worker: PythonWorker | undefined

const python = await detectBareInterpreter()
const describeIfPython = python === undefined ? describe.skip : describe

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as ConstructorParameters<typeof PythonWorker>[0]['logger']

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-nested-'))
  await fs.writeFile(path.join(dir, 'worker.py'), PYTHON_WORKER_SOURCE, 'utf8')
})

afterEach(async () => {
  worker?.dispose()
  worker = undefined
  // Windows holds a directory open until the child has actually gone, so `rm` straight after
  // `dispose` fails with EBUSY. Retried rather than slept on a fixed guess.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
})

async function toolFile(name: string, body: string): Promise<string> {
  const file = path.join(dir, `${name}.py`)
  await fs.writeFile(file, body, 'utf8')
  return file
}

function start(callTool: ConstructorParameters<typeof PythonWorker>[0]['callTool']): PythonWorker {
  worker = new PythonWorker({
    pythonPath: (python as { path: string }).path,
    workerScript: path.join(dir, 'worker.py'),
    cwd: dir,
    env: { ...process.env },
    logger,
    timeoutMs: 20_000,
    ...(callTool === undefined ? {} : { callTool }),
  })
  return worker
}

describeIfPython('a Python tool calling another tool', () => {
  it('reaches the host and gets the answer back', async () => {
    const file = await toolFile(
      'caller',
      [
        'import light_code',
        '',
        'def run(x: int) -> str:',
        '    """Doubles via another tool."""',
        '    return light_code.call_tool("py__double", value=x)',
      ].join('\n'),
    )

    const asked: { name: string; args: Record<string, unknown>; caller: string }[] = []
    const instance = start(async (name, args, caller) => {
      asked.push({ name, args, caller })
      return `doubled ${String((args['value'] as number) * 2)}`
    })

    const result = await instance.call('caller', file, { x: 21 })
    expect(result.result).toBe('doubled 42')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.name).toBe('py__double')
    expect(asked[0]?.args).toEqual({ value: 21 })
    // Names who is asking, so an approval prompt can say so.
    expect(asked[0]?.caller).toBe('caller')
  })

  it('turns a refusal into an ordinary Python exception the tool can catch', async () => {
    const file = await toolFile(
      'guarded',
      [
        'import light_code',
        '',
        'def run() -> str:',
        '    """Handles a refusal."""',
        '    try:',
        '        light_code.call_tool("execute_command", command="rm -rf /")',
        '    except light_code.ToolError as error:',
        '        return f"refused: {error}"',
        '    return "it ran"',
      ].join('\n'),
    )

    const instance = start(async () => {
      throw new Error(PYTHON_CALL_DENIED)
    })

    const result = await instance.call('guarded', file, {})
    expect(String(result.result)).toContain('refused:')
    expect(String(result.result)).toContain('only call other Python tools')
  })

  it('says so when the session cannot make nested calls at all', async () => {
    // An unattended run: nobody is present to approve one, so `callTool` is absent.
    const file = await toolFile(
      'unattended',
      [
        'import light_code',
        '',
        'def run() -> str:',
        '    """Tries anyway."""',
        '    try:',
        '        light_code.call_tool("py__other")',
        '    except light_code.ToolError as error:',
        '        return str(error)',
        '    return "it ran"',
      ].join('\n'),
    )

    const instance = start(undefined)
    const result = await instance.call('unattended', file, {})
    expect(String(result.result)).toContain('nobody is present')
  })

  it('stops a tool that calls itself rather than filling the pipe', async () => {
    /*
     * Left unbounded, a tool calling itself is a loop that does not fail — it just consumes the
     * worker until the timeout, with nothing saying why.
     */
    const file = await toolFile(
      'recursive',
      [
        'import light_code',
        '',
        'def run(depth: int = 0) -> str:',
        '    """Calls itself."""',
        '    try:',
        '        return light_code.call_tool("py__recursive", depth=depth + 1)',
        '    except light_code.ToolError as error:',
        '        return str(error)',
      ].join('\n'),
    )

    let depth = 0
    const instance = start(async (_name, args) => {
      depth += 1
      // Re-enter the same tool, which is what a real registry would do.
      const nested = await instance.call('recursive', file, args)
      return nested.result
    })

    const result = await instance.call('recursive', file, { depth: 0 })
    expect(String(result.result)).toContain('almost certainly a loop')
    expect(depth).toBeLessThan(10)
  })

  it('still returns what the tool printed', async () => {
    // The nested frames share the stream with ordinary output; neither may swallow the other.
    const file = await toolFile(
      'chatty',
      [
        'import light_code',
        '',
        'def run() -> str:',
        '    """Prints and calls."""',
        '    print("before")',
        '    value = light_code.call_tool("py__other")',
        '    print("after")',
        '    return value',
      ].join('\n'),
    )

    const instance = start(async () => 'from the other tool')
    const result = await instance.call('chatty', file, {})
    expect(result.result).toBe('from the other tool')
    expect(result.stdout).toContain('before')
    expect(result.stdout).toContain('after')
  })
})

describe('what a Python tool may call', () => {
  it('allows other Python tools and MCP tools', () => {
    expect(mayPythonToolCall('py__other', 'command')).toBe(true)
    expect(mayPythonToolCall('filesystem__read_file', 'mcp')).toBe(true)
  })

  it('refuses every built-in, including ones added later', () => {
    /*
     * Denied by construction rather than by a list somebody has to remember to extend — which is
     * the direction this has to fail. A tool body is model-authored, so approving one must not
     * silently grant command execution, file writing, or the ability to author the next tool.
     */
    for (const name of ['execute_command', 'write_to_file', 'apply_diff', 'create_python_tool', 'write_skill']) {
      expect(mayPythonToolCall(name, 'command')).toBe(false)
      expect(mayPythonToolCall(name, 'edit')).toBe(false)
      expect(mayPythonToolCall(name, 'read')).toBe(false)
    }
  })
})
