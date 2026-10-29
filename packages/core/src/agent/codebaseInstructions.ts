import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomically } from '../usage/events.js'

/**
 * Codebase instructions: what every chat on one codebase is told, whatever else is configured.
 *
 * Asked for from Fire Code, where one codebase holds several chats: "codebase instructions ->
 * standing instructions -> each chat will get these, user should be able to edit these in Fire
 * Code itself". Three levels, from the most specific down:
 *
 * - **the chat** - what the user says in this conversation;
 * - **codebase instructions** - this file, about this one codebase;
 * - **standing instructions** - skills marked `always: true`, which may come from a team bucket
 *   and so apply to every codebase that loads them.
 *
 * Kept outside the workspace, in storage the user owns, for invariant 5's reason: a repository
 * able to write what every chat is told would be a prompt it could inject into every session the
 * moment it was opened. Standing instructions in `.lightcode/skills` already carry that risk and
 * are reviewed like code; this level does not need to.
 *
 * Read on every turn, like skills, so an edit made in another chat - or in Fire Code's own dialog -
 * applies to the next message everywhere without a restart.
 */

/** The file's name, which is also the title the editor shows. Fire Code writes the same file. */
export const CODEBASE_INSTRUCTIONS_FILE = 'codebase-instructions.md'

/** Beyond this the instructions are cut and the model is told so. Paid for on every request. */
export const CODEBASE_INSTRUCTIONS_LIMIT = 20_000

/**
 * Where a codebase's instructions live.
 *
 * Fire Code passes a folder per codebase (`codebaseDir`), and its own dialog edits the same file.
 * Elsewhere the storage folder is shared by every workspace, so the file is filed under the
 * workspace: its folder name for a person reading the directory, and a digest of its resolved,
 * case-folded path so `D:\x` and `d:\x` - one folder spelled two ways (§16) - are one codebase.
 */
export function codebaseInstructionsPath(options: {
  codebaseDir?: string | undefined
  storageDir: string
  workspaceRoot: string | undefined
}): string | undefined {
  // A folder of its own, because the panel's editor may open anything in the folder it lives in -
  // and the codebase folder also holds the checkpoint objects and the venv.
  if (options.codebaseDir !== undefined) return path.join(options.codebaseDir, 'instructions', CODEBASE_INSTRUCTIONS_FILE)
  if (options.workspaceRoot === undefined) return undefined
  const resolved = path.resolve(options.workspaceRoot)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12)
  const slug = path.basename(resolved).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  return path.join(options.storageDir, 'codebases', `${slug}-${digest}`, CODEBASE_INSTRUCTIONS_FILE)
}

/** The file's text, trimmed; empty when there is none. Never throws - a missing file is "none". */
export async function readCodebaseInstructions(file: string | undefined): Promise<string> {
  if (file === undefined) return ''
  try {
    return (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '').trim()
  } catch {
    return ''
  }
}

/** The prompt section, or empty when there is nothing to say. */
export function renderCodebaseInstructions(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ''
  const cut = trimmed.length > CODEBASE_INSTRUCTIONS_LIMIT
  return [
    '## Codebase instructions',
    '',
    'The user wrote these for this codebase, and every chat on it receives them. Follow them in every',
    'reply. They outrank the standing instructions and every general guideline above: where the two',
    'disagree, follow these. Only what the user says in this conversation, or a plan they set for',
    'it, overrides them.',
    '',
    cut ? trimmed.slice(0, CODEBASE_INSTRUCTIONS_LIMIT) : trimmed,
    ...(cut
      ? ['', `(Cut at ${String(CODEBASE_INSTRUCTIONS_LIMIT)} characters. Tell the user these instructions are too long to send in full.)`]
      : []),
  ].join('\n')
}

/** Writes the file whole (§15): a chat reading it mid-save sees the old text or the new. */
export async function writeCodebaseInstructions(file: string, text: string): Promise<void> {
  await writeFileAtomically(file, text.split('\r\n').join('\n'))
}
