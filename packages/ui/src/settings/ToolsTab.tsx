import type { ToolCatalogueEntry } from '@light-code/core/browser'
import { useMemo, useState, type ReactElement } from 'react'
import { badgeStyle, colors, fontFamily, labelStyle, textFieldStyle } from '../theme.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface ToolsTabProps {
  tools: ToolCatalogueEntry[]
  /** True when tool schemas are being kept out of the prompt. */
  dispatcher: boolean
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
              <div style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>{tool.description}</div>
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
