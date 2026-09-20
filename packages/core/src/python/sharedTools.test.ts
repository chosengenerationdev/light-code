import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '../logging/logger.js'
import {
  approveTool,
  describeIssue,
  hashSource,
  loadRegistries,
  toolFileName,
} from './registry.js'
import { createDeletePythonTool, type PythonToolContext } from './tools.js'

/**
 * Python tools read from more than one folder.
 *
 * §13 kept tool folders singular partly because read-only extras looked like they would need a
 * second approval-hash store — §15's two-stores-that-diverge problem, on the sharpest surface in
 * the project. They do not, and that is what most of this file pins: **each folder carries its own
 * `.registry.json`**, so a shared `.py` arrives unapproved and a shared *change* refuses itself,
 * with nothing stored twice.
 */

const SOURCE = '"""Margin rows."""\ndef run(region: str) -> list[dict]:\n    return []\n'
const OTHER = '"""Ledger rows."""\ndef run() -> list[dict]:\n    return []\n'

const logger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as Logger

let root: string
let mine: string
let shared: string

async function put(dir: string, name: string, source: string, approve = true): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, toolFileName(name)), source, 'utf8')
  if (approve) {
    await approveTool(dir, name, source, { name, description: `${name} desc`, schema: {} })
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-pytools-'))
  mine = path.join(root, 'mine')
  shared = path.join(root, 'shared')
  await fs.mkdir(mine, { recursive: true })
  await fs.mkdir(shared, { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('loading from several folders', () => {
  it('offers tools from a shared folder alongside your own', async () => {
    await put(mine, 'margin_rows', SOURCE)
    await put(shared, 'ledger_fetch', OTHER)

    const loaded = await loadRegistries([mine, shared], undefined, logger)
    expect(loaded.tools.map((tool) => tool.name)).toEqual(['ledger_fetch', 'margin_rows'])
    expect(loaded.issues).toEqual([])
  })

  it('says which folder each came from', async () => {
    // What the tab marks read-only on, and what `delete_python_tool` refuses on.
    await put(shared, 'ledger_fetch', OTHER)
    const loaded = await loadRegistries([mine, shared], undefined, logger)
    expect(loaded.tools[0]?.sourceDir).toBe(path.resolve(shared))
  })

  it('lets your own copy win, and says the other is hidden', async () => {
    /*
     * A search path, like the skills folders: the writable entry wins, so somebody can fix a
     * colleague's tool locally without editing everyone's copy. Reported rather than dropped —
     * two folders quietly disagreeing about what `margin_rows` does cannot be diagnosed from
     * the outside.
     */
    await put(mine, 'margin_rows', SOURCE)
    await put(shared, 'margin_rows', OTHER)

    const loaded = await loadRegistries([mine, shared], undefined, logger)
    expect(loaded.tools).toHaveLength(1)
    expect(loaded.tools[0]?.sourceDir).toBe(path.resolve(mine))
    expect(loaded.issues.map((issue) => issue.kind)).toEqual(['shadowed'])
    expect(describeIssue(loaded.issues[0]!)).toMatch(/hidden by/)
  })

  it('collapses the same folder configured twice', async () => {
    // Easy to do when one entry is relative and another absolute; without this every tool in it
    // would shadow itself and report a conflict that is not one.
    await put(mine, 'margin_rows', SOURCE)
    const loaded = await loadRegistries([mine, path.join(mine, '.', '')], undefined, logger)
    expect(loaded.tools).toHaveLength(1)
    expect(loaded.issues).toEqual([])
  })

  it('is ordered by name, whatever order the folders are in', async () => {
    // The tool block sits at the front of the prompt; an order that varied with configuration
    // would move the prefix and cost the cache (§12).
    await put(mine, 'zebra', SOURCE)
    await put(shared, 'alpha', OTHER)
    const loaded = await loadRegistries([mine, shared], undefined, logger)
    expect(loaded.tools.map((tool) => tool.name)).toEqual(['alpha', 'zebra'])
  })
})

describe('what makes a shared folder safe', () => {
  it('never loads a shared tool that has not been approved here', async () => {
    /*
     * The whole security argument. A `.py` synced out of a bucket has no registry entry on this
     * machine, so it is refused and reported — approval is per-machine, and a file appearing on
     * disk is never enough to run it.
     */
    await put(shared, 'ledger_fetch', OTHER, false)

    const loaded = await loadRegistries([mine, shared], undefined, logger)
    expect(loaded.tools).toEqual([])
    expect(loaded.issues[0]?.kind).toBe('unapproved')
  })

  it('refuses a shared tool whose source changed after approval', async () => {
    // The second half: a sync that brings down an edited tool breaks the hash recorded in *that
    // folder's* registry, so it stops loading until somebody reads the change and approves it.
    await put(shared, 'ledger_fetch', OTHER)
    await fs.writeFile(path.join(shared, toolFileName('ledger_fetch')), `${OTHER}# changed\n`, 'utf8')

    const loaded = await loadRegistries([mine, shared], undefined, logger)
    expect(loaded.tools).toEqual([])
    expect(loaded.issues[0]?.kind).toBe('hash-mismatch')
  })

  it('keeps each folder’s approvals in that folder, not in one shared store', async () => {
    /*
     * This is the objection §13 recorded, answered. Approving the shared tool writes into the
     * shared folder's own `.registry.json` and leaves the writable folder's alone — so there is
     * one store per folder and never two describing the same thing.
     */
    await put(shared, 'ledger_fetch', OTHER)
    const sharedRegistry = JSON.parse(
      await fs.readFile(path.join(shared, '.registry.json'), 'utf8'),
    ) as { tools: Record<string, { hash: string }> }

    expect(Object.keys(sharedRegistry.tools)).toEqual(['ledger_fetch'])
    expect(sharedRegistry.tools['ledger_fetch']?.hash).toBe(hashSource(OTHER))
    await expect(fs.stat(path.join(mine, '.registry.json'))).rejects.toThrow()
  })
})

describe('delete_python_tool', () => {
  const context = (): PythonToolContext =>
    ({
      toolsDir: mine,
      onChanged: async () => undefined,
      findTool: (name: string) =>
        name === 'ledger_fetch'
          ? { filePath: path.join(shared, toolFileName(name)), sourceDir: shared }
          : { filePath: path.join(mine, toolFileName(name)), sourceDir: mine },
    }) as unknown as PythonToolContext

  it('refuses to remove a tool from a shared folder', async () => {
    // One person's assistant must not delete a tool every colleague depends on. Said out loud
    // rather than left to `force: true`, which would report success while deleting nothing.
    await put(shared, 'ledger_fetch', OTHER)

    const result = await createDeletePythonTool(context()).execute(
      { name: 'ledger_fetch' },
      {} as never,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/read-only tools folder/)
    await expect(fs.stat(path.join(shared, toolFileName('ledger_fetch')))).resolves.toBeTruthy()
  })

  it('still removes one of your own', async () => {
    await put(mine, 'margin_rows', SOURCE)
    const result = await createDeletePythonTool(context()).execute(
      { name: 'margin_rows' },
      {} as never,
    )
    expect(result.isError).not.toBe(true)
    await expect(fs.stat(path.join(mine, toolFileName('margin_rows')))).rejects.toThrow()
  })
})

describe('declining, and getting it back', () => {
  it('hides a tool whose exact bytes were declined', async () => {
    await put(shared, 'ledger_fetch', OTHER)
    const loaded = await loadRegistries([mine, shared], undefined, logger, {
      ledger_fetch: hashSource(OTHER),
    })
    expect(loaded.tools).toEqual([])
    expect(loaded.issues[0]?.kind).toBe('declined')
  })

  it('deletes nothing, so restoring costs nothing', async () => {
    // Recovery has to be cheaper than the mistake. The file never moved; the entry is what hid it.
    await put(shared, 'ledger_fetch', OTHER)
    await loadRegistries([mine, shared], undefined, logger, { ledger_fetch: hashSource(OTHER) })
    await expect(fs.stat(path.join(shared, toolFileName('ledger_fetch')))).resolves.toBeTruthy()

    const restored = await loadRegistries([mine, shared], undefined, logger, {})
    expect(restored.tools.map((tool) => tool.name)).toEqual(['ledger_fetch'])
  })

  it('brings a changed version back on its own', async () => {
    /*
     * The reason the decline is pinned to a hash rather than a name. Saying no was about the code
     * that was read; a version published later is different code and deserves the same look. A
     * name-only list would suppress every future version, invisibly.
     */
    await put(shared, 'ledger_fetch', OTHER)
    const declined = { ledger_fetch: hashSource('something else entirely') }

    const loaded = await loadRegistries([mine, shared], undefined, logger, declined)
    expect(loaded.tools.map((tool) => tool.name)).toEqual(['ledger_fetch'])
  })

  it('reports a declined tool rather than hiding it outright', async () => {
    // A tool that vanished with no explanation is the one nobody can recover.
    await put(shared, 'ledger_fetch', OTHER)
    const loaded = await loadRegistries([mine, shared], undefined, logger, {
      ledger_fetch: hashSource(OTHER),
    })
    expect(describeIssue(loaded.issues[0]!)).toMatch(/declined/i)
    expect(describeIssue(loaded.issues[0]!)).toMatch(/restore/i)
  })

  it('declining is checked before approval, so a declined tool stays hidden', async () => {
    // Otherwise "approved once, declined later" would keep loading, and the later decision — the
    // one the user made most recently — would be the one that did nothing.
    await put(shared, 'ledger_fetch', OTHER)
    const loaded = await loadRegistries([mine, shared], undefined, logger, {
      ledger_fetch: hashSource(OTHER),
    })
    expect(loaded.tools).toEqual([])
  })
})
