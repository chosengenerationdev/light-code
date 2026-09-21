import type { Mode } from './types.js'

/**
 * Two built-in modes (CLAUDE.md §8). **Ask *is* the read-only mode** — it is not a
 * separate flag layered on top of Code. Custom user-defined modes are deferred.
 *
 * This mechanism doubles as the tool-profile system for context budgeting (§12), which is
 * why selection happens at mode boundaries rather than per turn: swapping tool
 * definitions mid-session would invalidate the prompt-cache prefix and everything after it.
 */
export const CODE_MODE: Mode = {
  id: 'code',
  name: 'Code',
  description: 'Full access: read, edit, run commands, and use MCP tools.',
  groups: ['read', 'edit', 'command', 'mcp', 'always'],
}

export const ASK_MODE: Mode = {
  id: 'ask',
  name: 'Ask',
  description:
    'Read-only: inspect the workspace and answer questions. Cannot edit or run commands.',
  groups: ['read', 'mcp', 'always'],
}

/**
 * Junior mode: a cheap model does the work, Claude does the thinking.
 *
 * ## The economics this is shaped by, because they are not obvious
 *
 * The saving does **not** come from Claude doing less thinking. It comes from Claude never
 * seeing the *mechanical* token volume of an agentic run — file reads, ripgrep output, test
 * failures, lint noise, retries, tool-call plumbing. In an all-Claude session every one of
 * those enters the context and is re-sent for the remainder of the task. Here they stay with
 * the junior, which is cheap per token.
 *
 * Against that, **every consultation is a cold start.** A single Claude session has a cached
 * prefix, so a late turn costs a fraction of a fresh one; `ask_expert` spawns the CLI anew
 * each time and pays full price for context it had a moment earlier and discarded.
 *
 * So the mode saves money in proportion to *mechanical work absorbed minus consultations
 * spent*, and a junior that consults on every step will cost **more** than simply running
 * Claude — a plausible, expensive mistake, which is why the guidance below spends most of its
 * words rationing consultations rather than encouraging them.
 *
 * The second lever is context gathering. The expert can `Read`/`Grep` for itself, and each of
 * those is an internal turn on the expensive model. A junior that pastes in the code it has
 * already read converts that spend into its own, which is the whole point of the arrangement.
 */
/**
 * Agent team: the assistant leads, and consults specialists it was given.
 *
 * This is what Junior mode became. The old shape had one specialist — "the expert", meaning Claude
 * through its CLI — and a prompt largely about rationing it, because every consultation was a
 * cold start on a metered command line. Both halves of that stopped being general: a specialist
 * can now be any configured model, and the useful question is not *is this hard enough for Claude*
 * but *who is the right reader for this*.
 *
 * The guidance is **assembled per turn** from the configured team rather than written here, so it
 * names the roles that actually exist — a model told to consult a reviewer that was never assigned
 * spends a step being refused and then trusts the rest of the instruction less. See
 * `agents/guidance.ts`, including why the advice half is editable and the roster half is not.
 */
export const AGENT_TEAM_MODE: Mode = {
  id: 'agent-team',
  name: 'Agent team',
  description:
    'You lead; specialists you assign are consulted as needed. Requires at least one agent.',
  groups: ['read', 'edit', 'command', 'mcp', 'always'],
  requiresExpert: true,
}

/**
 * Auto mode: the terminal is the first tool, not the last.
 *
 * Requested as "auto mode like yours" — the way a coding agent works when it reads with `cat`,
 * searches with `grep`, and makes a mechanical change with `sed` or a heredoc, reaching for the
 * dedicated file tools only where the shell genuinely cannot do the job.
 *
 * ## Why it is a mode rather than a setting
 *
 * It is entirely a matter of *guidance* — the tools are identical to Code mode's, and nothing is
 * withheld. Section 8's mechanism is exactly that: a named selection of behaviour resolved once
 * per turn, which is also what keeps it safe for the prompt cache (§12). A checkbox would have to
 * vary the prompt without a boundary to vary it at.
 *
 * ## What it actually trades, stated plainly
 *
 * **The approval prompt stops showing a diff.** `apply_diff` computes what changes and the user
 * approves *that*; `sed -i 's/a/b/' file` is ground truth about the command and says nothing about
 * what the file will look like afterwards. Invariant 8 is satisfied either way — the literal
 * command is shown, and it is what runs — but the user is being asked to read a command rather
 * than a change, and those are not equally easy to judge. So the guidance keeps content edits on
 * `apply_diff` and sends the mechanical work to the shell, which is where the shell is better
 * anyway.
 *
 * **Every command is still approved.** Nothing here widens the gate; a model that runs twelve
 * small commands asks twelve times. The guidance says to work in fewer, larger commands for that
 * reason, and it is why this mode pairs with the command allowlist rather than replacing it.
 *
 * **`cat` is not `read_file`.** The read-before-edit constraint (§6) is populated by `read_file`
 * alone, deliberately — it is what makes a hallucinated edit impossible. Reading a file in the
 * terminal does not satisfy it, so a fall back to `apply_diff` costs a `read_file` first. Said in
 * the guidance because the alternative is discovering it as a refused edit.
 */
export const AUTO_MODE: Mode = {
  id: 'auto',
  name: 'Auto',
  description:
    'Shell-first: read, search and make mechanical changes through the terminal, with the file ' +
    'tools kept for edits worth reading as a diff.',
  groups: ['read', 'edit', 'command', 'mcp', 'always'],
  // Edits arrive as commands here, so the task's rollback point has to be taken before the
  // first command rather than before the first `edit` tool. See `Mode.commandsEdit`.
  commandsEdit: true,
  guidance: [
    '## Working through the terminal',
    '',
    'Use execute_command wherever a command can do the job, in preference to the dedicated file',
    'tools:',
    '',
    '- **Reading**: print the part you need rather than a whole file — the equivalent of',
    '  `sed -n 200,260p`, `head`, or `tail` in whatever shell you are in.',
    '- **Searching**: grep/ripgrep and find, including for things no tool covers — counting',
    '  matches, listing by modification time, piping one search into another.',
    '- **Mechanical edits**: renames, moves, deletions, a substitution across many files, running',
    '  a formatter or codemod, creating a file from a heredoc.',
    '- **Everything a command already does well**: git, the package manager, the test runner,',
    '  building, and reading their output.',
    '',
    '### What stays on the dedicated tools',
    '',
    '- **Edits to code a person would want to read before approving.** Use apply_diff or',
    '  write_to_file for those. The approval prompt renders a real diff for them and can only',
    '  show the command line for a shell edit, so the user is judging a substitution rather than',
    '  a change. Mechanical is fine in the shell; consequential is not.',
    '- **read_file before any apply_diff or write_to_file on an existing file.** Reading it in the',
    '  terminal does not count, and the edit will be refused. That is deliberate, not a bug.',
    '',
    '### Two things that make this cheaper',
    '',
    '- **Every command is approved separately.** Do the work in fewer, larger commands rather',
    '  than a sequence of small ones — a chained command, or one short script, costs the user one',
    '  decision instead of six.',
    '- **Some commands always stop and ask**, whatever the user has auto-approved: destructive and',
    '  history-rewriting ones, and anything they have marked risky themselves. Do not try to work',
    '  around a prompt by rephrasing the command — say what you want to do and why, and let them',
    '  decide.',
    '- **Use the shell you are actually in.** On Windows that is PowerShell unless it has been',
    '  configured otherwise, and PowerShell 5.1 has no `&&`, no `head`/`tail`/`which`, and its own',
    "  redirection rules. If you are unsure which shell you have, find out with one cheap command",
    '  rather than guessing and reading the parse error.',
    '',
    'Your edits through the shell are covered by the task checkpoint exactly like any other edit,',
    'so the user can still roll the workspace back.',
  ].join('\n'),
}

export const BUILTIN_MODES: readonly Mode[] = [CODE_MODE, ASK_MODE, AUTO_MODE, AGENT_TEAM_MODE]

export const DEFAULT_MODE_ID = CODE_MODE.id

/**
 * What `junior` used to mean.
 *
 * Kept as an alias rather than dropped: the id is written into every existing config file and
 * every per-project override, and an unknown id falls back to Code — so removing it would
 * silently move people to a different mode, with nothing to say why their assistant had stopped
 * consulting anyone.
 */
const RENAMED: Record<string, string> = { junior: AGENT_TEAM_MODE.id }

export function findMode(id: string | undefined): Mode {
  const resolved = id !== undefined ? (RENAMED[id] ?? id) : id
  return BUILTIN_MODES.find((mode) => mode.id === resolved) ?? CODE_MODE
}
