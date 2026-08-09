import type { ContextUsage } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { colors, fontFamily } from './theme.js'

export interface TokenBarProps {
  usage: ContextUsage | undefined
}

const SEGMENTS = [
  { key: 'system', label: 'System prompt', color: 'var(--vscode-charts-blue, #4a90d9)' },
  { key: 'toolDefinitions', label: 'Tool definitions', color: 'var(--vscode-charts-purple, #b180d7)' },
  { key: 'history', label: 'Conversation', color: 'var(--vscode-charts-green, #89d185)' },
  { key: 'results', label: 'Tool results', color: 'var(--vscode-charts-orange, #d18616)' },
] as const

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

/**
 * The per-request token breakdown §12 asks for. Its job is proportion, not precision:
 * seeing that tool results are most of the window is what tells you where to look.
 *
 * Cache hit rate is here for a specific reason — a collapse in it means something is
 * mutating the static prefix, and that is otherwise invisible until the bill arrives.
 */
export function TokenBar(props: TokenBarProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const { usage } = props
  if (usage === undefined || usage.total === 0) return null

  const window = usage.contextWindow > 0 ? usage.contextWindow : undefined
  const fractionUsed = window !== undefined ? usage.total / window : undefined
  const nearLimit = fractionUsed !== undefined && fractionUsed > 0.75

  return (
    <div style={{ padding: '4px 12px 6px', borderTop: `1px solid ${colors.border}`, fontFamily, fontSize: 11 }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: colors.muted,
          cursor: 'pointer',
          padding: 0,
          fontFamily,
          fontSize: 11,
          textAlign: 'left',
        }}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span style={{ color: nearLimit ? colors.error : colors.muted }}>
          {formatTokens(usage.total)}
          {window !== undefined ? ` / ${formatTokens(window)}` : ''} tokens
          {usage.estimated ? ' (est.)' : ''}
        </span>
        {usage.cacheHitRate !== undefined && (
          <span style={{ marginLeft: 'auto' }}>cache {Math.round(usage.cacheHitRate * 100)}%</span>
        )}
      </button>

      {/* Proportional bar. Rendered even when collapsed — it is the whole point at a glance. */}
      <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 4, background: colors.border }}>
        {SEGMENTS.map((segment) => {
          const value = usage[segment.key]
          const width = usage.total > 0 ? (value / usage.total) * 100 : 0
          if (width <= 0) return null
          return <div key={segment.key} title={`${segment.label}: ${formatTokens(value)}`} style={{ width: `${width}%`, background: segment.color }} />
        })}
      </div>

      {expanded && (
        <div style={{ marginTop: 6, color: colors.muted }}>
          {SEGMENTS.map((segment) => (
            <div key={segment.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: segment.color, flexShrink: 0 }} />
              <span>{segment.label}</span>
              <span style={{ marginLeft: 'auto' }}>{formatTokens(usage[segment.key])}</span>
            </div>
          ))}

          {usage.supersededCount > 0 && (
            <div style={{ marginTop: 4 }}>
              {usage.supersededCount} superseded file read{usage.supersededCount === 1 ? '' : 's'} dropped
            </div>
          )}
          {usage.compactedCount > 0 && (
            <div>{usage.compactedCount} earlier message{usage.compactedCount === 1 ? '' : 's'} summarised</div>
          )}
          {usage.estimated && (
            <div style={{ marginTop: 4, fontStyle: 'italic' }}>
              Estimated from text length — the provider did not report usage.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
