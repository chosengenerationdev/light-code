/**
 * Paths in the startup bar, shortened to their last two parts (`…\s3\skills`). Reported: "it shows long string of temp
 * skills and tools directory, that takes more space on top of input box". The full text is kept for the bar's hover
 * and the log names the full path, so nothing is lost - only the line above the message box gets short.
 */

/** A Windows path (drive or UNC) or an absolute POSIX path of two or more parts, up to the next space. */
const PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+|\/(?:[^\s/"'<>|]+\/)+[^\s/"'<>|]*/g

export function shortenPaths(text: string): string {
  return text.replace(PATH, (path) => {
    const separator = path.includes('\\') ? '\\' : '/'
    const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
    if (parts.length <= 2) return path
    return `…${separator}${parts.slice(-2).join(separator)}`
  })
}
