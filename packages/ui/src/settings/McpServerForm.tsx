import {
  BLANK_MCP_FORM,
  fromMcpServerForm,
  type McpPlatform,
  type McpServerConfig,
  type McpServerForm as McpForm,
  type McpServerKind,
  toMcpServerForm,
  validateMcpServerForm,
  venvPython,
} from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { TrashIcon } from '../icons.js'
import {
  colors,
  fieldErrorStyle,
  fontFamily,
  iconButtonStyle,
  labelStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  textFieldStyle,
} from '../theme.js'
import { PathField, type BrowseRequest } from './PathField.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface McpServerFormProps {
  /** Empty for a new server. */
  initialName: string
  initialConfig: McpServerConfig | undefined
  existingNames: string[]
  platform: McpPlatform
  saving: boolean
  /** Result of the last Detect, or undefined if it has not run for this form. */
  probe: { interpreter?: string; venvDir?: string; detail: string } | undefined
  onDetect: (venvDir: string, script: string) => void
  /** Opens a native picker; the chosen path arrives back through `pickedPath`. */
  onBrowse: (request: BrowseRequest) => void
  /** The most recent picker result. Routed to a field by its `purpose`. */
  pickedPath: { purpose: string; path: string } | undefined
  onSave: (name: string, previousName: string | undefined, config: McpServerConfig) => void
  onCancel: () => void
}

/**
 * The transport is never chosen directly, because the stored format does not record it:
 * an entry with `command` is stdio and one with `url` is Streamable HTTP (§11). Inferring
 * it is what lets a config from another client paste in unchanged. The blurbs name it
 * anyway — it is the first thing anyone who has written one of these by hand looks for.
 */
const KINDS: { value: McpServerKind; label: string; transport: string; blurb: string }[] = [
  {
    value: 'python',
    label: 'Python (venv)',
    transport: 'stdio',
    blurb: 'A script run by the interpreter inside a virtualenv. Light Code starts the process and talks to it over stdio.',
  },
  {
    value: 'npx',
    label: 'npm package',
    transport: 'stdio',
    blurb: 'Fetched and run through npx. Light Code starts the process and talks to it over stdio.',
  },
  {
    value: 'custom',
    label: 'Command',
    transport: 'stdio',
    blurb: 'Any executable, with arguments you supply. Light Code starts the process and talks to it over stdio.',
  },
  {
    value: 'http',
    label: 'HTTP',
    transport: 'Streamable HTTP',
    blurb: 'A server already running somewhere. Light Code connects to it rather than starting it.',
  },
]

function Field(props: {
  id: string
  label: string
  value: string
  placeholder?: string
  hint?: string
  error?: string
  mono?: boolean
  onChange: (value: string) => void
}): ReactElement {
  return (
    <div style={{ marginBottom: 10 }}>
      <label htmlFor={props.id} style={labelStyle()}>
        {props.label}
      </label>
      <input
        id={props.id}
        type="text"
        value={props.value}
        spellCheck={false}
        placeholder={props.placeholder ?? ''}
        onChange={(event) => props.onChange(event.target.value)}
        style={{
          ...textFieldStyle(),
          ...(props.mono === true ? { fontFamily: monospace } : {}),
          ...(props.error !== undefined ? { borderColor: colors.error } : {}),
        }}
      />
      {props.error !== undefined ? (
        <span style={fieldErrorStyle()}>{props.error}</span>
      ) : (
        props.hint !== undefined && (
          <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>{props.hint}</span>
        )
      )}
    </div>
  )
}

/** Key/value rows for env and headers. An empty key drops the row on save. */
function PairEditor(props: {
  idPrefix: string
  label: string
  hint: string
  pairs: Record<string, string>
  onChange: (pairs: Record<string, string>) => void
}): ReactElement {
  // Kept as an array while editing: a record cannot hold a half-typed duplicate or empty
  // key, and rebuilding it on every keystroke reorders the rows under the cursor.
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(props.pairs))

  const push = (next: [string, string][]): void => {
    setRows(next)
    props.onChange(Object.fromEntries(next.filter(([key]) => key.trim().length > 0)))
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <label style={labelStyle()}>{props.label}</label>
      {rows.map(([key, value], index) => (
        // Keyed by position on purpose: the key is being typed, so keying on it would
        // remount the input on every keystroke and lose focus after one character.
        <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <input
            aria-label={`${props.label} name ${index + 1}`}
            value={key}
            spellCheck={false}
            placeholder="NAME"
            onChange={(event) => push(rows.map((row, i) => (i === index ? [event.target.value, row[1]] : row)))}
            style={{ ...textFieldStyle(), fontFamily: monospace, flex: 1 }}
          />
          <input
            aria-label={`${props.label} value ${index + 1}`}
            value={value}
            spellCheck={false}
            placeholder="value"
            onChange={(event) => push(rows.map((row, i) => (i === index ? [row[0], event.target.value] : row)))}
            style={{ ...textFieldStyle(), fontFamily: monospace, flex: 2 }}
          />
          <button
            type="button"
            aria-label={`Remove ${key.length > 0 ? key : `row ${index + 1}`}`}
            style={iconButtonStyle('ghost')}
            onClick={() => push(rows.filter((_, i) => i !== index))}
          >
            <TrashIcon />
          </button>
        </div>
      ))}
      <button type="button" style={secondaryButtonStyle()} onClick={() => setRows([...rows, ['', '']])}>
        Add
      </button>
      <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 4 }}>{props.hint}</span>
    </div>
  )
}

/**
 * A form over one `mcpServers` entry.
 *
 * The raw JSON editor stays — a config pasted from another client must keep working — but
 * hand-writing an entry means knowing that a virtualenv interpreter lives under `Scripts`
 * on Windows and `bin` elsewhere, and that `npx` without `-y` waits forever on a prompt
 * nobody can answer. Those are the two shapes people actually run, so they get real fields
 * and the command is derived.
 *
 * The derived command line is shown as it will be spawned. That is the same ground-truth
 * principle as the approval prompt: what you approve is what runs, not a description of it.
 */
export function McpServerForm(props: McpServerFormProps): ReactElement {
  const [name, setName] = useState(props.initialName)
  const [form, setForm] = useState<McpForm>(() =>
    props.initialConfig !== undefined ? toMcpServerForm(props.initialConfig) : BLANK_MCP_FORM,
  )
  const [submitted, setSubmitted] = useState(false)

  /*
   * A successful probe fills both fields in. Writing them into the form rather than merely
   * displaying them is what makes the result overridable: the detected path lands in an
   * ordinary editable input, so correcting it is typing over it, not fighting it.
   */
  useEffect(() => {
    const found = props.probe?.interpreter
    if (found === undefined) return
    setForm((current) => ({
      ...current,
      interpreter: found,
      venvDir: props.probe?.venvDir ?? current.venvDir,
    }))
  }, [props.probe])

  /*
   * Routes a picker result to the field that asked for it. Keyed on `purpose` rather than
   * "whichever field had focus", because the native dialog takes focus away while it is
   * open and there is nothing reliable to come back to.
   */
  useEffect(() => {
    const picked = props.pickedPath
    if (picked === undefined) return
    const field = ({
      'mcp.script': 'script',
      'mcp.venvDir': 'venvDir',
      'mcp.interpreter': 'interpreter',
      'mcp.cwd': 'cwd',
    } as const)[picked.purpose]
    if (field === undefined) return
    setForm((current) => ({ ...current, [field]: picked.path }))
  }, [props.pickedPath])

  const errors = validateMcpServerForm(name, form)
  const duplicate =
    name.trim() !== props.initialName && props.existingNames.includes(name.trim())
      ? 'A server with this name already exists.'
      : undefined
  const nameError = errors.name ?? duplicate
  const invalid = Object.keys(errors).length > 0 || duplicate !== undefined
  const show = (field: string): string | undefined => (submitted ? errors[field] : undefined)

  const patch = (changes: Partial<McpForm>): void => setForm({ ...form, ...changes })
  const selectedKind = KINDS.find((kind) => kind.value === form.kind)

  // Rendered from the same function that builds what gets written, so the preview cannot
  // drift from the entry it is previewing.
  const preview = ((): string => {
    const config = fromMcpServerForm(form, props.platform)
    if ('url' in config) return config.url
    return [config.command, ...(config.args ?? [])].join(' ')
  })()

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily }}>
      <h3 style={{ margin: '0 0 12px', color: colors.foreground }}>
        {props.initialName.length === 0 ? 'Add MCP server' : `Edit ${props.initialName}`}
      </h3>

      <Field
        id="lc-mcp-name"
        label="Name"
        value={name}
        placeholder="filesystem"
        hint="Prefixes every tool this server exposes, e.g. filesystem__read_file."
        {...(submitted && nameError !== undefined ? { error: nameError } : {})}
        onChange={setName}
      />

      <label style={labelStyle()}>Type</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
        {KINDS.map((kind) => {
          const selected = kind.value === form.kind
          return (
            <button
              key={kind.value}
              type="button"
              title={`${kind.blurb} Transport: ${kind.transport}.`}
              onClick={() => patch({ kind: kind.value })}
              style={{
                padding: '3px 10px',
                fontFamily,
                fontSize: 11,
                borderRadius: 3,
                cursor: 'pointer',
                background: selected ? colors.accent : 'transparent',
                color: selected ? colors.buttonForeground : colors.muted,
                border: `1px solid ${selected ? colors.accent : colors.border}`,
              }}
            >
              {kind.label}
            </button>
          )
        })}
      </div>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 12px' }}>
        {selectedKind?.blurb}
      </p>

      {form.kind === 'python' && (
        <>
          <PathField
            id="lc-mcp-script"
            label="Server script"
            value={form.script}
            placeholder={props.platform === 'win32' ? 'C:\\work\\my-server\\server.py' : '/home/me/my-server/server.py'}
            hint="Your FastMCP entry point. Pick this first — the virtualenv beside it is found automatically."
            browse={{ purpose: 'mcp.script', kind: 'file', extensions: ['py'] }}
            onBrowse={props.onBrowse}
            {...(show('script') !== undefined ? { error: show('script') as string } : {})}
            onChange={(script) => patch({ script })}
          />

          <PathField
            id="lc-mcp-venv"
            label="Virtualenv folder"
            value={form.venvDir}
            placeholder={props.platform === 'win32' ? 'C:\\work\\my-server\\.venv' : '/home/me/my-server/.venv'}
            hint="Leave blank and press Detect to search beside the script."
            browse={{ purpose: 'mcp.venvDir', kind: 'folder' }}
            onBrowse={props.onBrowse}
            {...(show('venvDir') !== undefined ? { error: show('venvDir') as string } : {})}
            onChange={(venvDir) => patch({ venvDir })}
          >
            <button
              type="button"
              style={secondaryButtonStyle()}
              title="Look on disk for the interpreter, or for a virtualenv beside the script"
              onClick={() => props.onDetect(form.venvDir, form.script)}
            >
              Detect
            </button>
          </PathField>

          {props.probe !== undefined && (
            <div
              style={{
                fontSize: 11,
                marginBottom: 8,
                color: props.probe.interpreter !== undefined ? colors.muted : colors.error,
              }}
            >
              {props.probe.detail}
            </div>
          )}

          <PathField
            id="lc-mcp-interpreter"
            label="Python interpreter"
            value={form.interpreter}
            placeholder={
              form.venvDir.trim().length > 0
                ? venvPython(form.venvDir.trim(), props.platform)
                : props.platform === 'win32'
                  ? 'python.exe'
                  : 'python3'
            }
            hint="Filled in by Detect. Override it for a conda environment, a system Python, or any layout detection does not recognise — this is the executable that actually runs."
            browse={{ purpose: 'mcp.interpreter', kind: 'file' }}
            onBrowse={props.onBrowse}
            onChange={(interpreter) => patch({ interpreter })}
          />
        </>
      )}

      {form.kind === 'npx' && (
        <Field
          id="lc-mcp-package"
          label="Package"
          value={form.packageName}
          mono
          placeholder="@modelcontextprotocol/server-filesystem"
          hint="Run with -y so it installs without waiting for a confirmation nobody can answer. It is fetched from the network on first use."
          {...(show('packageName') !== undefined ? { error: show('packageName') as string } : {})}
          onChange={(packageName) => patch({ packageName })}
        />
      )}

      {form.kind === 'custom' && (
        <Field
          id="lc-mcp-command"
          label="Command"
          value={form.command}
          mono
          placeholder="docker"
          hint="An executable on PATH, or an absolute path to one."
          {...(show('command') !== undefined ? { error: show('command') as string } : {})}
          onChange={(command) => patch({ command })}
        />
      )}

      {form.kind === 'http' && (
        <>
          <Field
            id="lc-mcp-url"
            label="URL"
            value={form.url}
            mono
            placeholder="https://mcp.internal/mcp"
            {...(show('url') !== undefined ? { error: show('url') as string } : {})}
            onChange={(url) => patch({ url })}
          />
          <PairEditor
            idPrefix="lc-mcp-header"
            label="Headers"
            hint="Use ${secret:NAME} for a token — it is read from secret storage at connect time and never written to the config file."
            pairs={form.headers}
            onChange={(headers) => patch({ headers })}
          />
        </>
      )}

      {form.kind !== 'http' && (
        <>
          <div style={{ marginBottom: 10 }}>
            <label htmlFor="lc-mcp-args" style={labelStyle()}>
              Arguments
            </label>
            <textarea
              id="lc-mcp-args"
              value={form.args.join('\n')}
              spellCheck={false}
              rows={3}
              placeholder={'--root\n/data'}
              onChange={(event) => patch({ args: event.target.value.split('\n') })}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: colors.inputBackground,
                color: colors.inputForeground,
                border: `1px solid ${colors.inputBorder}`,
                borderRadius: 2,
                padding: '6px 8px',
                fontFamily: monospace,
                fontSize: 12,
                resize: 'vertical',
              }}
            />
            <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
              One per line — not a command line, so nothing is split on spaces and quoting is never needed. A path
              containing a space goes on its own line as-is.
            </span>
          </div>

          <PathField
            id="lc-mcp-cwd"
            label="Working directory"
            value={form.cwd}
            placeholder="Optional"
            hint="Where the process starts. Set it if your server reads files by relative path."
            browse={{ purpose: 'mcp.cwd', kind: 'folder' }}
            onBrowse={props.onBrowse}
            onChange={(cwd) => patch({ cwd })}
          />

          <TimeoutField value={form.timeout} error={show('timeout')} onChange={(timeout) => patch({ timeout })} />

          <PairEditor
            idPrefix="lc-mcp-env"
            label="Environment variables"
            hint="Use ${secret:NAME} for a credential — it is read from secret storage at launch and never written to the config file. Provider API keys are never passed through."
            pairs={form.env}
            onChange={(env) => patch({ env })}
          />
        </>
      )}

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle()}>
          {form.kind === 'http' ? 'Connects to' : 'Will run'}
          <span style={{ marginLeft: 6, fontWeight: 'normal', textTransform: 'none', opacity: 0.7 }}>
            {selectedKind?.transport}
          </span>
        </label>
        <div
          style={{
            fontFamily: monospace,
            fontSize: 11,
            color: colors.muted,
            background: colors.inputBackground,
            border: `1px solid ${colors.border}`,
            borderRadius: 2,
            padding: '6px 8px',
            wordBreak: 'break-all',
          }}
        >
          {preview.trim().length > 0 ? preview : '—'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          style={primaryButtonStyle(false)}
          onClick={() => {
            setSubmitted(true)
            if (invalid) return
            props.onSave(
              name.trim(),
              props.initialName.length > 0 ? props.initialName : undefined,
              fromMcpServerForm(form, props.platform, props.initialConfig),
            )
          }}
        >
          Save
        </button>
        <button type="button" style={secondaryButtonStyle()} onClick={props.onCancel}>
          Cancel
        </button>
        {props.saving && <span style={{ fontSize: 11, color: colors.muted }}>Saving…</span>}
        {submitted && invalid && <span style={{ fontSize: 11, color: colors.error }}>Fix the fields above.</span>}
      </div>
    </div>
  )
}

/**
 * How long one tool call from this server may take.
 *
 * Offered because the SDK's minute-long default is short for what people actually put behind
 * MCP — a query over a large table, a build, a report — and hitting it presents as the server
 * being broken rather than as a limit being reached. Blank keeps the default rather than
 * meaning zero, which is why it is a text field and not a number input.
 */
function TimeoutField(props: { value: string; error: string | undefined; onChange: (value: string) => void }): ReactElement {
  return (
    <div style={{ marginBottom: 12 }}>
      <label htmlFor="lc-mcp-timeout" style={labelStyle()}>
        Tool call timeout
      </label>
      <input
        id="lc-mcp-timeout"
        inputMode="numeric"
        value={props.value}
        placeholder="Seconds — blank for the default"
        onChange={(event) => props.onChange(event.target.value)}
        style={{ ...textFieldStyle(), ...(props.error !== undefined ? { borderColor: colors.error } : {}) }}
      />
      <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
        Applies to each call, not to the session. Raise it for a server that queries something
        large; a call that exceeds it is cancelled and the error names this number.
      </span>
      {props.error !== undefined && <span style={fieldErrorStyle()}>{props.error}</span>}
    </div>
  )
}
