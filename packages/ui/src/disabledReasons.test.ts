import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { disabledWhen } from './disabledWhen.js'

/**
 * Every control that can be disabled says why when you hover it.
 *
 * Asked for: "if you disabled it for a reason, when user mouse over it, it should tell why it is
 * disabled". A greyed-out button with nothing to say reads as broken. This reads the source, because the
 * defect is a missing attribute, which no test of a working control can see: every element written with
 * `disabled={...}` must carry a `title` on the same element. The usual way is `disabledWhen`, which writes
 * both from one condition-and-reason pair, so it never shows up here as `disabled=`.
 */

const SRC = path.dirname(fileURLToPath(import.meta.url))

/** Elements whose own component writes the title from what it is given. */
const TITLE_WRITTEN_INSIDE = new Set(['ModeSelector'])

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return name.endsWith('.tsx') && !name.includes('.test.') ? [full] : []
  })
}

/** The JSX element around position `at`: from its `<` to the `>` that closes it, skipping `{...}`. */
function elementAround(source: string, at: number): string {
  const open = source.lastIndexOf('<', at)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (char === '>' && depth === 0 && source[index - 1] !== '=') return source.slice(open, index)
  }
  return source.slice(open)
}

describe('disabled controls', () => {
  it('each one carries a title, so hovering says why', () => {
    const missing: string[] = []
    for (const file of sources(SRC)) {
      const source = readFileSync(file, 'utf8')
      for (let at = source.indexOf('disabled={'); at >= 0; at = source.indexOf('disabled={', at + 1)) {
        const element = elementAround(source, at)
        const tag = /^<([A-Za-z.]+)/.exec(element)?.[1] ?? '?'
        if (TITLE_WRITTEN_INSIDE.has(tag) || /\btitle=/.test(element)) continue
        missing.push(`${path.relative(SRC, file)}:${String(source.slice(0, at).split('\n').length)} <${tag}>`)
      }
    }
    expect(missing).toEqual([])
  })

  it('disabledWhen names the first reason that holds, and keeps the enabled title otherwise', () => {
    expect(disabledWhen([false, 'a'], [true, 'b'], [true, 'c'])).toEqual({ disabled: true, title: 'b' })
    expect(disabledWhen([false, 'a'], { enabledTitle: 'Send' })).toEqual({ disabled: false, title: 'Send' })
    expect(disabledWhen([false, 'a'])).toEqual({ disabled: false })
  })
})
