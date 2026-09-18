import { useMemo, useState, type ReactElement } from 'react'
import { displayMaxWidth,
  diagramDataUri,
  diagramSvg,
  layoutDiagram,
  type DiagramPalette,
  type DiagramSpec,
} from '@light-code/core/browser'
import { colors, secondaryButtonStyle } from '../theme.js'

/**
 * A diagram in the transcript.
 *
 * ## Why it is an `<img>` and not inline SVG
 *
 * An SVG loaded through `<img>` cannot run script, whatever it contains — the same property that
 * lets the guide's diagrams be served as files. The markup is generated in core from a validated
 * graph with every label escaped, so there is nothing to smuggle in; rendering it this way means
 * that remains true even if somebody later changes the generator and forgets why.
 *
 * It also makes the picture a *thing*: it can be copied out of the page and saved, which inline
 * elements cannot be.
 *
 * ## Why the palette is built here
 *
 * The layout is decided when the tool runs; the colours are decided when it is drawn. So the same
 * diagram follows the editor from light to dark without the model being asked again — and the
 * accent is the user's own, so a diagram looks like it belongs to the panel around it.
 */
export function Diagram(props: { diagram: DiagramSpec }): ReactElement {
  const [copied, setCopied] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)

  // One vocabulary with charts: see `display/size.ts`.
  const requested = displayMaxWidth(props.diagram.size)
  const { svg, uri, width, height } = useMemo(() => {
    /*
     * Resolved to real colours, because the SVG is a document of its own.
     *
     * Every colour in `theme.ts` is a `var(--vscode-…)`, and a CSS custom property defined on this
     * page does not reach an SVG loaded through `<img>` — that document has its own root and
     * inherits nothing. So the values arrived as `var(…)`, which is not a valid attribute value:
     * `fill` fell back to black and the labels vanished into a dark panel, `stroke` fell back to
     * `none` and *every arrow disappeared*, and `dark` was decided from a string that was not a
     * colour, so a dark theme got the pale tints meant for a light one. One cause, all of it.
     *
     * `getComputedStyle` is what resolves a `var()` chain, fallbacks and all, so the browser does
     * the work rather than this file re-implementing the cascade.
     */
    const background = resolveColour(colors.background, '#1e1e1e')
    const palette: DiagramPalette = {
      background,
      // The arrows take the description colour rather than the widget border: a border is meant
      // to be barely visible, which is wrong for the lines carrying the meaning of the diagram.
      line: resolveColour(colors.muted, '#8a8a8a'),
      surface: resolveColour(colors.inputBackground, '#252526'),
      text: resolveColour(colors.foreground, '#e0e0e0'),
      muted: resolveColour(colors.muted, '#8a8a8a'),
      accent: resolveColour(colors.accent, '#22c55e'),
      dark: isDark(background),
    }
    const layout = layoutDiagram(props.diagram)
    const markup = diagramSvg(layout, palette)
    return { svg: markup, uri: diagramDataUri(markup), width: layout.width, height: layout.height }
  }, [props.diagram])

  return (
    <div style={{ margin: '8px 0' }}>
      <img
        src={uri}
        alt={props.diagram.title ?? 'Diagram'}
        /*
         * Never wider than the panel, and never stretched past its own size in a wide one — an
         * eight-box flow blown up to fill a monitor looks like a mistake.
         */
        /*
         * The requested size, or the panel, whichever is smaller — and never wider than the
         * diagram's own drawn width, so a small flow is not blown up to fill a monitor.
         */
        style={{
          maxWidth: requested === undefined ? '100%' : `min(100%, ${String(requested)}px)`,
          width,
          height: 'auto',
          display: 'block',
        }}
      />
      {props.diagram.note !== undefined && (
        <div style={{ color: colors.muted, fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
          {props.diagram.note}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
          title="Copy the SVG markup, to paste into a document or an editor"
          onClick={() => {
            void navigator.clipboard?.writeText(svg).then(
              () => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              },
              () => setCopied(false),
            )
          }}
        >
          {copied ? 'Copied' : 'Copy SVG'}
        </button>
        <button
          type="button"
          style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
          title="Save as SVG — vector, so it stays sharp at any size"
          onClick={() => {
            download(`${fileNameFor(props.diagram.title)}.svg`, new Blob([svg], { type: 'image/svg+xml' }))
          }}
        >
          Save SVG
        </button>
        <button
          type="button"
          style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
          title="Save as PNG, at twice the drawn size, for somewhere that cannot take an SVG"
          onClick={() => {
            void toPng(uri, width, height).then(
              (blob) => download(`${fileNameFor(props.diagram.title)}.png`, blob),
              () => setSaveError('Could not make a PNG here — use Save SVG, or copy it.'),
            )
          }}
        >
          Save PNG
        </button>
      </div>
      {saveError !== undefined && (
        <div style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>{saveError}</div>
      )}
    </div>
  )
}

/**
 * Hands a file to the browser.
 *
 * An object URL rather than a `data:` one: a large PNG as a data URI is a megabytes-long string in
 * an attribute, and some hosts cap how long an href may be. Revoked on the next frame, because
 * revoking immediately can beat the download starting.
 */
function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** A filename from the title, or a plain one. Nothing a title contains may steer a path. */
export function fileNameFor(title: string | undefined): string {
  const cleaned = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned.length > 0 ? cleaned : 'diagram'
}

/**
 * Rasterises the SVG through a canvas.
 *
 * At twice the drawn size, because a PNG is fixed and somebody will put it in a slide and enlarge
 * it. The SVG stays the better artifact and is offered first; this is for the places that cannot
 * take one.
 *
 * Drawn from a `data:` URI, which does not taint the canvas — a remote image would, and `toBlob`
 * would then throw rather than return anything.
 */
async function toPng(uri: string, width: number, height: number): Promise<Blob> {
  const scale = 2
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('the diagram could not be loaded for rasterising'))
    image.src = uri
  })

  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('no 2d canvas in this host')
  context.scale(scale, scale)
  context.drawImage(image, 0, 0, width, height)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('the canvas produced nothing'))
      else resolve(blob)
    }, 'image/png')
  })
}

/**
 * A CSS colour expression as an actual colour.
 *
 * The browser resolves it, rather than this file learning to parse `var()` chains and their
 * fallbacks. A hidden probe is the only way to ask: custom properties are resolved against an
 * element, so there is nothing to read without one.
 */
export function resolveColour(value: string, fallback: string): string {
  try {
    const probe = document.createElement('span')
    probe.style.color = value
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const resolved = globalThis.getComputedStyle(probe).color
    probe.remove()
    /*
     * The *output* is checked, not the input, and that is the point.
     *
     * A browser resolves a `var()` chain here and hands back `rgb(…)`. Something that does not —
     * an engine without custom-property support, a variable that is genuinely undefined, jsdom —
     * hands back the expression it was given, and passing that on is the exact bug this function
     * was written to end: an invalid attribute value paints black, or nothing at all.
     *
     * So anything that is not a colour becomes the fallback. A diagram in a guessed grey is
     * readable; one drawn in an invalid value is not drawn.
     */
    return isPaintable(resolved) ? resolved : fallback
  } catch {
    // No DOM: a test, or a renderer that has not mounted. The fallback is a real colour.
    return fallback
  }
}

/**
 * Whether a value will actually paint.
 *
 * Deliberately narrow: `rgb(…)`, `rgba(…)` and hex are what a resolved colour looks like, and
 * anything else — an unresolved `var()`, an empty string, a keyword this cannot vouch for — is
 * treated as unusable. Being strict costs a fallback colour; being permissive costs the diagram.
 */
function isPaintable(value: string): boolean {
  const text = value.trim()
  if (text.length === 0 || text.includes('var(')) return false
  return /^#[\da-f]{3,8}$/i.test(text) || /^rgba?\(/i.test(text)
}

/**
 * Whether a colour is dark, so a tone knows how hard to tint.
 *
 * Perceptual weights rather than a plain average: the eye is far more sensitive to green than to
 * blue, and an average calls a saturated blue "light" when nothing on it is readable.
 */
export function isDark(colour: string): boolean {
  const text = colour.trim()
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text)
  const hex = /^#?([\da-f]{6})$/i.exec(text)

  let r: number
  let g: number
  let b: number
  if (rgb !== null) {
    r = Number(rgb[1])
    g = Number(rgb[2])
    b = Number(rgb[3])
  } else if (hex !== null) {
    const value = Number.parseInt(hex[1] ?? 'ffffff', 16)
    r = (value >> 16) & 0xff
    g = (value >> 8) & 0xff
    b = value & 0xff
  } else {
    // Neither notation. Dark is the better guess in this product: the editor default is dark,
    // and the cost of being wrong is a slightly strong tint rather than an unreadable one.
    return true
  }
  return (r * 299 + g * 587 + b * 114) / 1000 < 128
}
