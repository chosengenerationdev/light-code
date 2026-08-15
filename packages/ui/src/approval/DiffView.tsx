import { useMemo, type ReactElement } from 'react'
import { colors } from '../theme.js'
import { tokenize, TOKEN_COLORS } from '../highlight.js'
import { collapseContext, diffLines } from './diff.js'

export interface DiffViewProps {
  path: string
  before: string
  after: string
}

const monospace = 'var(--vscode-editor-font-family, monospace)'

const lineBackground: Record<string, string> = {
  added: 'var(--vscode-diffEditor-insertedTextBackground, rgba(0,160,0,0.18))',
  removed: 'var(--vscode-diffEditor-removedTextBackground, rgba(200,0,0,0.18))',
  context: 'transparent',
}

/**
 * The language, from the file's extension.
 *
 * A diff has no fence to read a language from, and the extension is the only signal available.
 * An unrecognised one still highlights — the tokenizer falls back to a profile that accepts
 * every common comment and string syntax.
 */
function languageFor(path: string): string {
  return /\.([A-Za-z0-9+]+)$/.exec(path)?.[1] ?? ''
}

/**
 * Renders the *computed* diff between the file's current content and what the tool would
 * write — never a description supplied by the model (invariant 8).
 *
 * **Highlighted as well as diffed**, and the two do not fight: added and removed are carried by
 * the row background and the gutter marker, so token colours are free to say what the code is.
 * This is the view the user reads to decide whether an edit is safe, and a wall of monochrome
 * is where a stray line hides — the same argument as highlighting a code block in the chat,
 * only with more at stake.
 */
export function DiffView(props: DiffViewProps): ReactElement {
  const rows = useMemo(() => collapseContext(diffLines(props.before, props.after)), [props.before, props.after])
  const isNewFile = props.before.length === 0
  const language = useMemo(() => languageFor(props.path), [props.path])

  return (
    <div>
      <div style={{ color: colors.muted, fontSize: 11, marginBottom: 4, fontFamily: monospace }}>
        {props.path}
        {isNewFile && <span style={{ marginLeft: 6 }}>(new file)</span>}
      </div>
      <div
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: 4,
          maxHeight: 320,
          overflow: 'auto',
          fontFamily: monospace,
          fontSize: 12,
        }}
      >
        {rows.map((row, index) =>
          row.kind === 'gap' ? (
            <div key={index} style={{ padding: '2px 8px', color: colors.muted, background: 'transparent' }}>
              ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}
            </div>
          ) : (
            <div
              key={index}
              style={{
                display: 'flex',
                gap: 8,
                padding: '0 8px',
                background: lineBackground[row.kind],
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <span style={{ color: colors.muted, minWidth: 28, textAlign: 'right', userSelect: 'none' }}>
                {row.beforeLine ?? row.afterLine ?? ''}
              </span>
              <span style={{ color: colors.muted, userSelect: 'none' }}>
                {row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '}
              </span>
              <span style={{ flex: 1 }}>
                {tokenize(row.text, language).map((token, tokenIndex) => {
                  const color = TOKEN_COLORS[token.kind]
                  return color === undefined ? (
                    <span key={tokenIndex}>{token.text}</span>
                  ) : (
                    <span key={tokenIndex} style={{ color }}>
                      {token.text}
                    </span>
                  )
                })}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  )
}
