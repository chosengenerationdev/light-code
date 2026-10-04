import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NodeFileSystem } from '../platform/node/filesystem.js'
import { parseMentions, resolveMentions, siblingMention } from './mentions.js'

/** `@payments-api:src/app.py` - a file in another codebase open in Fire Code. */
describe('mentioning another codebase', () => {
  let base: string
  let here: string
  let other: string
  beforeAll(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lc-siblings-')))
    here = path.join(base, 'here')
    other = path.join(base, 'payments')
    await fs.mkdir(path.join(other, 'src'), { recursive: true })
    await fs.mkdir(here)
    await fs.writeFile(path.join(other, 'src', 'app.py'), 'print("pay")\n')
    await fs.writeFile(path.join(base, 'secret.txt'), 'outside both')
  })
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true })
  })
  const siblings = () => [{ name: 'payments-api', path: other }]

  it('reads the name only when it is one of the codebases, so a drive letter stays a path', () => {
    expect(siblingMention('payments-api:src/app.py', siblings())).toMatchObject({ name: 'payments-api', rest: 'src/app.py' })
    expect(siblingMention('Payments-API:src', siblings())?.name).toBe('payments-api')
    expect(siblingMention('C:\\work\\x.py', siblings())).toBeUndefined()
    expect(siblingMention('unknown:src/a.py', siblings())).toBeUndefined()
  })

  it('keeps the colon of a bare codebase mention, and drops sentence punctuation otherwise', () => {
    expect(parseMentions('see @payments-api: and @src/a.py, then @notes.')).toEqual(['payments-api:', 'src/a.py', 'notes'])
  })

  it('attaches the file, confined to that codebase', async () => {
    const [file, listing, escape] = await resolveMentions(
      'compare @payments-api:src/app.py with @payments-api: and @payments-api:../secret.txt',
      { fs: new NodeFileSystem(), workspaceRoot: here, siblings: siblings() },
    )
    expect(file).toMatchObject({ kind: 'file', relativePath: 'payments-api:src/app.py', content: 'print("pay")\n' })
    expect(listing).toMatchObject({ kind: 'directory', content: 'src/' })
    expect(escape?.kind).toBe('error')
  })
})
