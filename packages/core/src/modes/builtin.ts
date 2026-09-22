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
  /*
   * Reading and searching stop being twenty prompts an hour.
   *
   * Reported from real use — compiling and reading both asked, which in a mode where nearly all
   * the work is commands is the mode being unusable rather than careful. Narrow by construction:
   * see `approval/safeCommands.ts` for what qualifies and why `find` and `python foo.py` do not.
   */
  autoApproveSafeCommands: true,
  /*
   * **No static guidance, deliberately.** It is built per turn by `buildAutoGuidance` from
   * the shell that will actually run and the tools this machine actually has.
   *
   * The version that used to sit here asserted "On Windows that is PowerShell", which was
   * false - commands run in cmd.exe - so on the primary platform the mode's own instructions
   * produced commands that could not run. A prompt that *states* the environment is a second
   * copy of something the host already knows, and it drifts the moment either changes. See
   * `modes/autoGuidance.ts`.
   */
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
