import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findFireCodeHelper } from '../platform/node/fireHelper.js'
import { createFastFsTools, fastFsGuidance } from './fastFs.js'

/**
 * Reported: the Rust tools were registered and the model still did not use them until reminded. The
 * prompt now says which job each is for; these keep that true as tools are added.
 */
describe('the fast file tools are introduced to the model', () => {
  it('names every one of them', () => {
    const guidance = fastFsGuidance()
    for (const tool of createFastFsTools('fire-fs.exe')) expect(guidance, tool.name).toContain(tool.name)
  })

  it('is put into the prompt whenever the host supplies the helper', async () => {
    const bridge = await fs.readFile(path.join(import.meta.dirname, '..', 'host', 'bridge.ts'), 'utf8')
    expect(bridge).toMatch(/if \(services\.fastFs !== undefined\) parts\.push\(fastFsGuidance\(fastFsOps\)\)/)
  })

  it('offers only what an older helper can do, and says nothing about the rest', () => {
    const old = new Set(['find', 'readMany', 'inspect', 'table'])
    const names = createFastFsTools('fire-fs.exe', old).map((tool) => tool.name)
    expect(names).toEqual(['find_files', 'read_many_files', 'big_file', 'query_table'])
    expect(fastFsGuidance(old)).not.toContain('query_sqlite')
    expect(fastFsGuidance()).toContain('query_sqlite')
  })
})

describe("Fire Code's helper, found from another host", () => {
  it('reads where Fire Code recorded it, and refuses anything that is not fire-fs.exe', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-helper-'))
    const exe = path.join(dir, 'fire-fs.exe')
    await fs.writeFile(exe, '')
    await fs.writeFile(path.join(dir, 'helper.json'), JSON.stringify({ fireFs: exe }))
    expect(findFireCodeHelper({ FIRE_CODE_HOME: dir }, 'win32')).toBe(exe)
    await fs.writeFile(path.join(dir, 'helper.json'), JSON.stringify({ fireFs: path.join(dir, 'other.exe') }))
    expect(findFireCodeHelper({ FIRE_CODE_HOME: dir }, 'win32')).toBeUndefined()
    expect(findFireCodeHelper({ FIRE_CODE_HOME: dir }, 'linux')).toBeUndefined()
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('library results', () => {
  it('shows a list of lists as a table, and numbers and strings as themselves', async () => {
    const { renderValue } = await import('./pythonLibrary.js')
    expect(renderValue(101.25)).toBe('101.25')
    expect(renderValue('USD')).toBe('USD')
    const table = renderValue([['tenor', 'rate'], ['1Y', 0.031], ['2Y', 0.034]])
    expect(table).toContain('| tenor | rate |')
    expect(table).toContain('| 2Y | 0.034 |')
    expect(renderValue([[1, 2], [3, 4]])).toContain('| 1 | 2 |')
    expect(renderValue({ a: 1 })).toContain('"a": 1')
  })
})
