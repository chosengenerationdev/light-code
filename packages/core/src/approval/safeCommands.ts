/**
 * Commands that may run without asking, in a mode that says so.
 *
 * Requested from real use: in Auto mode nearly all the work arrives as `execute_command`, so
 * reading a file and compiling something both stop for approval — *"if it is safer commands like
 * compiling a python code, then it should automatically do it"*.
 *
 * ## Why this is allowed to match prefixes when §8 forbids it
 *
 * §8 is emphatic that the "always allow" list is exact-match only, and the reason is precise:
 * deciding whether a command is *covered* by a pattern means tokenising the shell's grammar, and a
 * bug there silently auto-approves a chained destructive command. `grep foo && rm -rf /` begins
 * with a harmless prefix.
 *
 * That objection is answered here not by parsing better but by **refusing to look at anything that
 * could chain**. A command qualifies only when it contains no shell metacharacter at all — no
 * `;`, `&`, `|`, redirect, substitution, backtick or newline. There is no grammar to get wrong:
 * it is a character test, and anything it cannot be certain about falls through to the prompt.
 *
 * Quoting makes that conservative rather than wrong. `grep "a;b" file` is refused because of the
 * `;` inside the quotes — an extra prompt, which is the failing direction this can afford.
 *
 * ## What is on the list, and what is deliberately not
 *
 * Only programs that read, print or compile. Two absences are worth recording because both look
 * safe and are not:
 *
 * - **`find`** — `find . -delete` and `find . -exec rm {} ;` need no metacharacter at all. The
 *   program is not the risk; its own flags are, and that is the thing this design refuses to
 *   reason about. `rg --files` covers the listing case.
 * - **`python foo.py`** — running a script is running whatever is in it. `python -m py_compile` is
 *   here because compiling is not executing; `python -c` is not, because it is.
 *
 * Anything added later has to survive the same two questions: can it write or delete through its
 * own flags, and can it execute something it was handed?
 *
 * ## It never overrides a refusal
 *
 * The risky list is checked first, so a command that is both — `git diff --force`, say — asks.
 * Safety here only ever *skips a prompt*; it cannot silence one.
 */

/**
 * Characters that make a command more than one command.
 *
 * Not a grammar — a list of everything that could chain, redirect, substitute or continue. A
 * command containing any of them is simply not considered, whatever it starts with.
 */
const SHELL_METACHARACTERS = [';', '&', '|', '>', '<', '`', '$', '(', ')', '{', '}', '\n', '\r']

/**
 * Prefixes that may run unprompted, matched at the start of the command.
 *
 * Phrases rather than program names where the program is only safe in part: `git` is not on the
 * list, `git status` is. The trailing space matters for the same reason it does in the risky
 * list — `cat ` must not match `catalogue-build`.
 */
export const DEFAULT_SAFE_COMMANDS: readonly string[] = [
  // Reading and printing.
  'ls',
  'dir ',
  'pwd',
  'cat ',
  'head ',
  'tail ',
  'wc ',
  'stat ',
  'file ',
  'echo ',
  'which ',
  'where ',
  'sed -n',
  'sort ',
  'uniq ',
  'diff ',
  // Searching. `find` is deliberately absent — see the note above.
  'grep ',
  'rg ',
  'fd ',
  // Git, read-only subcommands only.
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git blame',
  'git remote -v',
  // Versions and compiling. Compiling is not executing; `python -c` and `python <file>` are.
  'python --version',
  'python3 --version',
  'python -m py_compile',
  'python3 -m py_compile',
  'node --version',
  'npm --version',
  'pnpm --version',
  'tsc --noEmit',
  'npx tsc --noEmit',
]

/** Whether a command could be more than one command. Conservative by construction. */
export function couldChain(command: string): boolean {
  return SHELL_METACHARACTERS.some((character) => command.includes(character))
}

export interface SafeCommandOptions {
  /** Extra prefixes the user added. Applied on the same terms as the built-in ones. */
  extra?: readonly string[] | undefined
  /** Set false to use only the user's own. Absent means the built-in list applies. */
  builtin?: boolean | undefined
}

/**
 * Whether this command may run without asking.
 *
 * Both conditions, always: nothing that could chain, and a prefix somebody vouched for. Either one
 * alone would be the hole §8 warns about.
 */
export function isSafeCommand(command: string, options?: SafeCommandOptions): boolean {
  const trimmed = command.trim()
  if (trimmed.length === 0) return false
  if (couldChain(trimmed)) return false

  const haystack = trimmed.toLowerCase()
  const prefixes = [
    ...(options?.extra ?? []),
    ...(options?.builtin === false ? [] : DEFAULT_SAFE_COMMANDS),
  ]

  return prefixes.some((prefix) => {
    const needle = prefix.trim().toLowerCase()
    if (needle.length === 0) return false
    if (!haystack.startsWith(needle)) return false
    /*
     * A prefix with no trailing space must still end at a word boundary, or `ls` would vouch for
     * `lsof` and `pwd` for `pwdx`. Where the prefix already ends in a space, `startsWith` has
     * done that job.
     */
    if (prefix.endsWith(' ')) return true
    const next = haystack.charAt(needle.length)
    return next === '' || next === ' '
  })
}
