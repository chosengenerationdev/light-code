import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Code in chat, in diffs and in charts is coloured with VS Code theme variables. Inside VS Code the
 * editor supplies them; here the browser host has to, and it did not: every token fell through to
 * plain text, so code looked unhighlighted in the Node host, Sun Code and the JetBrains plugin
 * while the same build was coloured in VS Code. Reported from real use.
 *
 * Read from the source on purpose: the failure is a variable nobody defined, which no test of the
 * highlighter can see - it produces the right tokens either way.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(here, 'client', 'client.css'), 'utf8')
const highlight = readFileSync(path.join(here, '..', '..', '..', 'packages', 'ui', 'src', 'highlight.ts'), 'utf8')

/** The declarations inside the first block that starts with `selector`. */
function block(selector: string): string {
  const start = css.indexOf(selector)
  expect(start, `${selector} in client.css`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(open, i)
  }
  return css.slice(open)
}

describe('the browser host defines every colour the highlighter uses', () => {
  const tokenColours = highlight.slice(highlight.indexOf('export const TOKEN_COLORS'))
  const used = [...new Set([...tokenColours.matchAll(/var\((--vscode-[\w-]+)/g)].map((m) => m[1] as string))]

  it('finds the variables it is checking', () => {
    expect(used).toContain('--vscode-debugTokenExpression-string')
  })

  for (const [theme, selector] of [
    ['light', ':root {'],
    ['dark (system)', '@media (prefers-color-scheme: dark)'],
    ['dark (chosen)', ":root[data-theme='dark']"],
  ] as const) {
    it(`in ${theme}`, () => {
      const declarations = block(selector)
      // Each token's own variable, or else its fallback: one of the two must resolve.
      for (const line of tokenColours.split('\n').filter((l) => l.includes('var(--vscode-'))) {
        const names = [...line.matchAll(/var\((--vscode-[\w-]+)/g)].map((m) => m[1] as string)
        const defined = names.some((name) => declarations.includes(`${name}:`))
        expect(defined, `${line.trim()} - none of ${names.join(', ')} is defined in ${theme}`).toBe(true)
      }
    })
  }

  it('draws code as VS Code does: no ligatures', () => {
    expect(css).toMatch(/font-variant-ligatures:\s*none/)
    expect(css).not.toMatch(/editor-font-family:[^;]*Cascadia Code/)
  })
})
