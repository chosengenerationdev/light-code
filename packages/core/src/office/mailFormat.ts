/**
 * Turns an Outlook HTML body into text that still says which parts were coloured.
 *
 * ## Why colour is worth carrying at all
 *
 * `MailItem.Body` is the plain-text rendering, and it silently discards every bit of formatting.
 * In corporate mail that formatting is frequently the message: the red line is the failure, the
 * highlighted cell is the one that changed, the struck-through row is the one to ignore. An
 * assistant reading the plain body sees a list of equal-looking sentences and has no way to know
 * which one the sender was pointing at.
 *
 * ## Why not just hand over the HTML
 *
 * Outlook HTML is enormous — conditional comments, `mso-` declarations, a stylesheet per
 * message, tables nested four deep to lay out a signature. Passing it through would cost
 * thousands of tokens per message to convey a few words of emphasis, and would bury the text it
 * was supposed to deliver.
 *
 * So the text is extracted as text, and formatting is added back **only where it departs from
 * the default**: a colour that is not near-black, a highlight, bold, or a strikethrough. An
 * ordinary message therefore reads exactly as it did before, and a message that used colour to
 * mean something says so.
 */

export interface AnnotatedBody {
  text: string
  /** Which colours appeared, so a reader can be told what the annotations mean. */
  colours: string[]
}

/** Common colours, so the model reads meaning rather than a hex triple. */
const NAMED: [number, number, number, string][] = [
  [255, 0, 0, 'red'],
  [192, 0, 0, 'dark red'],
  [255, 192, 0, 'amber'],
  [255, 255, 0, 'yellow'],
  [0, 176, 80, 'green'],
  [0, 128, 0, 'green'],
  [0, 112, 192, 'blue'],
  [0, 0, 255, 'blue'],
  [112, 48, 160, 'purple'],
  [255, 102, 0, 'orange'],
  [128, 128, 128, 'grey'],
  /*
   * The Office theme's own dark blue, which is what a default signature and most heading styles
   * come out as. Named rather than suppressed: it usually means nothing, but a rule that hid dark
   * colours outright would also hide a deliberate dark green, and silently losing emphasis is the
   * failure this whole file exists to prevent. Noise is the cheaper mistake.
   */
  [31, 73, 125, 'dark blue'],
]

const CSS_NAMES: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  black: [0, 0, 0],
  white: [255, 255, 255],
  maroon: [128, 0, 0],
  navy: [0, 0, 128],
  teal: [0, 128, 128],
  lime: [0, 255, 0],
  fuchsia: [255, 0, 255],
  aqua: [0, 255, 255],
  silver: [192, 192, 192],
}

function parseColour(raw: string): [number, number, number] | undefined {
  const value = raw.trim().toLowerCase()

  const named = CSS_NAMES[value]
  if (named !== undefined) return named

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value)
  if (hex !== null) {
    const digits = hex[1] as string
    // `#f00` and `#ff0000` mean the same thing, and Outlook emits both.
    const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ]
  }

  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value)
  if (rgb !== null) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  }
  return undefined
}

/**
 * A name for a colour, or its hex if it is nothing recognisable.
 *
 * Nearest-match rather than exact: mail clients emit `#C00000` and `#FF0000` and `rgb(255,0,0)`
 * for what the sender chose from the same swatch, and "dark red" carries the intent where
 * `#C00000` carries none. The hex is kept alongside an unrecognised colour so nothing is lost.
 */
export function describeColour(raw: string): string | undefined {
  const parsed = parseColour(raw)
  if (parsed === undefined) return undefined

  const [r, g, b] = parsed
  // Near-black is the default text colour, and annotating every ordinary paragraph as "black"
  // would drown the one line that was actually red.
  if (r < 60 && g < 60 && b < 60) return undefined

  /*
   * Nearest by the *worst* channel, not by summed distance.
   *
   * Summed distance let a brown (#7f5a3c) come out as "grey": two channels being close outvoted
   * one being far. Naming a colour something it plainly is not is worse than leaving it as a hex,
   * since the whole point is to convey what the sender meant.
   */
  let best: { name: string; worst: number } | undefined
  for (const [nr, ng, nb, name] of NAMED) {
    const worst = Math.max(Math.abs(r - nr), Math.abs(g - ng), Math.abs(b - nb))
    if (best === undefined || worst < best.worst) best = { name, worst }
  }
  if (best !== undefined && best.worst <= 56) return best.name

  const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
  return hex
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X') ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Reads the interesting formatting out of one tag's attributes. */
function formattingOf(tag: string): { colour?: string; highlight?: string; bold: boolean; struck: boolean } {
  const style = /style\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /style\s*=\s*'([^']*)'/i.exec(tag)?.[1] ?? ''

  // `<font color=...>` is still what Outlook emits for a colour picked from the ribbon.
  const attribute = /\bcolor\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bcolor\s*=\s*'([^']*)'/i.exec(tag)?.[1]
  const declared = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style)?.[1]
  const background =
    /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i.exec(style)?.[1] ??
    /(?:^|;)\s*mso-highlight\s*:\s*([^;]+)/i.exec(style)?.[1]

  const colour = describeColour(declared ?? attribute ?? '')
  const highlight = describeColour(background ?? '')

  return {
    ...(colour === undefined ? {} : { colour }),
    ...(highlight === undefined ? {} : { highlight }),
    bold: /^<(b|strong)\b/i.test(tag) || /font-weight\s*:\s*(bold|[6-9]00)/i.test(style),
    struck: /^<(s|strike|del)\b/i.test(tag) || /text-decoration[^;]*line-through/i.test(style),
  }
}

/** A paragraph is a gap; every other block is a line break. Runs are collapsed afterwards. */
const PARAGRAPH_END = /<\/(p|h[1-6]|blockquote|table)\s*>/gi
const BLOCK_END = /<\/(div|tr|li|pre)\s*>/gi

/**
 * Extracts the text of an Outlook HTML body, marking runs that carry meaning through formatting.
 *
 * Annotations look like `[red: OVERDUE]` and `[highlight yellow: 42]`, which reads naturally in a
 * sentence and cannot be confused with the message's own punctuation the way a bare colour word
 * would be. Nesting is tracked with a stack, because Outlook wraps a coloured word in three spans
 * and closing the wrong one would spill the annotation across the rest of the paragraph.
 */
export function annotateHtmlBody(html: string): AnnotatedBody {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(PARAGRAPH_END, '\n\n')
    .replace(BLOCK_END, '\n')
    .replace(/<\/t[dh]\s*>/gi, '\t')

  const colours = new Set<string>()
  let output = ''
  /** Open annotations, innermost last, so a close pops the right one. */
  const stack: { tag: string; closer: string }[] = []
  let index = 0

  while (index < cleaned.length) {
    const next = cleaned.indexOf('<', index)
    if (next < 0) {
      output += decodeEntities(cleaned.slice(index))
      break
    }
    output += decodeEntities(cleaned.slice(index, next))

    const end = cleaned.indexOf('>', next)
    if (end < 0) break
    const tag = cleaned.slice(next, end + 1)
    index = end + 1

    if (tag.startsWith('</')) {
      const name = /^<\/\s*([a-z0-9]+)/i.exec(tag)?.[1]?.toLowerCase()
      // Only pop for the element that opened an annotation; every other close is layout.
      const top = stack[stack.length - 1]
      if (top !== undefined && top.tag === name) {
        output += top.closer
        stack.pop()
      }
      continue
    }

    const name = /^<\s*([a-z0-9]+)/i.exec(tag)?.[1]?.toLowerCase()
    if (name === undefined || tag.endsWith('/>')) continue

    const formatting = formattingOf(tag)
    const parts: string[] = []
    if (formatting.colour !== undefined) {
      parts.push(formatting.colour)
      colours.add(formatting.colour)
    }
    if (formatting.highlight !== undefined) {
      parts.push(`highlight ${formatting.highlight}`)
      colours.add(`highlight ${formatting.highlight}`)
    }
    if (formatting.bold) parts.push('bold')
    if (formatting.struck) parts.push('struck through')

    if (parts.length === 0) continue
    output += `[${parts.join(', ')}: `
    stack.push({ tag: name, closer: ']' })
  }

  // Anything still open ran to the end of the message; close it rather than leaving a dangling
  // bracket that reads as part of the text.
  while (stack.length > 0) output += (stack.pop() as { closer: string }).closer

  return { text: tidy(output), colours: [...colours] }
}

/** Collapses the whitespace Outlook leaves behind, without losing paragraph breaks. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
