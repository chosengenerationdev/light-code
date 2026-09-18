/**
 * How large a picture should be drawn, for every kind of picture.
 *
 * ## Why one module rather than a field on each
 *
 * Asked for after a chart filled the whole window on the Node host and could not be made smaller:
 * *"i want it for all kind of displays, like even for technical diagrams"*. A chart and a diagram
 * asking for "small" and getting two different widths is the shape this project has paid for most,
 * so the sizes live in one place and both read them.
 *
 * It also means the *next* kind of picture inherits the vocabulary rather than inventing a third.
 *
 * ## Why a word rather than a pixel count
 *
 * The model has no idea how wide the panel is. It is a sidebar in the extension and most of a
 * window in the browser, and the same 900 pixels is comfortable in one and absurd in the other.
 * A word says what was *meant* — "small, this is an aside" — and the panel decides what that is
 * worth here, which is the only place that knows.
 *
 * A cap, never a stretch: a picture narrower than its size is left alone rather than blown up.
 * Enlarging a small diagram to fill a wide column makes a blurry picture out of a sharp one.
 */

export const DISPLAY_SIZES = ['small', 'medium', 'large', 'full'] as const
export type DisplaySize = (typeof DISPLAY_SIZES)[number]

/**
 * The widest each size is drawn, in CSS pixels. `full` has no cap.
 *
 * Chosen against what they are for rather than by even steps: `small` is an aside beside text,
 * `medium` is the ordinary case and still readable in a sidebar, `large` is something worth
 * studying, and `full` is the behaviour everything had before this existed — which is why it stays
 * available and why nothing is cropped by default.
 */
export const DISPLAY_WIDTHS: Record<DisplaySize, number | undefined> = {
  small: 280,
  medium: 440,
  large: 680,
  full: undefined,
}

/** The default when nothing asked. `full`, so no existing chart or diagram changes size. */
export const DEFAULT_DISPLAY_SIZE: DisplaySize = 'full'

/**
 * A `maxWidth` for a container, or undefined to leave it uncapped.
 *
 * Takes an unknown string rather than the union so a value from a stored transcript — written by a
 * version that knew a size this one does not — degrades to uncapped instead of throwing. An old
 * picture drawn a little too wide is a much better failure than a task that will not reopen.
 */
export function displayMaxWidth(size: string | undefined): number | undefined {
  if (size === undefined) return DISPLAY_WIDTHS[DEFAULT_DISPLAY_SIZE]
  return (DISPLAY_WIDTHS as Record<string, number | undefined>)[size]
}

/** The sentence both tools use to describe the field, so they cannot describe it differently. */
export const DISPLAY_SIZE_DESCRIPTION =
  'How wide to draw it: small (an aside), medium (the ordinary case), large (worth studying), or ' +
  'full (the whole width available). Use a smaller one when the user says it is too big, and ' +
  'small or medium for something beside a paragraph of text rather than the point of the answer.'
