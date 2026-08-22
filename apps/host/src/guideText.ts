import { OPERATOR_GUIDE } from './generated/operatorGuide.js'

/**
 * The operator guide, rendered for a terminal.
 *
 * Markdown is what gets edited and what ships; this adds only enough emphasis to make headings
 * findable while scrolling. Deliberately minimal — the output is as likely to be piped into
 * `less` or a file as read directly, and escape codes in a file are noise.
 *
 * ## The carriage return is not a detail
 *
 * The source is checked out with CRLF on Windows, and **`.` in a JavaScript regular expression
 * does not match `\r`** — it is a line terminator. So `/^#{1,6}\s+(.*)$/` matched nothing at all
 * against a CRLF file, and the first version of this silently emitted the guide unstyled: no
 * error, no missing content, just a feature that quietly did nothing. §16's line-endings rule
 * again, in a place nobody would think to look for it.
 *
 * The `\r` is therefore separated before matching and put back afterwards, so what is printed
 * keeps the file's own endings and a copied command keeps its shape.
 */
export function renderGuide(colour: boolean, source: string = OPERATOR_GUIDE): string {
  if (!colour) return source

  /** Written once, so an escape cannot go missing from one of the pair and not the other. */
  const ESC = '\u001b'
  const bold = (text: string): string => `${ESC}[1m${text}${ESC}[0m`
  const dim = (text: string): string => `${ESC}[2m${text}${ESC}[0m`
  return source
    .split('\n')
    .map((line) => {
      const carriageReturn = line.endsWith('\r') ? '\r' : ''
      const text = carriageReturn === '' ? line : line.slice(0, -1)

      // Headings carry the structure; everything else is left exactly as written.
      const heading = /^#{1,6}\s+(.*)$/.exec(text)
      if (heading !== null) return bold(heading[1] ?? text) + carriageReturn

      /*
       * A fence is scaffolding for a renderer that is not here. Dimmed rather than removed:
       * dropping it would change the line count and shift what someone selects when copying the
       * command inside it.
       */
      if (text.startsWith('```')) return dim(text) + carriageReturn

      return line
    })
    .join('\n')
}
