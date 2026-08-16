import type {
  SearchConnectionInput,
  SearchConnectionSummary,
  SearchQueryLimits,
  VectorStoreKind,
} from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { TrashIcon } from '../icons.js'
import {
  colors,
  fontFamily,
  iconButtonStyle,
  labelStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  textFieldStyle,
} from '../theme.js'
import { Select } from '../Select.js'
import { IndexingSection, type IndexingSectionProps } from './IndexingSection.js'
import { DispatcherSection, type DispatcherSectionProps } from './DispatcherSection.js'
import { SearchActivity, type SearchActivityProps } from './SearchActivity.js'
import { ScopeBadge } from './ScopeBadge.js'
import { SecretField } from './SecretField.js'

export interface SearchIndex {
  name: string
  docsCount?: number
  storeSize?: string
}

export interface SearchTabProps {
  connections: SearchConnectionSummary[]
  activeConnectionId: string | undefined
  indexes: SearchIndex[]
  indexesWarning?: string
  testResult?: { ok: boolean; detail: string }
  /** Increments each time the host confirms a save actually reached disk. */
  savedTick: number
  onSave: (connection: SearchConnectionInput) => void
  onDelete: (id: string) => void
  onSetActive: (id: string | undefined) => void
  /** Copies this workspace's index out of another store into the active one. */
  onSyncFrom: (fromId: string) => void
  sync?: { running: boolean; copied?: number; error?: string; fromLabel?: string }
  onListIndexes: (connection: SearchConnectionInput) => void
  onTest: (connection: SearchConnectionInput) => void
  /** Codebase indexing, rendered under the connection list. */
  indexing: IndexingSectionProps
  /** Keeping tool schemas out of the prompt — same tab, since it is the other retrieval path. */
  dispatcher: DispatcherSectionProps
  /** What the model has been searching for, and a box to try a query by hand. */
  activity: SearchActivityProps
}

const BLANK: SearchConnectionSummary = {
  id: '',
  label: '',
  kind: 'qdrant',
  url: '',
  hasUsername: false,
  hasPassword: false,
}

/**
 * The three backends, with the local ones first.
 *
 * A URL is prefilled the same way a provider preset prefills a base URL (§9) — it is a
 * starting point the user still has to save, not a default endpoint. Invariant 3 is about a
 * fresh install contacting nothing on its own, and nothing here is contacted until a
 * connection is saved and made active.
 */
const BACKENDS: {
  kind: VectorStoreKind
  label: string
  url: string
  hint: string
  run?: string
}[] = [
  {
    kind: 'qdrant',
    label: 'Qdrant — local',
    url: 'http://127.0.0.1:6333',
    hint: 'A single container, nothing leaves your machine. The usual choice for indexing code privately.',
    run: 'docker run -p 6333:6333 qdrant/qdrant',
  },
  {
    kind: 'chroma',
    label: 'Chroma — local',
    url: 'http://127.0.0.1:8000',
    hint: 'Also local. Needs Chroma 1.0 or newer — the v1 API it replaced is not supported.',
    run: 'docker run -p 8000:8000 chromadb/chroma',
  },
  {
    kind: 'opensearch',
    label: 'OpenSearch — a cluster you already run',
    url: 'https://opensearch.internal:9200',
    hint: 'The only backend that can also query indexes your organisation already has, with raw DSL.',
  },
]

/**
 * A numeric limit with its default as the placeholder, so "unset" reads as the default.
 *
 * `min`/`max` mirror the config schema exactly. They are shown and checked here because the
 * schema is the last line of defence, not the first: a value outside the range failed
 * validation host-side, and the whole save was rejected — which is indistinguishable from
 * "the button does nothing" if you were simply trying to raise the result count past 100.
 */
function LimitRow(props: {
  id: string
  label: string
  /** The full explanation: what it does, and what going too low or too high costs you. */
  tooltip: string
  hint?: string
  placeholder: string
  min: number
  /** Omitted where the schema imposes no upper bound. */
  max?: number
  value: number | undefined
  onChange: (value: number | undefined) => void
}): ReactElement {
  const invalid =
    props.value !== undefined && (props.value < props.min || (props.max !== undefined && props.value > props.max))
  return (
    <div style={{ marginBottom: 8 }} title={props.tooltip}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label htmlFor={props.id} style={{ ...labelStyle(), marginBottom: 0, flex: 1 }}>
          {props.label}
          <span
            aria-hidden="true"
            style={{ marginLeft: 4, opacity: 0.6, cursor: 'help', fontSize: 10, border: `1px solid ${colors.border}`, borderRadius: '50%', padding: '0 4px' }}
          >
            ?
          </span>
          <span style={{ display: 'block', fontSize: 10, opacity: 0.8 }}>
            {props.hint !== undefined ? `${props.hint} ` : ''}
            {props.max !== undefined ? `Allowed: ${props.min}–${props.max}.` : `Minimum ${props.min}.`}
          </span>
        </label>
        <input
          id={props.id}
          type="number"
          min={props.min}
          {...(props.max !== undefined ? { max: props.max } : {})}
          value={props.value ?? ''}
          placeholder={props.placeholder}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10)
            props.onChange(Number.isNaN(parsed) ? undefined : parsed)
          }}
          style={{
            ...textFieldStyle(),
            width: 110,
            flex: 'none',
            ...(invalid ? { borderColor: 'var(--vscode-inputValidation-errorBorder, red)' } : {}),
          }}
        />
      </div>
      {invalid && (
        <div style={{ fontSize: 11, color: 'var(--vscode-errorForeground, red)', textAlign: 'right' }}>
          {props.max !== undefined ? `Must be between ${props.min} and ${props.max}.` : `Must be at least ${props.min}.`}
        </div>
      )}
    </div>
  )
}

/** Mirrors `vectorStoreSchema.limits`. Kept adjacent so the two are edited together. */
const LIMIT_RANGES = {
  maxHits: { min: 1, max: 100 },
  timeoutSeconds: { min: 1, max: 120 },
  terminateAfter: { min: 0 },
  maxIndexes: { min: 0 },
  defaultLookbackHours: { min: 0 },
  maxFieldChars: { min: 50, max: 20_000 },
} as const

export function SearchTab(props: SearchTabProps): ReactElement {
  const [editing, setEditing] = useState<SearchConnectionSummary | undefined>(undefined)
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [kind, setKind] = useState<VectorStoreKind>('qdrant')
  const [defaultIndex, setDefaultIndex] = useState('')
  const [caFile, setCaFile] = useState('')
  const [skipVerify, setSkipVerify] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [limits, setLimits] = useState<SearchQueryLimits>({})
  const [saving, setSaving] = useState(false)

  /*
   * The form used to close the instant Save was clicked, before the host had written
   * anything. A save that failed validation therefore looked exactly like one that
   * succeeded — the form closed, the values were gone, and the error went to a banner the
   * settings view did not render. It now closes only when the host confirms the write.
   */
  useEffect(() => {
    if (!saving) return
    setSaving(false)
    setEditing(undefined)
    // Deliberately keyed on `savedTick` alone — a counter rather than a boolean, so two
    // saves in a row both fire. Including `saving` would close the form the moment Save
    // was pressed, which is the behaviour this replaces.
  }, [props.savedTick])

  // Resync when a different connection is opened, or when the host echoes a save back.
  useEffect(() => {
    const source = editing ?? BLANK
    setLabel(source.label)
    setUrl(source.url)
    setKind(source.kind)
    setDefaultIndex(source.defaultIndex ?? '')
    setCaFile(source.caFile ?? '')
    setSkipVerify(source.rejectUnauthorized === false)
    setUsername('')
    setPassword('')
    setLimits(source.limits ?? {})
  }, [editing])

  const currentInput = (): SearchConnectionInput => ({
    ...(editing !== undefined && editing.id.length > 0 ? { id: editing.id } : {}),
    label,
    url,
    kind,
    defaultIndex,
    caFile,
    ...(skipVerify ? { rejectUnauthorized: false } : {}),
    ...(username.length > 0 ? { username } : {}),
    ...(password.length > 0 ? { password } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  })

  if (editing !== undefined) {
    return (
      <div style={{ padding: 12, overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', color: colors.foreground }}>
          {editing.id.length === 0 ? 'Add a vector store' : 'Edit connection'}
        </h3>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="lc-os-kind" style={labelStyle()}>
            Backend
          </label>
          <Select
            id="lc-os-kind"
            value={kind}
            onChange={(value) => {
              const chosen = BACKENDS.find((backend) => backend.kind === value)
              setKind(value as VectorStoreKind)
              /*
               * The suggested URL is filled in only when the field is empty or still holds
               * another backend's suggestion — never over something typed. Switching backend
               * by accident must not silently discard an address someone pasted.
               */
              const suggestions = BACKENDS.map((backend) => backend.url)
              if (chosen !== undefined && (url.trim().length === 0 || suggestions.includes(url.trim()))) {
                setUrl(chosen.url)
              }
            }}
            options={BACKENDS.map((backend) => ({ value: backend.kind, label: backend.label }))}
          />
          <span style={{ color: colors.muted, fontSize: 11 }}>
            {BACKENDS.find((backend) => backend.kind === kind)?.hint}
          </span>
          {(() => {
            const run = BACKENDS.find((backend) => backend.kind === kind)?.run
            return run === undefined ? null : (
              <div style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>
                Not running one yet?{' '}
                <code style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>{run}</code>
              </div>
            )
          })()}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="lc-os-label" style={labelStyle()}>
            Name
          </label>
          <input
            id="lc-os-label"
            type="text"
            value={label}
            placeholder="Production"
            onChange={(event) => setLabel(event.target.value)}
            style={textFieldStyle()}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="lc-os-url" style={labelStyle()}>
            {kind === 'opensearch' ? 'Cluster URL' : 'Server URL'}
          </label>
          <input
            id="lc-os-url"
            type="text"
            value={url}
            placeholder={BACKENDS.find((backend) => backend.kind === kind)?.url ?? ''}
            onChange={(event) => setUrl(event.target.value)}
            style={textFieldStyle()}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="lc-os-user" style={labelStyle()}>
            Username
          </label>
          <input
            id="lc-os-user"
            type="text"
            value={username}
            placeholder={editing.hasUsername ? 'Set — type to replace' : ''}
            onChange={(event) => setUsername(event.target.value)}
            style={textFieldStyle()}
          />
        </div>

        <SecretField
          id="lc-os-password"
          label="Password"
          hasValue={editing.hasPassword}
          value={password}
          onChange={setPassword}
          placeholder="Stored in the OS keychain"
        />

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="lc-os-index" style={labelStyle()}>
            Default index
          </label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              id="lc-os-index"
              type="text"
              value={defaultIndex}
              placeholder="Used when the model names no index"
              onChange={(event) => setDefaultIndex(event.target.value)}
              style={textFieldStyle()}
            />
            <button type="button" style={secondaryButtonStyle()} onClick={() => props.onListIndexes(currentInput())}>
              List
            </button>
          </div>

          {props.indexes.length > 0 && (
            <Select
              ariaLabel="Available indexes"
              value={props.indexes.some((index) => index.name === defaultIndex) ? defaultIndex : ''}
              onChange={(value) => {
                if (value.length > 0) setDefaultIndex(value)
              }}
              style={{ width: '100%' }}
              options={[
                { value: '', label: `Choose from ${props.indexes.length} index(es)…` },
                ...props.indexes.map((index) => ({
                  value: index.name,
                  label: index.name,
                  detail: [
                    index.docsCount !== undefined ? `${index.docsCount.toLocaleString()} docs` : undefined,
                    index.storeSize,
                  ]
                    .filter((part) => part !== undefined)
                    .join(', '),
                })),
              ]}
            />
          )}

          {/* Typing an index by hand always works: `_cat/indices` is frequently denied to a
              low-privilege account that can still search perfectly well. */}
          {props.indexesWarning !== undefined && props.indexes.length === 0 && (
            <span style={{ color: colors.muted, fontSize: 11, display: 'block', marginTop: 4 }}>
              Could not list indexes ({props.indexesWarning}). Type the name instead.
            </span>
          )}
        </div>

        <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}`, marginBottom: 12 }}>
          <strong style={{ fontSize: 12, color: colors.foreground }}>Connection security</strong>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label htmlFor="lc-os-ca" style={labelStyle()}>
            Additional CA certificate
          </label>
          <input
            id="lc-os-ca"
            type="text"
            value={caFile}
            placeholder="corp-root.pem"
            onChange={(event) => setCaFile(event.target.value)}
            style={textFieldStyle()}
          />
          <span style={{ color: colors.muted, fontSize: 11 }}>
Usually blank — the CA in Settings → Network already covers this cluster. Anything set here is added to it.
          </span>
        </div>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            style={{ marginTop: 2 }}
            checked={skipVerify}
            onChange={(event) => setSkipVerify(event.target.checked)}
          />
          <span style={{ color: colors.foreground }}>Skip certificate verification</span>
        </label>
        {skipVerify && (
          <p style={{ color: colors.error, fontSize: 11, margin: '0 0 12px', paddingLeft: 22 }}>
            Anyone able to intercept this connection can read and modify it, including the
            password. The CA file above is the safe fix.
          </p>
        )}

        <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}`, marginBottom: 8 }}>
          <strong style={{ fontSize: 12, color: colors.foreground }}>Query limits</strong>
          <p style={{ color: colors.muted, fontSize: 11, margin: '4px 0 8px' }}>
            Guard rails on the queries the model writes. It cannot change anything in the
            cluster — but a read can still be expensive, so these keep one bounded. Defaults
            are chosen to be safe on a large cluster; raise them if you know yours can take it.
          </p>
        </div>

        <LimitRow
          id="lc-os-hits"
          {...LIMIT_RANGES.maxHits}
          label="Maximum results"
          hint="Documents returned per search."
          tooltip={
            'How many documents one search returns.\n\n' +
            'The tool caps the model here no matter how many it asks for. Every hit spends ' +
            'context, so a high value crowds out the rest of the conversation and can push ' +
            'the result past the overall size cap, after which the model has to re-read it ' +
            'in pieces.\n\n' +
            'Raise it when the model keeps saying it found too few matches to judge. Lower ' +
            'it when replies are slow or the context bar fills up quickly.\n\n' +
            'Default 10.'
          }
          placeholder="10"
          value={limits.maxHits}
          onChange={(value) => setLimits({ ...limits, maxHits: value })}
        />
        <LimitRow
          id="lc-os-lookback"
          {...LIMIT_RANGES.defaultLookbackHours}
          label="Default lookback (hours)"
          hint="Time window used when the model asks for none."
          tooltip={
            'A time window applied automatically when the model gives no date range and the ' +
            'index has a date field.\n\n' +
            'This is the single most effective protection for a log index: on years of data, ' +
            'the difference between searching a day and searching everything is the ' +
            'difference between instant and a cluster in trouble. The model is always told ' +
            'the window was applied, so it can ask for a wider one deliberately.\n\n' +
            'Set 0 to allow unbounded scans — only sensible on a small index.\n\n' +
            'Default 24 hours.'
          }
          placeholder="24"
          value={limits.defaultLookbackHours}
          onChange={(value) => setLimits({ ...limits, defaultLookbackHours: value })}
        />
        <LimitRow
          id="lc-os-fieldchars"
          {...LIMIT_RANGES.maxFieldChars}
          label="Longest field value"
          hint="Characters kept from one field of one document."
          tooltip={
            'How much of a single field is kept before it is cut short.\n\n' +
            'This is the limit to raise if the model keeps reporting that log messages are ' +
            'truncated. A stack trace runs to several thousand characters and the default ' +
            'keeps 500 of them.\n\n' +
            'Unlike the overall result cap, this cut cannot be undone — the text never ' +
            'leaves the tool, so there is nothing to re-read. It is reported in the result ' +
            'rather than hidden, so a clipped trace never reads as a short one.\n\n' +
            'Default 500 characters.'
          }
          placeholder="500"
          value={limits.maxFieldChars}
          onChange={(value) => setLimits({ ...limits, maxFieldChars: value })}
        />
        <LimitRow
          id="lc-os-timeout"
          {...LIMIT_RANGES.timeoutSeconds}
          label="Query timeout (seconds)"
          hint="Per-shard time budget sent with the query."
          tooltip={
            'How long each shard may spend on one search, sent to OpenSearch as the ' +
            "query's own timeout.\n\n" +
            'On expiry the cluster returns whatever it has found so far rather than ' +
            'failing, so a slow query degrades into a partial answer instead of hanging the ' +
            'conversation.\n\n' +
            'Raise it for a large or heavily loaded cluster where legitimate searches are ' +
            'genuinely slow.\n\n' +
            'Default 10 seconds.'
          }
          placeholder="10"
          value={limits.timeoutSeconds}
          onChange={(value) => setLimits({ ...limits, timeoutSeconds: value })}
        />
        <LimitRow
          id="lc-os-terminate"
          {...LIMIT_RANGES.terminateAfter}
          label="Documents examined per shard"
          hint="Stops a query early instead of walking the whole index."
          tooltip={
            'How many documents each shard may inspect before it stops looking.\n\n' +
            'A timeout limits how long a query runs; this limits how much work it does. ' +
            'It is what stops a badly-targeted search from walking an entire index and ' +
            'evicting everything else from the cluster cache.\n\n' +
            'The trade-off: a rare match sitting past this point will not be found, and the ' +
            'result will honestly say the count is capped rather than claim there were none.\n\n' +
            'Set 0 to disable. Default 10,000.'
          }
          placeholder="10000"
          value={limits.terminateAfter}
          onChange={(value) => setLimits({ ...limits, terminateAfter: value })}
        />
        <LimitRow
          id="lc-os-maxindexes"
          {...LIMIT_RANGES.maxIndexes}
          label="Maximum indexes per query"
          hint="Refuses a wildcard that fans out wider than this."
          tooltip={
            'How many indexes one search may span.\n\n' +
            'A pattern like `logs-*` can resolve to hundreds of daily indexes, and querying ' +
            'them together is one of the easiest ways to overload a cluster by accident. ' +
            'A pattern matching more than this is refused before it is sent, and the model ' +
            'is told to narrow it.\n\n' +
            'Raise it if you routinely search a wide date range of daily indexes. Set 0 to ' +
            'disable the check.\n\n' +
            'Default 5.'
          }
          placeholder="5"
          value={limits.maxIndexes}
          onChange={(value) => setLimits({ ...limits, maxIndexes: value })}
        />

        <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}`, marginBottom: 12 }}>
          <button type="button" style={secondaryButtonStyle()} onClick={() => props.onTest(currentInput())}>
            Test Connection
          </button>
          {props.testResult !== undefined && (
            <div
              style={{
                marginTop: 8,
                fontSize: 12,
                color: props.testResult.ok ? 'var(--vscode-testing-iconPassed, #3fb950)' : colors.error,
              }}
            >
              {props.testResult.detail}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            style={primaryButtonStyle(false)}
            onClick={() => {
              setSaving(true)
              props.onSave(currentInput())
            }}
          >
            Save
          </button>
          <button type="button" style={secondaryButtonStyle()} onClick={() => setEditing(undefined)}>
            Cancel
          </button>
          {saving && <span style={{ fontSize: 11, color: colors.muted }}>Saving…</span>}
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 12, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0, color: colors.foreground }}>Search</h3>
        <ScopeBadge scope="user" />
      </div>

      <p style={{ color: colors.muted, fontSize: 12, fontFamily, margin: '0 0 12px' }}>
        Lets the model search OpenSearch indexes your organisation already runs — logs,
        tickets, documentation. It can only read: nothing here can create, change or delete
        anything in a cluster.
      </p>

      {props.connections.length === 0 && (
        <p style={{ color: colors.muted, fontFamily }}>No connections yet.</p>
      )}

      {/*
        Copying between stores, offered only when there is somewhere to copy *from*.
        Switching backend otherwise means re-embedding the whole repository — minutes to hours,
        and real money where embedding is billed — to produce vectors that already exist.
      */}
      {props.activeConnectionId !== undefined && props.connections.length > 1 && (
        <div
          style={{
            padding: 10,
            marginBottom: 12,
            borderRadius: 4,
            border: `1px solid ${colors.border}`,
            fontFamily,
            fontSize: 12,
          }}
        >
          <strong style={{ color: colors.foreground, fontSize: 12 }}>Copy an existing index here</strong>
          <p style={{ color: colors.muted, fontSize: 11, margin: '4px 0 8px' }}>
            Moves this workspace&rsquo;s vectors into the active store without re-embedding. Only
            possible when both were indexed with the same embedding model — otherwise the copy is
            refused, because mixing embeddings makes every search quietly wrong rather than
            visibly broken.
          </p>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {props.connections
              .filter((connection) => connection.id !== props.activeConnectionId)
              .map((connection) => (
                <button
                  key={connection.id}
                  type="button"
                  style={secondaryButtonStyle()}
                  disabled={props.sync?.running === true}
                  title={`Copy this workspace's index from ${connection.label} into the active store`}
                  onClick={() => props.onSyncFrom(connection.id)}
                >
                  From {connection.label}
                </button>
              ))}
          </div>
          {props.sync !== undefined && (
            <p
              style={{
                color: props.sync.error !== undefined ? colors.error : colors.muted,
                fontSize: 11,
                margin: '6px 0 0',
              }}
            >
              {props.sync.error ??
                (props.sync.running
                  ? `Copying from ${props.sync.fromLabel ?? 'the other store'}… ${String(props.sync.copied ?? 0)} so far.`
                  : `Copied ${String(props.sync.copied ?? 0)} entries from ${props.sync.fromLabel ?? 'the other store'}.`)}
            </p>
          )}
        </div>
      )}

      {props.connections.map((connection) => {
        const isActive = connection.id === props.activeConnectionId
        return (
          <div
            key={connection.id}
            style={{
              padding: 10,
              marginBottom: 8,
              borderRadius: 4,
              border: `1px solid ${isActive ? colors.accent : colors.border}`,
              background: isActive ? colors.assistantBubble : 'transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <strong>{connection.label}</strong>
              {isActive && <span style={{ color: colors.muted, fontSize: 11 }}>· active</span>}
            </div>
            <div style={{ color: colors.muted, fontSize: 12, marginBottom: 8 }}>
              {connection.url}
              {connection.defaultIndex !== undefined ? ` — ${connection.defaultIndex}` : ' — no default index'}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                style={secondaryButtonStyle()}
                onClick={() => props.onSetActive(isActive ? undefined : connection.id)}
              >
                {isActive ? 'Turn off' : 'Use in chat'}
              </button>
              <button type="button" style={secondaryButtonStyle()} onClick={() => setEditing(connection)}>
                Edit
              </button>
              <button
                type="button"
                title="Delete"
                aria-label="Delete"
                style={{ ...iconButtonStyle('secondary'), color: colors.error }}
                onClick={() => props.onDelete(connection.id)}
              >
                <TrashIcon />
              </button>
            </div>
          </div>
        )
      })}

      <button type="button" style={primaryButtonStyle(false)} onClick={() => setEditing({ ...BLANK })}>
        Add connection
      </button>

      {/* Stating the session rule where the choice is made, since "why did the tool vanish?"
          is otherwise a mystery. */}
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 16 }}>
        Search tools are offered only while a connection is active. Switching starts a fresh
        prompt, so change it between messages rather than mid-reply.
      </p>

      <IndexingSection {...props.indexing} />
      <DispatcherSection {...props.dispatcher} />
      <SearchActivity {...props.activity} />
    </div>
  )
}
