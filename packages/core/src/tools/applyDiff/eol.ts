export type Eol = '\n' | '\r\n'

/** Counts CRLF vs bare-LF lines; ties (including no newlines at all) default to `\n`. */
export function detectEol(text: string): Eol {
  const crlfCount = (text.match(/\r\n/g) ?? []).length
  const lfOnlyCount = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlfCount > 0 && crlfCount >= lfOnlyCount ? '\r\n' : '\n'
}

export function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export function restoreEol(text: string, eol: Eol): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}
