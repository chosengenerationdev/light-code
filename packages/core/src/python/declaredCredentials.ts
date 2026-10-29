/**
 * The saved credentials a Python tool declares it reads, from `__credentials__ = ["A", "B"]` in its
 * source. Pure and browser-safe: the approval card shows the same list the host enforces.
 */
/**
 * Whether a Python tool declares `__always_ask__ = True` at module level: every run asks first, for
 * everybody who has the tool, and "Always allow" is never offered for it. Part of the approved bytes,
 * so it cannot be taken out without the tool being reviewed again.
 */
export function declaresAlwaysAsk(source: string): boolean {
  return /^__always_ask__\s*(?::[^=\n]*)?=\s*True\b/m.test(source)
}

function declaredList(source: string, name: string): string[] {
  const match = new RegExp(`^${name}\\s*(?::[^=\\n]*)?=\\s*[[(]([\\s\\S]*?)[\\])]`, 'm').exec(source)
  if (match === null) return []
  return [...(match[1] ?? '').matchAll(/(["'])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((m) => m[2] ?? '').filter((s) => s.length > 0)
}

export function declaredCredentials(source: string): string[] {
  return declaredList(source, '__credentials__')
}

/**
 * The tools a Python tool declares it calls with `light_code.call_tool`, from `__tool_calls__ = [...]`.
 * Part of the approved bytes like `__credentials__`: a new call means approving the tool again. It is
 * what lets a tool reach Fire Code's built-in *reading* tools, and what an unattended monitor run may
 * call without a prompt (`host/bridge.ts` callTool, `monitoring/channel.ts`).
 */
export function declaredToolCalls(source: string): string[] {
  return declaredList(source, '__tool_calls__')
}
