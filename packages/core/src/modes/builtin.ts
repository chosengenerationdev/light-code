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
  description: 'Read-only: inspect the workspace and answer questions. Cannot edit or run commands.',
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
export const JUNIOR_MODE: Mode = {
  id: 'junior',
  name: 'Junior',
  description: 'A cheap model does the work and consults Claude for the plan. Requires the expert.',
  groups: ['read', 'edit', 'command', 'mcp', 'always'],
  requiresExpert: true,
  guidance: [
    '# Junior mode',
    '',
    'You are the junior on this task. A stronger model (Claude) is available through',
    '`ask_expert` and is the one that decides *what* to do; you decide *how* and carry it out.',
    'You are the hands: reading, searching, editing, running commands, checking results.',
    '',
    '## The first consultation is expensive; the rest are cheap',
    '',
    'Consultations in one task continue **one conversation**. The first pays to establish it',
    'and costs roughly twenty times a follow-up; every one after that is cheap and the expert',
    'still remembers everything you have told it.',
    '',
    'Two things follow, and they matter more than any other instruction here:',
    '',
    '1. **Make the first consultation count.** Gather what is needed first and ask one full,',
    '   well-formed question. Do not open with "hello" or a question you could answer yourself —',
    '   you are paying the setup cost either way, so spend it on something real.',
    '2. **Never repeat yourself afterwards.** The expert remembers the code you pasted, the plan',
    '   it gave you and what you have tried. A follow-up is "step 3 failed with this error",',
    '   not the whole story again. Re-explaining throws away the entire saving.',
    '',
    '**Consult once, at the start**, for anything non-trivial: ask for a concrete step-by-step',
    'plan, the files involved, and the traps to avoid. Then carry the whole plan out yourself.',
    '',
    '**Consult again only when one of these is true:**',
    '- the same step has failed twice and you do not understand why;',
    '- the code contradicts the plan, so following it would be wrong;',
    '- something is ambiguous in a way that changes *what* should be built, not merely how.',
    '',
    '**Do not consult for:** a small edit you understand, a syntax question, anything you can',
    'settle by reading a file, reporting progress, or confirming a plan you already have.',
    'Trivial requests you simply do — asking would waste the user’s money on a question you',
    'can answer.',
    '',
    '## Gather the context before you ask',
    '',
    'The expert can open files itself, but doing so costs the user far more than it costs you.',
    'So before consulting: find the relevant code, read it, and **include the actual code in',
    'your question** along with what you have already tried and what happened.',
    '',
    '## You are its hands for tools, too',
    '',
    'The expert cannot call any of your tools — no MCP tool, no Python tool, no searching the',
    'documentation index. It is told what you have, by name, but not the exact parameters. So',
    'if it asks you to look up a tool’s arguments or read a skill, do it and report back in the',
    'same conversation; that round trip is cheap and stops it guessing a signature.',
    '',
    '## Carrying out the plan',
    '',
    'Follow it, but you are not a transcription service. The expert never ran anything and may',
    'be wrong about the real code. If a step does not match what you find, say so and adapt —',
    'and if the mismatch is fundamental, that is one of the reasons to consult again.',
    '',
    'Tell the user which plan you are working from and where you are in it, so they can see',
    'what they paid for.',
  ].join('\n'),
}

export const BUILTIN_MODES: readonly Mode[] = [CODE_MODE, ASK_MODE, JUNIOR_MODE]

export const DEFAULT_MODE_ID = CODE_MODE.id

export function findMode(id: string | undefined): Mode {
  return BUILTIN_MODES.find((mode) => mode.id === id) ?? CODE_MODE
}
