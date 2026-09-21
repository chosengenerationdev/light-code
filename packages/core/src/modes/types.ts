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
  /**
   * This mode does its editing with `execute_command`, so a command may change the workspace.
   *
   * The loop snapshots before the first **edit** of a task, because that is where edits come
   * from in every other mode. Auto mode moves them into the shell, and without this the first
   * `sed -i` would run with no checkpoint behind it — rollback would silently cover nothing,
   * which is worse than having no rollback at all because the button is still there.
   */
  commandsEdit?: boolean
  /**
   * Read-only and compile-only commands may run without a prompt in this mode.
   *
   * Set for Auto mode alone, and it is a real relaxation rather than a convenience — so what it
   * covers is narrow and enforced in one place (`approval/safeCommands.ts`), not inferred here.
   *
   * §8's "all auto-approve toggles ship off" still holds: this is not a toggle, it is what the
   * mode *is*. Somebody choosing a mode called Auto, where nearly all the work arrives as
   * commands, is asking for `cat` and `grep` not to interrupt them twenty times an hour. Nothing
   * that writes, deletes or executes qualifies, and a risky rule still beats it.
   */
  autoApproveSafeCommands?: boolean
}
