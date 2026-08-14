import type { ToolGroup } from '../tools/types.js'

export interface Mode {
  id: string
  name: string
  description: string
  /** Tool groups this mode may use. `always` is implicit but listed for clarity. */
  groups: ToolGroup[]
  /**
   * Extra system-prompt text for this mode.
   *
   * Safe for the prompt cache: mode is resolved once per turn and can only change at a
   * session boundary, which is the same carve-out §12 already makes for tool selection.
   * Anything varying *within* a turn must not go here.
   */
  guidance?: string
  /**
   * Set when the mode is useless without the Claude CLI expert configured.
   *
   * Junior mode delegates its thinking, so with no expert it is an ordinary Code session
   * whose prompt keeps telling it to consult something that does not exist. Better to
   * disable it in the picker and say why.
   */
  requiresExpert?: boolean
}
