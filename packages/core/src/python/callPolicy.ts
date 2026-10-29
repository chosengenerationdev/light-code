/**
 * Which tools a Python tool may call, and why the answer is this narrow.
 *
 * ## The threat, stated plainly
 *
 * §13 calls dynamic Python tools the sharpest surface in the project, because the *body* is
 * model-authored: an injected instruction can create a persistent, later-auto-approved code path.
 * Letting that body call anything would make approving one tool a grant of everything the
 * approval prompt did not happen to make obvious — a `light_code.call_tool("execute_command", …)`
 * buried forty lines into a file somebody skimmed.
 *
 * ## So the reachable set is the one that was asked for, and nothing more
 *
 * **Other Python tools and MCP tools.** That is the request — "call other python tools or mcp
 * tools" — and it happens to be exactly the set that is safe to express as a rule rather than a
 * judgement. Everything dangerous is excluded by construction rather than by a list somebody has
 * to remember to extend:
 *
 * - `execute_command`, `write_to_file`, `apply_diff` are built-ins, not Python or MCP.
 * - `create_python_tool` and friends are built-ins too, which closes the ladder: a tool cannot
 *   write the tool that does what it is not allowed to do. Same reasoning as `schedule_prompt`
 *   being in `NEVER_AVAILABLE_TO_SCHEDULES`.
 * - `write_skill` is a built-in, so a tool cannot leave prose behind that steers future turns.
 *
 * A built-in added later is denied by default, which is the direction an allow list has to fail.
 *
 * ## MCP tools still go through the approval gate
 *
 * They always have, and a call arriving from inside a Python tool is not a reason to stop. The
 * prompt names the Python tool that asked, because "allow filesystem__write_file?" with no
 * indication of who wants it is exactly the prompt people click through.
 */
export const PYTHON_CALL_DENIED =
  'A Python tool may call other Python tools, MCP tools, and the built-in reading tools it declares in ' +
  '__tool_calls__ = ["name", ...]. Built-in tools that run commands, edit files, create tools or write ' +
  'skills are deliberately out of reach: a tool body is model-authored, and approving one must not ' +
  'silently grant the rest.'

/**
 * Whether a Python tool may call this tool at all. **Built-in reading tools** (AutoSys and Jira reads,
 * file search, ...) were added for monitoring - "tools created can access existing mcp tools and inbuilt
 * tools of firecode" - but only when the tool *declares* them (`__tool_calls__`), so the reviewer sees
 * it, and only the `read` group: everything that changes something stays out of reach as before.
 */
export function mayPythonToolCall(name: string, group: string | undefined, declared = false): boolean {
  if (name.startsWith('py__')) return true
  if (group === 'mcp') return true
  return declared && group === 'read'
}

/** What the approval prompt says, so the user knows who is asking rather than only what for. */
export function describeNestedCall(caller: string, callee: string): string {
  return `The Python tool "${caller}" is asking to call "${callee}".`
}
