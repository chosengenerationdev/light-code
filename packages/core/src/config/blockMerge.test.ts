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
/** Every place a block of this name is written, not just the first. */
function saveBlocks(name: string): string[] {
  const found: string[] = []
  const needle = `        ${name}: {`
  for (let at = bridge.indexOf(needle); at !== -1; at = bridge.indexOf(needle, at + 1)) {
    found.push(bridge.slice(at, at + 2500))
  }
  if (found.length === 0) throw new Error(`no write of a "${name}" block found in bridge.ts`)
  return found
}

/**
 * The one that writes the whole block from the settings form.
 *
 * Told apart by the field only that form sends. There are several writers of a `python` block
 * now - declining a tool writes one too - and they are not the same act: a small, targeted
 * write merges and touches one key, while the form writes the lot and needs the stronger rule.
 */
function formSaveBlock(name: string): string {
  const block = saveBlocks(name).find((candidate) => candidate.includes('dynamicTools:'))
  if (block === undefined) throw new Error(`no form write of a "${name}" block found`)
  return block
}

describe('writing a nested config block', () => {
  it('merges the python block rather than replacing it', () => {
    // Without this, saving from the Python tab drops `interpreterPath` and `extraIndexUrls` —
    // neither of which that form has a field for.
    expect(formSaveBlock('python')).toContain('...existing,')
  })

  it('merges at every other place the block is written too', () => {
    /*
     * The rule is about the *act*, not about one handler. Declining a tool writes a `python`
     * block to record it, and a write that did not spread the existing one would erase the
     * interpreter path because somebody said no to a tool - exactly the shape this file exists
     * for, arriving through a door that did not exist when it was written.
     */
    for (const block of saveBlocks('python')) {
      const head = block.slice(0, 120)
      expect(head, head).toContain('...')
    }
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
    expect(formSaveBlock('python')).toContain('venvPath: undefined')
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
