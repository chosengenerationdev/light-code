import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * "When I open multiple VS Code sessions, there will be multiple schedules running."
 *
 * Each window has its own bridge, its own timer and its own view of a schedule being due, so on
 * one project two windows both run it — at the same moment, against the same files. Binding a
 * schedule to its project fixes windows on *different* projects and does nothing for this one.
 *
 * The claim is a file created with `wx`, which fails when it already exists. That is a single
 * atomic filesystem operation, so two windows racing cannot both win — no lock service, nothing
 * left running. This mirrors `claimSchedule` in the bridge, which needs a whole host to reach;
 * what is worth pinning is the property, and the property is in the flag.
 */
const STALE_MS = 60 * 60 * 1000
let directory: string

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-claim-'))
})

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

async function claim(id: string, now = Date.now()): Promise<boolean> {
  const claimPath = path.join(directory, `${id}.json`)
  const mine = JSON.stringify({ pid: process.pid, at: now })
  try {
    await fs.writeFile(claimPath, mine, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return true
  }
  try {
    const held = JSON.parse(await fs.readFile(claimPath, 'utf8')) as { at?: unknown }
    const at = typeof held.at === 'number' ? held.at : 0
    if (now - at < STALE_MS) return false
    await fs.writeFile(claimPath, mine, 'utf8')
    return true
  } catch {
    return true
  }
}

describe('claiming a schedule before running it', () => {
  it('lets exactly one of many windows win the same tick', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => claim('nightly')))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('turns a second window away while the first is running', async () => {
    expect(await claim('nightly')).toBe(true)
    expect(await claim('nightly')).toBe(false)
  })

  /**
   * A window that crashed mid-run must not block its schedule for ever. Silently stopping a
   * nightly job, with nothing anywhere saying why, is a worse failure than an occasional
   * double run.
   */
  it('takes over a claim left behind by a window that died', async () => {
    await fs.writeFile(
      path.join(directory, 'nightly.json'),
      JSON.stringify({ pid: 999, at: Date.now() - 2 * STALE_MS }),
      'utf8',
    )
    expect(await claim('nightly')).toBe(true)
  })

  it('does not hold up a different schedule', async () => {
    expect(await claim('nightly')).toBe(true)
    expect(await claim('weekly')).toBe(true)
  })

  it('is free again once the run releases it', async () => {
    expect(await claim('nightly')).toBe(true)
    await fs.rm(path.join(directory, 'nightly.json'), { force: true })
    expect(await claim('nightly')).toBe(true)
  })

  /** An unreadable claim is not evidence that anything is running. */
  it('runs rather than blocking when the claim file is corrupt', async () => {
    await fs.writeFile(path.join(directory, 'nightly.json'), 'not json', 'utf8')
    expect(await claim('nightly')).toBe(true)
  })
})
