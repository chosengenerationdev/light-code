import { useEffect, useState, type ReactElement } from 'react'
import type { DatasetConfig, ProbeTarget } from '@light-code/core/browser'

import { IndexingProgress, type IndexingProgressState } from './IndexingProgress.js'
import { IndexProbe } from './IndexProbe.js'
import { Select } from '../Select.js'
import {
  colors,
  labelStyle,
  monospaceFamily,
  primaryButtonStyle,
  secondaryButtonStyle,
  sectionHeadingStyle,
  textFieldStyle,
} from '../theme.js'

export type DatasetStatus = DatasetConfig & {
  records: number
  sizeBytes: number
  oldest?: number
  newest?: number
  lastSyncedAt?: number
  busy?: boolean
  lastResult?: string
  storeLabel: string
}

export interface CustomDataTabProps {
  datasets: DatasetStatus[]
  /** Everything callable that could serve as a collector — Python tools and MCP tools alike. */
  tools: { name: string; description: string }[]
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
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A titled block, so a long page reads as parts rather than a wall. Matches the Outlook tab. */
function Section(props: { title: string; hint?: string; children: React.ReactNode }): ReactElement {
  return (
    <section style={{ marginBottom: 18 }}>
      <h3 style={sectionHeadingStyle()}>{props.title}</h3>
      {props.hint !== undefined && (
        <p style={{ margin: '0 0 8px', color: colors.muted, fontSize: 11 }}>{props.hint}</p>
      )}
      {props.children}
    </section>
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

        <label htmlFor="lc-ds-tool" style={labelStyle()}>
          Collector tool
        </label>
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
          <Select
            id="lc-ds-tool"
            value={editing.toolName}
            options={[
              { value: '', label: 'Choose a tool…' },
              ...props.tools.map((tool) => ({ value: tool.name, label: tool.name })),
            ]}
            onChange={(value) => setEditing({ ...editing, toolName: value })}
            ariaLabel="Collector tool"
          />
        )}
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 12px' }}>
          {props.tools.find((tool) => tool.name === editing.toolName)?.description ??
            'Python tools and MCP tools both work. It must return a list of records — see the contract below.'}
        </span>

        <label htmlFor="lc-ds-sync" style={labelStyle()}>
          Sync
        </label>
        <Select
          id="lc-ds-sync"
          value={String(editing.syncMinutes ?? 0)}
          options={[
            /*
             * Manual is first and is the default for a new dataset.
             *
             * A collector nobody has run yet is far more likely to want trying by hand than
             * putting on a timer — and some sources are expensive or only change when somebody
             * does something, where a schedule is simply the wrong shape.
             */
            { value: '0', label: 'Only when I ask' },
            { value: '15', label: 'Every 15 minutes' },
            { value: '60', label: 'Hourly' },
            { value: '360', label: 'Every 6 hours' },
            { value: '1440', label: 'Daily' },
          ]}
          onChange={(value) => setEditing({ ...editing, syncMinutes: Number(value) })}
          ariaLabel="How often to sync"
        />
        <span style={{ display: 'block', color: colors.muted, fontSize: 11, margin: '4px 0 12px' }}>
          {(editing.syncMinutes ?? 0) === 0
            ? 'Nothing runs on its own. Use Sync now on the list, or re-run it after changing the collector.'
            : 'The collector is called on this timer, and given the time of the last successful sync so it can fetch only what changed.'}
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

      <Section title="Datasets">
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
                <div style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>{dataset.lastResult}</div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {confirming?.id === dataset.id ? (
                  <>
                    <span style={{ fontSize: 11 }}>
                      {confirming.action === 'delete'
                        ? `Delete "${dataset.name}" and everything it collected?`
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
                      disabled={dataset.busy === true || dataset.records === 0}
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

        <button type="button" style={primaryButtonStyle(false)} onClick={() => setEditing(newDataset())}>
          Add a dataset
        </button>

        <IndexingProgress progress={props.progress} onStop={props.onStop} />
      </Section>

      <Section
        title="Where it is stored"
        hint="Records are sent to your embedding endpoint, like anything else indexed. Route this corpus to its own connection under Search if it should not share a cluster."
      >
        <span style={{ color: colors.muted, fontSize: 11 }}>
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
