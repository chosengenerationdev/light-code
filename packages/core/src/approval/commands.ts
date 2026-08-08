/**
 * Exact-match command allowlist. **Byte-for-byte comparison only — never prefix, glob, or
 * pattern matching.** See CLAUDE.md §8.
 *
 * The reason is not stylistic. Deciding whether a command is "covered by" a pattern means
 * tokenising a shell grammar; PowerShell's (`;`, `&&`, `|`, `$(...)`, nested quoting) is
 * easy to get wrong, and a parsing bug silently auto-approves a chained destructive
 * command. Exact comparison needs no parser, so that entire class of bug cannot occur —
 * which is also why this works on Windows, where pattern matching was ruled out.
 *
 * Widening this to prefixes would reintroduce exactly the hazard it exists to avoid.
 */
export function isCommandAllowlisted(command: string, allowlist: readonly string[]): boolean {
  // No trimming, no case folding, no normalisation. `npm test` and ` npm test` are
  // different strings and must be approved separately — surprising once, safe always.
  return allowlist.includes(command)
}

export function addToAllowlist(command: string, allowlist: readonly string[]): string[] {
  return allowlist.includes(command) ? [...allowlist] : [...allowlist, command]
}

export function removeFromAllowlist(command: string, allowlist: readonly string[]): string[] {
  return allowlist.filter((entry) => entry !== command)
}
