import fs from 'node:fs/promises'
import url from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Sharing through a bucket only works if the bucket is actually read.
 *
 * Reported as "search team skills is dead" and "will newly created tool docs be sent to the team":
 * a new skill or tool was uploaded the moment it was written, and then reached nobody until each
 * colleague pressed Sync — while the schema's own comment said an enabled folder is read on every
 * panel open. And a synced tool was never noticed at all until something else reloaded the Python
 * registry, so it neither appeared for approval nor reached the documentation index.
 *
 * Reads `bridge.ts` rather than running it, for `config/retrieval.test.ts`'s reason: the defect was
 * a call that never happened, which no test of the called function can see.
 */
async function bridgeCode(): Promise<string> {
  const source = await fs.readFile(url.fileURLToPath(new URL('../host/bridge.ts', import.meta.url)), 'utf8')
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('bucket folders are brought down on their own', () => {
  it('starts when the bridge is built, and stops when it is disposed', async () => {
    const code = await bridgeCode()
    expect(code).toMatch(/startScheduleTimer\(\)\s*\n\s*startMirrorSync\(\)/)
    expect(code).toContain('clearInterval(mirrorSyncTimer)')
    expect(code).toContain('clearTimeout(mirrorSyncStartup)')
  })

  it('only ever reads folders that are enabled, so a fresh install contacts nothing', async () => {
    const code = await bridgeCode()
    const start = code.slice(code.indexOf('function startMirrorSync'))
    expect(start.slice(0, 900)).toContain('mirror.enabled === true')
  })

  it('reloads Python tools after a tools sync, so a colleague’s tool appears for approval', async () => {
    const code = await bridgeCode()
    const sync = code.slice(code.indexOf('async function syncMirrorsOf'))
    const body = sync.slice(0, sync.indexOf('\n  }\n'))
    expect(body).toContain("if (kind === 'tools')")
    expect(body).toContain('await python.refresh()')
    expect(body).toContain('await postPython()')
  })
})
