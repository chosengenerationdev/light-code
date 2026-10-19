/**
 * What lands on the clipboard when somebody copies a reply.
 *
 * Asked for: whatever the assistant renders - tables, headings, lists, code - must paste into Word,
 * OneNote, a wiki or an email "in the same format". A browser's own copy carries the theme with it:
 * computed colours from a dark editor (white text that vanishes on a white page) and none of the
 * stylesheet's table borders. So the rendered reply is walked and written again as plain document HTML
 * with neutral inline styles - the only styling every one of those targets reads - and nothing of the
 * chat's own chrome (copy buttons, language labels, diagrams that only render here).
 *
 * The rendered DOM says what each element is through `data-copy` where the tag does not (a heading is
 * a styled `div` in the chat), so this needs no knowledge of how the chat lays a reply out.
 */

const FONT = 'font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#1f1f1f'
// Single quotes: these go inside style="...", where a double quote would end the attribute.
const MONO = "font-family:Consolas,'Courier New',monospace;font-size:10pt"

const STYLES: Record<string, string> = {
  p: `${FONT};margin:0 0 8px`,
  h1: `${FONT};font-size:18pt;font-weight:bold;margin:12px 0 6px`,
  h2: `${FONT};font-size:15pt;font-weight:bold;margin:12px 0 6px`,
  h3: `${FONT};font-size:13pt;font-weight:bold;margin:10px 0 4px`,
  h4: `${FONT};font-size:12pt;font-weight:bold;margin:10px 0 4px`,
  h5: `${FONT};font-weight:bold;margin:8px 0 4px`,
  h6: `${FONT};font-weight:bold;margin:8px 0 4px`,
  ul: `${FONT};margin:0 0 8px;padding-left:24px`,
  ol: `${FONT};margin:0 0 8px;padding-left:24px`,
  li: `${FONT};margin:2px 0`,
  table: `${FONT};border-collapse:collapse;margin:6px 0 10px`,
  th: 'border:1px solid #8c8c8c;padding:4px 8px;background:#f2f2f2;font-weight:bold;vertical-align:top',
  td: 'border:1px solid #8c8c8c;padding:4px 8px;vertical-align:top',
  pre: `${MONO};color:#1f1f1f;background:#f6f8fa;border:1px solid #d0d7de;padding:8px;margin:6px 0 10px;white-space:pre-wrap`,
  code: `${MONO};background:#f2f2f2;padding:0 2px`,
  blockquote: `${FONT};border-left:3px solid #c8c8c8;margin:6px 0;padding-left:10px;color:#555555`,
  a: 'color:#0563c1;text-decoration:underline',
  hr: 'border:none;border-top:1px solid #c8c8c8;margin:10px 0',
}

/** Kept as themselves. Anything else is unwrapped - its children are kept, the element is not. */
const KEPT = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code', 'strong', 'b', 'em', 'i', 'del', 's', 'a', 'blockquote', 'hr', 'br'])
/** Never copied: controls, and pictures that only render here. */
const DROPPED = new Set(['button', 'svg', 'script', 'style', 'input', 'select', 'textarea', 'img'])
const VOID = new Set(['hr', 'br'])
const SAFE_HREF = /^(https?:|mailto:)/i

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;')
}

function walk(node: Node, insidePre: boolean): string {
  if (node.nodeType === 3) {
    const text = escapeText(node.textContent ?? '')
    // Outside a code block a line break in the text is a line break on the page (the chat shows it).
    return insidePre ? text : text.replace(/\n/g, '<br>')
  }
  if (node.nodeType !== 1 && node.nodeType !== 11) return ''
  const children = (pre: boolean): string => Array.from(node.childNodes, (child) => walk(child, pre)).join('')
  if (node.nodeType === 11) return children(insidePre)

  const element = node as Element
  const marked = element.getAttribute('data-copy')
  if (marked === 'skip') return ''
  const tag = (marked ?? element.tagName).toLowerCase()
  if (DROPPED.has(tag)) return ''
  if (!KEPT.has(tag)) {
    // A styled div is a block on the page; keep it a block, without its theme.
    const inner = children(insidePre)
    return tag === 'div' && !insidePre && inner.length > 0 ? `<div>${inner}</div>` : inner
  }
  if (VOID.has(tag)) return tag === 'hr' ? `<hr style="${STYLES.hr}">` : '<br>'

  const attributes: string[] = []
  // Inside a code block, inline code has the block's look already.
  const style = tag === 'code' && insidePre ? '' : (STYLES[tag] ?? '')
  const align = (element as HTMLElement).style?.textAlign
  const styled = (tag === 'th' || tag === 'td') && align !== undefined && align !== '' ? `${style};text-align:${align}` : style
  if (styled !== '') attributes.push(`style="${escapeAttribute(styled)}"`)
  if (tag === 'a') {
    const href = element.getAttribute('href') ?? ''
    if (SAFE_HREF.test(href)) attributes.push(`href="${escapeAttribute(href)}"`)
  }
  for (const span of ['colspan', 'rowspan']) {
    const value = element.getAttribute(span)
    if (value !== null && /^\d+$/.test(value)) attributes.push(`${span}="${value}"`)
  }
  const open = attributes.length > 0 ? `<${tag} ${attributes.join(' ')}>` : `<${tag}>`
  return `${open}${children(insidePre || tag === 'pre')}</${tag}>`
}

/** Clean document HTML for a rendered fragment: a whole reply, or what is selected in one. */
export function clipboardHtml(fragment: Node): string {
  return `<div style="${FONT}">${walk(fragment, false)}</div>`
}

/**
 * Puts a rendered reply on the clipboard as formatted HTML, with `plain` as the plain-text version
 * (the Markdown source, which is what a wiki or a Markdown editor wants). Falls back to text alone
 * where the rich clipboard is not available.
 */
export async function copyRich(rendered: Node, plain: string): Promise<void> {
  const html = clipboardHtml(rendered)
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
  if (Item !== undefined && navigator.clipboard?.write !== undefined) {
    try {
      await navigator.clipboard.write([
        new Item({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        }),
      ])
      return
    } catch {
      // Refused (an embedded browser without clipboard permission): the older way below still keeps formatting.
    }
  }
  if (copyThroughSelection(html, plain)) return
  await navigator.clipboard.writeText(plain)
}

/**
 * The pre-async way: put the clean HTML in a hidden element, select it, and ask the page to copy. The
 * browser copies it as HTML with the inline styles it carries. The copy event is answered here directly,
 * with both versions, so the result does not depend on how this browser serialises a selection.
 */
function copyThroughSelection(html: string, plain: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const holder = document.createElement('div')
  holder.setAttribute('aria-hidden', 'true')
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0'
  holder.innerHTML = html
  document.body.append(holder)
  const answer = (event: ClipboardEvent): void => {
    event.clipboardData?.setData('text/html', html)
    event.clipboardData?.setData('text/plain', plain)
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  document.addEventListener('copy', answer, true)
  try {
    const range = document.createRange()
    range.selectNodeContents(holder)
    const selection = globalThis.getSelection?.()
    selection?.removeAllRanges()
    selection?.addRange(range)
    return document.execCommand('copy')
  } finally {
    document.removeEventListener('copy', answer, true)
    globalThis.getSelection?.()?.removeAllRanges()
    holder.remove()
  }
}

let installed = false

/**
 * One document-level listener, installed once: a copy event's target follows focus rather than the
 * selection, so a handler on each reply would miss some copies. It acts only when the selection touches
 * a rendered reply (`data-copy-root`), and leaves every other copy to the browser.
 */
export function installRichCopy(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('copy', (event) => {
    const selection = globalThis.getSelection?.()
    if (selection === null || selection === undefined || selection.rangeCount === 0 || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    const ancestor = range.commonAncestorContainer
    const element = ancestor.nodeType === 1 ? (ancestor as Element) : ancestor.parentElement
    if (element === null) return
    const inside = element.closest('[data-copy-root]') !== null
    const spans = Array.from(element.querySelectorAll('[data-copy-root]')).some((root) => range.intersectsNode(root))
    if (inside || spans) onCopyRich(event)
  })
}

/**
 * Ctrl+C inside a reply: the selected part, in the same clean form. Left to the browser when nothing is
 * selected (a copy from a focused control is that control's business).
 */
export function onCopyRich(event: ClipboardEvent | { clipboardData: DataTransfer | null; preventDefault(): void }): void {
  const selection = globalThis.getSelection?.()
  if (selection === null || selection === undefined || selection.rangeCount === 0 || selection.isCollapsed) return
  if (event.clipboardData === null) return
  const holder = document.createElement('div')
  for (let index = 0; index < selection.rangeCount; index += 1) holder.append(selection.getRangeAt(index).cloneContents())
  event.clipboardData.setData('text/html', clipboardHtml(holder))
  event.clipboardData.setData('text/plain', selection.toString())
  event.preventDefault()
}
