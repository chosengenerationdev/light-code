import type { CommandToolset, ResolvedShell } from '../platform/node/shell.js'

/**
 * Auto mode's instructions, built from what this machine actually has.
 *
 * ## The two faults this replaces, both real and both Windows-only
 *
 * **It named the wrong shell.** The guidance said *"On Windows that is PowerShell unless it has
 * been configured otherwise"*. It is cmd.exe, nothing had ever configured it otherwise, and
 * `Get-ChildItem` in cmd answers *"is not recognized as an internal or external command"*. So on
 * the platform this product is primarily used on, the mode's own advice produced commands that
 * could not run.
 *
 * **Its advice about cost was backwards.** It said to work in fewer, larger, chained commands
 * because each one is approved separately. That is right in Code mode and **wrong in Auto**: a
 * command containing `&` can never be auto-approved — the safe list refuses anything that could
 * be two commands — so chaining converts several free commands into one that stops and asks. The
 * model was being told to do the expensive thing, in the mode built to avoid it.
 *
 * ## Why it is generated
 *
 * A prompt that *states* the environment is a second copy of something the host already knows,
 * and it drifts the moment either changes — which is exactly what happened. `buildTeamGuidance`
 * made the same move for the same reason, and `agents/briefing.ts` records why a generated
 * roster beats a written one. Ground truth, in the prompt.
 */

export interface AutoGuidanceEnvironment {
  shell: ResolvedShell
  tools: CommandToolset
  platform?: NodeJS.Platform | undefined
}

/** The idiom for a job, in the shell that is actually running. */
interface ShellIdioms {
  readPart: string
  search: string
  listing: string
  chain: string
  notes: string[]
  /**
   * Fully-formed commands this guidance holds up as the way to work.
   *
   * Exported through `autoExamples` so a test can assert **every one of them is auto-approved**.
   * That is the whole of what "Auto mode works as advertised" means: the mode promises that
   * reading and searching do not interrupt you, and an idiom in the prompt that stops for
   * approval breaks the promise silently - the model does as it was told and the user gets the
   * prompts the mode existed to remove.
   */
  examples: string[]
}

function idiomsFor(environment: AutoGuidanceEnvironment): ShellIdioms {
  const has = (name: string): boolean => environment.tools.present.includes(name)
  const grep = has('rg') ? 'rg' : has('grep') ? 'grep' : has('findstr') ? 'findstr' : undefined

  if (environment.shell.kind === 'cmd') {
    return {
      readPart: has('sed')
        ? '`sed -n 200,260p file` for a range, `type file` for a whole small one'
        : '`type file` for a whole file, and `more +200 file` to skip ahead — this shell has no `sed`, so read a range with read_file instead',
      search: grep === 'findstr' ? '`findstr /s /n /i pattern *.ts`' : `\`${grep ?? 'findstr'}\``,
      listing: '`dir /b /s`',
      chain: '`&&`',
      examples: [
        'type package.json',
        'dir /b /s',
        ...(has('sed') ? ['sed -n 200,260p src/app.ts'] : ['more +200 README.md']),
        grep === 'findstr' ? 'findstr /s /n /i TODO *.ts' : `${grep ?? 'findstr'} -rn TODO src`,
        'git status',
        'git diff --stat',
      ],
      notes: [
        'This is **cmd.exe**, not PowerShell. `Get-ChildItem`, `Select-String`, `Test-Path` and' +
          ' every other cmdlet will fail with "is not recognized". So will `$variables` and' +
          ' PowerShell operators.',
        'Environment variables are `%NAME%`, not `$NAME`.',
      ],
    }
  }

  if (environment.shell.kind === 'powershell' || environment.shell.kind === 'pwsh') {
    return {
      readPart: '`Get-Content file -TotalCount 60` and `-Tail 60`',
      search: '`Select-String -Path *.ts -Pattern foo`',
      listing: '`Get-ChildItem -Recurse -Name`',
      chain: environment.shell.kind === 'pwsh' ? '`&&`' : '`;` (5.1 has no `&&`)',
      examples: ['git status', 'git diff --stat', 'git log --oneline -20'],
      notes: [
        'This is **PowerShell**. Its aliases shadow the GNU tools: `ls`, `sort`, `diff`, `where`' +
          ' and `cat` are cmdlets, so GNU arguments like `ls -la` or `head -5` will fail. Call' +
          ' the cmdlet, or the real executable by name with its extension.',
        ...(environment.shell.kind === 'powershell'
          ? ['Windows PowerShell 5.1 has no `&&` and no `??`. Use `;` or separate commands.']
          : []),
      ],
    }
  }

  return {
    readPart: '`sed -n 200,260p file`, `head`, `tail`',
    search: `\`${grep ?? 'grep'}\``,
    listing: '`ls`, `find`',
    chain: '`&&`',
    examples: [
      'ls src',
      'sed -n 200,260p src/app.ts',
      `${grep ?? 'grep'} -rn TODO src`,
      'git status',
      'git diff --stat',
    ],
    notes: [],
  }
}

/**
 * A shell named the way somebody would say it, not as an absolute path.
 *
 * `%ComSpec%` is `C:\WINDOWS\system32\cmd.exe`, and putting that in the prompt is noise that
 * also invites the model to *invoke* it by path - which would then contain no brackets here but
 * does under `Program Files`, turning a free command into a prompt.
 */
function shellName(label: string): string {
  // Both separators. Splitting on `/` alone left a Windows `%ComSpec%` path entirely intact,
  // which is the whole case this exists for.
  const base = label.split(/[\\/]/).pop() ?? label
  return base.length > 0 ? base : label
}

/** The concrete commands this guidance recommends. See `ShellIdioms.examples`. */
export function autoExamples(environment: AutoGuidanceEnvironment): string[] {
  return idiomsFor(environment).examples
}

export function buildAutoGuidance(environment: AutoGuidanceEnvironment): string {
  const idioms = idiomsFor(environment)
  const missing = environment.tools.missing
  const present = environment.tools.present

  const lines: string[] = [
    '## Working through the terminal',
    '',
    `Commands run in **${shellName(environment.shell.label)}**, from the workspace root. Use`,
    'execute_command wherever a command can do the job, in preference to the dedicated file',
    'tools:',
    '',
    `- **Reading**: print the part you need rather than a whole file — ${idioms.readPart}.`,
    `- **Searching**: ${idioms.search}, including for things no tool covers — counting matches,`,
    `  listing by modification time, ${idioms.listing}.`,
    '- **Mechanical edits**: renames, moves, deletions, a substitution across many files, running',
    '  a formatter or codemod.',
    '- **Everything a command already does well**: git, the package manager, the test runner,',
    '  building, and reading their output.',
    '',
  ]

  if (idioms.notes.length > 0) {
    lines.push('### The shell you are in', '')
    for (const note of idioms.notes) lines.push(`- ${note}`)
    lines.push('')
  }

  /*
   * What is on PATH, stated rather than assumed.
   *
   * On a developer machine with Git for Windows this is most of the POSIX toolkit and it works
   * in cmd; on a locked-down corporate build it is none of it, and guidance naming `grep` and
   * `sed` produces a run of "not recognized" errors that reads as the assistant being broken.
   */
  if (present.length > 0) {
    lines.push(
      `**Available here:** ${present.map((name) => `\`${name}\``).join(', ')}.`,
      ...(missing.length > 0
        ? [
            `**Not on this machine:** ${missing.map((name) => `\`${name}\``).join(', ')} — do not`,
            '  reach for these; use read_file and search_files instead of guessing at a substitute.',
          ]
        : []),
      '',
    )
  }

  lines.push(
    '### What stays on the dedicated tools',
    '',
    '- **Edits to code a person would want to read before approving.** Use apply_diff or',
    '  write_to_file for those. The approval prompt renders a real diff for them and can only',
    '  show the command line for a shell edit, so the user is judging a substitution rather than',
    '  a change. Mechanical is fine in the shell; consequential is not.',
    '- **read_file before any apply_diff or write_to_file on an existing file.** Reading it in the',
    '  terminal does not count, and the edit will be refused. That is deliberate, not a bug.',
    '',
    '### How to keep this cheap, which is the opposite of what you may expect',
    '',
    '- **Read-only commands run without asking in this mode. Chained ones never do.** Anything',
    `  containing ${idioms.chain}, \`|\`, \`&\`, \`;\`, a redirect, a backtick or \`$\` is treated as`,
    '  possibly-two-commands and always stops for approval, however harmless it looks. So do',
    '  **not** combine steps to save approvals: three separate reads cost you nothing, and the',
    '  same three joined together cost the user a decision.',
    `- **Invoke programs by bare name** — ${present
      .slice(0, 3)
      .map((name) => `\`${name}\``)
      .join(', ')} — rather than by full path. A path`,
    '  under `Program Files (x86)` contains brackets, which fall into the same rule and turn a',
    '  free command into a prompt.',
    '- **Some commands always stop and ask**, whatever is auto-approved: destructive and',
    '  history-rewriting ones, and anything the user has marked risky. Do not rephrase a command',
    '  to get around a prompt — say what you want to do and why, and let them decide.',
    '- If a read-only command you expect to be free keeps asking, it is simply not on the list.',
    '  Say so: the user can add it in Settings → Approvals, where the whole list is shown.',
    '',
    'Your edits through the shell are covered by the task checkpoint exactly like any other edit,',
    'so the user can still roll the workspace back.',
  )

  return lines.join('\n')
}
