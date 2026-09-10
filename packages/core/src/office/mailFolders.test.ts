import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Resolving a mail folder path the way a person writes it.
 *
 * A real defect, found while adding validation to the settings box: `outlook_folders` prints
 * store-rooted backslash paths, the resolver required exactly that, and everything written for
 * mail indexing used `Inbox/Alerts` instead. Following the product's own placeholder matched
 * nothing at all - wrong separator, and a missing mailbox name, so it looked for a store
 * literally called "Inbox/Alerts".
 *
 * Asserted against the worker source: this is PowerShell reached only through a live Outlook,
 * so the shape is what a test can see.
 */
const workerPath = fileURLToPath(new URL('./worker.ps1', import.meta.url))
const worker = async (): Promise<string> => fs.readFile(workerPath, 'utf8')

describe('folder paths', () => {
  /**
   * Backslash first, forward slash only as a fallback.
   *
   * This test used to assert the opposite — a single character class over both separators — and
   * that was the bug: an Outlook folder may be *named* `Prod/Test`, and splitting on both turned
   * one folder into two path segments, resolved nothing, and the harvest skipped it in silence.
   * Whole subtrees were missing and nothing anywhere said so.
   *
   * So the strict reading, which cannot misread a name, is tried first; the forgiving one is kept
   * for a path somebody typed by hand, attempted only once the strict reading has failed and
   * there is no correct folder left to damage.
   */
  it('splits on backslash by default and offers a lenient pass', async () => {
    const source = await worker()
    expect(source).toContain("$pattern = '\\\\+'")
    expect(source).toContain("if ($Lenient) { $pattern = '[\\\\/]+' }")
  })

  it('tries the strict reading before the lenient one', async () => {
    const source = await worker()
    // `@($false, $true)` is the order. Reversed, a folder named with a slash is lost again.
    expect(source).toContain('foreach ($lenient in @($false, $true))')
  })

  it('reports folders it could not open instead of skipping them silently', async () => {
    const source = await worker()
    expect(source).toContain('$skipped +=')
    expect(source).toContain('skipped = @($skipped | Select-Object -Unique)')
  })

  it('does not require the mailbox name to be typed', async () => {
    expect(await worker()).toContain('GetDefaultFolder(6).Parent')
  })

  /**
   * Two mailboxes each with `Inbox\Alerts` is a real situation, and silently choosing one would
   * index the wrong mailbox for months without anything indicating it.
   */
  it('refuses an ambiguous match rather than guessing', async () => {
    expect(await worker()).toContain('exists in more than one mailbox')
  })

  /** Stored as Outlook spells it, so anything comparing two paths agrees with itself. */
  it('returns the canonical path rather than what was typed', async () => {
    const source = await worker()
    expect(source).toContain('function Get-CanonicalFolderPath')
    expect(source).toContain('canonical')
  })

  /** Told only that it does not exist, someone guesses again. */
  it('offers near misses when a folder is not found', async () => {
    expect(await worker()).toContain('suggestions')
  })

  /** Counts are a server round trip each on Exchange - the thing that once caused a timeout. */
  it('reads an item count only for the single folder being checked', async () => {
    const source = await worker()
    const validate = source.slice(source.indexOf('function Invoke-OutlookValidateFolder'))
    expect(validate.slice(0, 1200)).toContain('Items.Count')
    // The recursive walk must not.
    const candidates = source.slice(source.indexOf('function Get-FolderCandidates'))
    expect(candidates.slice(0, 600)).not.toContain('Items.Count')
  })
})
