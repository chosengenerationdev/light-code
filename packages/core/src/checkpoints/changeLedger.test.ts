import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ChangeLedger, RecordedChanges } from './changeLedger.js'

/** Two chats on one codebase, each its own process, sharing one ledger file. */
describe('the change ledger shared by chats', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-ledger-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("names the other chats that changed a file after this chat's checkpoint", async () => {
    const file = path.join(dir, 'changes.jsonl')
    const one = new ChangeLedger(file, 'Chat 1')
    const two = new ChangeLedger(file, 'Refactor')
    const shared = path.join(dir, 'app.py')
    const mine = path.join(dir, 'mine.py')

    one.record(path.join(dir, 'old.py'))
    await new Promise((r) => setTimeout(r, 30))
    const checkpoint = Date.now()
    const changed = new RecordedChanges(one)
    changed.add(shared)
    changed.add(mine)
    two.record(shared)
    await new Promise((r) => setTimeout(r, 50))

    const others = await one.othersSince([...changed], checkpoint)
    expect([...others]).toEqual([[shared, ['Refactor']]])
    expect(await one.othersSince([path.join(dir, 'old.py')], checkpoint)).toEqual(new Map())
  })

  it('a missing ledger means nobody else changed anything', async () => {
    expect(await new ChangeLedger(path.join(dir, 'none.jsonl'), 'Chat 1').othersSince(['x'], 0)).toEqual(new Map())
  })
})
