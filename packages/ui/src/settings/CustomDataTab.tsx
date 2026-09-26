import { useEffect, useState, type ReactElement } from 'react'
import type { DatasetConfig, ProbeTarget } from '@light-code/core/browser'

import { IndexingProgress, type IndexingProgressState } from './IndexingProgress.js'
import { IndexProbe } from './IndexProbe.js'
import { Select } from '../Select.js'
import { SearchableSelect } from '../SearchableSelect.js'
import {
  colors,
  labelStyle,
  monospaceFamily,
  primaryButtonStyle,
  secondaryButtonStyle,
  textFieldStyle,
} from '../theme.js'
import { Panel } from './Panel.js'

export type DatasetStatus = DatasetConfig & {
  records: number
  sizeBytes: number
  oldest?: number
  newest?: number
  lastSyncedAt?: number
  busy?: boolean
  lastResult?: string
  lastFailed?: boolean
  lastAttemptAt?: number
  storeLabel: string
}

/**
 * A cadence, as a number and a unit.
 *
 * Stored as minutes, because that is what the timer wants and one number cannot disagree with
 * itself. Shown as two fields, because "every 90 minutes" and "every 3 days" are both things
 * people mean and a fixed list of five options can express neither.
 */
const UNITS: { value: string; label: string; minutes: number }[] = [
  { value: 'minutes', label: 'minutes', minutes: 1 },
  { value: 'hours', label: 'hours', minutes: 60 },
  { value: 'days', label: 'days', minutes: 60 * 24 },
]

/** The largest unit that divides the interval exactly, so 120 reads as "2 hours", not "120 minutes". */
export function splitInterval(totalMinutes: number): { every: number; unit: string } {
  for (const unit of [...UNITS].reverse()) {
    if (totalMinutes % unit.minutes === 0 && totalMinutes >= unit.minutes) {
      return { every: totalMinutes / unit.minutes, unit: unit.value }
    }
  }
  return { every: totalMinutes, unit: 'minutes' }
}

export function joinInterval(every: number, unit: string): number {
  const found = UNITS.find((entry) => entry.value === unit)
  return Math.max(1, Math.round(every)) * (found?.minutes ?? 1)
}

export interface CustomDataTabProps {
  datasets: DatasetStatus[]
  /** Everything callable that could serve as a collector — Python tools and MCP tools alike. */
  tools: { name: string; description: string; kind: 'python' | 'mcp' }[]
  stores: { id: string; label: string }[]
  defaultStoreLabel: string
  semantic: boolean
  guidance: string
  progress: IndexingProgressState | undefined
  probe: { running: boolean; result: { query: string; text: string; error?: string } | undefined }
  onProbe: (query: string, target: ProbeTarget) => void
  onClearProbe: () => void
  onSave: (dataset: DatasetConfig) => void
  onDelete: (id: string) => void
  onSync: (id: string) => void
  onClear: (id: string, resync: boolean) => void
  onStop: () => void
  onOpenPython: () => void
  /** Re-asks for the tool list and the dataset figures. */
  onRefresh: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * A titled block, as a collapsible panel — the same `Panel` every settings tab uses, so this tab
 * reads as parts and follows the theme like the rest. The first section of the tab is open.
 */
function Section(props: {
  title: string
  hint?: string
  defaultOpen?: boolean
  children: React.ReactNode
}): ReactElement {
  return (
    <Panel
      id={`customData.${props.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      title={props.title}
      defaultOpen={props.defaultOpen === true}
    >
      {props.hint !== undefined && (
        <p style={{ margin: '0 0 8px', color: colors.muted, fontSize: 11 }}>{props.hint}</p>
      )}
      {props.children}
    </Panel>
  )
}

function newDataset(): DatasetConfig {
  return {
    id: `ds-${String(Date.now().toString(36))}`,
    name: '',
    toolName: '',
    enabled: true,
    // Zero, not fifteen: a new collector is far more likely to want running by hand until it is
    // known to work than to want putting on a timer straight away.
    syncMinutes: 0,
  }
}

/**
 * Corpora the user collects themselves.
 *
 * ## Why this is its own tab
 *
 * It was going to live in Search, which already has the connection, the embedder, the index name,
 * the team alias and the activity panel. A sixth section there would have been the complaint that
 * produced the Outlook tab repeated exactly — and this is not a setting, it is a list of things
 * with their own lifecycles, each with a schedule and a size and a last result.
 */
export function CustomDataTab(props: CustomDataTabProps): ReactElement {
  const [editing, setEditing] = useState<DatasetConfig | undefined>(undefined)
  const [confirming, setConfirming] = useState<{ id: string; action: 'clear' | 'delete' } | undefined>(undefined)
  const [showGuidance, setShowGuidance] = useState(false)

  // Closed once a save lands, which is how the form confirms the write reached disk.
  useEffect(() => {
    if (editing !== undefined && props.datasets.some((dataset) => dataset.id === editing.id && dataset.name === editing.name)) {
      setEditing(undefined)
    }
  }, [props.datasets])

  if (editing !== undefined) {
    const valid = editing.name.trim().length > 0 && editing.toolName.trim().length > 0
    return (
      <div style={{ padding: 12, overflowY: 'auto', fontSize: 13, color: colors.foreground }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 14 }}>
          {props.datasets.some((dataset) => dataset.id === editing.id) ? 'Edit dataset' : 'New dataset'}
        </h2>

        <label htmlFor="lc-ds-name" style={labelStyle()}>
          Name
        </label>
        <input
          id="lc-ds-name"
          type="text"
          value={editing.name}
          spellCheck={false}
          placeholder="tickets"
          onChange={(event) => setEditing({ ...editing, name: event.target.value })}
          style={textFieldStyle()}
        />
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginBottom: 12 }}>
          What the assistant will call it. Short and obvious &mdash; you will be saying
          &ldquo;check the {editing.name.trim().length > 0 ? editing.name : 'tickets'}&rdquo;.
        </span>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label htmlFor="lc-ds-tool" style={labelStyle()}>
            Collector tool
          </label>
          {/*
            Here as well as on the list, because this is where a missing tool is noticed: you came
            to pick the collector you just wrote. The list does refresh on its own when a tool is
            registered — this is for a file edited outside the editor, and for confirming rather
            than assuming.
          */}
          <button
            type="button"
            style={{ background: 'none', border: 'none', color: colors.accent, cursor: 'pointer', padding: 0, fontSize: 11 }}
            onClick={props.onRefresh}
          >
            Refresh the list
          </button>
        </div>
        {props.tools.length === 0 ? (
          <div style={{ border: `1px solid ${colors.border}`, borderRadius: 4, padding: 10, fontSize: 11, color: colors.muted }}>
            <span style={{ display: 'block', marginBottom: 6 }}>
              Nothing callable to collect with yet. A collector is a Python tool or an MCP tool that
              returns records.
            </span>
            <button
              type="button"
              style={{ background: 'none', border: 'none', color: colors.accent, cursor: 'pointer', padding: 0, fontSize: 11 }}
              onClick={props.onOpenPython}
            >
              Open Python to switch on tools
            </button>
          </div>
        ) : (
          <SearchableSelect
            ariaLabel="Collector tool"
            value={editing.toolName}
            emptyText="No tool matches. Clear the search to see them all."
            /*
             * Python first, then MCP. Somebody's own collector is what they are usually looking
             * for, and a server with forty tools would otherwise bury it.
             */
            options={[
              ...props.tools
                .filter((tool) => tool.kind === 'python')
                .map((tool) => ({ value: tool.name, hint: tool.description, group: 'Python tools' })),
              ...props.tools
                .filter((tool) => tool.kind === 'mcp')
                .map((tool) => ({ value: tool.name, hint: tool.description, group: 'MCP tools' })),
            ]}
            onChange={(value) => setEditing({ ...editing, toolName: value })}
          />
        )}
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 12px' }}>
          It must return a list of records &mdash; see the contract on the previous screen. A tool
          that returns something else is refused when it runs, naming the shape it should have.
        </span>

        <label htmlFor="lc-ds-sync" style={labelStyle()}>
          Sync
        </label>
        {/*
          A number and a unit, not a list of five.

          "Every 90 minutes" and "every 3 days" are both things people mean, and a fixed list can
          express neither. Manual stays a separate choice rather than "every 0 minutes", because
          it is a different decision — not a very long interval.
        */}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={(editing.syncMinutes ?? 0) === 0}
            onChange={(event) =>
              setEditing({ ...editing, syncMinutes: event.target.checked ? 0 : 60 })
            }
          />
          <span style={{ fontSize: 13 }}>Only when I ask</span>
        </label>

        {(editing.syncMinutes ?? 0) > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: colors.muted }}>Every</span>
            <input
              id="lc-ds-sync"
              type="text"
              inputMode="numeric"
              aria-label="How often to sync"
              value={splitInterval(editing.syncMinutes ?? 60).every}
              onChange={(event) =>
                setEditing({
                  ...editing,
                  syncMinutes: joinInterval(
                    Number(event.target.value) || 1,
                    splitInterval(editing.syncMinutes ?? 60).unit,
                  ),
                })
              }
              style={{ ...textFieldStyle(), width: 70 }}
            />
            <div style={{ flex: 1 }}>
              <Select
                id="lc-ds-unit"
                value={splitInterval(editing.syncMinutes ?? 60).unit}
                options={UNITS.map((unit) => ({ value: unit.value, label: unit.label }))}
                onChange={(unit) =>
                  setEditing({
                    ...editing,
                    syncMinutes: joinInterval(splitInterval(editing.syncMinutes ?? 60).every, unit),
                  })
                }
                ariaLabel="Interval unit"
              />
            </div>
          </div>
        )}
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 12px' }}>
          {(editing.syncMinutes ?? 0) === 0
            ? 'Nothing runs on its own. Use Sync now on the list, or re-run it after changing the collector.'
            : `The collector runs every ${String(editing.syncMinutes ?? 0)} minute(s), and is given the ` +
              'time of the last successful sync so it can fetch only what changed. A failed run does ' +
              'not advance that, so nothing is skipped while the source is down.'}
        </span>

        {/*
          Per dataset rather than one setting for all of them.

          The reason is the same one that gave mail its own store (§12e): a corpus somebody
          collects themselves is frequently the one they most want kept off a cluster their team
          shares — and unlike mail there can be several at once, with different answers. Tickets
          to the shared cluster, an extract of something sensitive to a local Qdrant.
        */}
        <label htmlFor="lc-ds-store" style={labelStyle()}>
          Where the index is stored
        </label>
        <Select
          id="lc-ds-store"
          value={editing.storeId ?? ''}
          options={[
            { value: '', label: `Default for custom data (${props.defaultStoreLabel})` },
            ...props.stores.map((store) => ({ value: store.id, label: store.label })),
          ]}
          onChange={(value) => setEditing({ ...editing, storeId: value === '' ? undefined : value })}
          ariaLabel="Vector store for this dataset"
        />
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 12px' }}>
          Records are embedded and written here. Changing it on a dataset that already has records
          leaves the old ones where they were &mdash; clear it first, or rebuild afterwards, so the
          two copies do not both answer searches.
        </span>

        <label htmlFor="lc-ds-retention" style={labelStyle()}>
          Keep records for <span style={{ color: colors.muted, fontWeight: 400 }}>(days, blank for ever)</span>
        </label>
        <input
          id="lc-ds-retention"
          type="text"
          inputMode="numeric"
          value={editing.retentionDays ?? ''}
          onChange={(event) =>
            setEditing({ ...editing, retentionDays: Number(event.target.value) || undefined })
          }
          style={textFieldStyle()}
        />
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginBottom: 12 }}>
          Applied on every sync. Only records whose collector gave them a timestamp can be aged out
          &mdash; one without has no age, so it is kept.
        </span>

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            style={primaryButtonStyle(!valid)}
            disabled={!valid}
            onClick={() => props.onSave({ ...editing, name: editing.name.trim(), toolName: editing.toolName.trim() })}
          >
            Save
          </button>
          <button type="button" style={secondaryButtonStyle()} onClick={() => setEditing(undefined)}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontSize: 13, color: colors.foreground }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 14 }}>Custom data</h2>
      <p style={{ margin: '0 0 14px', color: colors.muted, fontSize: 11 }}>
        Corpora you collect yourself. Point at a tool that returns records &mdash; from a ticketing
        system, a wiki, a database, anything your own code or an MCP server can reach &mdash; and
        Light Code embeds them, keeps them current, and lets the assistant search them with{' '}
        <code style={{ fontFamily: monospaceFamily }}>search_data</code>.
      </p>

      <Section defaultOpen title="Datasets">
        {props.datasets.length === 0 ? (
          <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
            None yet. The assistant can write a collector for you if you ask it &mdash; describe
            where the data lives and it will offer one.
          </p>
        ) : (
          props.datasets.map((dataset) => (
            <div
              key={dataset.id}
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                padding: 10,
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13 }}>{dataset.name}</strong>
                <span style={{ color: colors.muted, fontSize: 11, fontFamily: monospaceFamily }}>
                  {dataset.toolName}
                </span>
                {dataset.enabled === false && (
                  <span style={{ color: colors.muted, fontSize: 11 }}>&mdash; paused</span>
                )}
              </div>

              <div style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>
                {dataset.records === 0
                  ? 'Nothing collected yet.'
                  : `${String(dataset.records)} record(s), ${formatSize(dataset.sizeBytes)}` +
                    `${dataset.newest !== undefined ? `, newest ${new Date(dataset.newest).toLocaleDateString()}` : ''}.`}
                {' '}
                {(dataset.syncMinutes ?? 0) === 0
                  ? 'Runs only when asked.'
                  : `Every ${String(dataset.syncMinutes)} minute(s).`}
                {dataset.lastSyncedAt !== undefined &&
                  ` Last synced ${new Date(dataset.lastSyncedAt).toLocaleString()}.`}
                {` Stored in ${dataset.storeLabel}.`}
              </div>

              {dataset.lastResult !== undefined && (
                /*
                 * A failure is coloured and dated, not shown as ordinary muted text.
                 *
                 * A sync that stopped working keeps its old records and its old count, so the row
                 * otherwise looks exactly like a healthy one — which is how a dataset goes stale
                 * for a fortnight before anybody notices.
                 */
                <div
                  style={{
                    color: dataset.lastFailed === true ? colors.error : colors.muted,
                    fontSize: 11,
                    marginTop: 4,
                    ...(dataset.lastFailed === true
                      ? {
                          border: `1px solid ${colors.error}`,
                          borderRadius: 4,
                          padding: '4px 6px',
                          overflowWrap: 'anywhere' as const,
                        }
                      : {}),
                  }}
                >
                  {dataset.lastFailed === true && <strong>Last sync failed. </strong>}
                  {dataset.lastResult}
                  {dataset.lastFailed === true && dataset.lastAttemptAt !== undefined && (
                    <span style={{ display: 'block', marginTop: 2 }}>
                      {`Attempted ${new Date(dataset.lastAttemptAt).toLocaleString()}. The records ` +
                        'below are from before that, so they are no longer being kept current.'}
                    </span>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {confirming?.id === dataset.id ? (
                  <>
                    <span style={{ fontSize: 11 }}>
                      {confirming.action === 'delete'
                        ? `Delete "${dataset.name}" and everything it collected?`
                        : dataset.records === 0
                          ? // Says what it will actually do, rather than offering to throw away nothing.
                            'Nothing is collected. Clear the last result and start again from scratch?'
                          : `Throw away all ${String(dataset.records)} record(s)?`}
                    </span>
                    <button
                      type="button"
                      style={primaryButtonStyle(false)}
                      onClick={() => {
                        if (confirming.action === 'delete') props.onDelete(dataset.id)
                        else props.onClear(dataset.id, false)
                        setConfirming(undefined)
                      }}
                    >
                      {confirming.action === 'delete' ? 'Delete it' : 'Clear it'}
                    </button>
                    <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirming(undefined)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      style={secondaryButtonStyle()}
                      disabled={dataset.busy === true}
                      onClick={() => props.onSync(dataset.id)}
                    >
                      {dataset.busy === true ? 'Syncing…' : 'Sync now'}
                    </button>
                    <button
                      type="button"
                      style={secondaryButtonStyle()}
                      disabled={dataset.busy === true}
                      title="Throws everything away and runs the collector again from scratch"
                      onClick={() => props.onClear(dataset.id, true)}
                    >
                      Rebuild
                    </button>
                    <button
                      type="button"
                      style={secondaryButtonStyle()}
                      /*
                       * Enabled even with nothing collected, which is the case it was disabled in.
                       *
                       * A dataset whose sync has only ever failed holds no records — so Clear was
                       * greyed out precisely when somebody wanted it, and clicking a disabled
                       * button does nothing and says nothing. Reported as Clear not clearing.
                       * Clearing also resets the sync watermark and puts the failure away, and
                       * both of those are worth doing whether or not any records exist.
                       */
                      disabled={dataset.busy === true}
                      onClick={() => setConfirming({ id: dataset.id, action: 'clear' })}
                    >
                      Clear
                    </button>
                    <button type="button" style={secondaryButtonStyle()} onClick={() => setEditing(dataset)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      style={secondaryButtonStyle()}
                      disabled={dataset.busy === true}
                      onClick={() => setConfirming({ id: dataset.id, action: 'delete' })}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" style={primaryButtonStyle(false)} onClick={() => setEditing(newDataset())}>
            Add a dataset
          </button>
          <button type="button" style={secondaryButtonStyle()} onClick={props.onRefresh}>
            Refresh
          </button>
        </div>

        <IndexingProgress progress={props.progress} onStop={props.onStop} />
      </Section>

      <Section
        title="Where it is stored"
        hint="Records are sent to your embedding endpoint, like anything else indexed."
      >
        <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
          {`Datasets that name no store of their own go to ${props.defaultStoreLabel}. `}
          Each one can be pointed somewhere else when you edit it &mdash; a corpus you collected
          yourself is often the one you least want on a cluster your team shares.
        </span>
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 6 }}>
          {props.semantic
            ? 'An embedding model is configured, so searches rank by meaning.'
            : 'No embedding model is configured. Datasets still sync and are still searchable — on words rather than meaning, and exact filters like dates and tags work either way.'}
        </span>
      </Section>

      <Section
        title="Try a search"
        hint="Runs the same search the assistant would, against these datasets. The quickest way to tell an empty corpus from a search that is not working."
      >
        <IndexProbe
          target="data"
          label="Search your datasets"
          hint="Each hit shows its dataset, timestamp and id."
          running={props.probe.running}
          result={props.probe.result}
          onProbe={props.onProbe}
          onClear={props.onClearProbe}
        />
      </Section>

      <Section title="Writing a collector">
        <button
          type="button"
          style={{ background: 'none', border: 'none', color: colors.accent, cursor: 'pointer', padding: 0, fontSize: 11 }}
          onClick={() => setShowGuidance((current) => !current)}
        >
          {showGuidance ? 'Hide the contract' : 'Show the contract a collector must satisfy'}
        </button>
        {showGuidance && (
          <pre
            className="lc-scroll"
            style={{
              margin: '8px 0 0',
              maxHeight: 300,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              fontSize: 11,
              fontFamily: monospaceFamily,
              color: colors.muted,
              background: colors.inputBackground,
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              padding: 8,
            }}
          >
            {props.guidance}
          </pre>
        )}
        <p style={{ color: colors.muted, fontSize: 11, margin: '8px 0 0' }}>
          {/*
            Said here because it is the fastest route and nobody would guess it: the assistant
            already has this contract in its prompt, so describing the source is enough.
          */}
          You do not have to write it yourself. Tell the assistant where the data lives and ask for
          a collector &mdash; it knows this contract and will offer one for you to approve.
        </p>
      </Section>
    </div>
  )
}
