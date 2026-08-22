import type { PythonSettings, PythonStatus } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { colors, fontFamily, labelStyle, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { Select } from '../Select.js'
import { PathField, type BrowseRequest } from './PathField.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface PythonTabProps {
  status: PythonStatus | undefined
  /** What is saved in config — the source for these fields. See the `python` message. */
  settings: PythonSettings | undefined
  onBrowse: (request: BrowseRequest) => void
  pickedPath: { purpose: string; path: string } | undefined
  onSave: (settings: {
    dynamicTools: 'off' | 'on'
    uvPath: string
    toolsDir: string
    venvPath: string
    timeoutSeconds: number
    indexUrl: string
    offline: boolean
  }) => void
  /** Opens a tool's source in an editor tab, which is where editing belongs. */
  onOpenFile: (path: string) => void
  /**
   * Which provider writes tool source, and what there is to choose from.
   *
   * Here rather than in Providers because it is a decision about *making tools* — the question
   * arrives while you are setting this up, not while you are managing credentials.
   */
  programming?: {
    profiles: { id: string; label: string }[]
    selectedId: string | undefined
    onSelect: (id: string) => void
  }
  onDeleteTool: (name: string) => void
  /** Re-pins a tool the user has edited by hand — see the hash pin in `registry.ts`. */
  onApproveTool: (name: string) => void
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
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [venvPath, setVenvPath] = useState('')
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
    if (props.pickedPath?.purpose === 'python.venvPath') setVenvPath(props.pickedPath.path)
  }, [props.pickedPath])

  /*
   * Every field is resynced from the saved settings, not just the toggle.
   *
   * Only `enabled` was, so re-opening the tab showed blank boxes for values that were saved —
   * which reads as "nothing persisted", and would have quietly cleared them on the next save
   * from those empty fields. The resolved status stays as the *placeholder*: it reports which
   * interpreter won, which is usually not the one that was typed.
   */
  useEffect(() => {
    const saved = props.settings
    if (saved === undefined) return
    setEnabled(saved.dynamicTools === 'on')
    setUvPath(saved.uvPath ?? '')
    setToolsDir(saved.toolsDir ?? '')
    setVenvPath(saved.venvPath ?? '')
    setIndexUrl(saved.indexUrl ?? '')
    setOffline(saved.offline === true)
    setTimeoutSeconds(String(saved.timeoutSeconds ?? 30))
    // Any answer from the host supersedes an optimistic "Saved." from a previous click.
    setSaved(false)
  }, [props.settings])

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

          {/*
            The environment. Absent until now, which left "which Python is this actually using?"
            answerable only by reading the status line and unanswerable if you disagreed with it.
          */}
          <PathField
            id="lc-py-venv"
            label="Python environment"
            value={venvPath}
            placeholder={status?.venvPath ?? "the project's .venv, or one created for you"}
            hint="Leave blank to prefer the project's own .venv — that is where its internal libraries already are. Give a venv folder, or a python.exe directly, to override."
            browse={{ purpose: 'python.venvPath', kind: 'folder' }}
            onBrowse={props.onBrowse}
            onChange={setVenvPath}
          />

          {props.programming !== undefined && props.programming.profiles.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <label htmlFor="lc-py-writer" style={labelStyle()}>
                Which model writes the code
              </label>
              <Select
                id="lc-py-writer"
                value={props.programming.selectedId ?? ''}
                onChange={props.programming.onSelect}
                options={[
                  { value: '', label: 'The model you are chatting with' },
                  ...props.programming.profiles.map((profile) => ({ value: profile.id, label: profile.label })),
                ]}
              />
              <p style={{ color: colors.muted, fontSize: 11, margin: '4px 0 0' }}>
                {props.programming.selectedId === undefined || props.programming.selectedId === '' ? (
                  <>
                    The assistant writes the Python itself. Pick a different profile and it will
                    describe the tool instead, leaving the file to a model chosen for code.
                  </>
                ) : (
                  <>
                    The assistant describes what the tool must do and this profile writes the file.
                    You still approve the source before anything is saved, and the prompt says which
                    model produced it.
                  </>
                )}
              </p>
            </div>
          )}

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
              venvPath: venvPath.trim(),
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
          {status.issues.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <strong style={{ fontSize: 12, color: colors.error }}>Not loaded</strong>
              {status.issues.map((issue) => (
                <div key={issue.filePath} style={{ marginTop: 4 }}>
                  <div style={{ fontSize: 11, color: colors.error }}>⚠ {issue.detail}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 3 }}>
                    <button
                      type="button"
                      style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
                      onClick={() => props.onOpenFile(issue.filePath)}
                    >
                      Open
                    </button>
                    {/*
                      Offered only where re-pinning would actually fix it. A file that does not
                      load at all must not be approved — the pin would start certifying broken
                      code, which is worse than the mismatch it was meant to resolve.
                    */}
                    {issue.recoverable && (
                      <button
                        type="button"
                        style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
                        title="Trust this file as it stands now. Read it first — a change you did not make is exactly what the check is for."
                        onClick={() => props.onApproveTool(issue.name)}
                      >
                        Approve this version
                      </button>
                    )}
                    <button
                      type="button"
                      style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
                      onClick={() => setConfirming(issue.name)}
                    >
                      Delete
                    </button>
                  </div>
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
                <div key={tool.name} style={{ padding: '6px 0', borderBottom: `1px solid ${colors.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontFamily: monospace, fontSize: 12 }}>py__{tool.name}</span>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                      {/*
                        Opens the real file, not a copy: editing has to write back. A hand-edit
                        leaves the tool refused on a hash mismatch until it is approved again,
                        which the "Not loaded" section above offers.
                      */}
                      <button
                        type="button"
                        style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
                        title="Open the source in an editor tab"
                        onClick={() => props.onOpenFile(tool.filePath)}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        style={{ ...secondaryButtonStyle(), fontSize: 10, padding: '1px 6px' }}
                        onClick={() => setConfirming(tool.name)}
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                  {tool.description.length > 0 && (
                    <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>{tool.description}</span>
                  )}
                  <span style={{ display: 'block', color: colors.muted, fontSize: 10, fontFamily: monospace }}>
                    {tool.filePath}
                  </span>

                  {confirming === tool.name && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12 }}>
                      <span>Delete this tool and its approval?</span>
                      <button
                        type="button"
                        style={primaryButtonStyle(false)}
                        onClick={() => {
                          props.onDeleteTool(tool.name)
                          setConfirming(undefined)
                        }}
                      >
                        Delete
                      </button>
                      <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirming(undefined)}>
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
