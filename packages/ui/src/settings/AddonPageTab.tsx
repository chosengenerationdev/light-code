import {
  cleanAddonValues,
  isShown,
  type AddonField,
  type AddonPageView,
  type HostToUiMessage,
  type Transport,
  type UiToHostMessage,
} from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'

import { disabledWhen } from '../disabledWhen.js'
import { Select } from '../Select.js'
import { colors, fieldErrorStyle, labelStyle, monospaceFamily, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { Panel } from './Panel.js'
import { PathField, type BrowseRequest } from './PathField.js'

/**
 * An installed add-on's own settings tab (`addons/page.ts`), drawn from what its package declares.
 *
 * Light Code's controls and theme only: the add-on supplies a description of fields, never markup.
 * Secrets are write-only (invariant 7): the panel learns only whether one is set, a blank box means
 * "unchanged", and clearing is a separate act so an unrelated save can never wipe a password.
 */
export function AddonPageTab(props: {
  transport: Transport
  package: string
  onBrowse?: (request: BrowseRequest) => void
  pickedPath?: { purpose: string; path: string } | undefined
}): ReactElement {
  const { transport } = props
  const [view, setView] = useState<AddonPageView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  /** The record being edited: an id, `''` for a new one, undefined when no form is open. */
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [actionResults, setActionResults] = useState<Record<string, { ok: boolean; text: string; running?: boolean }>>({})
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined)
  /** `<record>:<tool>` of a button waiting for its second press. */
  const [confirmAction, setConfirmAction] = useState<string | undefined>(undefined)

  useEffect(() => {
    const unsubscribe = transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'addonPage' && message.package === props.package) {
        if (message.view !== undefined) setView(message.view)
        setError(message.error)
        setBusy(false)
        if (message.saved === true) setEditing(undefined)
      }
      // Tools and their Always / Ask / Never change with the server's state: ask for the page again.
      if (message.type === 'mcp') transport.post({ type: 'requestAddonPage', package: props.package } satisfies UiToHostMessage)
      if (message.type === 'addonActionResult' && message.package === props.package) {
        setActionResults((current) => ({ ...current, [`${message.id}:${message.tool}`]: { ok: message.ok, text: message.text } }))
      }
    })
    transport.post({ type: 'requestAddonPage', package: props.package } satisfies UiToHostMessage)
    return unsubscribe
  }, [transport, props.package])

  if (view === undefined) {
    return <div style={{ padding: 12, color: error !== undefined ? colors.error : colors.muted, fontSize: 12 }}>{error ?? 'Loading…'}</div>
  }
  const { page } = view
  const records = page.records
  const send = (message: UiToHostMessage): void => {
    setBusy(true)
    setError(undefined)
    transport.post(message)
  }
  const runAction = (recordId: string, tool: string): void => {
    setConfirmAction(undefined)
    setActionResults((current) => ({ ...current, [`${recordId}:${tool}`]: { ok: true, text: 'Running…', running: true } }))
    transport.post({ type: 'runAddonAction', package: view.package, id: recordId, tool } satisfies UiToHostMessage)
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {view.icon !== undefined && <img src={view.icon} alt="" width={22} height={22} />}
        <strong style={{ fontSize: 14 }}>{page.title}</strong>
        <span style={{ color: colors.muted, fontSize: 11 }}>from the {view.package} add-on</span>
      </div>
      {page.description !== undefined && <p style={{ color: colors.muted, fontSize: 12, margin: '0 0 10px', whiteSpace: 'pre-wrap' }}>{page.description}</p>}
      {view.state !== 'enabled' && (
        <p role="status" style={{ fontSize: 12, margin: '0 0 10px', padding: '6px 8px', border: `1px solid ${colors.border}`, borderRadius: 3 }}>
          {view.state === 'updated' ? 'This add-on was updated and is off until you enable the new version' : 'This add-on is not enabled yet'} - its tools
          are off. Enable it on the <strong>Add-ons</strong> tab.
        </p>
      )}
      {error !== undefined && (
        <p role="alert" style={{ ...fieldErrorStyle(), fontSize: 12, margin: '0 0 10px' }}>
          {error}
        </p>
      )}

      {/*
        What it gives the assistant, so nobody has to go looking in the MCP tab to find out - but
        switched there, where every tool's Always / Ask / Never lives.
      */}
      <Panel id={`addon.${view.package}.tools`} title="Tools it gives the assistant" summary={view.tools.length > 0 ? String(view.tools.length) : 'Not running'}>
        {view.tools.length === 0 ? (
          <p style={{ color: colors.muted, fontSize: 12, margin: 0 }}>
            {view.state === 'enabled' ? 'Starting, or it could not start - its state and log are on the Add-ons tab.' : 'Listed here once it is enabled and running.'}
          </p>
        ) : (
          <>
            {view.tools.map((tool) => (
              <div key={tool.name} style={{ margin: '0 0 8px', fontSize: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <code style={{ fontFamily: monospaceFamily }}>{tool.tool}</code>
                  <span style={{ flex: 1 }} />
                  {/* The same three states the MCP tab uses, kept in the same place. */}
                  <Select
                    compact
                    ariaLabel={`When ${tool.tool} runs`}
                    value={tool.permission}
                    options={[
                      { value: 'ask', label: 'Ask first' },
                      { value: 'always', label: 'Always allow' },
                      { value: 'never', label: 'Never' },
                    ]}
                    onChange={(permission) =>
                      transport.post({ type: 'setMcpToolPermission', server: tool.server, tool: tool.tool, permission: permission as 'ask' | 'always' | 'never' } satisfies UiToHostMessage)
                    }
                  />
                </div>
                <div style={{ color: colors.muted, fontSize: 11 }}>{tool.description.length > 220 ? `${tool.description.slice(0, 220)}…` : tool.description}</div>
              </div>
            ))}
          </>
        )}
      </Panel>

      {page.fields !== undefined && page.fields.length > 0 && (
        <Panel id={`addon.${view.package}.settings`} title="Settings">
          <AddonForm
            fields={page.fields}
            values={view.values}
            secretsSet={view.secretsSet}
            busy={busy}
            purposePrefix={`addon:${view.package}:settings`}
            onBrowse={props.onBrowse}
            pickedPath={props.pickedPath}
            submitLabel="Save"
            onSubmit={(values, secrets, clearSecrets) => send({ type: 'saveAddonValues', package: view.package, values, secrets, clearSecrets })}
          />
        </Panel>
      )}

      {records !== undefined && (
        <Panel id={`addon.${view.package}.records`} title={records.title} summary={`${String(view.records.length)}`}>
          {records.description !== undefined && <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{records.description}</p>}
          {view.records.length === 0 && editing !== '' && <p style={{ color: colors.muted, fontSize: 12 }}>No {records.noun}s yet.</p>}
          {view.records.map((record) => {
            const name = String(record.values[records.keyField] ?? '')
            if (editing === record.id) {
              return (
                <div key={record.id} style={{ border: `1px solid ${colors.border}`, borderRadius: 3, padding: 8, margin: '6px 0' }}>
                  <AddonForm
                    fields={records.fields}
                    values={record.values}
                    secretsSet={record.secretsSet}
                    busy={busy}
                    purposePrefix={`addon:${view.package}:${record.id}`}
                    onBrowse={props.onBrowse}
                    pickedPath={props.pickedPath}
                    submitLabel="Save"
                    onCancel={() => setEditing(undefined)}
                    onSubmit={(values, secrets, clearSecrets) =>
                      send({ type: 'saveAddonRecord', package: view.package, id: record.id, values, secrets, clearSecrets })
                    }
                  />
                </div>
              )
            }
            return (
              <div key={record.id} style={{ border: `1px solid ${colors.border}`, borderRadius: 3, padding: '6px 8px', margin: '6px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <strong style={{ fontFamily: monospaceFamily }}>{name}</strong>
                  {records.summary !== undefined && <span style={{ color: colors.muted, fontSize: 11 }}>{fillSummary(records.summary, record.values)}</span>}
                  <span style={{ flex: 1 }} />
                  {(records.actions ?? [])
                    .filter((action) => isShown(action, record.values))
                    .map((action) => (
                      <button
                        key={action.tool}
                        type="button"
                        style={secondaryButtonStyle()}
                        {...disabledWhen([view.state !== 'enabled', 'Enable the add-on first, on the Add-ons tab.'])}
                        // An action that changes something says what first, and runs on a second press.
                        onClick={() => (action.confirm !== undefined ? setConfirmAction(`${record.id}:${action.tool}`) : runAction(record.id, action.tool))}
                      >
                        {action.label}
                      </button>
                    ))}
                  <button type="button" style={secondaryButtonStyle()} {...disabledWhen([busy, 'Wait for the last change to finish.'])} onClick={() => setEditing(record.id)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    style={secondaryButtonStyle()}
                    {...disabledWhen([busy, 'Wait for the last change to finish.'])}
                    onClick={() => {
                      if (confirmDelete === record.id) {
                        setConfirmDelete(undefined)
                        send({ type: 'deleteAddonRecord', package: view.package, id: record.id })
                      } else setConfirmDelete(record.id)
                    }}
                  >
                    {confirmDelete === record.id ? `Delete ${name}` : 'Delete'}
                  </button>
                </div>
                {(records.actions ?? [])
                  .filter((action) => action.confirm !== undefined && confirmAction === `${record.id}:${action.tool}`)
                  .map((action) => (
                    <div key={`confirm-${action.tool}`} role="alertdialog" style={{ margin: '6px 0 0', padding: '6px 8px', border: `1px solid ${colors.border}`, borderRadius: 3, fontSize: 12 }}>
                      <p style={{ margin: '0 0 6px', whiteSpace: 'pre-wrap' }}>{fillSummary(action.confirm ?? '', record.values)}</p>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" style={primaryButtonStyle(false)} onClick={() => runAction(record.id, action.tool)}>
                          {action.label}
                        </button>
                        <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirmAction(undefined)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ))}
                {(records.actions ?? []).map((action) => {
                  const result = actionResults[`${record.id}:${action.tool}`]
                  if (result === undefined) return null
                  return (
                    <pre
                      key={action.tool}
                      style={{ fontFamily: monospaceFamily, fontSize: 11, whiteSpace: 'pre-wrap', margin: '6px 0 0', color: result.running === true ? colors.muted : result.ok ? colors.foreground : colors.error }}
                    >
                      {result.text}
                    </pre>
                  )
                })}
              </div>
            )
          })}
          {editing === '' ? (
            <div style={{ border: `1px solid ${colors.border}`, borderRadius: 3, padding: 8, margin: '6px 0' }}>
              <AddonForm
                fields={records.fields}
                values={{}}
                secretsSet={[]}
                busy={busy}
                purposePrefix={`addon:${view.package}:new`}
                onBrowse={props.onBrowse}
                pickedPath={props.pickedPath}
                submitLabel={`Add ${records.noun}`}
                onCancel={() => setEditing(undefined)}
                onSubmit={(values, secrets) => send({ type: 'saveAddonRecord', package: view.package, values, secrets })}
              />
            </div>
          ) : (
            <button type="button" style={primaryButtonStyle(busy)} {...disabledWhen([busy, 'Wait for the last change to finish.'])} onClick={() => setEditing('')}>
              Add {records.noun}
            </button>
          )}
        </Panel>
      )}
    </div>
  )
}

/** "{username}@{host}:{port}" with the record's values; a missing one leaves its part out. */
export function fillSummary(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => (values[key] === undefined ? '' : String(values[key])))
}

function AddonForm(props: {
  fields: readonly AddonField[]
  values: Record<string, unknown>
  secretsSet: readonly string[]
  busy: boolean
  purposePrefix: string
  submitLabel: string
  onBrowse?: ((request: BrowseRequest) => void) | undefined
  pickedPath?: { purpose: string; path: string } | undefined
  onCancel?: () => void
  onSubmit: (values: Record<string, unknown>, secrets: Record<string, string>, clearSecrets: string[]) => void
}): ReactElement {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const start: Record<string, unknown> = { ...props.values }
    for (const field of props.fields) if (start[field.key] === undefined && field.default !== undefined) start[field.key] = field.default
    return start
  })
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [clear, setClear] = useState<string[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const set = (key: string, value: unknown): void => setValues((current) => ({ ...current, [key]: value }))

  // A file chosen with Browse arrives for whichever field asked.
  const picked = props.pickedPath
  useEffect(() => {
    if (picked === undefined || !picked.purpose.startsWith(`${props.purposePrefix}:`)) return
    set(picked.purpose.slice(props.purposePrefix.length + 1), picked.path)
  }, [picked, props.purposePrefix])

  const submit = (): void => {
    const cleaned = cleanAddonValues(props.fields, values)
    if (!cleaned.ok) {
      setError(cleaned.message)
      return
    }
    // A required secret must exist somewhere: typed now, or stored already.
    const missing = props.fields.find(
      (field) => field.type === 'secret' && field.required === true && isShown(field, values) && (secrets[field.key] ?? '') === '' && !props.secretsSet.includes(field.key),
    )
    if (missing !== undefined) {
      setError(`${missing.label} is required.`)
      return
    }
    setError(undefined)
    props.onSubmit(cleaned.values, secrets, clear)
  }

  return (
    <div>
      {props.fields.filter((field) => isShown(field, values)).map((field) => {
        const id = `${props.purposePrefix}-${field.key}`
        const text = values[field.key] === undefined ? '' : String(values[field.key])
        const label = `${field.label}${field.required === true ? ' *' : ''}`
        const help = field.help !== undefined ? <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 2 }}>{field.help}</span> : null
        if (field.type === 'path') {
          return (
            <PathField
              key={field.key}
              id={id}
              label={label}
              value={text}
              {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
              {...(field.help !== undefined ? { hint: field.help } : {})}
              browse={{ purpose: `${props.purposePrefix}:${field.key}`, kind: 'file' }}
              {...(props.onBrowse !== undefined ? { onBrowse: props.onBrowse } : {})}
              onChange={(value) => set(field.key, value)}
            />
          )
        }
        if (field.type === 'boolean') {
          return (
            <div key={field.key} style={{ marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={values[field.key] === true} onChange={(event) => set(field.key, event.target.checked)} />
                {field.label}
              </label>
              {help}
            </div>
          )
        }
        return (
          <div key={field.key} style={{ marginBottom: 10 }}>
            <label htmlFor={id} style={labelStyle()}>
              {label}
            </label>
            {field.type === 'choice' ? (
              <Select id={id} value={text} options={field.options ?? []} onChange={(value) => set(field.key, value)} ariaLabel={field.label} />
            ) : field.type === 'text' ? (
              <textarea
                id={id}
                rows={3}
                value={text}
                placeholder={field.placeholder ?? ''}
                onChange={(event) => set(field.key, event.target.value)}
                style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
              />
            ) : field.type === 'secret' ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  value={secrets[field.key] ?? ''}
                  placeholder={props.secretsSet.includes(field.key) && !clear.includes(field.key) ? 'Set - leave blank to keep' : (field.placeholder ?? '')}
                  onChange={(event) => setSecrets((current) => ({ ...current, [field.key]: event.target.value }))}
                  style={textFieldStyle()}
                />
                {props.secretsSet.includes(field.key) && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, whiteSpace: 'nowrap' }}>
                    <input
                      type="checkbox"
                      checked={clear.includes(field.key)}
                      onChange={(event) => setClear((current) => (event.target.checked ? [...current, field.key] : current.filter((key) => key !== field.key)))}
                    />
                    Remove
                  </label>
                )}
              </div>
            ) : (
              <input
                id={id}
                type="text"
                inputMode={field.type === 'number' ? 'numeric' : undefined}
                value={text}
                placeholder={field.placeholder ?? ''}
                spellCheck={false}
                onChange={(event) => set(field.key, event.target.value)}
                style={textFieldStyle()}
              />
            )}
            {help}
          </div>
        )
      })}
      {error !== undefined && <p style={{ ...fieldErrorStyle(), fontSize: 12 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" style={primaryButtonStyle(props.busy)} {...disabledWhen([props.busy, 'Wait for the last change to finish.'])} onClick={submit}>
          {props.submitLabel}
        </button>
        {props.onCancel !== undefined && (
          <button type="button" style={secondaryButtonStyle()} onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
