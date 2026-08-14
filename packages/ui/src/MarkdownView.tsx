import { useState, type ReactElement, type ReactNode } from 'react'
import { CheckIcon, CopyIcon } from './icons.js'
import { parseMarkdown, type Block, type Inline } from './markdown.js'
import { colors, fontFamily } from './theme.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

/**
 * Renders a model's reply.
 *
 * **React elements, never HTML.** Nothing here goes near `dangerouslySetInnerHTML`, so a reply
 * containing `<script>` renders those characters rather than being parsed as markup. That is a
 * stronger guarantee than sanitising after the fact, and it needs no dependency to make it.
 *
 * Colours come from the editor's own theme, so a code block matches the editor beside it rather
 * than introducing a second palette into the panel.
 */

function renderInline(nodes: readonly Inline[], keyPrefix = ''): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${String(index)}`
    if (node.kind === 'text') return <span key={key}>{node.text}</span>
    if (node.kind === 'code') {
      return (
        <code
          key={key}
          style={{
            fontFamily: monospace,
            fontSize: '0.92em',
            padding: '1px 4px',
            borderRadius: 4,
            background: colors.accentSoft,
            // Long identifiers must wrap, or one of them widens the whole bubble.
            wordBreak: 'break-word',
          }}
        >
          {node.text}
        </code>
      )
    }
    if (node.kind === 'strong') return <strong key={key}>{renderInline(node.children, `${key}-`)}</strong>
    if (node.kind === 'em') return <em key={key}>{renderInline(node.children, `${key}-`)}</em>
    if (node.kind === 'strike') {
      return (
        <span key={key} style={{ textDecoration: 'line-through', opacity: 0.75 }}>
          {renderInline(node.children, `${key}-`)}
        </span>
      )
    }
    return (
      <a
        key={key}
        href={node.href}
        // The scheme was already checked when parsing; these are for the target document.
        rel="noopener noreferrer"
        title={node.href}
        style={{ color: colors.accent, textDecoration: 'underline' }}
      >
        {renderInline(node.children, `${key}-`)}
      </a>
    )
  })
}

/**
 * A fenced code block, with a copy button.
 *
 * The single most-copied thing in a coding assistant's output, and selecting it by hand in a
 * narrow sidebar is genuinely awkward — the block scrolls horizontally and the drag runs away.
 */
function CodeBlock(props: { text: string; language?: string | undefined }): ReactElement {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard?.writeText(props.text).then(() => {
      setCopied(true)
      // Reverts on its own: a button stuck on "copied" stops confirming anything.
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div
      style={{
        position: 'relative',
        margin: '6px 0',
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        background: colors.inputBackground,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 6px 3px 10px',
          borderBottom: `1px solid ${colors.border}`,
          color: colors.muted,
          fontFamily,
          fontSize: 10,
        }}
      >
        <span>{props.language ?? 'code'}</span>
        <button
          type="button"
          title={copied ? 'Copied' : 'Copy'}
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={copy}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 6px',
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            color: copied ? colors.accent : colors.muted,
            cursor: 'pointer',
            fontSize: 10,
          }}
        >
          {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
        </button>
      </div>
      {/*
        Scrolls rather than wraps. Wrapped code changes where the line breaks fall, and for
        anything indentation-sensitive that is a different program.
      */}
      <pre
        className="lc-scroll"
        style={{
          margin: 0,
          padding: '8px 10px',
          overflowX: 'auto',
          fontFamily: monospace,
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        {props.text}
      </pre>
    </div>
  )
}

function renderBlock(block: Block, key: string): ReactElement {
  if (block.kind === 'code') {
    return <CodeBlock key={key} text={block.text} language={block.language} />
  }
  if (block.kind === 'rule') {
    return <hr key={key} style={{ border: 'none', borderTop: `1px solid ${colors.border}`, margin: '10px 0' }} />
  }
  if (block.kind === 'heading') {
    // Scaled down hard: an `h1` at browser defaults is enormous inside a chat bubble, and a
    // model uses headings far more freely than a document author would.
    const size = [15, 14, 13, 12.5, 12, 12][block.level - 1] ?? 12
    return (
      <div key={key} style={{ fontSize: size, fontWeight: 600, margin: '10px 0 4px' }}>
        {renderInline(block.content, `${key}-`)}
      </div>
    )
  }
  if (block.kind === 'quote') {
    return (
      <div
        key={key}
        style={{
          margin: '6px 0',
          paddingLeft: 10,
          borderLeft: `2px solid ${colors.accent}`,
          color: colors.muted,
          whiteSpace: 'pre-wrap',
        }}
      >
        {renderInline(block.content, `${key}-`)}
      </div>
    )
  }
  if (block.kind === 'list') {
    const List = block.ordered ? 'ol' : 'ul'
    return (
      <List key={key} style={{ margin: '6px 0', paddingLeft: 20 }}>
        {block.items.map((item, index) => (
          <li key={`${key}-${String(index)}`} style={{ margin: '2px 0' }}>
            {renderInline(item, `${key}-${String(index)}-`)}
          </li>
        ))}
      </List>
    )
  }
  if (block.kind === 'table') {
    const cell = (index: number): { textAlign: 'left' | 'center' | 'right' } => ({
      textAlign: block.align[index] ?? 'left',
    })
    return (
      // Scrolls rather than squeezing: a table narrower than its content is unreadable, and a
      // sidebar is narrow by definition.
      <div key={key} className="lc-scroll" style={{ overflowX: 'auto', margin: '6px 0' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
          <thead>
            <tr>
              {block.head.map((heading, index) => (
                <th
                  key={`${key}-h${String(index)}`}
                  style={{
                    ...cell(index),
                    padding: '4px 8px',
                    borderBottom: `1px solid ${colors.accent}`,
                    color: colors.foreground,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {renderInline(heading, `${key}-h${String(index)}-`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-r${String(rowIndex)}`}>
                {row.map((values, columnIndex) => (
                  <td
                    key={`${key}-r${String(rowIndex)}c${String(columnIndex)}`}
                    style={{
                      ...cell(columnIndex),
                      padding: '4px 8px',
                      borderBottom: `1px solid ${colors.border}`,
                      verticalAlign: 'top',
                    }}
                  >
                    {renderInline(values, `${key}-r${String(rowIndex)}c${String(columnIndex)}-`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <div key={key} style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>
      {renderInline(block.content, `${key}-`)}
    </div>
  )
}

/**
 * Named `MarkdownView` rather than `Markdown` because the parser beside it is `markdown.ts`,
 * and two files differing only in case cannot coexist on Windows (§16) — the compiler resolves
 * one import to the other and the error names neither cause.
 */
export function MarkdownView(props: { text: string }): ReactElement {
  return <>{parseMarkdown(props.text).map((block, index) => renderBlock(block, String(index)))}</>
}
