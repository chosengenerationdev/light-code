import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Logger } from '../logging/logger.js'
import { approveTool, loadRegistries } from './registry.js'

/**
 * The same tool in two folders, and the approval panel that would not go away.
 *
 * Reported from real use: *"when I click approve, I see the notification that 1 tool approved,
 * but that approval window is not leaving... sometimes it seems to be showing some tools for
 * reapproval."*
 *
 * Two folders holding the same tool name is not an odd case - 0.99.0 deliberately supports it,
 * because that is how a bucket mirror sits beside the folder you write to. Each folder keeps its
 * own `.registry.json`, which is what makes approvals per-machine. So the second copy had no
 * entry, was reported `unapproved`, and the Approve button records against the **first** folder
 * holding the file - the one already approved. Nothing changed, and the panel came back
 * identical, for ever.
 *
 * The fault was one of category. `unapproved` means *this cannot run until you read it*, and that
 * is false once another folder has claimed the name: it runs, from approved code. The extra copy
 * is shadowed, which this module already had a word for.
 *
 * Against a real filesystem, because the bug is about what is on disk in two places - an
 * in-memory fake would have been written to the same belief that produced the bug.
 */

const logger = new Logger({ level: 'error', sink: () => {} })

const SOURCE = '"""A shared tool."""\n\n\ndef run() -> str:\n    """Does a thing."""\n    return "ok"\n'
const described = {
  name: 'shared_tool',
  description: 'Does a thing.',
  schema: { type: 'object', properties: {} },
}

let root: string
let local: string
let mirror: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-shadow-'))
  local = path.join(root, 'local')
  mirror = path.join(root, 'mirror')
  await fs.mkdir(local, { recursive: true })
  await fs.mkdir(mirror, { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** What the approval panel would show: the issues it treats as waiting on a person. */
async function pending(dirs: string[]): Promise<string[]> {
  const loaded = await loadRegistries(dirs, undefined, logger, {})
  return loaded.issues
    .filter((issue) => issue.kind === 'unapproved' || issue.kind === 'hash-mismatch')
    .map((issue) => `${issue.kind}:${issue.name}`)
}

describe('a tool that exists in two folders', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(local, 'shared_tool.py'), SOURCE, 'utf8')
    await fs.writeFile(path.join(mirror, 'shared_tool.py'), SOURCE, 'utf8')
  })

  it('asks about it while neither copy is approved', async () => {
    // Both are genuinely unrunnable, so both are genuinely waiting on somebody.
    expect(await pending([local, mirror])).toHaveLength(2)
  })

  it('stops asking once one copy is approved, which is what the button does', async () => {
    /*
     * The reported bug, in one assertion. Measured before the fix: two pending, then **one**
     * pending after approving - and the button can never clear that one, because it always
     * resolves to the first folder holding the file.
     */
    await approveTool(local, 'shared_tool', SOURCE, described)

    const loaded = await loadRegistries([local, mirror], undefined, logger, {})
    expect(await pending([local, mirror])).toEqual([])
    // And the tool is genuinely usable - the panel clearing is not it being hidden.
    expect(loaded.tools.map((tool) => tool.name)).toEqual(['shared_tool'])
  })

  it('still reports the copy that will not run, as shadowed rather than as unapproved', async () => {
    // Silence would be wrong too: there are two files, and only one of them is what runs.
    await approveTool(local, 'shared_tool', SOURCE, described)
    const loaded = await loadRegistries([local, mirror], undefined, logger, {})
    const shadowed = loaded.issues.filter((issue) => issue.kind === 'shadowed')
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]?.filePath).toContain('mirror')
  })

  it('does not hide a copy whose own name nothing else has claimed', async () => {
    /*
     * Non-vacuity, and the security property: reclassifying is only ever right when *another*
     * folder resolved that name. A tool nothing has claimed must still be asked about, or code
     * could reach the model unread.
     */
    await fs.writeFile(path.join(mirror, 'only_here.py'), SOURCE, 'utf8')
    await approveTool(local, 'shared_tool', SOURCE, described)
    expect(await pending([local, mirror])).toEqual(['unapproved:only_here'])
  })

  it('treats a changed shadowed copy the same way', async () => {
    // A mirror that drifted would otherwise report `hash-mismatch` for ever, which is the
    // "showing some tools for reapproval" half of the report.
    await approveTool(local, 'shared_tool', SOURCE, described)
    await approveTool(mirror, 'shared_tool', SOURCE, described)
    await fs.writeFile(path.join(mirror, 'shared_tool.py'), `${SOURCE}# changed\n`, 'utf8')
    expect(await pending([local, mirror])).toEqual([])
  })

  it('still refuses a change to the copy that actually runs', async () => {
    /*
     * The pin is the whole security boundary (§13) and must survive all of this. A change to the
     * *winning* file is refused loudly, exactly as before.
     */
    await approveTool(local, 'shared_tool', SOURCE, described)
    await fs.writeFile(path.join(local, 'shared_tool.py'), `${SOURCE}# changed\n`, 'utf8')
    const loaded = await loadRegistries([local, mirror], undefined, logger, {})
    expect(loaded.tools).toHaveLength(0)
    expect(await pending([local, mirror])).toContain('hash-mismatch:shared_tool')
  })
})

describe('the same folder named twice', () => {
  it('reads it once, however it is spelled', async () => {
    /*
     * §16: paths compare case-insensitively on Windows. `path.resolve` preserves case, so
     * `d:\\proj\\tools` and `D:\\proj\\tools` are one folder spelled two ways and both survived
     * an exact-string filter - so every tool in it was read twice and listed twice in the
     * approval panel. The same trap `approvals` hit when it keyed a workspace path in JSON.
     */
    await fs.writeFile(path.join(local, 'shared_tool.py'), SOURCE, 'utf8')
    const upper = local.replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`)
    const spelledTwice = process.platform === 'win32' ? [local, upper] : [local, `${local}/.`]

    expect(await pending(spelledTwice)).toEqual(['unapproved:shared_tool'])
  })
})
