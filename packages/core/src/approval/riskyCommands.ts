/**
 * Commands you want to see, whatever else is switched on.
 *
 * Requested for Auto mode, where most of the work arrives as `execute_command` and the category
 * toggle is therefore a much blunter instrument than it is elsewhere. It applies in every mode,
 * though, because a command that is risky in Auto is risky in Code — the mode changes how often
 * you meet one, not what it does.
 *
 * ## Why patterns are allowed here when the allowlist forbids them
 *
 * §8 is emphatic that "always allow" is exact-match only and must never become prefix or glob
 * matching, because deciding whether a command is *covered* by a pattern means tokenising
 * PowerShell's grammar, and a parsing bug there silently auto-approves a chained destructive
 * command.
 *
 * This is the opposite direction, and the asymmetry is the whole justification. A wrong rule here
 * **cannot remove a gate**: at worst it adds a prompt to something harmless, or fails to match and
 * leaves the command exactly where it would have been anyway — in front of the ordinary approval
 * prompt. An allow rule fails open; a risky rule fails closed. Only one of those is safe to get
 * subtly wrong.
 *
 * ## Why substrings and not regular expressions
 *
 * The same decision `mcp/deny.ts` made, for the same reason: a regex typed into a settings box
 * fails *open* when it is subtly wrong — it matches nothing, nothing is refused, and nothing says
 * so. `rm -rf`, `--force`, `DROP TABLE` and `Remove-Item -Recurse` are all substrings, which is
 * what people actually reach for.
 *
 * ## Matched against the preview, not the arguments
 *
 * Invariant 8 applied to the policy decision, exactly as the allowlist does it: the tool computes
 * the command it will really run, and that string is what a rule sees. Matching the model's
 * arguments would let a rule be evaded by a tool that assembled the command differently.
 */

export interface RiskyCommandRule {
  /** Matched case-insensitively anywhere in the command. */
  contains: string
  /** Shown in the approval prompt, so the user knows which rule fired and why they wrote it. */
  reason?: string | undefined
  /**
   * Refuse outright rather than asking.
   *
   * Off by default: the useful thing is nearly always "make me look at this", and a rule that
   * blocks is a rule people disable the first time it is inconvenient. Reserved for the handful
   * somebody genuinely never wants run from here.
   */
  refuse?: boolean | undefined
}

/**
 * The ones that ask before anybody has configured anything.
 *
 * Asked for directly: *"by default agent should take approval from user for any risky commands
 * even if pattern is not there in config"*. A protection that only works once you have thought of
 * the command is a protection that arrives after the first accident, and the whole point of Auto
 * mode is that more of the work goes through the shell.
 *
 * ## What is on it, and what is not
 *
 * Only things that **destroy or exfiltrate**, and only where the substring is unambiguous. This
 * list is deliberately short and boring:
 *
 * - it must not become a taxonomy of everything dangerous, which nobody can complete and which
 *   makes every command prompt;
 * - an entry that fires on ordinary work gets the whole feature switched off, so a false positive
 *   costs more here than a gap does.
 *
 * `git push` is absent and `git push --force` is present, because one is how work gets shared and
 * the other rewrites somebody else's history. `rm` is absent and `rm -rf` is present, for the
 * same reason.
 *
 * ## It applies in every mode, not only Auto
 *
 * Auto mode is where it was asked for and where it matters most, but `rm -rf` is `rm -rf` in Code
 * mode too — and a rule that depended on the mode would be a second thing to reason about at the
 * moment somebody is deciding whether to press Approve. Turn it off with `commands.builtinRisky`.
 */
export const DEFAULT_RISKY_COMMANDS: readonly RiskyCommandRule[] = [
  { contains: 'rm -rf', reason: 'Recursive delete.' },
  { contains: 'rm -fr', reason: 'Recursive delete.' },
  { contains: 'remove-item -recurse', reason: 'Recursive delete.' },
  { contains: 'rmdir /s', reason: 'Recursive delete.' },
  { contains: 'del /s', reason: 'Recursive delete.' },
  /*
   * `format ` was here and is not, because plenty of repositories have an `npm run format`. An
   * entry that fires on everyday work gets the whole feature switched off, which costs more than
   * the gap — `mkfs` and `diskpart` cover the same ground without the false positive.
   */
  { contains: 'mkfs', reason: 'Makes a filesystem over whatever is there.' },
  { contains: 'diskpart', reason: 'Partition editing.' },
  /*
   * History rewriting, not ordinary git. Each of these loses work that is not in the transcript
   * and cannot be reconstructed from it.
   */
  { contains: '--force', reason: 'Forced, so whatever it would have refused to do it will do.' },
  { contains: '-f origin', reason: 'Force push.' },
  { contains: 'reset --hard', reason: 'Discards uncommitted work.' },
  { contains: 'clean -fd', reason: 'Deletes untracked files.' },
  // The trailing space matters: without it this also caught `checkout --track`, which is how
  // people start ordinary work.
  { contains: 'checkout -- ', reason: 'Discards uncommitted changes to those paths.' },
  { contains: 'filter-branch', reason: 'Rewrites history.' },
  // Destructive SQL, for a tool or a client invoked from the shell.
  { contains: 'drop table', reason: 'Drops a table.' },
  { contains: 'drop database', reason: 'Drops a database.' },
  { contains: 'truncate table', reason: 'Empties a table.' },
  /*
   * Fetch-and-execute. The command is short, the thing it runs is not shown anywhere, and it is
   * the standard shape of "paste this to install" — which is also the standard shape of the other
   * thing.
   */
  { contains: '| sh', reason: 'Runs whatever was just downloaded.' },
  { contains: '| bash', reason: 'Runs whatever was just downloaded.' },
  { contains: '|iex', reason: 'Runs whatever was just downloaded.' },
  { contains: '| iex', reason: 'Runs whatever was just downloaded.' },
  { contains: 'invoke-expression', reason: 'Runs text as code.' },
  // Machine-wide, and nothing to do with the workspace.
  { contains: 'shutdown', reason: 'Shuts the machine down.' },
  { contains: 'chmod 777', reason: 'Makes it writable by anyone on the machine.' },
  { contains: 'sudo ', reason: 'Runs as another user.' },
]

/**
 * The rules in force: the user's first, then the built-in ones unless they are switched off.
 *
 * The user's come first because `matchRiskyCommand` reports the *first* match and the prompt names
 * one reason — somebody who wrote their own rule for `--force` should see their own words, not
 * ours.
 */
export function riskyCommandRules(config?: {
  risky?: readonly RiskyCommandRule[] | undefined
  builtinRisky?: boolean | undefined
}): readonly RiskyCommandRule[] {
  const own = config?.risky ?? []
  // Absent means on. The protection people asked for is the one that works before it is
  // configured, so it cannot be opt-in.
  return config?.builtinRisky === false ? own : [...own, ...DEFAULT_RISKY_COMMANDS]
}

export interface RiskyCommandMatch {
  rule: RiskyCommandRule
  /** The text that matched, as the user wrote it — so the prompt can quote the rule back. */
  matched: string
}

/**
 * The first rule this command trips, or undefined.
 *
 * First rather than all: the prompt names one reason, and a list of three would bury the one that
 * mattered. Rules are checked in the order they are configured, so the most specific goes first —
 * which is also the order somebody reading the settings expects them to apply.
 */
export function matchRiskyCommand(
  command: string,
  rules: readonly RiskyCommandRule[] | undefined,
): RiskyCommandMatch | undefined {
  if (rules === undefined || rules.length === 0) return undefined
  const haystack = command.toLowerCase()

  for (const rule of rules) {
    /*
     * **Not trimmed.** An earlier version trimmed the needle to forgive whitespace typed into a
     * settings box, and that quietly destroyed the rules where a boundary space is the whole
     * point: `checkout -- ` became `checkout --`, which then matched `checkout --track` — an
     * ordinary command, flagged. Its own test caught it.
     *
     * A rule that is *entirely* whitespace is still skipped, because that one would match every
     * command and is never what anybody meant.
     */
    if (rule.contains.trim().length === 0) continue
    const needle = rule.contains.toLowerCase()
    if (haystack.includes(needle)) return { rule, matched: rule.contains }
  }
  return undefined
}

/** What the approval prompt says about a match. Names the rule, because the user wrote it. */
export function describeRiskyMatch(match: RiskyCommandMatch): string {
  const head = `This matches a command you marked risky: "${match.matched}".`
  return match.rule.reason === undefined || match.rule.reason.trim().length === 0
    ? head
    : `${head} ${match.rule.reason.trim()}`
}
