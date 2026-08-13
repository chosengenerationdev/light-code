import type { PythonStatus } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { colors, fontFamily, labelStyle, primaryButtonStyle, textFieldStyle } from '../theme.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface PythonTabProps {
  status: PythonStatus | undefined
  onSave: (dynamicTools: 'off' | 'on', uvPath: string, timeoutSeconds: number) => void
}

/**
 * Dynamic Python tools.
 *
 * The tab exists as much to *explain* the feature as to configure it. This is the one place
 * where the model writes code that later runs, so the panel states what that means, shows
 * exactly which tools are registered and where their source lives, and reports loudly when a
 * tool was refused — a quietly shorter tool list teaches nobody anything.
 */
export function PythonTab(props: PythonTabProps): ReactElement {
  const status = props.status
  const [enabled, setEnabled] = useState(false)
  const [uvPath, setUvPath] = useState('')
  const [timeout, setTimeoutSeconds] = useState('30')

  // Resynced from the host rather than seeded once — its reply can arrive after mount.
  useEffect(() => {
    if (status === undefined) return
    setEnabled(status.enabled)
  }, [status])

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily, fontSize: 13, color: colors.foreground }}>
      <h3 style={{ margin: '0 0 4px' }}>Python tools</h3>
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 0 }}>
        Lets the model write small Python tools and call them in the same conversation — useful
        for parsing, data wrangling, or anything needing a library that a shell command handles
        badly.
      </p>

      {/*
        Stated plainly and before the switch. Every other approval in Light Code gates
        *calling* something; this one gates the creation of code that runs later, which is a
        different kind of decision and the user deserves to be told so.
      */}
      <div
        style={{
          fontSize: 11,
          color: colors.muted,
          border: `1px solid ${colors.border}`,
          borderRadius: 3,
          padding: '8px 10px',
          margin: '10px 0',
          lineHeight: 1.5,
        }}
      >
        This is the sharpest feature in Light Code. Elsewhere you approve a tool <em>call</em>;
        here you approve a tool&apos;s <strong>source code</strong>, which then runs whenever the
        model uses it. Every create and update shows you the full diff first, and a file changed
        afterwards — by anything — is refused rather than loaded. Tools live in your workspace so
        they land in git and get reviewed like any other code. There is no sandbox: a tool runs
        with your privileges.
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>Let the model create and run Python tools</span>
      </label>

      {enabled && (
        <>
          <div style={{ marginBottom: 10 }}>
            <label htmlFor="lc-py-uv" style={labelStyle()}>
              Path to uv
            </label>
            <input
              id="lc-py-uv"
              type="text"
              value={uvPath}
              spellCheck={false}
              placeholder={status?.uv?.path ?? 'uv (found on PATH)'}
              onChange={(event) => setUvPath(event.target.value)}
              style={{ ...textFieldStyle(), fontFamily: monospace }}
            />
            <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
              Leave blank to use <code style={{ fontFamily: monospace }}>uv</code> from PATH. uv is
              used because it reads a tool&apos;s inline dependency block natively, so a tool file
              is the only place its dependencies are declared.
            </span>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label htmlFor="lc-py-timeout" style={labelStyle()}>
              Timeout per call (seconds)
            </label>
            <input
              id="lc-py-timeout"
              type="number"
              min={1}
              max={600}
              value={timeout}
              onChange={(event) => setTimeoutSeconds(event.target.value)}
              style={{ ...textFieldStyle(), width: 120 }}
            />
            <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
              A tool that exceeds this is stopped and its whole process tree killed, so a hang
              cannot hold up the conversation.
            </span>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button
          type="button"
          style={primaryButtonStyle(false)}
          onClick={() => {
            const parsed = Number.parseInt(timeout, 10)
            props.onSave(enabled ? 'on' : 'off', uvPath.trim(), Number.isFinite(parsed) ? parsed : 30)
          }}
        >
          Save
        </button>
      </div>

      {status !== undefined && (
        <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
          <strong style={{ fontSize: 12 }}>Status</strong>
          <div
            style={{
              fontSize: 11,
              marginTop: 4,
              color: status.ready ? colors.muted : status.enabled ? colors.error : colors.muted,
            }}
          >
            {status.detail}
          </div>

          {status.enabled && (
            <div style={{ fontSize: 11, color: colors.muted, marginTop: 6, fontFamily: monospace }}>
              <div>tools: {status.toolsDir || '—'}</div>
              <div>venv: {status.venvPath || '—'}</div>
            </div>
          )}

          {/*
            Refused tools are shown, not merely logged. A silently shorter tool list is the
            one outcome that teaches nobody anything — and a hash mismatch is either an
            attack or a mistake, both of which need saying out loud.
          */}
          {status.issues.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <strong style={{ fontSize: 12, color: colors.error }}>Not loaded</strong>
              {status.issues.map((issue) => (
                <div key={issue} style={{ fontSize: 11, color: colors.error, marginTop: 4 }}>
                  ⚠ {issue}
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <strong style={{ fontSize: 12 }}>Registered tools</strong>
            {status.tools.length === 0 ? (
              <p style={{ fontSize: 11, color: colors.muted, margin: '4px 0 0' }}>
                {status.ready
                  ? 'None yet. Ask the model to write one — it will show you the source before anything is saved.'
                  : 'None.'}
              </p>
            ) : (
              status.tools.map((tool) => (
                <div key={tool.name} style={{ padding: '4px 0', borderBottom: `1px solid ${colors.border}` }}>
                  <span style={{ fontFamily: monospace, fontSize: 12 }}>py__{tool.name}</span>
                  {tool.description.length > 0 && (
                    <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>{tool.description}</span>
                  )}
                  <span style={{ display: 'block', color: colors.muted, fontSize: 10, fontFamily: monospace }}>
                    {tool.filePath}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
