import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { officeSupported } from './bridge.js'
import { OFFICE_WORKER_SOURCE } from './workerSource.js'

/**
 * The worker is a PowerShell file that has to exist on disk, inlined into the bundle because
 * esbuild does not copy `.ps1` and resolving a path relative to the bundle is the trap that once
 * shipped a VSIX that could not activate. So the risk is drift: editing the script and shipping
 * the old copy, which fails at runtime and nowhere else.
 */
const workerPath = fileURLToPath(new URL('./worker.ps1', import.meta.url))

describe('the inlined PowerShell worker', () => {
  it('matches worker.ps1 exactly', async () => {
    const onDisk = await fs.readFile(workerPath, 'utf8')
    expect(OFFICE_WORKER_SOURCE).toBe(onDisk)
  })

  /**
   * Windows PowerShell 5.1 decodes a BOM-less `.ps1` as ANSI, so a single non-ASCII character
   * becomes mojibake — and inside a string literal that is a parse error and a worker that never
   * starts. Measured, not theorised: an em dash in a comment cost one debugging round.
   */
  it('is pure ASCII, so it cannot be mangled by the ANSI fallback', () => {
    const offenders = [...new Set([...OFFICE_WORKER_SOURCE].filter((c) => c.charCodeAt(0) > 127))]
    expect(offenders).toEqual([])
  })

  /**
   * Model-supplied text must never reach a command line (CLAUDE.md section 16).
   *
   * Comments are stripped first: the header explains *why* the cmdlet is absent, and naming it
   * there is exactly right — a check that could not tell the two apart would push the
   * explanation out of the file to keep itself happy.
   */
  it('never evaluates a string as code', () => {
    const code = OFFICE_WORKER_SOURCE.split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/Invoke-Expression/)
    expect(code).not.toMatch(/\biex\b/)
  })

  /**
   * `New-Object -ComObject Excel.Application` would *launch* Excel. The feature is about the
   * session someone already has open, and silently starting a second one — invisible, holding a
   * file lock — is a worse outcome than saying "open it first".
   */
  it('attaches to a running Excel rather than starting one', () => {
    expect(OFFICE_WORKER_SOURCE).toMatch(/GetActiveObject/)
    expect(OFFICE_WORKER_SOURCE).toMatch(/is not running on this machine\. Open it and try again/)
  })

  it('leaves the workbook unsaved after a macro write, and says so', () => {
    expect(OFFICE_WORKER_SOURCE).toMatch(/Deliberately not saved/)
  })

  /**
   * Measured against Excel 16: with the Trust Center setting off, `VBProject` returns **null**
   * rather than throwing. The original try/catch therefore never fired and every caller reported
   * "this workbook contains no VBA modules" — a confident wrong answer to a question that was
   * really about a security setting.
   */
  it('detects blocked VBA access by the null it actually returns', () => {
    expect(OFFICE_WORKER_SOURCE).toMatch(/\$null -eq \$project/)
    expect(OFFICE_WORKER_SOURCE).toMatch(/Trust access to the VBA project object model/)
  })

  /**
   * An Excel error arrives over COM as a signed integer — #N/A is -2146826246 — which reads as a
   * number a formula produced. Verified live: evaluating a failing VLOOKUP returned exactly that.
   */
  it('turns error variants back into the text a person sees in the cell', () => {
    expect(OFFICE_WORKER_SOURCE).toMatch(/#DIV\/0!/)
    expect(OFFICE_WORKER_SOURCE).toMatch(/#N\/A/)
    expect(OFFICE_WORKER_SOURCE).toMatch(/2042/)
  })

  /** Running a macro is qualified with its workbook, or one of the same name elsewhere could run. */
  it('qualifies a macro with the workbook that owns it', () => {
    expect(OFFICE_WORKER_SOURCE).toMatch(/\$qualified = /)
  })
})

describe('platform support', () => {
  it('is claimed only on Windows', () => {
    expect(officeSupported()).toBe(process.platform === 'win32')
  })
})

describe('the generated file', () => {
  it('names the script it came from, so the next editor knows what to run', async () => {
    const generated = await fs.readFile(
      path.join(path.dirname(workerPath), 'workerSource.ts'),
      'utf8',
    )
    expect(generated).toContain('generate-office-worker.mjs')
    expect(generated).toContain('worker.ps1')
  })
})
