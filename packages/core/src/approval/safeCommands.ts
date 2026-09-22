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
  /*
   * ## Windows first, because that is where this runs
   *
   * Reported from real use: Auto mode still asked about "a lot of read-only commands". The list
   * was written entirely in Unix program names, and `execute_command` spawns with `shell: true`,
   * which on Windows is `%ComSpec%` - **cmd.exe**. So the two commonest read-only operations on
   * the primary platform, `type` and `findstr`, were not on the list at all, and neither was
   * anything else cmd provides.
   *
   * This is the same fault as 0.104.0's, one level up: that one covered `python` and missed
   * `py`, `python.exe` and an interpreter reached by path. This one covered `cat` and `grep` and
   * missed the shell they would have to run in. **Every miss is a prompt, and enough of them is
   * the mode being unusable rather than careful.**
   */
  // Reading and printing - cmd.exe.
  'type ',
  'more ',
  'tree',
  'vol',
  'ver',
  'chdir',
  // Reading and printing - POSIX, and the same names under Git Bash or WSL.
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
  'whoami',
  'hostname',
  'uname',
  /*
   * `date /t` and not `date`. In cmd.exe a bare `date` **prompts** for a new one and waits on
   * stdin, so auto-approving it would hang the tool until its timeout and report that as the
   * command being slow. `/t` prints and exits. POSIX `date` prints either way, and a shell that
   * has it will not have been reached by this entry.
   */
  'date /t',
  'printenv',
  'basename ',
  'dirname ',
  'realpath ',
  'readlink ',
  'nl ',
  'cut ',
  'comm ',
  'paste ',
  'sort ',
  'uniq ',
  'diff ',
  'cmp ',
  'du ',
  'df ',
  /*
   * `sed -n` and not `sed`, deliberately. `sed -i` edits in place - the program is only
   * read-only in part, so the phrase is what gets vouched for rather than the name. Same reason
   * `git status` is here and `git` is not.
   */
  'sed -n',
  // Hashes and dumps, for "is this the same file".
  'md5sum ',
  'sha1sum ',
  'sha256sum ',
  'cksum ',
  'od ',
  'xxd ',
  'certutil -hashfile',
  // Searching. `find` is deliberately absent - see the note above.
  'grep ',
  'findstr ',
  'rg ',
  'fd ',
  'ag ',
  /*
   * ## Git, read-only subcommands only
   *
   * Named one phrase at a time rather than trusting the program, because `git` as a whole is
   * emphatically not read-only. Anything that writes a ref, an object or the working tree is
   * absent: no `tag` (it lists with no argument and *creates* with one, and a prefix cannot tell
   * them apart), no `stash` beyond `list`, no `fetch`, no `checkout`, no `restore`.
   */
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git blame',
  'git remote -v',
  'git rev-parse',
  'git rev-list',
  'git ls-files',
  'git ls-tree',
  'git ls-remote',
  'git for-each-ref',
  'git show-ref',
  'git symbolic-ref',
  'git cat-file',
  'git describe',
  'git shortlog',
  'git name-rev',
  'git whatchanged',
  'git diff-tree',
  'git grep',
  'git check-ignore',
  'git count-objects',
  'git stash list',
  'git config --get',
  'git config --list',
  'git --version',
  /*
   * ## Versions
   *
   * A version flag cannot be made to do anything else, and "which toolchain is this" is the
   * question an agent asks first in an unfamiliar repository.
   */
  'python --version',
  'python3 --version',
  'py --version',
  'python -V',
  'python3 -V',
  'py -V',
  'node --version',
  'node -v',
  'npm --version',
  'npm -v',
  'pnpm --version',
  'pnpm -v',
  'yarn --version',
  'npx --version',
  'pip --version',
  'tsc --version',
  'go version',
  'cargo --version',
  'rustc --version',
  'java -version',
  'javac -version',
  'dotnet --version',
  'dotnet --info',
  'ruby --version',
  'perl --version',
  'php --version',
  'terraform version',
  'docker --version',
  /*
   * ## Listing what is installed
   *
   * All read-only. `npm install` and friends are a long way from here: these are the query
   * subcommands, named individually for the same reason the git ones are.
   */
  'pip list',
  'pip show ',
  'pip freeze',
  'npm ls',
  'npm list',
  'pnpm list',
  'pnpm why ',
  /*
   * ## Compiling and checking, which is not running
   *
   * `python -m py_compile` is here because compiling is not executing; `python -c` is not,
   * because it is. `compileall` walks a tree and writes bytecode beside the sources without ever
   * importing them, and it is how anybody compiles a *project* rather than one file.
   *
   * **Three near-misses are deliberately absent, and each fails one of the two questions:**
   * `eslint` and `ruff check` both take `--fix` and rewrite the files, so the program can write
   * through its own flags; `black` writes unless `--check` is given, so only the phrase carrying
   * `--check` is vouched for; and `pytest` runs the code it collects, which is the second
   * question, not the first.
   */
  'python -m py_compile',
  'python3 -m py_compile',
  'py -m py_compile',
  'python -m compileall',
  'python3 -m compileall',
  'py -m compileall',
  'python -m json.tool',
  'tsc --noEmit',
  'npx tsc --noEmit',
  'mypy ',
  'pyright ',
  'flake8 ',
  'pylint ',
  'black --check',
  'prettier --check',
  'cargo check',
  'go vet',
  'go build -n',
]

/** Whether a command could be more than one command. Conservative by construction. */
export function couldChain(command: string): boolean {
  return SHELL_METACHARACTERS.some((character) => command.includes(character))
}

/**
 * Interpreter options that change how Python runs without changing *what* it runs.
 *
 * Asked directly, about `-X`: is it dangerous? **No, and it is worth saying why rather than
 * asserting it.** `-X` is a bag of implementation options that land in `sys._xoptions`, and the
 * interpreter accepts keys it has never heard of — measured: `python -X totally_made_up_key
 * --version` prints the version and says nothing. It cannot name code to run. What runs is decided
 * by `-c`, `-m` or a filename, and those are judged exactly as before: after these flags are
 * skipped, `python -X dev app.py` is still `python app.py`, which still asks.
 *
 * So the reason `python -X utf8 -m py_compile app.py` was stopping for approval is not that
 * anything thought it risky. It is that a literal prefix cannot see past a flag, so a modifier
 * between the program and the action hid the action. Skipping the modifiers puts the action back
 * where the rule can see it.
 *
 * Each entry is here because it cannot execute anything: they select a Python, silence output,
 * ignore the environment, control bytecode, or set a warning filter. **Anything that names code
 * to run belongs nowhere near this list**, which is why `-c` and `-m` are absent - `-m` in
 * particular, because `-m py_compile` is a phrase somebody vouched for and `-m` alone is not.
 */
const INERT_PYTHON_FLAGS: Readonly<Record<string, number>> = {
  // Boolean: no value follows.
  '-B': 0,
  '-E': 0,
  '-I': 0,
  '-O': 0,
  '-OO': 0,
  '-P': 0,
  '-q': 0,
  '-S': 0,
  '-s': 0,
  '-u': 0,
  '-v': 0,
  // A value follows as a separate token. `-Xdev` and `-X dev` are both valid, so the glued
  // form is handled by prefix below rather than here.
  '-X': 1,
  '-W': 1,
}

/** Programs whose flags the list above describes. `py` is the Windows launcher. */
const PYTHON_PROGRAMS = new Set(['python', 'python3', 'py'])

/**
 * The command with inert interpreter options removed, so the action is where a prefix can see it.
 *
 * Applied only to Python, and only to the flags named above. A general flag-skipper would be a
 * much larger claim - that no program on the list has an option which changes what it does - and
 * that is not true of programs in general.
 */
function stripInertPythonFlags(command: string): string {
  const parts = command.split(' ')
  const program = parts[0]
  if (program === undefined || !PYTHON_PROGRAMS.has(program.toLowerCase())) return command

  const kept: string[] = [program]
  let index = 1
  while (index < parts.length) {
    const part = parts[index]
    if (part === undefined) break
    if (part.length === 0) {
      index += 1
      continue
    }

    const arity = INERT_PYTHON_FLAGS[part]
    if (arity !== undefined) {
      index += 1 + arity
      continue
    }
    // The glued forms: `-Xdev`, `-Wignore`. Never `-c...` or `-m...`, which are not listed.
    if (/^-[XW]./.test(part)) {
      index += 1
      continue
    }
    // A version selector for the `py` launcher: -3, -3.12, -3.12-64.
    if (program.toLowerCase() === 'py' && /^-\d+(\.\d+)?(-(32|64|arm64))?$/.test(part)) {
      index += 1
      continue
    }
    break
  }

  kept.push(...parts.slice(index))
  return kept.join(' ')
}

/**
 * The same command with its leading program reduced to a bare name.
 *
 * Reported from real use: compiling a Python file still asked in Auto mode. The list said
 * `python -m py_compile` and the command was
 * `D:\proj\.venv\Scripts\python.exe -m py_compile app.py` — the same act, spelled the way it is
 * actually spelled on Windows, where an interpreter is reached by path and carries `.exe`. A list
 * written in bare Unix program names covers almost nothing of what this product's primary platform
 * produces, and every miss is a prompt, which is the mode being unusable rather than careful.
 *
 * Only the **first token** is touched, and only by removing a directory and an executable suffix.
 * No grammar is involved: the chain check has already refused anything that could be more than one
 * command, so what is left is one program and its arguments.
 *
 * **What this concedes, stated plainly:** the list vouches for a program *name*, so a program of
 * that name anywhere on disk is now vouched for. That was already true — a bare `git` is whatever
 * `PATH` resolves it to, which is no more under our control than a path somebody typed. What it
 * does not concede is the §8 objection, because none of this decides whether a *pattern* covers a
 * command; the prefix rule is unchanged and still runs against a single unchainable command.
 */
export function normaliseProgram(command: string): string {
  const trimmed = command.trim()

  let program: string
  let rest: string
  if (trimmed.startsWith('"')) {
    // A quoted program, which is how a path containing a space arrives: "C:\Program Files\...".
    const close = trimmed.indexOf('"', 1)
    if (close === -1) return trimmed
    program = trimmed.slice(1, close)
    rest = trimmed.slice(close + 1)
  } else {
    const space = trimmed.indexOf(' ')
    program = space === -1 ? trimmed : trimmed.slice(0, space)
    rest = space === -1 ? '' : trimmed.slice(space)
  }

  const lastSeparator = Math.max(program.lastIndexOf('/'), program.lastIndexOf('\\'))
  const base = program.slice(lastSeparator + 1)
  // `.cmd` and `.bat` because `npm`, `pnpm` and `npx` are shims on Windows (§16).
  const bare = base.replace(/\.(exe|cmd|bat|com)$/i, '')

  // A path ending in a separator names no program; leave it alone rather than inventing one.
  return bare.length === 0 ? trimmed : bare + rest
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

  /*
   * Normalised *after* the chain check, never before. Normalising strips characters, so a
   * metacharacter inside a program's own path would be removed by it — checking the original is
   * what keeps `C:\\a&b\\python.exe ...` out.
   */
  const haystack = stripInertPythonFlags(normaliseProgram(trimmed)).toLowerCase()
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
