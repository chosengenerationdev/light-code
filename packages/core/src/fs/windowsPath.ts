/**
 * Repairs Windows paths a model has over-escaped.
 *
 * ## The observed failure
 *
 * A user asked for `\\nas.apac.net.intra\sg\prd\...`. The model emitted JSON containing
 * *eight* leading backslashes, which parses to four:
 *
 * ```
 * typed  \\nas.apac.net.intra\sg\...
 * sent   \\\\\\\\nas.apac.net.intra\\\\sg\\\\...   (JSON source)
 * parsed \\\\nas.apac.net.intra\\sg\\...
 * ```
 *
 * `path.resolve` does not recognise four leading backslashes as a UNC prefix, so it treated the
 * whole thing as drive-relative and produced `C:\nas.apac.net.intra\sg\...` — a path that has
 * never existed. The user sees `ENOENT` naming a `C:\` path they never mentioned, which reads
 * as a bug in the assistant's reading rather than in its quoting.
 *
 * ## Why repair rather than reject
 *
 * Escaping a Windows path through JSON is something models get wrong often and unpredictably —
 * a double backslash is correct in the JSON *source* and wrong once parsed, and the two are
 * easy to conflate. Refusing would be defensible and useless: the user's request was
 * unambiguous, and the intent survives the mangling completely.
 *
 * It is also safe to repair, because the collapsed forms are not valid paths in the first
 * place. Windows has no meaning for a run of separators inside a path, and no meaning for more
 * than two at the front. There is nothing being silently reinterpreted — only a spelling that
 * cannot refer to anything being turned into the one that can.
 *
 * **Not applied on POSIX**, where a backslash is an ordinary filename character and collapsing
 * one would corrupt a legitimate name.
 */

/** True for a path that means "the root of this drive" or "this UNC share". */
function leadingSeparators(value: string): number {
  let count = 0
  while (count < value.length && (value[count] === '\\' || value[count] === '/')) count++
  return count
}

export function normalizeWindowsPath(input: string, platform: string = process.platform): string {
  if (platform !== 'win32') return input
  if (input.length === 0) return input

  const leading = leadingSeparators(input)
  const rest = input.slice(leading)

  /*
   * Runs inside the path collapse to one. `C:\\a\\\b` cannot refer to anything, so there is no
   * reading of it being discarded. Forward slashes are left as they are — Windows accepts them
   * and `path.resolve` normalises them.
   */
  const body = rest.replace(/\\{2,}/g, '\\')

  /*
   * Two or more at the front means UNC, however many arrived. One stays one: `\folder` is
   * drive-relative and legitimate, and turning it into `\\folder` would invent a server name.
   */
  if (leading >= 2) return `\\\\${body}`
  if (leading === 1) return `${input.slice(0, 1)}${body}`
  return body
}
