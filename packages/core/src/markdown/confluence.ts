import { isSafeHref, parseMarkdown, type Block, type Inline } from './parse.js'

/**
 * Markdown to Confluence storage format, so a page the assistant writes looks like the reply did.
 *
 * Reported: pages the agent created or updated did not look as good as the same content in the chat.
 * The chat renders Markdown; a page had to be hand-written XHTML, and hand-written XHTML comes out bare -
 * paragraphs where there were headings, tables with no header row, code as plain text. Converting the
 * Markdown the model already writes well gives a page the same structure the chat shows: real headings,
 * tables with a header row (which Confluence shades), Confluence's own code macro with highlighting,
 * quotes, lists and links. Parsed by the chat's own parser, so the two cannot read it differently.
 */

/** Text in an XHTML document: the three characters that would be markup. */
function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(text: string): string {
  return escape(text).replace(/"/g, '&quot;')
}

/**
 * The code macro accepts only its own language names, and an unknown one shows an error on the page.
 * Common spellings map to the macro's; anything else is shown as plain code, which always works.
 */
const LANGUAGES: Record<string, string> = {
  py: 'py', python: 'py',
  js: 'javascript', javascript: 'javascript', jsx: 'javascript', ts: 'javascript', typescript: 'javascript', tsx: 'javascript', json: 'javascript',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  ps1: 'powershell', powershell: 'powershell', pwsh: 'powershell',
  sql: 'sql', java: 'java', kotlin: 'java', groovy: 'groovy', scala: 'scala',
  xml: 'xml', html: 'xml', xhtml: 'xml', svg: 'xml',
  yaml: 'yml', yml: 'yml',
  cs: 'c#', csharp: 'c#', 'c#': 'c#',
  c: 'cpp', cpp: 'cpp', 'c++': 'cpp', h: 'cpp',
  css: 'css', diff: 'diff', patch: 'diff', ruby: 'ruby', rb: 'ruby', perl: 'perl', php: 'php', vb: 'vb', erlang: 'erl',
}

function inline(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
          // A line break the model wrote inside a paragraph is one on the page too, as in the chat.
          return escape(node.text).replace(/\n/g, '<br />')
        case 'code':
          return `<code>${escape(node.text)}</code>`
        case 'strong':
          return `<strong>${inline(node.children)}</strong>`
        case 'em':
          return `<em>${inline(node.children)}</em>`
        case 'strike':
          return `<span style="text-decoration: line-through;">${inline(node.children)}</span>`
        case 'link':
          // An unsafe scheme keeps its words and loses the link - the parser's own rule, kept here.
          return isSafeHref(node.href) ? `<a href="${escapeAttribute(node.href)}">${inline(node.children)}</a>` : inline(node.children)
      }
    })
    .join('')
}

/** `]]>` would end the CDATA section early; split it across two sections. */
function cdata(text: string): string {
  return `<![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
}

function block(node: Block): string {
  switch (node.kind) {
    case 'heading': {
      const level = Math.min(Math.max(node.level, 1), 6)
      return `<h${String(level)}>${inline(node.content)}</h${String(level)}>`
    }
    case 'paragraph':
      return `<p>${inline(node.content)}</p>`
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul'
      return `<${tag}>${node.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`
    }
    case 'quote':
      return `<blockquote><p>${inline(node.content)}</p></blockquote>`
    case 'rule':
      return '<hr />'
    case 'code': {
      const language = node.language === undefined ? undefined : LANGUAGES[node.language.toLowerCase()]
      return (
        '<ac:structured-macro ac:name="code">' +
        (language !== undefined ? `<ac:parameter ac:name="language">${escape(language)}</ac:parameter>` : '') +
        `<ac:plain-text-body>${cdata(node.text)}</ac:plain-text-body></ac:structured-macro>`
      )
    }
    case 'table': {
      const cell = (tag: 'th' | 'td', content: readonly Inline[], index: number): string => {
        const align = node.align[index]
        const paragraph = align === undefined || align === 'left' ? `<p>${inline(content)}</p>` : `<p style="text-align: ${align};">${inline(content)}</p>`
        return `<${tag}>${paragraph}</${tag}>`
      }
      const head = `<tr>${node.head.map((content, index) => cell('th', content, index)).join('')}</tr>`
      const rows = node.rows.map((row) => `<tr>${row.map((content, index) => cell('td', content, index)).join('')}</tr>`).join('')
      return `<table><tbody>${head}${rows}</tbody></table>`
    }
  }
}

/** A page body in storage format from Markdown - the same Markdown the chat renders. */
export function markdownToStorage(markdown: string): string {
  return parseMarkdown(markdown).map(block).join('')
}
