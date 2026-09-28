/**
 * Turns a failed ripgrep spawn into something a person can act on.
 *
 * `execFile` reports a binary that is not there as `spawn rg.exe ENOENT`, and that is what reached
 * the chat — reported from real use, in those words. It names no cause and suggests no action,
 * which is exactly what §17 forbids: an error should say what failed, what was involved, and what
 * to do next.
 *
 * **The cause is worth naming because it is not obvious and it is temporary.** A VS Code extension
 * lives in a version-stamped folder; installing a newer build deletes the old one while the
 * extension host that resolved a path into it carries on. The resolver recovers on its own where a
 * neighbouring install still has a copy, so reaching this message means it could not — and a window
 * reload genuinely does fix it, which is the one thing the raw errno never said.
 */
/**
 * Whether ripgrep failed to *start*, as opposed to running and reporting an error.
 *
 * A spawn failure carries a string code (`ENOENT`, `EACCES`, `EPERM`, `UNKNOWN` when policy blocks
 * the program); ripgrep's own failures carry its numeric exit status. Only the first means "use the
 * built-in search instead" — an invalid pattern must still be reported as one.
 */
export function ripgrepDidNotStart(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === 'string'
}

export function describeRipgrepFailure(error: unknown, what: string): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT') {
    return (
      `${what} is unavailable: the ripgrep binary it runs could not be found. ` +
      'This usually means Light Code was updated while this window was open, which replaces the ' +
      'folder the binary was in. Reloading the window (Developer: Reload Window) restores it. ' +
      'If it persists, the binary may have been removed by antivirus software.'
    )
  }
  return `${what} failed: ${error instanceof Error ? error.message : String(error)}`
}
