import type { ProfileInput, ProfileSummary, TestConnectionStep } from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { colors, fontFamily, labelStyle, primaryButtonStyle, secondaryButtonStyle } from '../theme.js'
import { ProviderForm, type ProviderFormValues } from './ProviderForm.js'
import { ScopeBadge } from './ScopeBadge.js'

export interface ProvidersTabProps {
  profiles: ProfileSummary[]
  activeProfileId: string | undefined
  onSave: (input: ProfileInput) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onSetActive: (id: string) => void
  onExport: () => void
  onImport: () => void
  onRequestModels: (input: ProfileInput) => void
  onTestConnection: (input: ProfileInput) => void
  /** Results live here rather than in the form so they survive a re-render of the list. */
  models: string[]
  modelsWarning?: string
  modelsLoading: boolean
  testRunning: boolean
  testResult?: { ok: boolean; steps: TestConnectionStep[] }
  /** Clears stale model/test results when a different profile is opened. */
  onEditingChange: () => void
}

type EditingState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; profile: ProfileSummary }

export function ProvidersTab(props: ProvidersTabProps): ReactElement {
  const [editing, setEditing] = useState<EditingState>({ mode: 'closed' })

  const open = (next: EditingState): void => {
    props.onEditingChange()
    setEditing(next)
  }

  if (editing.mode !== 'closed') {
    const initial: ProviderFormValues =
      editing.mode === 'edit'
        ? {
            id: editing.profile.id,
            label: editing.profile.label,
            wireFormat: editing.profile.wireFormat,
            baseUrl: editing.profile.baseUrl,
            model: editing.profile.model,
            authType: editing.profile.authType,
            hasApiKey: editing.profile.hasApiKey,
            hasClientSecret: editing.profile.hasClientSecret,
            hasCertPassphrase: editing.profile.hasCertPassphrase,
            ...(editing.profile.apigee !== undefined ? { apigee: editing.profile.apigee } : {}),
            ...(editing.profile.certs !== undefined ? { certs: editing.profile.certs } : {}),
            ...(editing.profile.modelCapabilities !== undefined
              ? { modelCapabilities: editing.profile.modelCapabilities }
              : {}),
          }
        : {
            label: '',
            wireFormat: 'openai' as const,
            baseUrl: '',
            model: '',
            // API key is the default because it is what almost every provider needs; mTLS
            // is opted into from the Authentication dropdown.
            authType: 'apiKey' as const,
            hasApiKey: false,
            hasClientSecret: false,
            hasCertPassphrase: false,
          }

    return (
      <ProviderForm
        initial={initial}
        onSave={(input) => {
          props.onSave(input)
          setEditing({ mode: 'closed' })
        }}
        onCancel={() => setEditing({ mode: 'closed' })}
        onRequestModels={props.onRequestModels}
        onTestConnection={props.onTestConnection}
        models={props.models}
        {...(props.modelsWarning !== undefined ? { modelsWarning: props.modelsWarning } : {})}
        modelsLoading={props.modelsLoading}
        testRunning={props.testRunning}
        {...(props.testResult !== undefined ? { testResult: props.testResult } : {})}
      />
    )
  }

  return (
    <div style={{ padding: 12, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h3 style={{ margin: 0, color: colors.foreground }}>Providers</h3>
        <ScopeBadge scope="user" />
      </div>

      {props.profiles.length === 0 && (
        <p style={{ color: colors.muted, fontFamily }}>No providers configured yet. Add one to start chatting.</p>
      )}

      {props.profiles.map((profile) => {
        const isActive = profile.id === props.activeProfileId
        return (
          <div
            key={profile.id}
            style={{
              padding: 10,
              marginBottom: 8,
              borderRadius: 4,
              border: `1px solid ${colors.border}`,
              background: isActive ? colors.assistantBubble : 'transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <strong>{profile.label}</strong>
              {isActive && <ScopeBadge scope="user" />}
            </div>
            <div style={{ color: colors.muted, fontSize: 12, marginBottom: 8 }}>
              {profile.baseUrl} — {profile.model}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {!isActive && (
                <button type="button" style={secondaryButtonStyle()} onClick={() => props.onSetActive(profile.id)}>
                  Use
                </button>
              )}
              <button type="button" style={secondaryButtonStyle()} onClick={() => open({ mode: 'edit', profile })}>
                Edit
              </button>
              <button type="button" style={secondaryButtonStyle()} onClick={() => props.onDuplicate(profile.id)}>
                Duplicate
              </button>
              <button type="button" style={secondaryButtonStyle()} onClick={() => props.onDelete(profile.id)}>
                Delete
              </button>
            </div>
          </div>
        )
      })}

      <button type="button" style={primaryButtonStyle(false)} onClick={() => open({ mode: 'create' })}>
        Add Provider
      </button>

      <div style={{ marginTop: 20, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
        <label style={labelStyle()}>Config file</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" style={secondaryButtonStyle()} onClick={props.onExport}>
            Export
          </button>
          <button type="button" style={secondaryButtonStyle()} onClick={props.onImport}>
            Import
          </button>
        </div>
      </div>
    </div>
  )
}
