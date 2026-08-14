import type { ToolRegistry } from '../tools/registry.js'
import type { Tool } from '../tools/types.js'
import type { Mode } from './types.js'

/**
 * Tools the mode permits. Filtering happens *before* tool definitions are built, so an
 * excluded tool never reaches the system prompt at all — the model cannot call what it
 * has never been told exists. See CLAUDE.md §8.
 *
 * Built from `promptList()`, so dispatch-only tools are absent too. The two exclusions are
 * not the same thing and must not be confused: a mode excludes a **capability**, and the
 * loop rejects it even when history references it. Dispatch-only merely withholds the
 * *advertisement* — the tool stays callable through `call_tool`, and the mode check still
 * applies to it when it is.
 */
export function toolsForMode(registry: ToolRegistry, mode: Mode): Tool[] {
  const allowed = new Set(mode.groups)
  return registry.promptList().filter((tool) => allowed.has(tool.group))
}
