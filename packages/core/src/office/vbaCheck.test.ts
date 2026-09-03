import { describe, expect, it } from 'vitest'

import { checkVba } from './vbaCheck.js'

/**
 * The checker exists because running a macro is the expensive move — it changes the workbook,
 * needs approval, and reports only the first thing that goes wrong. Most of what actually breaks
 * VBA is visible in the text, and finding it there costs nothing and risks nothing.
 *
 * The risk in a checker is the opposite one: a rule that fires on working code gets the whole
 * thing ignored, and the real finding is ignored with it. So each of these pins both the catch
 * and the case that must stay quiet.
 */
const messages = (code: string, sheets?: string[]): string[] =>
  checkVba({ code, ...(sheets === undefined ? {} : { sheets }) }).map((finding) => finding.message)

const clean = `Option Explicit

Sub Recalculate()
    Dim total As Double
    total = Application.WorksheetFunction.Sum(Sheets("Data").Range("A:A"))
    Sheets("Report").Range("B2").Value = total
End Sub
`

describe('a module with nothing wrong with it', () => {
  it('produces no findings at all', () => {
    expect(checkVba({ code: clean, sheets: ['Data', 'Report'] })).toEqual([])
  })
})

describe('Option Explicit', () => {
  /** Without it a mistyped name is a new empty Variant, so the macro runs and does the wrong thing. */
  it('is reported when missing, because a typo becomes a silent wrong answer', () => {
    expect(messages('Sub A()\nEnd Sub\n').join(' ')).toContain('Option Explicit')
  })
})

describe('swallowed errors', () => {
  it('is an error when it is never turned off, since the fault being hunted vanishes', () => {
    const findings = checkVba({ code: 'Option Explicit\nSub A()\nOn Error Resume Next\nFoo\nEnd Sub\n' })
    expect(findings[0]?.severity).toBe('error')
    expect(findings[0]?.message).toContain('silently discarded')
  })

  it('is only a warning when handling is restored afterwards', () => {
    const code = 'Option Explicit\nSub A()\nOn Error Resume Next\nFoo\nOn Error GoTo Fail\nExit Sub\nFail:\nEnd Sub\n'
    expect(checkVba({ code })[0]?.severity).toBe('warning')
  })
})

describe('block structure', () => {
  it('catches a Sub that is never closed', () => {
    expect(messages('Option Explicit\nSub A()\n').join(' ')).toContain('is never closed')
  })

  it('catches an End that closes the wrong kind of block', () => {
    expect(messages('Option Explicit\nSub A()\nEnd Function\n').join(' ')).toContain('closes a `Sub`')
  })

  it('catches a missing End If', () => {
    expect(messages('Option Explicit\nSub A()\nIf x Then\nEnd Sub\n').join(' ')).toContain('no `End If`')
  })

  /** A one-line If needs no End If, and reporting one would fire on ordinary working code. */
  it('leaves a single-line If alone', () => {
    expect(messages('Option Explicit\nSub A()\nIf x Then y = 1\nEnd Sub\n')).toEqual([])
  })

  it('leaves With and Do blocks alone when they are closed properly', () => {
    const code = 'Option Explicit\nSub A()\nWith Range("A1")\n.Value = 1\nEnd With\nDo While x\nLoop\nEnd Sub\n'
    expect(messages(code)).toEqual([])
  })
})

describe('error handlers', () => {
  it('catches a handler jumping to a label that does not exist', () => {
    expect(messages('Option Explicit\nSub A()\nOn Error GoTo Nowhere\nEnd Sub\n').join(' ')).toContain('not defined')
  })

  it('accepts one whose label is defined', () => {
    expect(messages('Option Explicit\nSub A()\nOn Error GoTo Fail\nExit Sub\nFail:\nEnd Sub\n')).toEqual([])
  })
})

describe('sheet references', () => {
  /** A renamed tab is the commonest way a working macro starts failing, and VBA names nothing. */
  it('catches a reference to a sheet the workbook does not have', () => {
    const found = messages('Option Explicit\nSub A()\nSheets("Old Name").Range("A1").Value = 1\nEnd Sub\n', ['Data'])
    expect(found.join(' ')).toContain('Old Name')
    expect(found.join(' ')).toContain('Sheets present: Data')
  })

  it('says nothing when the sheet is there', () => {
    expect(messages('Option Explicit\nSub A()\nSheets("Data").Range("A1").Value = 1\nEnd Sub\n', ['Data'])).toEqual([])
  })

  /** With no sheet list the check cannot be made, and guessing would be worse than silence. */
  it('says nothing when the workbook sheets are unknown', () => {
    expect(messages('Option Explicit\nSub A()\nSheets("Anything").Range("A1").Value = 1\nEnd Sub\n')).toEqual([])
  })
})

describe('comments and strings', () => {
  /** A rule that fires on prose is a rule people learn to ignore. */
  it('does not fire on a rule name mentioned in a comment', () => {
    expect(messages("Option Explicit\nSub A()\n' remember On Error Resume Next is bad\nEnd Sub\n")).toEqual([])
  })

  it('does not treat a sheet name inside a string as a reference', () => {
    expect(messages('Option Explicit\nSub A()\nDebug.Print "Sheets(""Ghost"")"\nEnd Sub\n', ['Data'])).toEqual([])
  })
})

describe('Select', () => {
  it('is flagged as a warning, since it makes a macro depend on what is active', () => {
    const findings = checkVba({ code: 'Option Explicit\nSub A()\nRange("A1").Select\nEnd Sub\n' })
    expect(findings[0]?.severity).toBe('warning')
  })

  /** `Select Case` is unrelated and must not be caught by the same rule. */
  it('does not fire on Select Case', () => {
    expect(messages('Option Explicit\nSub A()\nSelect Case x\nEnd Select\nEnd Sub\n')).toEqual([])
  })
})
