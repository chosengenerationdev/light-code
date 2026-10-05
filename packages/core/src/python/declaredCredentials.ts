/**
 * The saved credentials a Python tool declares it reads, from `__credentials__ = ["A", "B"]` in its
 * source. Pure and browser-safe: the approval card shows the same list the host enforces.
 */
export function declaredCredentials(source: string): string[] {
  const match = /^__credentials__\s*(?::[^=\n]*)?=\s*[[(]([\s\S]*?)[\])]/m.exec(source)
  if (match === null) return []
  return [...(match[1] ?? '').matchAll(/(["'])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((m) => m[2] ?? '').filter((s) => s.length > 0)
}
