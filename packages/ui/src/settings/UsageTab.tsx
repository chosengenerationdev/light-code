import { useEffect, useMemo, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type {
  HostToUiMessage,
  RankedItem,
  Transport,
  UiToHostMessage,
  UsageDashboard,
  UsageProblem,
  UsageScope,
  UsageStoreConfig,
} from '@light-code/core/browser'
import { Select } from '../Select.js'
import { badgeStyle, colors, labelStyle, monospaceFamily, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { Panel } from './Panel.js'
import { disabledWhen } from '../disabledWhen.js'

/**
 * Settings → Usage: which skills and tools are used, by whom, who writes them, and what needs
 * attention - for this person or the whole team, over any range.
 *
 * **Self-contained**, talking to the host through the transport itself (the `stagedFiles` pattern)
 * rather than through App's props: nothing else on screen shares this state, and threading a
 * dashboard through three components would be three places for a field to go missing - the defect
 * shape §19 keeps recording.
 *
 * **No dashboard without collection.** Collection is automatic wherever a shared store already
 * exists (OpenSearch, then any vector store, then a team bucket - `usage/auto.ts`); until there is
 * one, the tab is the setup and nothing else: an empty dashboard reads as "nobody uses anything",
 * which is a claim, and the wrong one.
 */

type UsageMessage = Extract<HostToUiMessage, { type: 'usage' }>

const DAY = 86_400_000
const PRESETS: { id: string; label: string; ms: number }[] = [
  { id: '1d', label: '24 h', ms: DAY },
  { id: '1w', label: '7 days', ms: 7 * DAY },
  { id: '1m', label: '30 days', ms: 30 * DAY },
  { id: '3m', label: '90 days', ms: 90 * DAY },
  { id: '1y', label: '1 year', ms: 365 * DAY },
]

/** The range a preset or the custom dates describe. Custom `to` is inclusive of its whole day. */
export function usageRange(preset: string, customFrom: string, customTo: string, now = Date.now()): { from: number; to: number } {
  if (preset === 'custom') {
    const from = Date.parse(`${customFrom}T00:00:00`)
    const to = Date.parse(`${customTo}T23:59:59.999`)
    if (Number.isFinite(from) && Number.isFinite(to) && from <= to) return { from, to }
  }
  const found = PRESETS.find((entry) => entry.id === preset) ?? PRESETS[1]!
  return { from: now - found.ms, to: now }
}

const dateInput = (t: number): string => {
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function ago(t: number, now = Date.now()): string {
  if (t <= 0) return 'never'
  const minutes = Math.round((now - t) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${String(minutes)} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${String(hours)} h ago`
  return `${String(Math.round(hours / 24))} days ago`
}

function shortDate(iso: string | undefined): string {
  if (iso === undefined) return ''
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toLocaleDateString() : iso
}

/** "+40%" / "−12%" / "new" against the previous period of the same length. */
export function trend(value: number, previous: number): { text: string; direction: 'up' | 'down' | 'flat' } {
  if (previous === 0) return value === 0 ? { text: '—', direction: 'flat' } : { text: 'new', direction: 'up' }
  const change = Math.round(((value - previous) / previous) * 100)
  if (change === 0) return { text: '0%', direction: 'flat' }
  return { text: `${change > 0 ? '+' : '−'}${String(Math.abs(change))}%`, direction: change > 0 ? 'up' : 'down' }
}

const card: CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: '10px 12px',
  background: colors.inputBackground,
  minWidth: 0,
}

const tableCell: CSSProperties = { padding: '4px 6px', borderBottom: `1px solid ${colors.border}`, textAlign: 'left', verticalAlign: 'middle' }

function Section(props: { title: string; hint?: string; children: ReactNode; right?: ReactNode }): ReactElement {
  return (
    <div style={{ ...card, background: 'transparent', marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: '1.02em' }}>{props.title}</strong>
        {props.hint !== undefined ? <span style={{ color: colors.muted, fontSize: '0.88em' }}>{props.hint}</span> : null}
        <span style={{ flex: 1 }} />
        {props.right}
      </div>
      {props.children}
    </div>
  )
}

function Kpi(props: { label: string; value: string; previous?: { value: number; previous: number }; invert?: boolean; hint?: string }): ReactElement {
  const t = props.previous === undefined ? undefined : trend(props.previous.value, props.previous.previous)
  const good = t === undefined || t.direction === 'flat' ? undefined : (t.direction === 'up') !== (props.invert === true)
  return (
    <div style={card} title={props.hint}>
      <div style={{ color: colors.muted, fontSize: '0.85em' }}>{props.label}</div>
      <div style={{ fontSize: '1.6em', fontWeight: 600, lineHeight: 1.2 }}>{props.value}</div>
      {t !== undefined ? (
        <div style={{ fontSize: '0.82em', color: good === undefined ? colors.muted : good ? colors.accent : colors.error }}>
          {t.direction === 'up' ? '▲ ' : t.direction === 'down' ? '▼ ' : ''}
          {t.text} <span style={{ color: colors.muted }}>vs previous</span>
        </div>
      ) : null}
    </div>
  )
}

function Sparkline(props: { values: readonly number[]; width?: number; height?: number }): ReactElement {
  const width = props.width ?? 80
  const height = props.height ?? 18
  const max = Math.max(1, ...props.values)
  const step = props.values.length > 1 ? width / (props.values.length - 1) : width
  const points = props.values.map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * (height - 2) - 1).toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} aria-hidden="true" style={{ display: 'block' }}>
      <polyline points={points} fill="none" stroke={colors.accent} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

/** Stacked bars: skills in the accent, tools in the expert colour, failures as a red tick. */
function Timeline(props: { dashboard: UsageDashboard }): ReactElement {
  const buckets = props.dashboard.timeline.buckets
  const max = Math.max(1, ...buckets.map((bucket) => bucket.skills + bucket.tools))
  const height = 120
  const barWidth = Math.max(2, Math.min(24, Math.floor(600 / Math.max(1, buckets.length)) - 1))
  const width = buckets.length * (barWidth + 1)
  const unit = props.dashboard.timeline.unit
  const label = (start: number): string =>
    unit === 'hour' ? new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date(start).toLocaleDateString()
  return (
    <div style={{ overflowX: 'auto' }} className="lc-scroll">
      <svg width={Math.max(width, 200)} height={height + 16} role="img" aria-label="Uses over time">
        {buckets.map((bucket, index) => {
          const x = index * (barWidth + 1)
          const skillHeight = (bucket.skills / max) * height
          const toolHeight = (bucket.tools / max) * height
          return (
            <g key={bucket.start}>
              <title>{`${label(bucket.start)}: ${String(bucket.skills)} skill uses, ${String(bucket.tools)} tool calls${bucket.failures > 0 ? `, ${String(bucket.failures)} failed` : ''}`}</title>
              <rect x={x} y={height - toolHeight} width={barWidth} height={toolHeight} fill={colors.expert} opacity={0.75} rx={1} />
              <rect x={x} y={height - toolHeight - skillHeight} width={barWidth} height={skillHeight} fill={colors.accent} rx={1} />
              {bucket.failures > 0 ? <rect x={x} y={height + 3} width={barWidth} height={3} fill={colors.error} /> : null}
            </g>
          )
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.muted, fontSize: '0.8em' }}>
        <span>{buckets[0] !== undefined ? label(buckets[0].start) : ''}</span>
        <span>
          <span style={{ color: colors.accent }}>■</span> skills <span style={{ color: colors.expert }}>■</span> tools{' '}
          <span style={{ color: colors.error }}>■</span> failures · per {unit}
        </span>
        <span>{buckets.length > 0 ? label(buckets[buckets.length - 1]!.start) : ''}</span>
      </div>
    </div>
  )
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function Heatmap(props: { cells: number[][] }): ReactElement {
  const max = Math.max(1, ...props.cells.flat())
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '32px repeat(24, minmax(8px, 1fr))', gap: 2, fontSize: '0.75em' }}>
      {props.cells.map((row, day) => (
        <div key={day} style={{ display: 'contents' }}>
          <span style={{ color: colors.muted }}>{WEEKDAYS[day]}</span>
          {row.map((value, hour) => (
            <span
              key={hour}
              title={`${WEEKDAYS[day] ?? ''} ${String(hour).padStart(2, '0')}:00 — ${String(value)} uses`}
              style={{ height: 12, borderRadius: 2, background: value === 0 ? colors.border : colors.accent, opacity: value === 0 ? 0.35 : 0.25 + (value / max) * 0.75 }}
            />
          ))}
        </div>
      ))}
      <span />
      {Array.from({ length: 24 }, (_, hour) => (
        <span key={hour} style={{ color: colors.muted, textAlign: 'center' }}>
          {hour % 6 === 0 ? String(hour) : ''}
        </span>
      ))}
    </div>
  )
}

/** Two clicks, the second naming what goes: a dashboard button is easy to press by accident. */
function DeleteButton(props: { label: string; onConfirm: () => void }): ReactElement {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirming(true)}>
        Delete
      </button>
    )
  }
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <span style={{ color: colors.error, fontSize: '0.85em' }}>Delete {props.label}?</span>
      <button type="button" style={{ ...secondaryButtonStyle(), color: colors.error }} onClick={() => { setConfirming(false); props.onConfirm() }}>
        Yes, delete
      </button>
      <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirming(false)}>
        Keep
      </button>
    </span>
  )
}

function RankedTable(props: { items: readonly RankedItem[]; kind: 'skill' | 'tool'; showUsers: boolean; onOpen: (path: string) => void }): ReactElement {
  if (props.items.length === 0) return <div style={{ color: colors.muted }}>Nothing used in this range.</div>
  const max = Math.max(1, ...props.items.map((item) => item.uses))
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92em' }}>
      <thead>
        <tr style={{ color: colors.muted }}>
          <th style={tableCell}>{props.kind === 'skill' ? 'Skill' : 'Tool'}</th>
          <th style={tableCell}>Uses</th>
          <th style={tableCell}>Trend</th>
          {props.showUsers ? <th style={tableCell}>People</th> : null}
          {props.kind === 'tool' ? <th style={tableCell}>Failed</th> : <th style={tableCell}>Author</th>}
          <th style={tableCell}>Last</th>
        </tr>
      </thead>
      <tbody>
        {props.items.map((item) => {
          const t = trend(item.uses, item.previous)
          return (
            <tr key={`${item.kind}:${item.name}`}>
              <td style={tableCell}>
                {item.filePath !== undefined ? (
                  <button type="button" onClick={() => props.onOpen(item.filePath!)} style={{ background: 'none', border: 'none', padding: 0, color: colors.foreground, cursor: 'pointer', fontFamily: monospaceFamily, textAlign: 'left' }} title="Open">
                    {item.label}
                  </button>
                ) : (
                  <span style={{ fontFamily: monospaceFamily }} title={item.installed ? undefined : 'Not installed on this machine'}>
                    {item.label}
                    {item.installed ? '' : ' ◌'}
                  </span>
                )}
                <div style={{ height: 3, marginTop: 2, borderRadius: 2, background: colors.accent, opacity: 0.6, width: `${String(Math.round((item.uses / max) * 100))}%` }} />
              </td>
              <td style={tableCell}>{item.uses}</td>
              <td style={tableCell}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Sparkline values={item.spark} width={60} />
                  <span style={{ fontSize: '0.85em', color: t.direction === 'up' ? colors.accent : t.direction === 'down' ? colors.error : colors.muted }}>{t.text}</span>
                </div>
              </td>
              {props.showUsers ? <td style={tableCell}>{item.users}</td> : null}
              {props.kind === 'tool' ? (
                <td style={{ ...tableCell, color: item.failures > 0 ? colors.error : colors.muted }}>
                  {item.failures > 0 ? `${String(item.failures)} (${String(Math.round((item.failures / item.uses) * 100))}%)` : '0'}
                  {item.averageMs !== undefined ? <div style={{ color: colors.muted, fontSize: '0.85em' }}>{item.averageMs < 1000 ? `${String(item.averageMs)} ms` : `${(item.averageMs / 1000).toFixed(1)} s`} avg</div> : null}
                </td>
              ) : (
                <td style={{ ...tableCell, color: colors.muted }}>{item.author ?? '—'}</td>
              )}
              <td style={{ ...tableCell, color: colors.muted, whiteSpace: 'nowrap' }}>{ago(item.lastUsed)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** The leaderboard's order: what was written, how far it travelled, or what was done in the range. */
export function rankContributors<T extends { skills: number; tools: number; uses: number; impact: number; added: number; updated: number; author: string }>(
  contributors: readonly T[],
  by: 'written' | 'impact' | 'period',
): T[] {
  const score = (entry: T): number[] =>
    by === 'written'
      ? [entry.skills + entry.tools, entry.uses]
      : by === 'impact'
        ? [entry.impact, entry.uses, entry.skills + entry.tools]
        : [entry.added + entry.updated, entry.added, entry.uses]
  return [...contributors].sort((a, b) => {
    const left = score(a)
    const right = score(b)
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return right[index]! - left[index]!
    return a.author.localeCompare(b.author)
  })
}

function severityColour(severity: UsageProblem['severity']): string {
  return severity === 'error' ? colors.error : severity === 'warning' ? colors.warning : colors.muted
}

export interface UsageTabProps {
  transport: Transport
}

export function UsageTab(props: UsageTabProps): ReactElement {
  const { transport } = props
  const [message, setMessage] = useState<UsageMessage | undefined>(undefined)
  const [scope, setScope] = useState<UsageScope>('team')
  const [preset, setPreset] = useState('1w')
  const [customFrom, setCustomFrom] = useState(() => dateInput(Date.now() - 30 * DAY))
  const [customTo, setCustomTo] = useState(() => dateInput(Date.now()))
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const [unusedKind, setUnusedKind] = useState<'all' | 'skill' | 'tool'>('all')
  const [onlyDeletable, setOnlyDeletable] = useState(false)
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [rankBy, setRankBy] = useState<'written' | 'impact' | 'period'>('written')

  // Settings form. `auto` is the default: collection goes wherever the team already shares a store.
  const [stopped, setStopped] = useState(false)
  const [kind, setKind] = useState<UsageStoreConfig['kind'] | 'auto'>('auto')
  const [userInfoTool, setUserInfoTool] = useState('')
  const [folder, setFolder] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [prefix, setPrefix] = useState('')
  const [storeId, setStoreId] = useState('')
  const [collection, setCollection] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(
    () =>
      transport.onMessage((raw) => {
        const incoming = raw as HostToUiMessage
        if (incoming.type !== 'usage') return
        setMessage(incoming)
        setLoading(false)
        setSaving(false)
        const store = incoming.settings.store
        setStopped(incoming.settings.stopped)
        setUserInfoTool(incoming.settings.userInfoTool ?? '')
        setKind(store?.kind ?? 'auto')
        if (store !== undefined) {
          setFolder(store.path ?? '')
          setConnectionId(store.connectionId ?? '')
          setPrefix(store.prefix ?? '')
          setStoreId(store.storeId ?? '')
          setCollection(store.collection ?? '')
        }
        if (incoming.saved === true) setTick((value) => value + 1)
      }),
    [transport],
  )

  const range = useMemo(() => usageRange(preset, customFrom, customTo), [preset, customFrom, customTo, tick])

  useEffect(() => {
    setLoading(true)
    transport.post({
      type: 'requestUsage',
      scope,
      from: range.from,
      to: range.to,
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    } satisfies UiToHostMessage)
  }, [transport, scope, range])

  const refresh = (): void => setTick((value) => value + 1)

  const open = (filePath: string): void => transport.post({ type: 'openManagedFile', path: filePath } satisfies UiToHostMessage)
  const remove = (item: { kind: 'skill' | 'tool'; name: string; filePath?: string }): void => {
    if (item.kind === 'skill') transport.post({ type: 'deleteSkillFile', name: item.name } satisfies UiToHostMessage)
    else transport.post({ type: 'deletePythonTool', name: item.name, ...(item.filePath !== undefined ? { filePath: item.filePath } : {}) } satisfies UiToHostMessage)
    setRemoved((current) => new Set([...current, `${item.kind}:${item.name}`]))
    setTimeout(refresh, 1500)
  }

  const storeFromForm = (): UsageStoreConfig | undefined => {
    if (kind === 'auto') return undefined
    if (kind === 'folder') return folder.trim().length > 0 ? { kind, path: folder.trim() } : undefined
    if (kind === 's3') return connectionId.length > 0 ? { kind, connectionId, ...(prefix.trim().length > 0 ? { prefix: prefix.trim() } : {}) } : undefined
    return storeId.length > 0 ? { kind, storeId, ...(collection.trim().length > 0 ? { collection: collection.trim() } : {}) } : undefined
  }
  const save = (): void => {
    setSaving(true)
    const store = storeFromForm()
    transport.post({
      type: 'saveUsageSettings',
      stopped,
      ...(store !== undefined ? { store } : {}),
      ...(userInfoTool.trim().length > 0 ? { userInfoTool: userInfoTool.trim() } : {}),
    } satisfies UiToHostMessage)
  }

  const options = message?.options ?? { s3: [], vectorStores: [] }
  const settings = message?.settings
  const collecting = settings?.collecting === true
  const effective = settings?.effective
  const describeStore = (store: UsageStoreConfig): string => {
    if (store.kind === 'folder') return `the shared folder ${store.path ?? ''}`
    if (store.kind === 's3') return `the S3 connection "${options.s3.find((entry) => entry.id === store.connectionId)?.label ?? store.connectionId ?? ''}"`
    return `the vector store "${options.vectorStores.find((entry) => entry.id === store.storeId)?.label ?? store.storeId ?? ''}"`
  }
  const status =
    settings === undefined
      ? 'Loading…'
      : settings.stopped
        ? 'Stopped on this machine. Nothing is collected here until "Stop collecting" is unticked.'
        : effective === undefined
          ? 'Not collecting: no shared store is configured. Add an OpenSearch or other vector store (Settings → Search) or a team S3 bucket (Settings → Skills → S3) and collection starts by itself - or choose a shared folder below.'
          : `Collecting into ${describeStore(effective.store)}, ${effective.automatic ? `automatically, because ${effective.reason}` : 'as chosen here'}.`
  const dashboard = message?.dashboard

  const setup = (
    <Panel
      id="usage.store"
      title="Collection and storage"
      summary={collecting ? `Collecting${effective?.automatic === true ? ' automatically' : ''}` : settings?.stopped === true ? 'Stopped' : 'Off'}
      defaultOpen={!collecting}
      forceOpen={!collecting}
    >
      <div style={{ ...card, borderLeft: `3px solid ${collecting ? colors.accent : colors.border}`, marginBottom: 8 }}>{status}</div>
      <p style={{ color: colors.muted, marginTop: 0 }}>
        Usage is collected automatically into a store the whole team already shares - OpenSearch first, then any other vector
        store, then a team S3 bucket - so the dashboard shows real team numbers. Each event is a name, a time, who and whether
        it worked: never arguments, file contents or results. The first time, conversations already saved on this machine are
        imported too{settings?.backfill !== undefined ? ` (done: ${String(settings.backfill.events)} uses from ${String(settings.backfill.tasks)} conversations${settings.backfill.via === 'rust' ? ', by Fire Code\'s helper' : ''})` : ''}.
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        <label style={labelStyle()}>Keep usage in</label>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {(
            [
              ['auto', 'Automatic (recommended)', true],
              ['folder', 'A shared folder', true],
              ['s3', `An S3 bucket${options.s3.length === 0 ? ' (none configured)' : ''}`, options.s3.length > 0],
              ['vector', `A vector store${options.vectorStores.length === 0 ? ' (none configured)' : ''}`, options.vectorStores.length > 0],
            ] as const
          ).map(([value, label, available]) => (
            <label key={value} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', opacity: available ? 1 : 0.55 }}>
              <input type="radio" name="usage-store" checked={kind === value} {...disabledWhen([!available, value === 's3' ? 'No S3 bucket is configured. Add one in Settings → Skills or Python (bucket folders).' : 'No vector store is configured. Add one in Settings → Search.'])} onChange={() => setKind(value)} />
              {label}
            </label>
          ))}
        </div>
        {kind === 'auto' ? (
          <span style={{ color: colors.muted, fontSize: '0.88em' }}>
            {effective?.automatic === true ? `Using ${describeStore(effective.store)}.` : 'Nothing suitable is configured yet.'} In a vector store the collection is
            named <code>light-code-usage</code>; in a bucket, entries go under <code>usage/</code>.
          </span>
        ) : kind === 'folder' ? (
          <>
            <input
              style={textFieldStyle()}
              value={folder}
              placeholder={'\\\\server\\share\\light-code-usage'}
              onChange={(event) => setFolder(event.target.value)}
              aria-label="Shared folder"
            />
            <span style={{ color: colors.muted, fontSize: '0.88em' }}>
              A network share or synced folder every member can write to. Plain files: one JSON Lines file per person, per day, per
              install, in a sub-folder per person, and each person's details in <code>_profiles</code>.
            </span>
          </>
        ) : kind === 's3' ? (
          <>
            <Select
              value={connectionId}
              placeholder="Choose a connection"
              options={options.s3.map((entry) => ({ value: entry.id, label: entry.label, detail: `${entry.bucket}${entry.readOnly === true ? ' · read-only' : ''}`, disabled: entry.readOnly === true }))}
              onChange={setConnectionId}
              ariaLabel="S3 connection"
            />
            <input style={textFieldStyle()} value={prefix} placeholder="Folder inside the bucket (optional)" onChange={(event) => setPrefix(event.target.value)} aria-label="Prefix" />
            <span style={{ color: colors.muted, fontSize: '0.88em' }}>Written under <code>usage/</code> in that folder. Connections are set up in Settings → Skills → S3.</span>
          </>
        ) : (
          <>
            <Select
              value={storeId}
              placeholder="Choose a vector store"
              options={options.vectorStores.map((entry) => ({ value: entry.id, label: entry.label, detail: entry.kind }))}
              onChange={setStoreId}
              ariaLabel="Vector store"
            />
            <input style={textFieldStyle()} value={collection} placeholder="light-code-usage" onChange={(event) => setCollection(event.target.value)} aria-label="Collection" />
            <span style={{ color: colors.muted, fontSize: '0.88em' }}>One collection for the team. Stores are set up in Settings → Search.</span>
          </>
        )}
        <label style={labelStyle()}>Who people are</label>
        <span style={{ color: colors.muted, fontSize: '0.88em' }}>
          {settings?.directory.available === true
            ? `From the company directory first - ${String(settings.directory.people)} people named so far${settings.directory.via === 'rust' ? ", read by Fire Code's helper" : ''}. Authors and colleagues are looked up in the background.`
            : `The company directory is not available here${settings?.directory.reason !== undefined ? ` (${settings.directory.reason})` : ''}, so a tool or skill below is used instead.`}
          {settings !== undefined && settings.userInfoSkills.length > 0 ? ` Skills that can look users up: ${settings.userInfoSkills.join(', ')}.` : ''}
        </span>
        <label style={labelStyle()}>Tool that looks up who a user is (when the directory cannot)</label>
        <input
          style={textFieldStyle()}
          value={userInfoTool}
          list="usage-user-info-tools"
          placeholder={settings !== undefined && settings.userInfoCandidates.length > 0 ? `Found: ${settings.userInfoCandidates.join(', ')}` : 'e.g. whoami, employee_lookup'}
          onChange={(event) => setUserInfoTool(event.target.value)}
          aria-label="User-info tool"
        />
        <datalist id="usage-user-info-tools">
          {(settings?.userInfoCandidates ?? []).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <span style={{ color: colors.muted, fontSize: '0.88em' }}>
          When one is available the assistant calls it once (you approve it as usual) and records your name, team and title, so the
          dashboard shows people rather than login names. Leave empty to use any tool whose name says it looks users up.
          {settings?.profile !== undefined
            ? ` Recorded: ${[settings.profile.displayName, settings.profile.team ?? settings.profile.department, settings.profile.title].filter((part) => part !== undefined).join(' · ')}${settings.profile.source !== undefined ? ` (from ${settings.profile.source})` : ''}.`
            : ''}
        </span>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={stopped} onChange={(event) => setStopped(event.target.checked)} />
          Stop collecting on this machine
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" style={primaryButtonStyle(saving)} {...disabledWhen([saving, 'Checking that the store can be written - this takes a moment.'])} onClick={save}>
            {saving ? 'Checking the store…' : 'Save'}
          </button>
          {message?.saveError !== undefined ? <span style={{ color: colors.error }}>{message.saveError}</span> : null}
          {message?.saved === true ? <span style={{ color: colors.accent }}>Saved.</span> : null}
        </div>
      </div>
    </Panel>
  )

  if (!collecting || dashboard === undefined) {
    return (
      <div>
        <div style={{ ...card, marginBottom: 6 }}>
          <strong>Usage dashboard</strong>
          <p style={{ color: colors.muted, margin: '6px 0 0' }}>
            {message === undefined
              ? 'Loading…'
              : message.storeProblem !== undefined
                ? message.storeProblem
                : 'Which skills the team uses most, who writes skills and tools, what has gone unused, and problems such as duplicates - for you or the whole team, over any range. It appears by itself once there is a shared store to keep the numbers in.'}
          </p>
        </div>
        {setup}
      </div>
    )
  }

  const t = dashboard.totals
  const failureRate = t.toolUses.value === 0 ? 0 : Math.round((t.failures.value / t.toolUses.value) * 100)
  const unused = dashboard.unused.filter(
    (item) => !removed.has(`${item.kind}:${item.name}`) && (unusedKind === 'all' || item.kind === unusedKind) && (!onlyDeletable || item.deletable),
  )
  const rangeWords = preset === 'custom' ? `${customFrom} to ${customTo}` : `the last ${PRESETS.find((entry) => entry.id === preset)?.label ?? ''}`

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', position: 'sticky', top: 0, zIndex: 1, background: colors.background, padding: '4px 0' }}>
        <div role="tablist" style={{ display: 'inline-flex', border: `1px solid ${colors.border}`, borderRadius: 6, overflow: 'hidden' }}>
          {(['me', 'team'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={scope === value}
              onClick={() => setScope(value)}
              style={{ border: 'none', padding: '4px 12px', cursor: 'pointer', background: scope === value ? colors.accent : 'transparent', color: scope === value ? colors.accentContrast : colors.foreground }}
            >
              {value === 'me' ? 'Me' : 'Team'}
            </button>
          ))}
        </div>
        {[...PRESETS, { id: 'custom', label: 'Custom', ms: 0 }].map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setPreset(entry.id)}
            style={{ ...secondaryButtonStyle(), ...(preset === entry.id ? { boxShadow: `inset 0 0 0 1px ${colors.accent}`, color: colors.accent } : {}) }}
          >
            {entry.label}
          </button>
        ))}
        {preset === 'custom' ? (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input type="date" style={{ ...textFieldStyle(), width: 'auto' }} value={customFrom} max={customTo} onChange={(event) => setCustomFrom(event.target.value)} aria-label="From" />
            <span>to</span>
            <input type="date" style={{ ...textFieldStyle(), width: 'auto' }} value={customTo} min={customFrom} onChange={(event) => setCustomTo(event.target.value)} aria-label="To" />
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" style={secondaryButtonStyle()} onClick={refresh} {...disabledWhen([loading, 'The dashboard is loading.'])}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <div style={{ color: colors.muted, fontSize: '0.85em', margin: '2px 0 6px' }}>
        {scope === 'me' ? `You (${dashboard.me})` : 'Everybody'}, {rangeWords} · from {message?.storeLabel}
        {message?.storeProblem !== undefined ? <span style={{ color: colors.warning }}> · {message.storeProblem}</span> : null}
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
        <Kpi label="Uses" value={String(t.uses.value)} previous={t.uses} hint="Skill uses plus tool calls" />
        <Kpi label="Skill uses" value={String(t.skillUses.value)} previous={t.skillUses} />
        <Kpi label="Skills in use" value={`${String(t.skillsUsed.value)} / ${String(dashboard.inventory.skills)}`} previous={t.skillsUsed} hint="Different skills used, of those installed here" />
        <Kpi label="Tool calls" value={String(t.toolUses.value)} previous={t.toolUses} />
        <Kpi label="Failure rate" value={`${String(failureRate)}%`} previous={t.failures} invert hint="Failed tool calls" />
        {scope === 'team' ? <Kpi label="Active people" value={String(t.people.value)} previous={t.people} /> : null}
      </div>

      {/* Impact */}
      <div style={{ ...card, marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', borderLeft: `3px solid ${colors.accent}` }}>
        <strong>Your contribution</strong>
        <span>{dashboard.myImpact.skills} skills and {dashboard.myImpact.tools} tools written by you</span>
        <span>used {dashboard.myImpact.uses} times</span>
        <span>by {dashboard.myImpact.reached} {dashboard.myImpact.reached === 1 ? 'person' : 'people'}</span>
        {dashboard.myImpact.usedByOthers > 0 ? <span style={{ color: colors.accent }}>{dashboard.myImpact.usedByOthers} colleague{dashboard.myImpact.usedByOthers === 1 ? '' : 's'} rely on your work</span> : null}
      </div>

      {/* Problems */}
      {dashboard.problems.length > 0 ? (
        <Section title="Needs attention" hint={`${String(dashboard.problems.length)} finding${dashboard.problems.length === 1 ? '' : 's'}`}>
          {dashboard.problems.map((problem) => (
            <details key={problem.id} style={{ borderLeft: `3px solid ${severityColour(problem.severity)}`, padding: '4px 8px', margin: '4px 0' }}>
              <summary style={{ cursor: 'pointer' }}>
                <span style={{ ...badgeStyle(problem.severity === 'info' ? 'neutral' : 'warning'), marginRight: 6 }}>{problem.severity}</span>
                {problem.title}
              </summary>
              <div style={{ color: colors.muted, margin: '4px 0' }}>{problem.detail}</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {problem.items
                  .filter((item) => !removed.has(`${item.kind}:${item.name}`))
                  .map((item, index) => (
                    <li key={`${item.name}-${String(index)}`} style={{ margin: '2px 0' }}>
                      <span style={{ fontFamily: monospaceFamily }}>{item.name}</span>
                      {item.note !== undefined ? <span style={{ color: colors.muted }}> — {item.note}</span> : null}
                      {item.filePath !== undefined ? (
                        <>
                          {' '}
                          <button type="button" style={secondaryButtonStyle()} onClick={() => open(item.filePath!)}>
                            Open
                          </button>
                        </>
                      ) : null}
                      {item.deletable === true ? (
                        <>
                          {' '}
                          <DeleteButton label={item.name} onConfirm={() => remove(item)} />
                        </>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </details>
          ))}
        </Section>
      ) : (
        <Section title="Needs attention">
          <span style={{ color: colors.accent }}>Nothing - no duplicates, failing tools or broken installs found.</span>
        </Section>
      )}

      <Section title="Activity" hint={`${String(dashboard.eventsInStore)} events in range`}>
        <Timeline dashboard={dashboard} />
      </Section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 8 }}>
        <Section title="Most used skills">
          <RankedTable items={dashboard.topSkills} kind="skill" showUsers={scope === 'team'} onOpen={open} />
          {dashboard.rising.length > 0 ? (
            <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ color: colors.muted }}>Rising:</span>
              {dashboard.rising.map((item) => (
                <span key={item.name} style={{ ...badgeStyle(), color: colors.accent }}>
                  ▲ {item.label} {trend(item.uses, item.previous).text}
                </span>
              ))}
            </div>
          ) : null}
        </Section>
        <Section title="Most used tools">
          <RankedTable items={dashboard.topTools} kind="tool" showUsers={scope === 'team'} onOpen={open} />
        </Section>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 8 }}>
        <Section
          title="Leaderboard"
          hint={rankBy === 'written' ? 'Skills and tools written' : rankBy === 'impact' ? 'Uses × people reached, in range' : 'Added and updated in range'}
          right={
            <Select
              compact
              value={rankBy}
              options={[
                { value: 'written', label: 'Most written' },
                { value: 'impact', label: 'Most impact' },
                { value: 'period', label: 'Most active this period' },
              ]}
              onChange={(value) => setRankBy(value as 'written' | 'impact' | 'period')}
              ariaLabel="Rank by"
            />
          }
        >
          {dashboard.contributors.length === 0 ? (
            <div style={{ color: colors.muted }}>No skill or tool carries an author yet. Settings → Project can label them.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92em' }}>
              <thead>
                <tr style={{ color: colors.muted }}>
                  <th style={tableCell}>#</th>
                  <th style={tableCell}>Author</th>
                  <th style={tableCell}>Skills</th>
                  <th style={tableCell}>Tools</th>
                  <th style={tableCell} title="Added (new) and updated in this range">This period</th>
                  <th style={tableCell}>Used</th>
                  <th style={tableCell}>Reached</th>
                </tr>
              </thead>
              <tbody>
                {rankContributors(dashboard.contributors, rankBy)
                  .slice(0, 12)
                  .map((person, index) => (
                    <tr key={person.author} style={person.author === dashboard.me ? { background: colors.accentSoft } : undefined}>
                      <td style={tableCell}>{index < 3 ? ['🥇', '🥈', '🥉'][index] : String(index + 1)}</td>
                      <td style={tableCell} title={person.author}>
                        {person.displayName ?? person.author}
                        {person.team !== undefined ? <div style={{ color: colors.muted, fontSize: '0.85em' }}>{person.team}</div> : null}
                      </td>
                      <td style={tableCell}>{person.skills}</td>
                      <td style={tableCell}>{person.tools}</td>
                      <td style={tableCell}>
                        {person.added + person.updated === 0 ? (
                          <span style={{ color: colors.muted }}>—</span>
                        ) : (
                          <span>
                            {person.added > 0 ? <span style={{ color: colors.accent }}>+{person.added} new</span> : null}
                            {person.added > 0 && person.updated > 0 ? ' · ' : ''}
                            {person.updated > 0 ? `${String(person.updated)} updated` : ''}
                          </span>
                        )}
                      </td>
                      <td style={tableCell}>{person.uses}</td>
                      <td style={tableCell}>{person.reached}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </Section>
        {scope === 'team' ? (
          <Section title="Who uses Light Code" hint="Activity in range">
            {dashboard.people.length === 0 ? (
              <div style={{ color: colors.muted }}>No activity in this range.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92em' }}>
                <thead>
                  <tr style={{ color: colors.muted }}>
                    <th style={tableCell}>Person</th>
                    <th style={tableCell}>Uses</th>
                    <th style={tableCell}>Skills</th>
                    <th style={tableCell}>Favourite skill</th>
                    <th style={tableCell}>Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.people.slice(0, 20).map((person) => (
                    <tr key={person.user}>
                      <td style={tableCell} title={person.user}>
                        {person.displayName ?? person.user}
                        {person.team !== undefined || person.title !== undefined ? (
                          <div style={{ color: colors.muted, fontSize: '0.85em' }}>{[person.title, person.team].filter((part) => part !== undefined).join(' · ')}</div>
                        ) : null}
                      </td>
                      <td style={tableCell}>{person.uses}</td>
                      <td style={tableCell}>{person.skills}</td>
                      <td style={{ ...tableCell, fontFamily: monospaceFamily }}>{person.favourite ?? '—'}</td>
                      <td style={{ ...tableCell, color: colors.muted }}>{ago(person.lastActive)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        ) : (
          <Section title="When you work" hint="Uses by weekday and hour, your time">
            <Heatmap cells={dashboard.heatmap} />
          </Section>
        )}
      </div>

      {scope === 'team' && dashboard.teams.length > 0 ? (
        <Section title="By team" hint="From the details each person's user-info tool gave">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92em' }}>
            <thead>
              <tr style={{ color: colors.muted }}>
                <th style={tableCell}>Team</th>
                <th style={tableCell}>People</th>
                <th style={tableCell}>Uses</th>
                <th style={tableCell}>Skill uses</th>
                <th style={tableCell}>Top skill</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.teams.map((team) => (
                <tr key={team.team}>
                  <td style={tableCell}>{team.team}</td>
                  <td style={tableCell}>{team.people}</td>
                  <td style={tableCell}>{team.uses}</td>
                  <td style={tableCell}>{team.skillUses}</td>
                  <td style={{ ...tableCell, fontFamily: monospaceFamily }}>{team.topSkill ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      {scope === 'team' ? (
        <Section title="When the team works" hint="Uses by weekday and hour, your time">
          <Heatmap cells={dashboard.heatmap} />
        </Section>
      ) : null}

      <Section
        title="Unused"
        hint={`not used by anybody in ${rangeWords}`}
        right={
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Select
              compact
              value={unusedKind}
              options={[
                { value: 'all', label: 'Skills and tools' },
                { value: 'skill', label: 'Skills' },
                { value: 'tool', label: 'Tools' },
              ]}
              onChange={(value) => setUnusedKind(value as 'all' | 'skill' | 'tool')}
              ariaLabel="Show"
            />
            <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: '0.9em' }}>
              <input type="checkbox" checked={onlyDeletable} onChange={(event) => setOnlyDeletable(event.target.checked)} />
              deletable here
            </label>
          </span>
        }
      >
        {unused.length === 0 ? (
          <div style={{ color: colors.muted }}>Everything was used at least once.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92em' }}>
            <tbody>
              {unused.slice(0, 60).map((item) => (
                <tr key={`${item.kind}:${item.filePath}`}>
                  <td style={tableCell}>
                    <span style={{ ...badgeStyle(), marginRight: 6 }}>{item.kind}</span>
                    <span style={{ fontFamily: monospaceFamily }}>{item.name}</span>
                    {item.stale ? <span style={{ ...badgeStyle('warning'), marginLeft: 6 }}>stale</span> : null}
                  </td>
                  <td style={{ ...tableCell, color: colors.muted }}>{item.author ?? 'no author'}</td>
                  <td style={{ ...tableCell, color: colors.muted }}>{item.updated !== undefined ? `updated ${shortDate(item.updated)}` : ''}</td>
                  <td style={{ ...tableCell, color: colors.muted }}>{item.location}</td>
                  <td style={{ ...tableCell, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button type="button" style={secondaryButtonStyle()} onClick={() => open(item.filePath)}>
                      Open
                    </button>{' '}
                    {item.deletable ? (
                      <DeleteButton label={item.name} onConfirm={() => remove(item)} />
                    ) : (
                      <span style={{ color: colors.muted, fontSize: '0.85em' }} title="Only skills and tools in this project's own folder can be deleted from here; a shared or bucket copy belongs to everybody.">
                        shared
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {unused.length > 60 ? <div style={{ color: colors.muted }}>…and {unused.length - 60} more.</div> : null}
      </Section>

      {dashboard.recent.length > 0 ? (
        <Section title="New and updated" hint={`in ${rangeWords}`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {dashboard.recent.map((item) => (
              <span key={`${item.kind}:${item.name}`} style={badgeStyle()} title={item.location}>
                {item.kind === 'skill' ? '📘' : '🛠'} {item.name} · {item.author ?? 'unknown'} · {shortDate(item.updated)}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      {setup}
    </div>
  )
}
