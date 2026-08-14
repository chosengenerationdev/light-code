import type { PythonStatus } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { colors, fontFamily, labelStyle, primaryButtonStyle, textFieldStyle } from '../theme.js'
import { PathField, type BrowseRequest } from './PathField.js'
import { DismissableProblems } from './DismissableProblems.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface PythonTabProps {
  status: PythonStatus | undefined
  onBrowse: (request: BrowseRequest) => void
  pickedPath: { purpose: string; path: string } | undefined
  onSave: (settings: {
    dynamicTools: 'off' | 'on'
    uvPath: string
    toolsDir: string
    timeoutSeconds: number
    indexUrl: string
    offline: boolean
  }) => void
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
  const [toolsDir, setToolsDir] = useState('')
  const [timeout, setTimeoutSeconds] = useState('30')
  const [indexUrl, setIndexUrl] = useState('')
  const [offline, setOffline] = useState(false)
  const [saved, setSaved] = useState(false)

  // Routed by purpose, not by focus: the native dialog takes focus while it is open.
  useEffect(() => {
    if (props.pickedPath?.purpose === 'python.uvPath') setUvPath(props.pickedPath.path)
    if (props.pickedPath?.purpose === 'python.toolsDir') setToolsDir(props.pickedPath.path)
  }, [props.pickedPath])

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
          <PathField
            id="lc-py-uv"
            label="Path to uv"
            value={uvPath}
            placeholder={status?.uv?.path ?? 'uv (found on PATH)'}
            hint="Leave blank to use uv from PATH. uv is used because it reads a tool's inline dependency block natively, so the tool file is the only place its dependencies are declared."
            browse={{ purpose: 'python.uvPath', kind: 'file' }}
            onBrowse={props.onBrowse}
            onChange={setUvPath}
          />

          <PathField
            id="lc-py-tools"
            label="Where tools are kept"
            value={toolsDir}
            placeholder={status?.toolsDir ?? '.lightcode/tools'}
            hint="Leave blank for .lightcode/tools in the workspace, which is the safer default: a tool is code the model wrote, and keeping it in the repository means every change lands in git and gets reviewed. One folder only — each tool's approved content hash is recorded alongside it."
            browse={{ purpose: 'python.toolsDir', kind: 'folder' }}
            onBrowse={props.onBrowse}
            onChange={setToolsDir}
          />

          <div style={{ marginBottom: 10 }}>
            <label htmlFor="lc-py-index" style={labelStyle()}>
              Package index
            </label>
            <input
              id="lc-py-index"
              type="text"
              value={indexUrl}
              spellCheck={false}
              placeholder="https://artifactory.corp/api/pypi/pypi/simple"
              onChange={(event) => setIndexUrl(event.target.value)}
              style={{ ...textFieldStyle(), fontFamily: monospace }}
            />
            <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
              Where a tool&apos;s declared dependencies are fetched from. Point this at your internal
              mirror to make company packages installable — and to avoid reaching public PyPI at all.
            </span>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={offline} onChange={(event) => setOffline(event.target.checked)} />
            <span style={{ fontSize: 12 }}>Offline — never fetch a package, use only what is already installed</span>
          </label>

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
            props.onSave({
              dynamicTools: enabled ? 'on' : 'off',
              uvPath: uvPath.trim(),
              toolsDir: toolsDir.trim(),
              timeoutSeconds: Number.isFinite(parsed) ? parsed : 30,
              indexUrl: indexUrl.trim(),
              offline,
            })
            setSaved(true)
          }}
        >
          Save
        </button>
        {saved && <span style={{ fontSize: 11, color: colors.muted }}>Saved.</span>}
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
              <div>
                venv: {status.venvPath || '—'}{' '}
                {status.venvSource === 'workspace'
                  ? `(this project's${status.venvIsUvManaged ? ', uv-managed' : ''})`
                  : status.venvSource === 'configured'
                    ? '(configured)'
                    : status.venvSource === 'created'
                      ? '(created by Light Code)'
                      : ''}
              </div>
            </div>
          )}

          {/*
            Refused tools are shown, not merely logged. A silently shorter tool list is the
            one outcome that teaches nobody anything — and a hash mismatch is either an
            attack or a mistake, both of which need saying out loud.
          */}
          <DismissableProblems title="Not loaded" problems={status.issues} />

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
