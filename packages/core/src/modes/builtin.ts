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

export const BUILTIN_MODES: readonly Mode[] = [CODE_MODE, ASK_MODE, AGENT_TEAM_MODE]

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
