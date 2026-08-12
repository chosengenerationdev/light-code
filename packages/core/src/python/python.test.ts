import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Logger } from '../logging/logger.js'
import { approveTool, describeIssue, forgetTool, hashSource, isValidToolName, loadRegistry } from './registry.js'
import { minimalPythonEnv, venvPythonPath } from './uv.js'

const logger = new Logger({ level: 'error', sink: () => {} })

describe('minimalPythonEnv', () => {
  /**
   * The test the plan asks for by name. Network egress from tool code cannot be controlled
   * without a real sandbox, so the one thing that *is* controllable is which secrets are in
   * scope when it runs. An allowlist, because a denylist has to be updated for every new
   * provider and fails silently when it is not.
   */
  it('contains no key-shaped values from the parent environment', () => {
    const planted = {
      OPENAI_API_KEY: 'sk-live-planted-value',
      ANTHROPIC_API_KEY: 'sk-ant-planted-value',
      LIGHT_CODE_GATEWAY_TOKEN: 'Bearer planted-value',
      AWS_SECRET_ACCESS_KEY: 'planted-value',
      GITHUB_TOKEN: 'ghp_plantedvalue',
    }
    Object.assign(process.env, planted)
    try {
      const env = minimalPythonEnv()
      const serialised = JSON.stringify(env)

      for (const key of Object.keys(planted)) expect(env[key]).toBeUndefined()
      expect(serialised).not.toContain('planted-value')
      expect(serialised).not.toContain('plantedvalue')
    } finally {
      for (const key of Object.keys(planted)) delete process.env[key]
    }
  })

  it('keeps what Python needs to run at all', () => {
    const env = minimalPythonEnv()
    // PATH under either casing — Windows reports `Path`.
    expect(env.PATH ?? env.Path).toBeDefined()
    expect(env.PYTHONUNBUFFERED).toBe('1')
    // __pycache__ would otherwise land in the user's workspace, which is checked into git.
    expect(env.PYTHONDONTWRITEBYTECODE).toBe('1')
  })

  it('carries extras the caller passes deliberately', () => {
    expect(minimalPythonEnv({ LIGHT_CODE_TOOLS_DIR: '/tools' }).LIGHT_CODE_TOOLS_DIR).toBe('/tools')
  })
})

describe('venvPythonPath', () => {
  it('uses the Scripts layout on Windows and bin elsewhere', () => {
    expect(venvPythonPath('/v', 'win32')).toBe(path.join('/v', 'Scripts', 'python.exe'))
    expect(venvPythonPath('/v', 'linux')).toBe(path.join('/v', 'bin', 'python'))
  })
})

describe('isValidToolName', () => {
  it('accepts a plain snake_case name', () => {
    expect(isValidToolName('count_lines')).toBe(true)
  })

  /** The name becomes a filename and a namespaced tool id, so both have to be safe. */
  it('rejects anything that could escape a path or break a tool id', () => {
    for (const name of ['../evil', 'has space', 'Upper', '9leading', 'has-dash', '', 'a'.repeat(70)]) {
      expect(isValidToolName(name)).toBe(false)
    }
  })
})

describe('hashSource', () => {
  /** A CRLF checkout must not invalidate every approval on the machine (§16). */
  it('ignores line-ending differences', () => {
    expect(hashSource('def run():\r\n    return 1\r\n')).toBe(hashSource('def run():\n    return 1\n'))
  })

  it('changes when the code changes', () => {
    expect(hashSource('return 1')).not.toBe(hashSource('return 2'))
  })
})

describe('loadRegistry', () => {
  let dir: string
  const described = { name: 'count_lines', description: 'Counts lines.', schema: { type: 'object' } }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-py-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const writeTool = (name: string, source: string): Promise<void> =>
    fs.writeFile(path.join(dir, `${name}.py`), source, 'utf8')

  it('loads a tool whose source still matches its approval', async () => {
    const source = 'def run():\n    return 1\n'
    await writeTool('count_lines', source)
    await approveTool(dir, 'count_lines', source, described)

    const loaded = await loadRegistry(dir, undefined, logger)
    expect(loaded.tools.map((tool) => tool.name)).toEqual(['count_lines'])
    expect(loaded.issues).toEqual([])
  })

  /**
   * The property the whole pin exists for. Everything else gates *calling* a tool; the body
   * here is model-authored, so an approval that survived an edit would be a persistent,
   * auto-approved code path nobody ever reviewed.
   */
  it('refuses a tool edited after approval, and says so', async () => {
    const source = 'def run():\n    return 1\n'
    await writeTool('count_lines', source)
    await approveTool(dir, 'count_lines', source, described)
    await writeTool('count_lines', 'import os\ndef run():\n    return os.environ\n')

    const loaded = await loadRegistry(dir, undefined, logger)
    expect(loaded.tools).toEqual([])
    expect(loaded.issues[0]?.kind).toBe('hash-mismatch')
    expect(describeIssue(loaded.issues[0]!)).toMatch(/changed since it was approved/)
  })

  /**
   * The tools directory sits inside the workspace so changes land in git and get reviewed
   * — which means a cloned repo can contain one. Presence on disk must never be enough.
   */
  it('does not load a .py file that was never approved', async () => {
    await writeTool('sneaky', 'def run():\n    return "from a cloned repo"\n')

    const loaded = await loadRegistry(dir, undefined, logger)
    expect(loaded.tools).toEqual([])
    expect(loaded.issues[0]?.kind).toBe('unapproved')
  })

  it('treats an unreadable registry as nothing approved rather than everything approved', async () => {
    const source = 'def run():\n    return 1\n'
    await writeTool('count_lines', source)
    await approveTool(dir, 'count_lines', source, described)
    await fs.writeFile(path.join(dir, '.registry.json'), '{ not json', 'utf8')

    const loaded = await loadRegistry(dir, undefined, logger)
    expect(loaded.tools).toEqual([])
    expect(loaded.issues[0]?.kind).toBe('unapproved')
  })

  it('rejects a file whose name could escape the tools directory', async () => {
    await fs.writeFile(path.join(dir, 'Bad-Name.py'), 'def run(): pass', 'utf8')
    const loaded = await loadRegistry(dir, undefined, logger)
    expect(loaded.issues[0]?.kind).toBe('invalid')
  })

  it('stops loading a tool once it is forgotten', async () => {
    const source = 'def run():\n    return 1\n'
    await writeTool('count_lines', source)
    await approveTool(dir, 'count_lines', source, described)
    await forgetTool(dir, 'count_lines')

    const loaded = await loadRegistry(dir, undefined, logger)
    expect(loaded.tools).toEqual([])
  })

  it('returns nothing at all when the tools directory does not exist', async () => {
    const loaded = await loadRegistry(path.join(dir, 'missing'), undefined, logger)
    expect(loaded).toEqual({ tools: [], issues: [] })
  })
})
