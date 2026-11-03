import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MonitorRequest } from '@light-code/core'

import { StdioControl } from './controlChannel.js'

/**
 * Fire Code asks this host - its monitoring executor - to change a monitor that is a copy from the team's bucket
 * or repository, because Fire Code itself has no network (reported: the team's monitors could not be edited or
 * deleted from the dashboard at all).
 */
describe('Fire Code asking for a team monitor to be changed', () => {
  it('reaches the executor as a skill request, and the answer goes back under its id', async () => {
    const written: string[] = []
    const control = new StdioControl((line) => void written.push(line))
    const asked: MonitorRequest[] = []
    control.executor().serve(async (request) => {
      asked.push(request)
      return { ok: true, data: 'Saved and uploaded to the bucket team-skills.' }
    })
    control.feed(`${JSON.stringify({ type: 'monitorRequest', id: 'm7', kind: 'skill', op: 'write', name: 'batch', file: 'C:/m/batch.md', content: 'new text' })}\n`)
    control.feed(`${JSON.stringify({ type: 'monitorRequest', id: 'm8', kind: 'skill', op: 'delete', name: 'batch', file: 'C:/m/batch.md' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(asked).toEqual([
      { kind: 'skill', id: 'm7', op: 'write', name: 'batch', file: 'C:/m/batch.md', content: 'new text' },
      { kind: 'skill', id: 'm8', op: 'delete', name: 'batch', file: 'C:/m/batch.md' },
    ])
    const answers = written.filter((line) => line.includes('"answer"')).map((line) => JSON.parse(line.replace('light-code-monitor: ', '')) as Record<string, unknown>)
    expect(answers[0]).toEqual({ type: 'answer', id: 'm7', ok: true, data: 'Saved and uploaded to the bucket team-skills.' })
  })

  it('asks whether a monitor\'s tool can run here before this computer claims its run, by the lookup a check uses', async () => {
    const written: string[] = []
    const control = new StdioControl((line) => void written.push(line))
    const asked: MonitorRequest[] = []
    control.executor().serve(async (request) => {
      asked.push(request)
      return { ok: true, data: { ready: false, reason: 'py__jobs is waiting for approval here' } }
    })
    control.feed(`${JSON.stringify({ type: 'monitorRequest', id: 'p1', kind: 'probe', tool: 'py__jobs' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(asked).toEqual([{ kind: 'probe', id: 'p1', tool: 'py__jobs' }])
    const bridge = fs.readFileSync(path.join(__dirname, '../../../packages/core/src/host/bridge.ts'), 'utf8')
    // A probe and a real check share one lookup, so "ready" never says yes to what a check would refuse.
    expect(bridge).toMatch(/case 'probe': \{\s*const here = await monitorToolHere\(request\.tool\)/)
    expect(bridge).toMatch(/async function executeForMonitor[\s\S]{0,200}const here = await monitorToolHere\(name\)/)
  })

  // Every kind Fire Code sends must be one this host parses: the dashboard's Refresh ("sync") was refused
  // when it was added to Rust and the bridge but not here.
  it('passes on every kind of request the bridge answers', async () => {
    const control = new StdioControl(() => undefined)
    const asked: MonitorRequest[] = []
    control.executor().serve(async (request) => {
      asked.push(request)
      return { ok: true, data: null }
    })
    control.feed(`${JSON.stringify({ type: 'monitorRequest', id: 's1', kind: 'sync' })}\n`)
    control.feed(`${JSON.stringify({ type: 'monitorRequest', id: 'h1', kind: 'history', file: 'C:/x/disks.md' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(asked).toEqual([{ kind: 'sync', id: 's1' }, { kind: 'history', id: 'h1', file: 'C:/x/disks.md' }])
    const bridge = fs.readFileSync(path.join(__dirname, '../../../packages/core/src/host/bridge.ts'), 'utf8')
    const answered = [...bridge.matchAll(/^\s{8}case '([a-z]+)':/gm)].map((m) => m[1])
    for (const kind of ['fetch', 'store', 'explain', 'probe', 'sync', 'history', 'skill']) expect(answered).toContain(kind)
  })

  it('is answered with the same delete everywhere the Skills tab uses, and a write held to the team folders', () => {
    // Read from the source: one deletion path for both, so the dashboard cannot delete a different way.
    const bridge = fs.readFileSync(path.join(__dirname, '../../../packages/core/src/host/bridge.ts'), 'utf8')
    expect(bridge).toContain("await deleteEverywhere(await planDeleteEverywhere('skill', request.name))")
    expect(bridge).toMatch(/async function handleDeleteEverywhere[\s\S]{0,200}const result = await deleteEverywhere\(requested\)/)
    const writer = bridge.slice(bridge.indexOf('async function writeTeamMonitorSkill'), bridge.indexOf('/** The team repository, as the approval prompt names it'))
    expect(writer).toContain('for (const dir of mirroredSkillsDirs)')
    expect(writer).toContain('team.dirs.skills')
    expect(writer).toContain('is not in a bucket folder or the team repository')
  })
})
