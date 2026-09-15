import { useMemo, useState, type ReactElement } from 'react'
import {
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

  const { svg, uri, width } = useMemo(() => {
    const palette: DiagramPalette = {
      background: colors.background,
      line: colors.border,
      surface: colors.inputBackground,
      text: colors.foreground,
      muted: colors.muted,
      accent: colors.accent,
      dark: isDark(colors.background),
    }
    const layout = layoutDiagram(props.diagram)
    const markup = diagramSvg(layout, palette)
    return { svg: markup, uri: diagramDataUri(markup), width: layout.width }
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
        style={{ maxWidth: '100%', width, height: 'auto', display: 'block' }}
      />
      {props.diagram.note !== undefined && (
        <div style={{ color: colors.muted, fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
          {props.diagram.note}
        </div>
      )}
      <button
        type="button"
        style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px', marginTop: 6 }}
        title="Copy the SVG, which scales to any size without blurring"
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
    </div>
  )
}

/**
 * Whether a colour is dark, so a tone knows how hard to tint.
 *
 * Perceptual weights rather than a plain average: the eye is far more sensitive to green than to
 * blue, and an average calls a saturated blue "light" when nothing on it is readable.
 */
function isDark(colour: string): boolean {
  const hex = /^#?([\da-f]{6})$/i.exec(colour.trim())
  // Not a hex colour — a CSS variable, most likely. Light is the safer guess: the tint is
  // gentler, so a wrong guess costs contrast rather than legibility.
  if (hex === null) return false
  const value = Number.parseInt(hex[1] ?? 'ffffff', 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return (r * 299 + g * 587 + b * 114) / 1000 < 128
}
