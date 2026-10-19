// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { MarkdownView } from './MarkdownView.js'
import { clipboardHtml, onCopyRich } from './richCopy.js'

/**
 * Copying a reply must paste into Word, OneNote, a wiki or an email as it looks in the chat. Driven
 * against a real rendered reply, because the defect was what the browser put on the clipboard: theme
 * colours that vanish on a white page and tables without their borders.
 */

const REPLY = [
  '## Results',
  '',
  'Two jobs **failed** overnight, see [the runbook](https://wiki.example.com/runbook).',
  '',
  '| Job | Status |',
  '| --- | :---: |',
  '| PAY_LOAD | FAILURE |',
  '| PAY_SUM | SUCCESS |',
  '',
  '- first',
  '- second',
  '',
  '> quoted note',
  '',
  '```python',
  'print("hi")',
  '```',
].join('\n')

function rendered(): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  act(() => createRoot(container).render(<MarkdownView text={REPLY} />))
  return container.querySelector('[data-copy-root]')!
}

describe('copying a reply', () => {
  it('writes document HTML: real headings, bordered tables, lists, quotes and code blocks', () => {
    const html = clipboardHtml(rendered())
    expect(html).toMatch(/<h2 style="[^"]*font-weight:bold[^"]*">Results<\/h2>/)
    expect(html).toMatch(/<table style="[^"]*border-collapse:collapse/)
    expect(html).toMatch(/<th style="[^"]*border:1px solid #8c8c8c[^"]*background:#f2f2f2/)
    expect(html).toMatch(/<td style="[^"]*border:1px solid #8c8c8c[^"]*text-align:center[^"]*">FAILURE/)
    expect(html).toMatch(/<ul [^>]*><li [^>]*>first<\/li>/)
    expect(html).toMatch(/<blockquote [^>]*>quoted note<\/blockquote>/)
    expect(html).toMatch(/<pre style="[^"]*Consolas[^"]*">print\("hi"\)<\/pre>/)
    expect(html).toContain('<strong>failed</strong>')
    expect(html).toContain('href="https://wiki.example.com/runbook"')
  })

  it('carries none of the chat: no theme colours, no copy button, no language label', () => {
    const html = clipboardHtml(rendered())
    expect(html).not.toContain('var(--')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('python')
    expect(html).not.toMatch(/Copy/)
  })

  it('Ctrl+C on a selection puts the same clean form on the clipboard, with plain text beside it', () => {
    const root = rendered()
    const range = document.createRange()
    range.selectNodeContents(root.querySelector('table')!)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const data = new Map<string, string>()
    let prevented = false
    onCopyRich({ clipboardData: { setData: (type: string, value: string) => data.set(type, value) } as unknown as DataTransfer, preventDefault: () => (prevented = true) })
    expect(prevented).toBe(true)
    expect(data.get('text/html')).toMatch(/<td style="[^"]*border:1px solid/)
    expect(data.get('text/plain')).toContain('PAY_LOAD')
  })

  it('leaves the copy alone when nothing is selected', () => {
    window.getSelection()!.removeAllRanges()
    let prevented = false
    onCopyRich({ clipboardData: { setData: () => undefined } as unknown as DataTransfer, preventDefault: () => (prevented = true) })
    expect(prevented).toBe(false)
  })
})
