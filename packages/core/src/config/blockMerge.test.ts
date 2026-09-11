import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const bridge = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host', 'bridge.ts'),
  'utf8',
)

/**
 * A nested config block written from a form must be merged, never replaced.
 *
 * `configManager.save` replaces whichever top-level keys it is given, so writing a whole nested
 * object from one panel erases every key that panel does not happen to send. That has now cost
 * real settings twice: once for `embedder`, whose alias is edited in Skills while its model is
 * edited in Search, and once for `python` — a configured virtualenv gone after an update,
 * because a field had been added to the block that the form did not know to send back.
 *
 * The shape is the one CLAUDE.md names as the most expensive in this project, wearing a different
 * hat: one fact, written from a place that does not know the whole of it.
 *
 * Read from the source because the defect is a *missing* spread. Nothing about the saved result
 * reveals it until a key that was never sent goes missing, which is exactly the thing nobody
 * tests for in advance.
 */
function saveBlock(name: string): string {
  const at = bridge.indexOf(`        ${name}: {`)
  if (at < 0) throw new Error(`no write of a "${name}" block found in bridge.ts`)
  return bridge.slice(at, at + 2500)
}

describe('writing a nested config block', () => {
  it('merges the python block rather than replacing it', () => {
    // Without this, saving from the Python tab drops `interpreterPath` and `extraIndexUrls` —
    // neither of which that form has a field for.
    expect(saveBlock('python')).toContain('...existing,')
  })

  it('reads the existing block before writing it', () => {
    expect(bridge).toContain("const existing = (await configManager.load()).config.python ?? {}")
  })

  it('still lets a cleared field clear', () => {
    /*
     * The other half, and it is not optional: with the existing block spread in, *omitting* a
     * blank field would keep the old value, so emptying the box would appear to do nothing. A
     * field the form did not send is kept; a field it sent empty is removed.
     */
    expect(saveBlock('python')).toContain('venvPath: undefined')
  })

  it('keeps the embedder merge that taught this lesson the first time', () => {
    // `handleSaveSkillsAlias` writes the alias without touching the model or the width.
    expect(bridge).toContain('const embedder = { ...(config.embedder ?? {}) }')
  })

  it('sends back every key the block holds, so nothing is invisible and rewritten', () => {
    // A field the panel cannot see is a field it cannot preserve by accident either.
    expect(bridge).toContain('interpreterPath: saved.interpreterPath')
    expect(bridge).toContain('extraIndexUrls: saved.extraIndexUrls')
  })
})
