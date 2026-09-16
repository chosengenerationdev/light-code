import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cli = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts'),
  'utf8',
).replace(/\r\n/g, '\n')

/**
 * A line a program can read.
 *
 * Added for the IntelliJ plugin, which starts this server and has to find out where it went. The
 * banner is prose written for a person — it wraps, it explains, and what it says varies with a
 * dozen flags — so a plugin scraping it is one broken by the next reworded sentence.
 *
 * Read from the source because what matters is that the line exists and is shaped as promised;
 * the alternative is starting a real server in a unit test to read one line of its output.
 */
describe('--print-url', () => {
  it('is a known flag, so it is not refused as a typo', () => {
    expect(cli).toContain("'--print-url'")
  })

  /* Prefixed, so a reader scans for its own line rather than assuming it comes first. */
  it('prints the URL prefixed and alone', () => {
    expect(cli).toContain('light-code-url: ${reachableUrl}')
  })

  /*
   * A program that asked for the URL did not ask for a browser window on whatever machine this is
   * running on — which on a server is nobody's screen.
   */
  it('implies --no-open', () => {
    expect(cli).toMatch(/const noOpen =.*printUrl/)
  })

  /*
   * And the banner stops claiming to open something it is not opening. Small, but it is the line
   * people read to work out what just happened.
   */
  it('says "Serving on" when nothing is being opened', () => {
    expect(cli).toContain("noOpen ? 'Serving on' : 'Opening'")
  })

  it('documents itself in the usage text', () => {
    expect(cli).toContain('--print-url')
    expect(cli).toContain('light-code-url:')
  })
})
