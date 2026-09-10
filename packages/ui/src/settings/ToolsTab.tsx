import type { ToolCatalogueEntry } from '@light-code/core/browser'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { badgeStyle, colors, fontFamily, labelStyle, textFieldStyle } from '../theme.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface ToolsTabProps {
  tools: ToolCatalogueEntry[]
  /** True when tool schemas are being kept out of the prompt. */
  dispatcher: boolean
  /** Excel and Outlook on this machine: whether they can be reached, and whether they are on. */
  office: { supported: boolean; excel: boolean; outlook: boolean }
  onSetOffice: (excel: boolean, outlook: boolean) => void
  /**
   * How long any one tool call may take, in seconds, when nothing more specific applies.
   *
   * Undefined means each kind of tool keeps its own default. This is the fallback, not the rule:
   * a per-tool timeout wins, then a per-server one, then this.
   */
  toolTimeoutSeconds?: number
  onSetToolTimeout: (seconds?: number) => void
  /**
   * A limit for one tool, by the name the model calls. Undefined clears it.
   *
   * Where it is stored depends on the tool — an MCP tool's goes with its server so it travels
   * with a pasted config — but that is the host's problem, not the reader's: one box per row.
   */
  onSetToolTimeoutFor: (name: string, seconds?: number) => void
}

const SOURCE_LABELS: Record<ToolCatalogueEntry['source'], string> = {
  'built-in': 'Built in',
  mcp: 'MCP servers',
  python: 'Python tools',
}

const GROUP_LABELS: Record<string, string> = {
  read: 'reads',
  edit: 'edits',
  command: 'runs commands',
  mcp: 'mcp',
  always: 'always available',
}

/**
 * Everything the assistant can call, in one place.
 *
 * Until now the only complete catalogue was inside the schedule editor's permission picker —
 * which is a strange place to have to go to answer "what can it actually do", and it was built
 * for deciding what an unattended job may use rather than for reading. The built-in tools
 * appeared nowhere else at all.
 *
 * **Read-only, deliberately.** What a tool *is* belongs to whatever created it: an MCP server's
 * tools change when its config does, Python tools are files on disk, and built-ins are the
 * product. Editing here would mean a second place to change things that already have one, which
 * is the drift §15's single-schema rule exists to prevent. Enabling and disabling stays in the
 * MCP tab, where the thing being changed is the server.
 */
export function ToolsTab(props: ToolsTabProps): ReactElement {
  const [query, setQuery] = useState('')

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return props.tools
    // Name and description both, because a user looking for "read a spreadsheet" knows what
    // they want it to do and not what it is called — which is the same reason `search_docs`
    // exists for the model.
    return props.tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle),
    )
  }, [props.tools, query])

  const bySource = useMemo(() => {
    const groups = new Map<ToolCatalogueEntry['source'], ToolCatalogueEntry[]>()
    for (const tool of matches) {
      const existing = groups.get(tool.source)
      if (existing === undefined) groups.set(tool.source, [tool])
      else existing.push(tool)
    }
    return groups
  }, [matches])

  const hidden = props.tools.filter((tool) => !tool.advertised).length

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily, fontSize: 13, color: colors.foreground }}>
      <h3 style={{ margin: '0 0 4px' }}>Tools</h3>
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 0 }}>
        Everything the assistant can call right now — built in, from your MCP servers, and your
        own Python tools. Read-only: each is configured where it comes from.
      </p>

      {props.dispatcher && (
        <p style={{ color: colors.muted, fontSize: 11 }}>
          {/*
            Said plainly because the dispatcher invites exactly one misreading: that a shorter
            prompt means a shorter tool list. A hidden tool is still callable — the model finds
            it with `search_docs` and calls it through `call_tool`.
          */}
          {hidden} of these are kept out of the system prompt to save space. They are still
          callable — the assistant looks them up when it needs one. Turn that off in{' '}
          <strong>Search</strong> if you would rather it saw them all.
        </p>
      )}

      <TimeoutSection value={props.toolTimeoutSeconds} onSet={props.onSetToolTimeout} />

      <OfficeSection office={props.office} onSet={props.onSetOffice} />

      <div style={{ margin: '10px 0' }}>
        <label htmlFor="lc-tools-search" style={labelStyle()}>
          Search
        </label>
        <input
          id="lc-tools-search"
          type="search"
          value={query}
          placeholder="e.g. read a spreadsheet"
          onChange={(event) => setQuery(event.target.value)}
          style={textFieldStyle()}
        />
      </div>

      <p style={{ color: colors.muted, fontSize: 11 }}>
        {matches.length} of {props.tools.length} {props.tools.length === 1 ? 'tool' : 'tools'}
      </p>

      {props.tools.length === 0 && (
        <p style={{ color: colors.muted, fontSize: 12 }}>
          Nothing yet. Open a folder and configure a provider — the built-in tools appear once a
          session can start.
        </p>
      )}

      {[...bySource.entries()].map(([source, tools]) => (
        <div key={source} style={{ marginTop: 14 }}>
          <strong style={{ fontSize: 12 }}>
            {SOURCE_LABELS[source]} <span style={{ color: colors.muted }}>({tools.length})</span>
          </strong>

          {tools.map((tool) => (
            <div key={tool.name} style={{ padding: '6px 0', borderBottom: `1px solid ${colors.border}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: monospace, fontSize: 12 }}>{tool.name}</span>
                <span style={{ ...badgeStyle(), fontSize: 9 }}>{GROUP_LABELS[tool.group] ?? tool.group}</span>
                {tool.server !== undefined && (
                  <span style={{ ...badgeStyle(), fontSize: 9 }} title={`From the ${tool.server} server`}>
                    {tool.server}
                  </span>
                )}
                {!tool.advertised && (
                  <span
                    style={{ ...badgeStyle(), fontSize: 9 }}
                    title="Registered but kept out of the system prompt. Still callable — the assistant looks it up first."
                  >
                    looked up
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
                <div style={{ color: colors.muted, fontSize: 11, flex: 1, minWidth: 0 }}>{tool.description}</div>
                {/*
                  This tool's own limit, showing the number that will actually apply.

                  Placeholder rather than value when the limit is inherited, so "120 because the
                  server says so" and "120 because I set it here" are visibly different states —
                  otherwise clearing the box would look like it changed nothing.
                */}
                <input
                  inputMode="numeric"
                  aria-label={`Timeout for ${tool.name}`}
                  title={
                    tool.timeoutSeconds === undefined
                      ? 'Seconds this tool may take. Blank leaves it to whatever runs it.'
                      : tool.timeoutIsOwn === true
                        ? `${String(tool.timeoutSeconds)}s, set on this tool. Clear it to inherit again.`
                        : `${String(tool.timeoutSeconds)}s, inherited. Type a number to set one just for this tool.`
                  }
                  defaultValue={tool.timeoutIsOwn === true ? String(tool.timeoutSeconds) : ''}
                  placeholder={tool.timeoutSeconds === undefined ? 's' : String(tool.timeoutSeconds)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                  onBlur={(event) => {
                    const raw = event.target.value.trim()
                    if (raw.length === 0) {
                      if (tool.timeoutIsOwn === true) props.onSetToolTimeoutFor(tool.name)
                      return
                    }
                    const seconds = Number(raw)
                    // Refused rather than clamped: a typo must not become a limit nobody chose.
                    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
                      event.target.value = tool.timeoutIsOwn === true ? String(tool.timeoutSeconds) : ''
                      return
                    }
                    if (seconds !== tool.timeoutSeconds || tool.timeoutIsOwn !== true) {
                      props.onSetToolTimeoutFor(tool.name, Math.round(seconds))
                    }
                  }}
                  style={{
                    width: 54,
                    flexShrink: 0,
                    background: colors.inputBackground,
                    color: tool.timeoutIsOwn === true ? colors.accent : colors.inputForeground,
                    border: `1px solid ${tool.timeoutIsOwn === true ? colors.accent : colors.inputBorder}`,
                    borderRadius: 2,
                    padding: '0 4px',
                    fontFamily,
                    fontSize: 11,
                    textAlign: 'right',
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      ))}

      {props.tools.length > 0 && matches.length === 0 && (
        <p style={{ color: colors.muted, fontSize: 12, marginTop: 12 }}>
          Nothing matches “{query.trim()}”.
        </p>
      )}
    </div>
  )
}

/**
 * Excel and Outlook on this machine.
 *
 * ## Why it is off, and why the wording is blunt
 *
 * Switching these on lets the assistant read the workbooks someone has open and the mail in
 * their local Outlook. That is a large grant and nothing about the phrase "Office integration"
 * conveys it, so the copy says what it means. It is user-scope only in config for the same
 * reason: a repository must never be able to turn it on.
 *
 * ## Why the toggles are disabled rather than hidden off Windows
 *
 * Hiding them would leave someone on a Mac wondering where the feature went. Disabled with the
 * reason answers the question in place.
 */
function OfficeSection(props: {
  office: { supported: boolean; excel: boolean; outlook: boolean }
  onSet: (excel: boolean, outlook: boolean) => void
}): ReactElement {
  const { office } = props
  return (
    <div
      style={{
        margin: '12px 0',
        padding: 10,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        opacity: office.supported ? 1 : 0.6,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Excel and Outlook</div>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
        {office.supported
          ? 'Lets the assistant attach to the Office applications already running here. Off by ' +
            'default: nothing is started and nothing is read until you switch one on.'
          : 'Windows only — this uses COM to attach to a running Office application, which exists ' +
            'nowhere else. The tools are absent on this machine rather than present and failing.'}
      </p>

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6, cursor: office.supported ? 'pointer' : 'not-allowed' }}>
        <input
          type="checkbox"
          checked={office.excel}
          disabled={!office.supported}
          onChange={(event) => props.onSet(event.target.checked, office.outlook)}
          style={{ marginTop: 2 }}
        />
        <span>
          <span style={{ display: 'block', fontSize: 13 }}>Excel</span>
          <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
            Read cells and formulas from open workbooks, trace where a value comes from, and read
            or replace VBA. <strong>It can read any workbook you have open</strong>, including
            unsaved ones. Replacing a macro always asks first and shows the code.
          </span>
        </span>
      </label>

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: office.supported ? 'pointer' : 'not-allowed' }}>
        <input
          type="checkbox"
          checked={office.outlook}
          disabled={!office.supported}
          onChange={(event) => props.onSet(office.excel, event.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          <span style={{ display: 'block', fontSize: 13 }}>Outlook</span>
          <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
            Search and read mail from the Outlook installed here. <strong>Read-only</strong> —
            nothing can send, reply, delete or move a message. Message text becomes part of the
            conversation, so it goes to your model provider like anything else you paste in.
          </span>
        </span>
      </label>
    </div>
  )
}

/**
 * One limit for every tool, as a fallback.
 *
 * Each kind of tool had its own timeout and there was nowhere to say "everything on this machine
 * is slow" — which is a property of the environment, not of any one tool: a slow network, a
 * workbook on a share, an interpreter on a mapped drive. Setting it in three separate places was
 * the only way to say it once.
 *
 * Deliberately a fallback rather than an override. A tool that genuinely needs ten minutes should
 * say so on its own row; raising the floor for everything would mean a hung call anywhere waits
 * ten minutes before anyone hears about it.
 */
function TimeoutSection(props: { value: number | undefined; onSet: (seconds?: number) => void }): ReactElement {
  const [draft, setDraft] = useState(props.value === undefined ? '' : String(props.value))
  useEffect(() => setDraft(props.value === undefined ? '' : String(props.value)), [props.value])

  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed.length === 0) {
      props.onSet()
      return
    }
    const seconds = Number(trimmed)
    // Refused rather than clamped: a typo should not quietly become a limit nobody chose.
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
      setDraft(props.value === undefined ? '' : String(props.value))
      return
    }
    props.onSet(Math.round(seconds))
  }

  return (
    <div style={{ margin: '12px 0', padding: 10, border: `1px solid ${colors.border}`, borderRadius: 6 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Tool timeout</div>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
        How long any one tool call may take. Applies to MCP servers, Python tools and the Excel and
        Outlook tools alike, and to anything added later. Blank leaves each kind at its own default.
        A timeout set on a particular tool or server still wins over this.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          inputMode="numeric"
          value={draft}
          placeholder="seconds"
          aria-label="Tool timeout in seconds"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          style={{ ...textFieldStyle(), width: 110 }}
        />
        <span style={{ color: colors.muted, fontSize: 11 }}>
          {props.value === undefined ? 'each tool decides' : `${String(props.value)}s for everything`}
        </span>
      </div>
    </div>
  )
}
