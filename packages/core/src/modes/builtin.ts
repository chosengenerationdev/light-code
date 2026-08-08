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

export const BUILTIN_MODES: readonly Mode[] = [CODE_MODE, ASK_MODE]

export const DEFAULT_MODE_ID = CODE_MODE.id

export function findMode(id: string | undefined): Mode {
  return BUILTIN_MODES.find((mode) => mode.id === id) ?? CODE_MODE
}
