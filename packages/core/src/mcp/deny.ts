/**
 * Calls a server is never allowed to make, declared by the user.
 *
 * ## What this is for
 *
 * Asked for in these terms: an agent may fill a web form and click Next, but must not click the
 * final submit — the person reviews and submits. Prompt guidance alone cannot promise that, and a
 * heuristic that tried to *recognise* a submit button would be wrong often enough to be dangerous
 * while sounding certain. Plenty of forms submit from a `div`, or a button labelled Confirm, or
 * the Enter key.
 *
 * So the rule is **declared, never inferred**. The user names what must not happen; nothing here
 * guesses. That is the same reasoning as §8's exact-match command allowlist and `--allow-host`:
 * where being wrong is expensive, the product does not get to be clever.
 *
 * ## What it can and cannot promise
 *
 * It reliably stops the model doing something it would ordinarily do — reaching for a button that
 * finishes a form. It is **not** a defence against an adversary: a model determined to submit
 * could find a phrasing the rule does not match, and no substring list fixes that. The honest
 * claim is "a guard against ordinary behaviour", and the approval gate remains the thing that
 * cannot be talked past.
 *
 * Stated plainly here because the difference matters to whoever relies on it.
 *
 * ## Why substrings rather than patterns
 *
 * A regular expression written in a settings box is a silent hole: one that does not compile, or
 * that means something slightly different from what was intended, fails *open* and nothing says
 * so. A substring has one meaning, needs no parser, and a person can tell at a glance what it
 * will and will not catch. §8 made this trade for commands and it holds here.
 *
 * The comparison is against the arguments as JSON, so it catches a selector, a visible label, an
 * element id or a URL without the rule having to know which field a particular server uses.
 */

export interface McpDenyRule {
  /** Tools this applies to, by bare name. Absent means every tool on that server. */
  tools?: readonly string[] | undefined
  /** Refused when this appears anywhere in the call's arguments. Compared case-insensitively. */
  contains: string
  /** Shown to the model and the user. A rule whose reason is missing explains itself poorly. */
  reason?: string | undefined
}

export interface DenyDecision {
  denied: boolean
  message?: string
}

/**
 * Whether one call is refused, and why.
 *
 * The arguments are serialised rather than walked, so a rule catches a value wherever it sits —
 * nested in an object, in an array, under a key this code has never heard of. A server's argument
 * shape is its own business, and a guard that had to know it would break whenever the server
 * changed.
 */
export function denyCheck(
  toolName: string,
  args: unknown,
  rules: readonly McpDenyRule[] | undefined,
): DenyDecision {
  if (rules === undefined || rules.length === 0) return { denied: false }

  let serialised: string
  try {
    serialised = JSON.stringify(args ?? {}).toLowerCase()
  } catch {
    /*
     * Arguments that will not serialise are refused rather than allowed.
     *
     * This only happens for something circular or exotic, and "I could not read this well enough
     * to check it" is not a reason to let it through — a guard that fails open is not a guard.
     */
    return {
      denied: true,
      message: `Refused: the arguments to "${toolName}" could not be checked against this server's deny rules.`,
    }
  }

  for (const rule of rules) {
    const needle = rule.contains.trim().toLowerCase()
    if (needle.length === 0) continue
    if (rule.tools !== undefined && !rule.tools.some((name) => name === toolName)) continue
    if (!serialised.includes(needle)) continue

    return {
      denied: true,
      message:
        `Refused by a rule on this server: calls to "${toolName}" containing "${rule.contains}" ` +
        `are not allowed.` +
        (rule.reason === undefined || rule.reason.trim().length === 0
          ? ' Ask the user to do this step themselves.'
          : ` ${rule.reason.trim()}`),
    }
  }

  return { denied: false }
}
