/**
 * Static checks over VBA source, without running anything.
 *
 * ## Why a checker at all, when the macro could just be run
 *
 * Running is the expensive move: it changes the workbook, it needs approval, and it tells you
 * about the *first* thing that goes wrong and nothing about the rest. Most of what breaks VBA in
 * practice is visible in the text — a name that no longer matches a sheet, an `On Error Resume
 * Next` that has been swallowing the real failure for a year, a variable that is a typo of
 * another one. Finding those costs nothing and risks nothing.
 *
 * ## What this is not
 *
 * Not a VBA parser and not a compiler. It reads structure and names, and it is deliberately
 * conservative: every rule here either points at something definitely wrong or something worth a
 * second look, because a checker that cries wolf gets ignored and then the real finding is
 * ignored with it. Anything needing real evaluation — types, overload resolution, whether a
 * Variant holds what you think — is left to running the thing.
 */

export interface VbaFinding {
  line: number
  /** `error` is definitely wrong. `warning` is worth looking at and may be deliberate. */
  severity: 'error' | 'warning'
  message: string
}

export interface VbaCheckInput {
  code: string
  /** Sheet names in the workbook, so a reference to a missing one can be spotted. */
  sheets?: readonly string[]
}

/**
 * Two views of a line, because the rules need different things.
 *
 * `bare` has comments *and* string contents removed, so a keyword rule cannot fire on prose —
 * a comment saying "On Error Resume Next is bad" must not be reported as swallowing errors.
 *
 * `quoted` keeps the strings, because the sheet-name rule is *about* a string: `Sheets("Data")`
 * is invisible once the quotes are blanked. This split is here because blanking everything was
 * the first version and it silently disabled the sharpest check in the file.
 *
 * An apostrophe only starts a comment outside a string, which is why both are computed in one
 * pass rather than by two independent regexes.
 */
function splitLine(line: string): { bare: string; quoted: string } {
  let bare = ''
  let quoted = ''
  let inString = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string
    if (character === '"') {
      inString = !inString
      quoted += character
      continue
    }
    if (!inString && character === "'") break
    quoted += character
    bare += inString ? ' ' : character
  }
  return { bare, quoted }
}

const BLOCK_OPENERS: [RegExp, string][] = [
  [/^\s*(?:public\s+|private\s+|friend\s+)?(?:static\s+)?sub\s+\w+/i, 'Sub'],
  [/^\s*(?:public\s+|private\s+|friend\s+)?(?:static\s+)?function\s+\w+/i, 'Function'],
  [/^\s*(?:public\s+|private\s+)?property\s+(?:get|let|set)\s+\w+/i, 'Property'],
  [/^\s*with\s+\S/i, 'With'],
  [/^\s*(?:do\s+while|do\s+until|do)\s*$|^\s*do\s+(?:while|until)\s+/i, 'Do'],
  [/^\s*select\s+case\s+/i, 'Select Case'],
]

const BLOCK_CLOSERS: [RegExp, string][] = [
  [/^\s*end\s+sub\b/i, 'Sub'],
  [/^\s*end\s+function\b/i, 'Function'],
  [/^\s*end\s+property\b/i, 'Property'],
  [/^\s*end\s+with\b/i, 'With'],
  [/^\s*loop\b/i, 'Do'],
  [/^\s*end\s+select\b/i, 'Select Case'],
]

export function checkVba(input: VbaCheckInput): VbaFinding[] {
  const findings: VbaFinding[] = []
  const split = input.code.split(/\r?\n/).map(splitLine)
  const lines = split.map((entry) => entry.bare)

  /*
   * The single most valuable check, and the reason this file exists.
   *
   * Without `Option Explicit` a mistyped name is a new empty Variant rather than an error, so the
   * macro runs and quietly does the wrong thing. That is the failure people bring to a debugger
   * having already lost an afternoon to it.
   */
  if (!lines.some((line) => /^\s*option\s+explicit\b/i.test(line))) {
    findings.push({
      line: 1,
      severity: 'warning',
      message:
        'No Option Explicit. Any mistyped name becomes a new empty variable instead of an error, ' +
        'so the macro runs and silently does the wrong thing. Adding it is the single best change ' +
        'you can make to this module.',
    })
  }

  const stack: { kind: string; line: number }[] = []
  const ifStack: number[] = []

  lines.forEach((line, index) => {
    const number = index + 1

    for (const [pattern, kind] of BLOCK_OPENERS) {
      // `Declare` is a statement, not a procedure body, and has no `End Sub`.
      if (pattern.test(line) && !/^\s*(?:public\s+|private\s+)?declare\b/i.test(line)) {
        stack.push({ kind, line: number })
        break
      }
    }
    for (const [pattern, kind] of BLOCK_CLOSERS) {
      if (pattern.test(line)) {
        const open = stack.pop()
        if (open === undefined) {
          findings.push({ line: number, severity: 'error', message: `\`End ${kind}\` with nothing open before it.` })
        } else if (open.kind !== kind) {
          findings.push({
            line: number,
            severity: 'error',
            message: `\`End ${kind}\` closes a \`${open.kind}\` opened on line ${String(open.line)}.`,
          })
        }
        break
      }
    }

    // A one-line `If ... Then something` needs no `End If`; only a bare `Then` opens a block.
    if (/^\s*if\b.*\bthen\s*$/i.test(line)) ifStack.push(number)
    if (/^\s*end\s+if\b/i.test(line)) {
      if (ifStack.pop() === undefined) {
        findings.push({ line: number, severity: 'error', message: '`End If` with no matching `If`.' })
      }
    }

    if (/\bon\s+error\s+resume\s+next\b/i.test(line)) {
      const restored = lines.slice(index + 1).some((later) => /\bon\s+error\s+goto\s+/i.test(later))
      findings.push({
        line: number,
        severity: restored ? 'warning' : 'error',
        message: restored
          ? 'On Error Resume Next hides every failure until error handling is restored. If you are ' +
            'debugging, the fault you are looking for may be happening inside this stretch.'
          : 'On Error Resume Next is never turned off in this module, so every error after this ' +
            'line is silently discarded — including the one you are trying to find. Errors vanish ' +
            'rather than being reported.',
      })
    }

    if (/\bgoto\s+0\b/i.test(line) === false && /^\s*on\s+error\s+goto\s+(\w+)/i.test(line)) {
      const label = /^\s*on\s+error\s+goto\s+(\w+)/i.exec(line)?.[1]
      if (label !== undefined && !lines.some((other) => new RegExp(`^\\s*${label}\\s*:`, 'i').test(other))) {
        findings.push({ line: number, severity: 'error', message: `Error handler jumps to \`${label}\`, which is not defined.` })
      }
    }

    /*
     * Sheet references by name, checked against the workbook.
     *
     * A renamed tab is one of the most common ways a working macro starts failing, and the error
     * VBA gives — "subscript out of range" — names nothing at all.
     */
    if (input.sheets !== undefined && input.sheets.length > 0) {
      // Read from the form that still has its strings; see `splitLine`.
      for (const match of (split[index]?.quoted ?? '').matchAll(/(?:Sheets|Worksheets)\(\s*"([^"]+)"\s*\)/gi)) {
        const name = match[1] as string
        if (!input.sheets.includes(name)) {
          findings.push({
            line: number,
            severity: 'error',
            message: `Refers to sheet "${name}", which is not in this workbook. Sheets present: ${input.sheets.join(', ')}.`,
          })
        }
      }
    }

    if (/\bselect\b/i.test(line) && /\b(?:range|cells|sheets|worksheets)\b/i.test(line) && !/select\s+case/i.test(line)) {
      findings.push({
        line: number,
        severity: 'warning',
        message:
          'Selecting to work with a range makes the macro depend on what is active, so it behaves ' +
          'differently when run from a different sheet. Acting on the range directly is both ' +
          'faster and predictable.',
      })
    }
  })

  for (const open of stack) {
    findings.push({ line: open.line, severity: 'error', message: `\`${open.kind}\` opened here is never closed.` })
  }
  for (const line of ifStack) {
    findings.push({ line, severity: 'error', message: '`If` block opened here has no `End If`.' })
  }

  return findings.sort((a, b) => a.line - b.line)
}
