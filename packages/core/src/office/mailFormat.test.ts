import { describe, expect, it } from 'vitest'

import { annotateHtmlBody, describeColour } from './mailFormat.js'

/**
 * Reported from real use: "it can't see colours in the email content".
 *
 * `MailItem.Body` is the plain-text rendering and discards every bit of formatting — which in
 * work email is frequently the message itself. The red line is the failure; the highlighted cell
 * is the one that changed. Flattened, they all read the same.
 *
 * The risk pulling in the other direction is noise: annotating every ordinary paragraph would
 * bury the one line that was actually red, so these pin both the catch and the silence.
 */
describe('naming a colour', () => {
  it('names the ones people pick from a ribbon', () => {
    expect(describeColour('#FF0000')).toBe('red')
    expect(describeColour('red')).toBe('red')
    expect(describeColour('rgb(255, 0, 0)')).toBe('red')
    expect(describeColour('#C00000')).toBe('dark red')
    expect(describeColour('#00B050')).toBe('green')
  })

  it('understands the short hex form, which Outlook also emits', () => {
    expect(describeColour('#f00')).toBe('red')
  })

  /** Near-black is the default. Marking every paragraph "black" would drown the red one. */
  it('says nothing about ordinary body text', () => {
    expect(describeColour('#000000')).toBeUndefined()
    expect(describeColour('black')).toBeUndefined()
    expect(describeColour('#1a1a1a')).toBeUndefined()
  })

  it('keeps the hex for a colour it cannot name, rather than guessing', () => {
    expect(describeColour('#7f5a3c')).toBe('#7f5a3c')
  })

  it('ignores anything that is not a colour at all', () => {
    expect(describeColour('inherit')).toBeUndefined()
    expect(describeColour('')).toBeUndefined()
  })
})

describe('reading a formatted mail body', () => {
  it('marks a coloured run and leaves the rest alone', () => {
    const { text } = annotateHtmlBody('<p>Status: <span style="color:#FF0000">FAILED</span> overnight.</p>')
    expect(text).toContain('[red: FAILED]')
    expect(text).toContain('Status:')
    expect(text).not.toContain('span')
  })

  it('marks a highlight, which is the other way people point at a cell', () => {
    const { text } = annotateHtmlBody('<p>Row <span style="background-color:#FFFF00">42</span> is wrong.</p>')
    expect(text).toContain('[highlight yellow: 42]')
  })

  it('reads the font tag Outlook still emits from the ribbon', () => {
    const { text } = annotateHtmlBody('<p><font color="#FF0000">urgent</font></p>')
    expect(text).toContain('[red: urgent]')
  })

  it('reports which colours were used, so the annotations can be explained', () => {
    const { colours } = annotateHtmlBody(
      '<p><span style="color:#FF0000">a</span> <span style="background:#FFFF00">b</span></p>',
    )
    expect(colours).toContain('red')
    expect(colours).toContain('highlight yellow')
  })

  /**
   * Outlook wraps a coloured word in several spans. Closing on the wrong one would spill the
   * annotation across the rest of the paragraph — the failure that makes this feature worse
   * than not having it.
   */
  it('closes the annotation on the right tag when spans are nested', () => {
    const { text } = annotateHtmlBody(
      '<div><span style="color:#FF0000">bad</span></div><div>fine</div>',
    )
    expect(text).toContain('[red: bad]')
    expect(text).toMatch(/fine\s*$/)
    expect(text).not.toContain('[red: bad\nfine]')
  })

  it('leaves an unformatted message exactly as it reads', () => {
    const { text, colours } = annotateHtmlBody('<html><body><p>Hello.</p><p>Thanks.</p></body></html>')
    expect(text).toBe('Hello.\n\nThanks.')
    expect(colours).toEqual([])
  })

  it('discards the stylesheet and conditional comments Outlook buries the text in', () => {
    const html = '<head><style>p { color: red }</style></head><!--[if mso]>junk<![endif]--><body><p>Real text.</p></body>'
    expect(annotateHtmlBody(html).text).toBe('Real text.')
  })

  it('decodes entities so the text reads as it was written', () => {
    expect(annotateHtmlBody('<p>Tom &amp; Jerry &mdash; 3 &lt; 5</p>').text).toBe('Tom & Jerry — 3 < 5')
  })

  it('keeps paragraph breaks and turns table cells into columns', () => {
    const { text } = annotateHtmlBody('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>')
    expect(text).toContain('A\tB')
    expect(text).toContain('C\tD')
  })

  it('marks bold and strikethrough, which also carry meaning', () => {
    expect(annotateHtmlBody('<p><b>Note</b></p>').text).toContain('[bold: Note]')
    expect(annotateHtmlBody('<p><s>cancelled</s></p>').text).toContain('[struck through: cancelled]')
  })

  /** A dangling bracket would read as part of the message. */
  it('closes anything still open at the end of a malformed body', () => {
    const { text } = annotateHtmlBody('<p><span style="color:red">unterminated')
    expect(text).toBe('[red: unterminated]')
  })
})

/**
 * A whole message, shaped the way Outlook actually emits one: MsoNormal paragraphs, nested spans,
 * a stylesheet in the head, and a table. Checked against a hand-built sample rather than only
 * unit fragments, because the failure that matters is an annotation spilling across a paragraph
 * and that only shows up at length.
 *
 * The job names here are invented. Fixtures get read, copied and published, so anything drawn
 * from a real workplace becomes permanent the moment it is committed - and a plausible-looking
 * name is exactly the kind of detail nobody thinks to check later.
 */
describe('a realistic Outlook message', () => {
  const html = [
    '<html><head><style><!-- p.MsoNormal {margin:0cm} --></style></head>',
    '<body><div class=WordSection1>',
    '<p class=MsoNormal><span style="font-size:11.0pt">Hi team,</span></p>',
    '<p class=MsoNormal><span>The run finished with <b><span style="color:#C00000">3 failures</span></b>',
    ' in <span style="background:yellow">widget-import</span>.</span></p>',
    '<p class=MsoNormal><span style="color:#00B050">Everything else was clean.</span></p>',
    '<table><tr><td>Job</td><td>Status</td></tr><tr><td>NightlyTotals</td><td><span style="color:red">FAILED</span></td></tr></table>',
    '</div></body></html>',
  ].join('')

  it('reads as the message, with the emphasis intact and in place', () => {
    const { text } = annotateHtmlBody(html)
    expect(text).toContain('Hi team,')
    expect(text).toContain('[dark red: 3 failures]')
    expect(text).toContain('[highlight yellow: widget-import]')
    expect(text).toContain('NightlyTotals\t[red: FAILED]')
    // The clean line is green; the failure line is not swallowed into it.
    expect(text).toContain('[green: Everything else was clean.]')
  })

  it('costs a fraction of the markup it came from', () => {
    expect(annotateHtmlBody(html).text.length).toBeLessThan(html.length / 2)
  })

  it('names the Office theme blue rather than emitting a hex nobody can read', () => {
    expect(describeColour('#1F497D')).toBe('dark blue')
  })
})
