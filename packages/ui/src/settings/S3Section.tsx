import { useEffect, useState, type ReactElement } from 'react'

import { Select } from '../Select.js'
import {
  colors,
  labelStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  textFieldStyle,
} from '../theme.js'

/**
 * S3 buckets, and pointing a folder of one at skills or Python tools.
 *
 * ## Why the connection list lives here
 *
 * Asked for in the Skills tab, because pointing skill storage at a bucket is what most people come
 * here to do. The list is shared, though — the Python tab picks from these same connections rather
 * than keeping its own — since a bucket and a key edited in two places is the drift this project
 * has paid for more than any other defect.
 */

export interface S3ConnectionSummary {
  id: string
  label: string
  bucket: string
  region: string
  accessKeyId: string
  hasSecret: boolean
  endpoint?: string
  pathStyle?: boolean
  prefix?: string
  readOnly?: boolean
}

export interface S3Mirror {
  connectionId: string
  prefix?: string | undefined
  enabled?: boolean | undefined
  /** New skills are also copied to this one. At most one folder carries it. */
  publish?: boolean | undefined
}

export interface S3SectionProps {
  connections: S3ConnectionSummary[]
  problems: { label: string; problem: string }[]
  /** Which mirror this instance edits. The Skills tab shows `skills`, the Python tab `tools`. */
  kind: 'skills' | 'tools'
  /** Bucket folders read from, in order. Several is the ordinary case, not a special one. */
  mirrors: S3Mirror[]
  /** Where each lands, stated rather than left to be guessed. */
  folders: string[]
  lastSync?: string | undefined
  onSaveConnection: (
    connection: {
      id?: string
      label: string
      bucket: string
      region: string
      accessKeyId: string
      endpoint?: string
      pathStyle?: boolean
      prefix?: string
      readOnly?: boolean
    },
    secret: string,
    sessionToken: string,
  ) => void
  onDeleteConnection: (id: string) => void
  onSaveMirrors: (mirrors: S3Mirror[]) => void
  onSync: () => void
  /** Only the Skills tab offers connection management; Python just picks one. */
  manageConnections?: boolean
}

const BLANK = {
  id: undefined as string | undefined,
  label: '',
  bucket: '',
  region: 'us-east-1',
  accessKeyId: '',
  endpoint: '',
  prefix: '',
  pathStyle: false,
  readOnly: false,
}

export function S3Section(props: S3SectionProps): ReactElement {
  const [editing, setEditing] = useState<typeof BLANK | undefined>(undefined)
  const [secret, setSecret] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined)

  /*
   * Edited as a whole list and saved as one.
   *
   * Resynced from props by value rather than by reference: the array is rebuilt on every message
   * from the host, so depending on its identity would discard whatever was half-typed each time
   * anything unrelated arrived.
   */
  const saved = JSON.stringify(props.mirrors)
  const [rows, setRows] = useState<S3Mirror[]>(props.mirrors)
  useEffect(() => setRows(JSON.parse(saved) as S3Mirror[]), [saved])
  const dirty = JSON.stringify(rows) !== saved

  const setRow = (index: number, change: Partial<S3Mirror>): void => {
    setRows(rows.map((row, at) => (at === index ? { ...row, ...change } : row)))
  }

  const what = props.kind === 'skills' ? 'skills' : 'Python tools'
  const extension = props.kind === 'skills' ? '.md' : '.py'

  const startEdit = (connection?: S3ConnectionSummary): void => {
    setSecret('')
    setSessionToken('')
    setEditing(
      connection === undefined
        ? { ...BLANK }
        : {
            id: connection.id,
            label: connection.label,
            bucket: connection.bucket,
            region: connection.region,
            accessKeyId: connection.accessKeyId,
            endpoint: connection.endpoint ?? '',
            prefix: connection.prefix ?? '',
            pathStyle: connection.pathStyle === true,
            readOnly: connection.readOnly === true,
          },
    )
  }

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${colors.border}` }}>
      <h4 style={{ margin: '0 0 4px' }}>Keep {what} in an S3 bucket</h4>
      <p style={{ margin: '0 0 10px', color: colors.muted, fontSize: 12, lineHeight: 1.5 }}>
        Files are copied down to this machine and then used exactly as local ones are &mdash; loaded,
        watched and <strong>indexed as you have already configured</strong>. Nothing about indexing
        changes because the files came from a bucket.
        {props.kind === 'tools' && (
          <>
            {' '}
            A downloaded tool is <strong>not run until you approve it</strong> and see its source,
            the same as one written here. A bucket is how a tool reaches this machine, not a reason
            to trust it.
          </>
        )}
      </p>

      {props.problems.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {props.problems.map((problem) => (
            <div key={problem.label} style={{ color: colors.error, fontSize: 12, marginBottom: 4 }}>
              <strong>{problem.label}:</strong> {problem.problem}
            </div>
          ))}
        </div>
      )}

      {props.manageConnections === true && (
        <>
          <label style={labelStyle()}>Buckets</label>
          {props.connections.length === 0 && (
            <p style={{ margin: '0 0 8px', color: colors.muted, fontSize: 12 }}>
              None yet. Add one to point {what} at a folder in it.
            </p>
          )}
          {props.connections.map((connection) => (
            <div
              key={connection.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 0',
                borderBottom: `1px solid ${colors.border}`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>
                  {connection.label}
                  {connection.readOnly === true && (
                    <span style={{ color: colors.muted, fontSize: 11 }}> &middot; read-only</span>
                  )}
                </div>
                <div style={{ color: colors.muted, fontSize: 11, wordBreak: 'break-all' }}>
                  s3://{connection.bucket}/{connection.prefix ?? ''} &middot; {connection.region}
                  {connection.hasSecret ? '' : ' · no key stored'}
                </div>
              </div>
              <button type="button" style={secondaryButtonStyle()} onClick={() => startEdit(connection)}>
                Edit
              </button>
              {confirmDelete === connection.id ? (
                <button
                  type="button"
                  style={secondaryButtonStyle()}
                  onClick={() => {
                    props.onDeleteConnection(connection.id)
                    setConfirmDelete(undefined)
                  }}
                >
                  Really delete?
                </button>
              ) : (
                <button
                  type="button"
                  style={secondaryButtonStyle()}
                  onClick={() => setConfirmDelete(connection.id)}
                >
                  Delete
                </button>
              )}
            </div>
          ))}

          {editing === undefined ? (
            <button type="button" style={{ ...secondaryButtonStyle(), marginTop: 8 }} onClick={() => startEdit()}>
              Add a bucket
            </button>
          ) : (
            <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
              <label style={labelStyle()}>Name</label>
              <input
                type="text"
                value={editing.label}
                placeholder="e.g. team-docs"
                onChange={(event) => setEditing({ ...editing, label: event.target.value })}
                style={textFieldStyle()}
              />
              <label style={labelStyle()}>Bucket</label>
              <input
                type="text"
                value={editing.bucket}
                onChange={(event) => setEditing({ ...editing, bucket: event.target.value })}
                style={textFieldStyle()}
              />
              <label style={labelStyle()}>Region</label>
              <input
                type="text"
                value={editing.region}
                onChange={(event) => setEditing({ ...editing, region: event.target.value })}
                style={textFieldStyle()}
              />
              <label style={labelStyle()}>Access key ID</label>
              <input
                type="text"
                value={editing.accessKeyId}
                spellCheck={false}
                onChange={(event) => setEditing({ ...editing, accessKeyId: event.target.value })}
                style={textFieldStyle()}
              />
              <label style={labelStyle()}>
                Secret access key{' '}
                {editing.id !== undefined &&
                  props.connections.find((connection) => connection.id === editing.id)?.hasSecret === true && (
                    <span style={{ color: colors.muted, fontWeight: 400 }}>
                      &mdash; stored; leave blank to keep it
                    </span>
                  )}
              </label>
              {/*
                Write-only across the bridge (invariant 7): the stored value is never sent back, so
                blank means "unchanged" rather than "clear". Read the other way, a save about the
                region would wipe the key on the way past.
              */}
              <input
                type="password"
                value={secret}
                spellCheck={false}
                onChange={(event) => setSecret(event.target.value)}
                style={textFieldStyle()}
              />
              <label style={labelStyle()}>
                Session token <span style={{ color: colors.muted, fontWeight: 400 }}>(only for temporary credentials)</span>
              </label>
              <input
                type="password"
                value={sessionToken}
                spellCheck={false}
                onChange={(event) => setSessionToken(event.target.value)}
                style={textFieldStyle()}
              />
              <label style={labelStyle()}>
                Endpoint <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                type="text"
                value={editing.endpoint}
                placeholder="https://s3.eu-west-1.amazonaws.com"
                spellCheck={false}
                onChange={(event) => setEditing({ ...editing, endpoint: event.target.value })}
                style={textFieldStyle()}
              />
              <label style={labelStyle()}>
                Limit to prefix <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                type="text"
                value={editing.prefix}
                placeholder="e.g. light-code/"
                spellCheck={false}
                onChange={(event) => setEditing({ ...editing, prefix: event.target.value })}
                style={textFieldStyle()}
              />
              <span style={{ color: colors.muted, fontSize: 11 }}>
                Everything this connection can reach is held inside this prefix, including what the
                assistant asks for. Leave it blank for the whole bucket.
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={editing.pathStyle}
                  onChange={(event) => setEditing({ ...editing, pathStyle: event.target.checked })}
                />
                Put the bucket in the path &mdash; <code>endpoint/bucket/key</code>
              </label>
              <span style={{ color: colors.muted, fontSize: 11, marginTop: -2 }}>
                Worked out from the endpoint when you leave this alone: anything that is not AWS
                uses the path, since an internal address would need wildcard DNS and a wildcard
                certificate per bucket to do otherwise. Tick it to force either way.
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={editing.readOnly}
                  onChange={(event) => setEditing({ ...editing, readOnly: event.target.checked })}
                />
                Read-only &mdash; refuse every upload
              </label>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  style={primaryButtonStyle(editing.label.trim() === '' || editing.bucket.trim() === '')}
                  disabled={editing.label.trim() === '' || editing.bucket.trim() === ''}
                  onClick={() => {
                    props.onSaveConnection(
                      {
                        ...(editing.id !== undefined ? { id: editing.id } : {}),
                        label: editing.label,
                        bucket: editing.bucket,
                        region: editing.region,
                        accessKeyId: editing.accessKeyId,
                        endpoint: editing.endpoint,
                        prefix: editing.prefix,
                        pathStyle: editing.pathStyle,
                        readOnly: editing.readOnly,
                      },
                      secret,
                      sessionToken,
                    )
                    setEditing(undefined)
                  }}
                >
                  Save bucket
                </button>
                <button type="button" style={secondaryButtonStyle()} onClick={() => setEditing(undefined)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 14 }}>
        <label style={labelStyle()}>Folders holding your {what}</label>
        {props.connections.length === 0 ? (
          <p style={{ margin: 0, color: colors.muted, fontSize: 12 }}>
            Add a bucket {props.manageConnections === true ? 'above' : 'in the Skills tab'} first.
          </p>
        ) : (
          <>
            {rows.length === 0 && (
              <p style={{ margin: '0 0 6px', color: colors.muted, fontSize: 12 }}>
                None yet. Add a folder to read {what} from it.
              </p>
            )}
            {rows.map((row, index) => (
              <div
                key={index}
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: '4px 0',
                }}
              >
                <Select
                  value={row.connectionId}
                  onChange={(value) => setRow(index, { connectionId: value })}
                  options={props.connections.map((connection) => ({
                    value: connection.id,
                    label: connection.label,
                  }))}
                />
                <input
                  type="text"
                  value={row.prefix ?? ''}
                  placeholder={props.kind === 'skills' ? 'skills/' : 'tools/'}
                  spellCheck={false}
                  onChange={(event) => setRow(index, { prefix: event.target.value })}
                  style={{ ...textFieldStyle(), flex: 1, minWidth: 120 }}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={row.enabled === true}
                    onChange={(event) => setRow(index, { enabled: event.target.checked })}
                  />
                  Use
                </label>
                {props.kind === 'skills' && (
                  /*
                   * At most one, enforced here rather than left to the user.
                   *
                   * Two folders both receiving new skills would make "where did that go"
                   * unanswerable - so ticking one unticks the rest, which is the same shape the
                   * local folders already have: many read from, one written to.
                   */
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={row.publish === true}
                      onChange={(event) =>
                        setRows(
                          rows.map((other, at) => ({
                            ...other,
                            publish: event.target.checked ? at === index : false,
                          })),
                        )
                      }
                    />
                    Save new here
                  </label>
                )}
                <button
                  type="button"
                  style={secondaryButtonStyle()}
                  onClick={() => setRows(rows.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                style={secondaryButtonStyle()}
                onClick={() =>
                  setRows([
                    ...rows,
                    { connectionId: props.connections[0]?.id ?? '', prefix: '', enabled: true },
                  ])
                }
              >
                Add a folder
              </button>
              <button
                type="button"
                style={primaryButtonStyle(!dirty)}
                disabled={!dirty}
                onClick={() => props.onSaveMirrors(rows)}
              >
                {dirty ? 'Save folders' : 'Saved'}
              </button>
              {props.mirrors.some((mirror) => mirror.enabled === true) && (
                <button type="button" style={secondaryButtonStyle()} onClick={() => props.onSync()}>
                  Sync now
                </button>
              )}
            </div>
            <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 4 }}>
              Only {extension} files are copied, and they are read in the order shown. Nothing here
              is deleted when a file disappears from a bucket, so a failed sync never takes your{' '}
              {what} away.
            </span>
          </>
        )}

        {props.folders.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, color: colors.muted, wordBreak: 'break-all' }}>
            Copied to:
            {props.folders.map((folder) => (
              <div key={folder}>
                <code style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>{folder}</code>
              </div>
            ))}
          </div>
        )}
        {props.lastSync !== undefined && (
          <div style={{ marginTop: 4, fontSize: 11, color: colors.muted }}>Last sync: {props.lastSync}</div>
        )}
      </div>
    </div>
  )
}
