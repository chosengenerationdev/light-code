import type { ReactElement } from 'react'
import { colors, fontFamily } from '../theme.js'
import { ProvidersTab, type ProvidersTabProps } from './ProvidersTab.js'

/**
 * Tabbed shell. Providers is the only tab in Phase 2b — Approvals, Modes, and MCP
 * tabs land in later phases and slot in here without redesigning this shell.
 */
export function SettingsPanel(props: ProvidersTabProps): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: '8px 12px',
            fontFamily,
            fontSize: 12,
            color: colors.foreground,
            borderBottom: `2px solid ${colors.buttonBackground}`,
          }}
        >
          Providers
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <ProvidersTab {...props} />
      </div>
    </div>
  )
}
