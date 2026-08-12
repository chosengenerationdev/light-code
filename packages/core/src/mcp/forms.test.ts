import { describe, expect, it } from 'vitest'
import {
  BLANK_MCP_FORM,
  fromMcpServerForm,
  toMcpServerForm,
  validateMcpServerForm,
  venvPython,
} from './forms.js'

describe('venvPython', () => {
  it('uses the Scripts layout on Windows and bin elsewhere', () => {
    expect(venvPython('C:\\work\\mcp\\.venv', 'win32')).toBe('C:\\work\\mcp\\.venv\\Scripts\\python.exe')
    expect(venvPython('/home/me/mcp/.venv', 'posix')).toBe('/home/me/mcp/.venv/bin/python')
  })

  it('tolerates a trailing separator', () => {
    expect(venvPython('C:\\work\\.venv\\', 'win32')).toBe('C:\\work\\.venv\\Scripts\\python.exe')
    expect(venvPython('/home/me/.venv/', 'posix')).toBe('/home/me/.venv/bin/python')
  })
})

describe('fromMcpServerForm', () => {
  it('builds a venv python server', () => {
    const config = fromMcpServerForm(
      { ...BLANK_MCP_FORM, kind: 'python', venvDir: 'C:\\work\\.venv', script: 'C:\\work\\server.py' },
      'win32',
    )

    expect(config).toEqual({ command: 'C:\\work\\.venv\\Scripts\\python.exe', args: ['C:\\work\\server.py'] })
  })

  /**
   * Without `-y`, npx prompts before installing a package it has not seen. Nothing is
   * attached to answer it, so the server simply never starts and the failure looks like a
   * hang rather than a question.
   */
  it('always passes -y to npx', () => {
    const config = fromMcpServerForm(
      { ...BLANK_MCP_FORM, kind: 'npx', packageName: '@modelcontextprotocol/server-filesystem', args: ['/data'] },
      'posix',
    )

    expect(config).toEqual({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'] })
  })

  it('omits empty optional fields rather than writing blanks', () => {
    const config = fromMcpServerForm({ ...BLANK_MCP_FORM, kind: 'custom', command: 'server' }, 'posix')
    expect(config).toEqual({ command: 'server' })
  })

  it('drops blank argument lines, which are just leftover UI rows', () => {
    const config = fromMcpServerForm(
      { ...BLANK_MCP_FORM, kind: 'custom', command: 'server', args: ['--port', '', '  ', '8080'] },
      'posix',
    )

    expect(config).toEqual({ command: 'server', args: ['--port', '8080'] })
  })

  /**
   * `disabled` and `disabledTools` are set from the server list, not this form. Rebuilding
   * the entry without them would re-enable a server the user switched off and unhide every
   * tool they had hidden — as a side effect of editing an unrelated field.
   */
  it('preserves enablement state that the form does not own', () => {
    const config = fromMcpServerForm({ ...BLANK_MCP_FORM, kind: 'custom', command: 'server' }, 'posix', {
      command: 'old',
      disabled: true,
      disabledTools: ['dangerous_tool'],
    })

    expect(config).toMatchObject({ command: 'server', disabled: true, disabledTools: ['dangerous_tool'] })
  })
})

describe('toMcpServerForm', () => {
  it('round-trips a venv python server', () => {
    const original = { command: 'C:\\work\\.venv\\Scripts\\python.exe', args: ['C:\\work\\server.py', '--verbose'] }
    const form = toMcpServerForm(original)

    expect(form.kind).toBe('python')
    expect(form.venvDir).toBe('C:\\work\\.venv')
    expect(form.script).toBe('C:\\work\\server.py')
    expect(form.args).toEqual(['--verbose'])
    expect(fromMcpServerForm(form, 'win32')).toEqual(original)
  })

  /**
   * `interpreter` is what runs, so anything python-shaped round-trips exactly even when the
   * venv folder cannot be recovered from it. Only the convenience field is left blank.
   */
  it('keeps a system python exactly as stored, with no venv folder', () => {
    const original = { command: 'python3', args: ['server.py'] }
    const form = toMcpServerForm(original)

    expect(form.kind).toBe('python')
    expect(form.interpreter).toBe('python3')
    expect(form.venvDir).toBe('')
    expect(fromMcpServerForm(form, 'posix')).toEqual(original)
  })

  /** An unrecognised layout must not be rewritten into the conventional one on save. */
  it('does not rewrite an interpreter path it cannot classify', () => {
    const original = { command: '/opt/conda/envs/mcp/bin/python3.11', args: ['/srv/server.py'] }
    expect(fromMcpServerForm(toMcpServerForm(original), 'win32')).toEqual(original)
  })

  it('round-trips a posix venv python server', () => {
    const original = { command: '/srv/mcp/.venv/bin/python', args: ['/srv/mcp/main.py'] }
    const form = toMcpServerForm(original)

    expect(form.kind).toBe('python')
    expect(form.venvDir).toBe('/srv/mcp/.venv')
    expect(fromMcpServerForm(form, 'posix')).toEqual(original)
  })

  it('round-trips an npx server without duplicating -y', () => {
    const original = { command: 'npx', args: ['-y', '@scope/pkg', '--root', '/data'] }
    const form = toMcpServerForm(original)

    expect(form.kind).toBe('npx')
    expect(form.packageName).toBe('@scope/pkg')
    expect(form.args).toEqual(['--root', '/data'])
    expect(fromMcpServerForm(form, 'posix')).toEqual(original)
  })

  it('reads an http server', () => {
    const form = toMcpServerForm({ url: 'https://mcp.internal/sse', headers: { 'X-Key': '${secret:K}' } })

    expect(form.kind).toBe('http')
    expect(form.url).toBe('https://mcp.internal/sse')
    expect(form.headers).toEqual({ 'X-Key': '${secret:K}' })
  })

  /**
   * The important property of the detector. Anything it cannot classify confidently shows
   * the raw command instead — guessing wrong would silently rewrite a working server on the
   * next save, which is a far worse outcome than an unfriendly form.
   */
  describe('falls back to custom rather than guessing', () => {
    it('for a python interpreter with no script argument', () => {
      expect(toMcpServerForm({ command: '/srv/.venv/bin/python' }).kind).toBe('custom')
    })

    it('for npx carrying flags it did not put there', () => {
      const original = { command: 'npx', args: ['--node-options=--inspect', '@scope/pkg'] }
      const form = toMcpServerForm(original)

      expect(form.kind).toBe('custom')
      expect(fromMcpServerForm(form, 'posix')).toEqual(original)
    })

    it('for an ordinary executable', () => {
      expect(toMcpServerForm({ command: 'docker', args: ['run', 'image'] }).kind).toBe('custom')
    })
  })

  it('keeps env and cwd across a round trip', () => {
    const original = { command: 'server', env: { TOKEN: '${secret:TOKEN}' }, cwd: '/srv' }
    expect(fromMcpServerForm(toMcpServerForm(original), 'posix')).toEqual(original)
  })
})

describe('validateMcpServerForm', () => {
  it('accepts a complete python form', () => {
    const errors = validateMcpServerForm('logs', { ...BLANK_MCP_FORM, venvDir: '/v', script: 's.py' })
    expect(errors).toEqual({})
  })

  /** The name prefixes every tool (`logs__search`), so a space produces an uncallable name. */
  it('rejects a name that would produce a broken tool prefix', () => {
    expect(validateMcpServerForm('my server', BLANK_MCP_FORM).name).toMatch(/prefixes every tool/)
    expect(validateMcpServerForm('', BLANK_MCP_FORM).name).toBeDefined()
    expect(validateMcpServerForm('my_server-2.1', { ...BLANK_MCP_FORM, venvDir: 'v', script: 's' }).name).toBeUndefined()
  })

  it('names the missing field per kind', () => {
    expect(validateMcpServerForm('x', { ...BLANK_MCP_FORM, kind: 'python' })).toMatchObject({
      venvDir: expect.any(String),
      script: expect.any(String),
    })
    expect(validateMcpServerForm('x', { ...BLANK_MCP_FORM, kind: 'npx' }).packageName).toBeDefined()
    expect(validateMcpServerForm('x', { ...BLANK_MCP_FORM, kind: 'custom' }).command).toBeDefined()
    expect(validateMcpServerForm('x', { ...BLANK_MCP_FORM, kind: 'http', url: 'not a url' }).url).toMatch(/valid URL/)
  })
})
