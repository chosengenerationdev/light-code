import type { ToolRegistry } from '../tools/registry.js'
import type { Tool } from '../tools/types.js'
import type { Mode } from './types.js'

/**
 * Tools the mode permits. Filtering happens *before* tool definitions are built, so an
 * excluded tool never reaches the system prompt at all — the model cannot call what it
 * has never been told exists. See CLAUDE.md §8.
 */
export function toolsForMode(registry: ToolRegistry, mode: Mode): Tool[] {
  const allowed = new Set(mode.groups)
  return registry.list().filter((tool) => allowed.has(tool.group))
}
