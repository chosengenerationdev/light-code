/**
 * `disabled`, and a title saying why, from the first reason that holds.
 *
 * Asked for: "if you disabled it for a reason, when user mouse over it, it should tell why it is
 * disabled". A greyed control with nothing to say reads as broken. Each condition is paired with its
 * sentence here, so a reason cannot be forgotten without the condition going with it -
 * `disabledReasons.test.ts` fails on a disabled control that carries no title.
 *
 * Spread it last-but-one: `{...disabledWhen([dirty === false, 'Nothing has changed since the last save.'])}`.
 * A control with its own title while enabled passes it as `enabledTitle`.
 */
export function disabledWhen(
  ...reasons: (readonly [boolean, string] | { enabledTitle: string })[]
): { disabled: boolean; title?: string } {
  let enabledTitle: string | undefined
  for (const reason of reasons) {
    if (!Array.isArray(reason)) {
      enabledTitle = (reason as { enabledTitle: string }).enabledTitle
      continue
    }
    const [on, why] = reason as readonly [boolean, string]
    if (on) return { disabled: true, title: why }
  }
  return enabledTitle === undefined ? { disabled: false } : { disabled: false, title: enabledTitle }
}
