import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { FileReplaceError, replaceFile } from './replaceFile.js'

/*
 * Reported from real use: saving sometimes failed with EPERM naming config.json. On Windows a
 * rename over a file another program has open is refused for that moment — another window, a
 * watcher, antivirus, OneDrive — so it is retried rather than reported.
 */
const busy = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
const noSleep = async () => {}

describe('replacing a file', () => {
  it('rides out a moment of EPERM and then succeeds', async () => {
    let tries = 0
    await replaceFile('a', 'b', {
      sleep: noSleep,
      rename: async () => {
        tries += 1
        if (tries < 4) throw busy('EPERM')
      },
    })
    expect(tries).toBe(4)
  })

  it('gives up with a sentence naming the file and the usual causes, and removes the temporary file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-replace-'))
    const temp = path.join(dir, 'config.json.tmp')
    await fs.writeFile(temp, '{}')
    const error = await replaceFile(temp, path.join(dir, 'config.json'), {
      sleep: noSleep,
      rename: async () => {
        throw busy('EBUSY')
      },
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FileReplaceError)
    expect(String((error as Error).message)).toMatch(/Could not save config\.json .*another VS Code window.*intact/)
    await expect(fs.access(temp)).rejects.toThrow()
  })

  it('does not wait on a failure that waiting cannot fix', async () => {
    let tries = 0
    await expect(
      replaceFile('a', 'b', {
        sleep: noSleep,
        rename: async () => {
          tries += 1
          throw busy('ENOSPC')
        },
      }),
    ).rejects.toThrow(/ENOSPC/)
    expect(tries).toBe(1)
  })

  it('replaces a real file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-replace-'))
    await fs.writeFile(path.join(dir, 'new'), 'new')
    await fs.writeFile(path.join(dir, 'live'), 'old')
    await replaceFile(path.join(dir, 'new'), path.join(dir, 'live'))
    expect(await fs.readFile(path.join(dir, 'live'), 'utf8')).toBe('new')
  })
})
