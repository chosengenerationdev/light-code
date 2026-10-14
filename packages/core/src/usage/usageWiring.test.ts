import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { USER_SCOPE_ONLY_KEYS } from '../config/scopes.js'
import { SHARE_SECTIONS } from '../config/share.js'

/**
 * The parts of the usage dashboard no test of `usage/` can see: that the bridge records at all, that
 * it records nothing until a shared store is configured (asked for in those words), and that the
 * settings can neither be set by a repository nor left out of a team's shared config.
 */
const bridge = readFileSync(new URL('../host/bridge.ts', import.meta.url), 'utf8')

function body(signature: string): string {
  const start = bridge.indexOf(signature)
  expect(start, signature).toBeGreaterThan(-1)
  return bridge.slice(start, bridge.indexOf('\n  }\n', start))
}

describe('usage wiring', () => {
  it('every tool result is offered to the recorder, and every call is timed', () => {
    expect(bridge).toMatch(/onToolResult: \(toolCall, result\) => \{\n\s+recordUsage\(toolCall, result\)/)
    expect(bridge).toMatch(/onToolCall: \(toolCall\) => \{\n\s+noteToolStarted\(toolCall\)/)
  })

  it('records nothing unless collection is on and names a store', () => {
    expect(body("function usageCollecting(): boolean")).toContain("cachedUsageChoice !== undefined && cachedUsage?.enabled !== false")
    expect(body('function recordUsage(')).toMatch(/if \(!usageCollecting\(\)/)
  })

  it('stores names and outcomes, never arguments', () => {
    const recorder = body('function recordUsage(')
    const pushes = recorder.match(/events\.push\(\{[\s\S]*?\}\)\n/g) ?? []
    expect(pushes.length).toBe(2)
    for (const push of pushes) expect(push).not.toMatch(/args|arguments|result\.content/)
  })

  it('a save is proved by writing to the store before it is kept', () => {
    const save = body('async function handleSaveUsageSettings(')
    expect(save.indexOf('trial.store.put')).toBeGreaterThan(-1)
    expect(save.indexOf('trial.store.put')).toBeLessThan(save.indexOf("configManager.save('user'"))
  })

  it('starts by itself: the store is recomputed on every settings load, and the first push is scheduled', () => {
    expect(bridge).toContain('cachedUsageChoice = chooseUsageStore(config, cachedS3.targets)')
    expect(bridge).toMatch(/if \(!usageKicked && usageCollectionOn\(config, cachedUsageChoice\)\)/)
  })

  it('imports past conversations through the Rust helper when Fire Code provides it', () => {
    expect(body('async function backfillUsageOnce(')).toContain('usageHelper()')
    expect(body('function usageHelper(')).toContain("fastFsOps.has('usage')")
  })

  it('offers the profile tool and its guidance only while collecting', () => {
    expect(bridge).toContain('if (usageCollecting()) combined.register(recordUserProfileTool')
    expect(bridge).toMatch(/schedule === undefined && usageCollecting\(\) && cachedProfileFresh === false/)
  })

  it('rolls finished months up after a push, once a day per session', () => {
    expect(bridge).toMatch(/if \(Date\.now\(\) - usageLastRollUp > 86_400_000\) \{[\s\S]*?rollUpMonths\(\{ log: usageLog, store: resolved\.store, target: resolved\.target, instance: usageInstance \}\)/)
  })

  it('is user-scope only, and travels in a share section', () => {
    expect(USER_SCOPE_ONLY_KEYS).toContain('usage')
    expect(SHARE_SECTIONS.some((section) => section.keys.includes('usage'))).toBe(true)
  })
})
