#!/usr/bin/env node
/**
 * Draws the walkthrough diagrams.
 *
 * A guide that only describes where things are leaves the reader to do the translation. These
 * are schematics of the actual panel — the tab strip with one tab lit, and that tab's real
 * fields in the order they appear — so "the CA certificate is under Network" becomes something
 * you can recognise rather than something you have to go and find.
 *
 * Generated rather than drawn by hand for the obvious reason: fourteen diagrams hand-authored
 * in two palettes drift apart, and the tab strip appearing in twelve of them has to be the same
 * tab strip every time or the reader stops trusting it as a map.
 *
 * Field names are copied from the components. When a tab gains a setting, add it here too — a
 * diagram that omits a field is a diagram that teaches the panel is smaller than it is.
 *
 *   node scripts/generate-walkthrough-art.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'vscode', 'walkthrough', 'media')

/**
 * Two palettes, because VS Code hands the walkthrough a light or dark image and never recolours
 * one. Each diagram paints its own background for the same reason a screenshot does — it must
 * not borrow the page's, or a light diagram on a dark page shows white text on white.
 */
const THEMES = {
  light: {
    page: '#f8f8f8', chrome: '#ececec', border: '#d0d0d0', text: '#1f1f1f', muted: '#6b6b6b',
    field: '#ffffff', fieldBorder: '#c8c8c8', accent: '#2f7d4f', accentText: '#ffffff',
    badge: '#e4e4e4', danger: '#b5361f', good: '#2f7d4f', expert: '#7a4bbf', rail: '#e0e0e0',
  },
  dark: {
    page: '#1f1f1f', chrome: '#282828', border: '#3d3d3d', text: '#e8e8e8', muted: '#9a9a9a',
    field: '#2f2f2f', fieldBorder: '#484848', accent: '#4caf7d', accentText: '#10261a',
    badge: '#343434', danger: '#e06c56', good: '#4caf7d', expert: '#b28ae8', rail: '#2b2b2b',
  },
}

const TABS = ['Providers', 'Approvals', 'MCP', 'Search', 'Expert', 'Schedules', 'Python', 'Tools', 'Skills', 'Network', 'Appearance']

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const FONT = "system-ui,'Segoe UI',Ubuntu,sans-serif"
const MONO = "ui-monospace,'Cascadia Code','Consolas',monospace"

function text(x, y, s, { fill, size = 12, weight = 400, mono = false, anchor = 'start', opacity = 1 } = {}) {
  return `<text x="${x}" y="${y}" font-family="${mono ? MONO : FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" opacity="${opacity}">${esc(s)}</text>`
}
const rect = (x, y, w, h, { fill, stroke, r = 4, dash, width = 1 }) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill ?? 'none'}"${stroke ? ` stroke="${stroke}" stroke-width="${width}"` : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}/>`

/** The tab strip, with one tab lit. The map every tab diagram shares. */
function tabStrip(t, active, width) {
  let x = 12
  const parts = [rect(0, 40, width, 30, { fill: t.chrome, r: 0 }), `<line x1="0" y1="70" x2="${width}" y2="70" stroke="${t.border}"/>`]
  for (const label of TABS) {
    const w = label.length * 6.1 + 16
    const on = label.toLowerCase() === active
    if (on) {
      parts.push(rect(x - 2, 44, w, 22, { fill: t.accent, r: 11 }))
      parts.push(text(x + w / 2 - 2, 59, label, { fill: t.accentText, size: 11, weight: 600, anchor: 'middle' }))
    } else {
      parts.push(text(x + w / 2 - 2, 59, label, { fill: t.muted, size: 11, anchor: 'middle' }))
    }
    x += w + 3
  }
  return parts.join('')
}

/** Panel chrome: title bar, back arrow, gear. */
function header(t, title, width) {
  return [
    rect(0, 0, width, 40, { fill: t.chrome, r: 0 }),
    `<path d="M20 20 l7 -7 M20 20 l7 7" stroke="${t.muted}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
    text(38, 25, title, { fill: t.text, size: 13, weight: 600 }),
  ].join('')
}

const CONTROLS = {
  text: (t, x, y, w, value) => rect(x, y, w, 22, { fill: t.field, stroke: t.fieldBorder }) + (value ? text(x + 8, y + 15, value, { fill: t.muted, size: 11, mono: true }) : ''),
  secret: (t, x, y, w) => rect(x, y, w, 22, { fill: t.field, stroke: t.fieldBorder }) + text(x + 8, y + 15, 'Set — replace?', { fill: t.muted, size: 11 }),
  select: (t, x, y, w, value) =>
    rect(x, y, w, 22, { fill: t.field, stroke: t.fieldBorder }) + text(x + 8, y + 15, value ?? '', { fill: t.text, size: 11 }) +
    `<path d="M${x + w - 16} ${y + 9} l4 5 l4 -5" stroke="${t.muted}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
  toggle: (t, x, y, _w, value) => {
    const on = value === 'on'
    return rect(x, y + 3, 28, 16, { fill: on ? t.accent : t.badge, stroke: on ? t.accent : t.fieldBorder, r: 8 }) +
      `<circle cx="${on ? x + 20 : x + 8}" cy="${y + 11}" r="5.5" fill="${on ? t.accentText : t.muted}"/>` +
      text(x + 36, y + 15, on ? 'on' : 'off', { fill: t.muted, size: 10 })
  },
  button: (t, x, y, _w, value) => {
    const w = String(value).length * 6.2 + 20
    return rect(x, y, w, 22, { fill: t.accent, r: 4 }) + text(x + w / 2, y + 15, value, { fill: t.accentText, size: 11, weight: 600, anchor: 'middle' })
  },
  chips: (t, x, y, _w, value) => String(value).split('|').map((c, i, all) => {
    const cw = c.length * 5.8 + 14
    const cx = x + all.slice(0, i).reduce((sum, prev) => sum + prev.length * 5.8 + 20, 0)
    return rect(cx, y + 2, cw, 18, { fill: t.badge, r: 9 }) + text(cx + cw / 2, y + 15, c, { fill: t.text, size: 10, anchor: 'middle' })
  }).join(''),
  list: (t, x, y, w, value) => rect(x, y, w, 22, { fill: 'none', stroke: t.fieldBorder, dash: '3 3' }) + text(x + 8, y + 15, value ?? '', { fill: t.muted, size: 11 }),
}

/** The generic tab diagram: a lit tab, then that tab's fields in order. */
function tabDiagram(t, { tab, note, rows }, width) {
  const LABEL_X = 20
  const CTRL_X = 250
  let y = 92
  const body = []
  if (note) { body.push(text(LABEL_X, y, note, { fill: t.muted, size: 11 })); y += 22 }
  for (const row of rows) {
    if (row.section) {
      y += 8
      body.push(text(LABEL_X, y + 4, row.section.toUpperCase(), { fill: t.muted, size: 9, weight: 700 }))
      body.push(`<line x1="${LABEL_X}" y1="${y + 12}" x2="${width - 20}" y2="${y + 12}" stroke="${t.border}"/>`)
      y += 26
      continue
    }
    body.push(text(LABEL_X, y + 15, row.label, { fill: t.text, size: 11.5 }))
    body.push(CONTROLS[row.control ?? 'text'](t, CTRL_X, y, width - CTRL_X - 20, row.value))
    if (row.hint) { body.push(text(LABEL_X, y + 29, row.hint, { fill: t.muted, size: 10 })); y += 14 }
    y += 30
  }
  const height = y + 12
  return { height, body: header(t, 'Settings', width) + tabStrip(t, tab, width) + body.join('') }
}

/** Where everything is: the VS Code window itself. Only useful once, but essential once. */
function orientation(t, width) {
  const p = []
  p.push(rect(10, 10, width - 20, 300, { fill: t.chrome, stroke: t.border, r: 6 }))
  p.push(rect(10, 10, 44, 300, { fill: t.rail, r: 6 }))
  p.push(rect(38, 10, 16, 300, { fill: t.rail, r: 0 }))
  // Activity bar icons, ours lit.
  for (const [i, on] of [false, false, true, false, false].entries()) {
    const cy = 44 + i * 40
    if (on) {
      p.push(`<line x1="11" y1="${cy - 15}" x2="11" y2="${cy + 15}" stroke="${t.accent}" stroke-width="2.5"/>`)
      p.push(`<circle cx="32" cy="${cy}" r="10" fill="none" stroke="${t.accent}" stroke-width="2"/>`)
      p.push(`<path d="M27 ${cy - 1} h10 M27 ${cy + 4} h6" stroke="${t.accent}" stroke-width="1.8" stroke-linecap="round"/>`)
    } else {
      p.push(rect(23, cy - 8, 18, 16, { fill: 'none', stroke: t.muted, r: 3, width: 1.2 }))
    }
  }
  p.push(text(66, 20, '1', { fill: t.accentText, size: 10, weight: 700 }))
  p.push(`<circle cx="62" cy="44" r="9" fill="${t.accent}"/>`)
  p.push(text(62, 48, '1', { fill: t.accentText, size: 11, weight: 700, anchor: 'middle' }))

  // The sidebar panel.
  const px = 78, pw = 300
  p.push(rect(px, 20, pw, 280, { fill: t.page, stroke: t.border, r: 5 }))
  p.push(rect(px, 20, pw, 34, { fill: t.chrome, r: 5 }))
  p.push(rect(px + 10, 28, 52, 18, { fill: 'none', stroke: t.accent, r: 9 }))
  p.push(text(px + 36, 41, 'Code ▾', { fill: t.accent, size: 10, weight: 600, anchor: 'middle' }))
  p.push(rect(px + 68, 28, 54, 18, { fill: 'none', stroke: t.expert, r: 9 }))
  p.push(text(px + 95, 41, '$0.02 ▾', { fill: t.expert, size: 10, weight: 600, anchor: 'middle' }))
  // Header icons: new task, history, settings, guide.
  const icons = ['+', '↺', '⚙', '?']
  for (const [i, glyph] of icons.entries()) {
    const cx = px + pw - 90 + i * 22
    const lit = i >= 2
    p.push(`<circle cx="${cx}" cy="37" r="9" fill="${lit ? t.accent : 'none'}" stroke="${lit ? t.accent : t.muted}" stroke-width="1.2"/>`)
    p.push(text(cx, 41, glyph, { fill: lit ? t.accentText : t.muted, size: 11, weight: 700, anchor: 'middle' }))
  }
  p.push(`<circle cx="${px + pw - 68}" cy="16" r="9" fill="${t.accent}"/>`)
  p.push(text(px + pw - 68, 20, '3', { fill: t.accentText, size: 11, weight: 700, anchor: 'middle' }))
  p.push(`<circle cx="${px + pw - 46}" cy="16" r="9" fill="${t.accent}"/>`)
  p.push(text(px + pw - 46, 20, '4', { fill: t.accentText, size: 11, weight: 700, anchor: 'middle' }))

  // Conversation.
  p.push(rect(px + 110, 66, 170, 26, { fill: t.badge, r: 6 }))
  p.push(text(px + 122, 83, 'add a health endpoint', { fill: t.text, size: 10.5 }))
  p.push(text(px + 12, 112, 'Reading src/server.ts …', { fill: t.muted, size: 10.5 }))
  p.push(rect(px + 12, 124, 200, 42, { fill: t.field, stroke: t.fieldBorder, r: 5 }))
  p.push(text(px + 22, 141, 'apply_diff  src/server.ts', { fill: t.text, size: 10, mono: true }))
  p.push(rect(px + 22, 148, 52, 13, { fill: t.accent, r: 3 }))
  p.push(text(px + 48, 158, 'Approve', { fill: t.accentText, size: 9, weight: 600, anchor: 'middle' }))
  p.push(rect(px + 80, 148, 40, 13, { fill: 'none', stroke: t.danger, r: 3 }))
  p.push(text(px + 100, 158, 'Deny', { fill: t.danger, size: 9, weight: 600, anchor: 'middle' }))

  // Composer + token bar.
  p.push(rect(px + 12, 232, pw - 24, 12, { fill: t.badge, r: 3 }))
  p.push(rect(px + 12, 232, 96, 12, { fill: t.accent, r: 3 }))
  p.push(text(px + 36, 228, '18k / 128k', { fill: t.muted, size: 9 }))
  p.push(rect(px + 12, 250, pw - 24, 38, { fill: t.field, stroke: t.fieldBorder, r: 5 }))
  p.push(`<circle cx="${px + pw - 34}" cy="269" r="11" fill="${t.accent}"/>`)
  p.push(`<path d="M${px + pw - 39} 269 h9 M${px + pw - 34} 264 l5 5 l-5 5" stroke="${t.accentText}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`)
  p.push(`<circle cx="${px + 16}" cy="269" r="9" fill="${t.accent}"/>`)
  p.push(text(px + 16, 273, '2', { fill: t.accentText, size: 11, weight: 700, anchor: 'middle' }))
  p.push(text(px + 32, 273, 'Ask for something…', { fill: t.muted, size: 10.5 }))

  // Legend.
  const legend = [
    ['1', 'The Light Code icon in the activity bar — everything lives here'],
    ['2', 'The composer: type, attach a file or image, @ to name a path'],
    ['3', 'The gear: eleven settings tabs, covered by the rest of this guide'],
    ['4', 'The question mark: reopens this guide, any time'],
  ]
  let ly = 332
  for (const [n, label] of legend) {
    p.push(`<circle cx="24" cy="${ly - 4}" r="8" fill="${t.accent}"/>`)
    p.push(text(24, ly, n, { fill: t.accentText, size: 10, weight: 700, anchor: 'middle' }))
    p.push(text(40, ly, label, { fill: t.text, size: 11 }))
    ly += 22
  }
  return { height: ly, body: p.join('') }
}

/** The chat window, annotated. */
function chatDiagram(t, width) {
  const p = []
  p.push(rect(10, 10, width - 20, 44, { fill: t.chrome, stroke: t.border, r: 5 }))
  const chips = [['Code ▾', t.accent], ['$0.02 / $1.00 ▾', t.expert]]
  let cx = 24
  for (const [label, colour] of chips) {
    const w = label.length * 6.4 + 18
    p.push(rect(cx, 22, w, 20, { fill: 'none', stroke: colour, r: 10 }))
    p.push(text(cx + w / 2, 36, label, { fill: colour, size: 11, weight: 600, anchor: 'middle' }))
    cx += w + 10
  }
  for (const [i, glyph] of ['+', '↺', '⚙', '?'].entries()) {
    const x = width - 130 + i * 28
    p.push(`<circle cx="${x}" cy="32" r="11" fill="none" stroke="${t.muted}" stroke-width="1.2"/>`)
    p.push(text(x, 36, glyph, { fill: t.muted, size: 12, weight: 700, anchor: 'middle' }))
  }
  /*
   * Numbered markers rather than leader lines. Lines drawn from a control down to its caption
   * have to cross the captions above it, and a dashed rule running through a sentence is harder
   * to read past than no annotation at all.
   */
  const notes = [
    ['Mode', 'Code can edit and run commands. Ask is read-only. Junior brings the expert in.', 30],
    ['Budget', 'Junior mode only. What the expert has spent on this task, and its ceiling. Raise it mid-task.', 130],
    ['New task, History, Settings, Guide', 'History keeps every past task; reopening one restores the whole transcript.', width - 122],
  ]
  for (const [i, [, , ax]] of notes.entries()) {
    p.push(`<circle cx="${ax}" cy="17" r="8.5" fill="${t.accent}"/>`)
    p.push(text(ax, 21, String(i + 1), { fill: t.accentText, size: 10, weight: 700, anchor: 'middle' }))
  }
  let y = 82
  for (const [i, [title, body]] of notes.entries()) {
    p.push(`<circle cx="28" cy="${y - 4}" r="8.5" fill="${t.accent}"/>`)
    p.push(text(28, y, String(i + 1), { fill: t.accentText, size: 10, weight: 700, anchor: 'middle' }))
    p.push(text(44, y, title, { fill: t.text, size: 11.5, weight: 700 }))
    p.push(text(44, y + 16, body, { fill: t.muted, size: 11 }))
    y += 44
  }
  p.push(rect(10, y, width - 20, 96, { fill: t.page, stroke: t.border, r: 5 }))
  p.push(text(24, y + 22, 'The composer', { fill: t.text, size: 11.5, weight: 700 }))
  p.push(rect(24, y + 32, width - 48, 44, { fill: t.field, stroke: t.fieldBorder, r: 5 }))
  p.push(text(34, y + 52, '@src/server.ts  add a health endpoint', { fill: t.text, size: 11, mono: true }))
  p.push(text(34, y + 68, 'paste a screenshot · drop a .docx, .xlsx or .pdf · @ names a file', { fill: t.muted, size: 10 }))
  return { height: y + 118, body: p.join('') }
}

/** What leaves the machine, and what does not. */
function privacyDiagram(t, width) {
  const p = []
  const boxes = [
    ['Your model gateway', 'the profile you configured', t.accent],
    ['Your MCP servers', 'only the ones you added', t.accent],
    ['Your vector store', 'only if you enable Search', t.danger],
    ['Your embedding endpoint', 'sees the files you index', t.danger],
  ]
  p.push(rect(20, 20, 190, 130, { fill: t.chrome, stroke: t.border, r: 6 }))
  p.push(text(115, 46, 'This machine', { fill: t.text, size: 12, weight: 700, anchor: 'middle' }))
  for (const [i, label] of ['Your files', 'Your commands', 'Your secrets'].entries()) {
    p.push(rect(38, 60 + i * 28, 154, 22, { fill: t.field, stroke: t.fieldBorder }))
    p.push(text(48, 75 + i * 28, label, { fill: t.text, size: 11 }))
  }
  let y = 24
  for (const [title, sub, colour] of boxes) {
    p.push(`<path d="M212 85 C 250 85, 250 ${y + 18}, 288 ${y + 18}" stroke="${colour}" stroke-width="1.4" fill="none"/>`)
    p.push(`<circle cx="290" cy="${y + 18}" r="3" fill="${colour}"/>`)
    p.push(rect(300, y, width - 320, 36, { fill: t.field, stroke: colour }))
    p.push(text(312, y + 16, title, { fill: t.text, size: 11.5, weight: 600 }))
    p.push(text(312, y + 29, sub, { fill: t.muted, size: 10 }))
    y += 44
  }
  const nots = ['No telemetry, ever', 'No update checks', 'No default endpoints — a fresh install contacts nothing', 'No remote assets in the panel']
  let ny = 178
  for (const line of nots) {
    p.push(`<path d="M28 ${ny - 4} l4 4 l7 -9" stroke="${t.good}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`)
    p.push(text(48, ny, line, { fill: t.text, size: 11 }))
    ny += 20
  }
  p.push(rect(20, ny + 6, width - 40, 46, { fill: 'none', stroke: t.danger, dash: '4 3' }))
  p.push(text(34, ny + 26, 'Not sandboxed.', { fill: t.danger, size: 11.5, weight: 700 }))
  p.push(text(132, ny + 26, 'Commands, Python tools and MCP servers run as you,', { fill: t.text, size: 11 }))
  p.push(text(34, ny + 41, 'with your permissions. Approval is the boundary — that is why it is per-invocation.', { fill: t.text, size: 11 }))
  return { height: ny + 66, body: p.join('') }
}

const STEPS = {
  orientation: { custom: orientation },
  chat: { custom: chatDiagram },
  privacy: { custom: privacyDiagram },

  providers: {
    tab: 'providers',
    note: 'Where the model comes from. One profile per gateway; switch between them from the chat header.',
    rows: [
      { section: 'the profile list' },
      { label: 'gateway (in use)', control: 'chips', value: 'Use this|Edit|Duplicate|Delete' },
      { label: 'Config file', control: 'list', value: 'opens the JSON these tabs write' },
      { section: 'editing one' },
      { label: 'Preset', control: 'select', value: 'OpenAI-compatible' , hint: 'Prefills base URL and wire format. Every field stays editable.' },
      { label: 'Label', value: 'corporate gateway' },
      { label: 'Base URL', value: 'https://gateway.internal/v1', hint: 'No defaults ship. Nothing is contacted until you put something here.' },
      { label: 'Authentication', control: 'select', value: 'API key', hint: 'Or Apigee mTLS — a client certificate and a token grant instead of a key.' },
      { label: 'API key', control: 'secret', hint: 'Held in the OS keychain. The panel is never sent it back.' },
      { label: 'Model', control: 'select', value: 'gpt-4o', hint: 'Fetched from the gateway, and always typeable — many return nothing.' },
      { label: 'Context window / vision / tools', control: 'list', value: 'override when a gateway alias is unknown' },
      { label: 'Test connection', control: 'button', value: 'Test connection', hint: 'Certificates, then token, then models — and says which step failed.' },
    ],
  },

  network: {
    tab: 'network',
    note: 'Trust and identity for every connection: gateway, token endpoint, MCP over HTTP, vector store, embedder.',
    rows: [
      { label: 'Certificate directory', value: 'C:\\certs', hint: 'Filenames resolve against it. Must sit outside the workspace.' },
      { label: 'CA certificate', value: 'corporate-root.pem', hint: 'Added to the public roots, not swapped for them.' },
      { label: 'Certificate', value: 'client.crt', hint: 'How the gateway identifies you. Taken as a pair with the key.' },
      { label: 'Private key', value: 'client.key' },
      { label: 'PFX bundle', value: 'instead of the two above', hint: 'What corporate Windows PKI usually issues.' },
      { label: 'Key passphrase', control: 'secret' },
      { label: 'Verify TLS certificates', control: 'toggle', value: 'on', hint: 'Turning it off lets an interceptor read the traffic, key included. Add the CA instead.' },
    ],
  },

  approvals: {
    tab: 'approvals',
    note: 'Nothing here is on by default. This tab is where standing permission is granted — and taken back.',
    rows: [
      { section: 'skip the prompt for' },
      { label: 'Reading files', control: 'toggle', value: 'off' },
      { label: 'Editing files', control: 'toggle', value: 'off' },
      { label: 'Running commands', control: 'toggle', value: 'off' },
      { label: 'MCP tools', control: 'toggle', value: 'off' },
      { section: 'standing grants, revocable' },
      { label: 'Always-allowed commands', control: 'list', value: 'npm test   ✕', hint: 'Exact match, byte for byte. "npm test" never covers "npm test && rm -rf /".' },
      { label: 'Always-allowed tools', control: 'list', value: 'filesystem__read_file   ✕' },
      { label: 'Folders outside the workspace', control: 'list', value: '\\\\nas\\shared   ✕', hint: 'Granted in the chat when a read is refused, listed here so you can take it back.' },
      { section: 'limits' },
      { label: 'Maximum steps per message', value: '25', hint: 'How many tool calls one message may take before it stops and asks.' },
    ],
  },

  mcp: {
    tab: 'mcp',
    note: 'Servers you already run. The standard mcpServers config — paste one from another client unchanged.',
    rows: [
      { label: 'filesystem', control: 'chips', value: 'connected|Restart|Logs' },
      { label: '  read_file', control: 'chips', value: 'Always|Ask|Never', hint: 'Per tool, not just per server: one server can expose forty.' },
      { label: '  write_file', control: 'chips', value: 'Always|Ask|Never' },
      { label: 'github', control: 'chips', value: 'failed to start|Restart' },
      { label: 'Configuration', control: 'list', value: '{ "mcpServers": { … } }', hint: 'stdio or HTTP, inferred from whether you gave a command or a url.' },
      { label: 'Secrets in env', value: '${secret:GITHUB_TOKEN}', hint: 'Resolved from the keychain at spawn time, never written into the file.' },
    ],
  },

  search: {
    tab: 'search',
    note: 'Off by default, and the largest thing Light Code ever sends anywhere. Indexing uploads your files to the embedder.',
    rows: [
      { section: 'the store' },
      { label: 'Backend', control: 'select', value: 'Qdrant', hint: 'Qdrant or Chroma run locally; OpenSearch is usually the one you already have.' },
      { label: 'Name / URL', value: 'http://127.0.0.1:6333' },
      { label: 'Username / Password', control: 'secret' },
      { label: 'Additional CA certificate', control: 'list', value: 'inherits the Network tab' },
      { section: 'embedding' },
      { label: 'Embedding profile', control: 'select', value: 'corporate gateway', hint: 'A provider profile — the same credentials, not a second place to configure one.' },
      { label: 'Index prefix', value: 'lc-' },
      { label: 'Index the workspace', control: 'button', value: 'Index now', hint: 'Says what it will send, and where, before the first upload.' },
      { section: 'how it is used' },
      { label: 'Look tools up instead of listing them', control: 'toggle', value: 'off', hint: 'Halves the prompt at forty tools. Makes it bigger at three — the tab shows the count.' },
      { label: 'Copy an existing index here', control: 'button', value: 'Copy', hint: 'Moving backend does not orphan what you already indexed.' },
      { label: 'Query limits', control: 'list', value: 'results · lookback · timeout · shards' },
      { label: 'Recent searches', control: 'list', value: 'every query it ran, and a box to run your own' },
    ],
  },

  expert: {
    tab: 'expert',
    note: 'A cheap model does the work and consults Claude on the hard parts. Off until you enable it.',
    rows: [
      { label: 'Enabled', control: 'toggle', value: 'off', hint: 'Nothing is spawned and nothing is spent until this is on.' },
      { label: 'Command', value: 'claude', hint: 'Found on PATH, or via npm, or point at it yourself if detection fails.' },
      { label: 'Model (optional)', control: 'select', value: 'default' },
      { section: 'budget per task' },
      { label: 'Maximum spend per task', value: '$1.00', hint: 'Also adjustable mid-task from the chat header.' },
      { label: 'Maximum consultations per task', value: '6' },
      { label: 'Cost estimate', control: 'list', value: 'the expert prices a task before starting it' },
      { label: 'Skill assessment', control: 'list', value: 'how the expert rates your primary model' },
      { section: 'what it may do' },
      { label: 'Read, Grep, Glob only', control: 'list', value: 'it can never edit or run anything', hint: 'A second agent editing your repo would sit outside the approval gate entirely.' },
    ],
  },

  schedules: {
    tab: 'schedules',
    note: 'Prompts that run on their own, in the background, without disturbing the chat you are in.',
    rows: [
      { label: 'Name', value: 'morning triage' },
      { label: 'Prompt', value: 'summarise failing tests' },
      { label: 'Minutes between runs', value: '60', hint: 'Or a time of day. Runs even with the panel closed.' },
      { section: 'what an unattended run may do' },
      { label: 'Workspace files', control: 'select', value: 'read only', hint: 'Nobody is there to approve anything, so editing is granted here or not at all.' },
      { label: 'Filter tools', control: 'list', value: 'pick exactly which tools it may call' },
      { label: 'Creating Python tools or skills', control: 'list', value: 'never available to a schedule', hint: 'Model-authored code with no one watching is the one thing that stays out of reach.' },
      { section: 'afterwards' },
      { label: 'Run history', control: 'chips', value: 'Run now|Open transcript|Delete' },
      { label: 'notify', control: 'list', value: 'a toast when a run has something to say' },
    ],
  },

  python: {
    tab: 'python',
    note: 'The assistant can write its own tools in Python. The sharpest surface in the product, so read the approval.',
    rows: [
      { label: 'Enabled', control: 'toggle', value: 'off' },
      { label: 'Path to uv', value: 'detected', hint: 'uv installs dependencies and manages the environment.' },
      { label: 'Python environment', control: 'select', value: 'the project\u2019s .venv', hint: 'Your own venv is preferred — it is where your internal libraries already are.' },
      { label: 'Where tools are kept', value: '.lightcode/tools', hint: 'Inside the workspace, so a new tool lands in git and gets reviewed.' },
      { label: 'Package index', value: 'https://pypi.internal/simple', hint: 'Or refuse the network entirely.' },
      { label: 'Timeout per call', value: '60' },
      { section: 'the tools it wrote' },
      { label: 'py__parse_report', control: 'chips', value: 'Open|Delete' },
      { label: 'Approval is by content hash', control: 'list', value: 'edited outside? refused, and reported', hint: 'Creating one always prompts, and always shows the whole source.' },
    ],
  },

  skills: {
    tab: 'skills',
    note: 'Markdown notes that teach it your conventions. Only the name and description cost prompt space.',
    rows: [
      { label: 'internal-http-client', control: 'chips', value: 'Open|Delete' },
      { label: 'release-process', control: 'chips', value: 'Open|Delete' },
      { label: 'Where skills are written', value: '.lightcode/skills' },
      { label: 'Extra folders to read', control: 'list', value: 'a shared team folder, read-only', hint: 'PATH-style precedence; a shadowed skill is reported, not silently dropped.' },
      { label: 'Problems', control: 'list', value: 'a file missing its frontmatter is named here' },
      { label: 'Writing one needs approval', control: 'list', value: 'you see the full text first', hint: 'A skill is prose that steers every future turn, so it is never written silently.' },
    ],
  },

  tools: {
    tab: 'tools',
    note: 'Everything it can call right now, in one list — built in, from MCP, and your own Python tools.',
    rows: [
      { label: 'Search', value: 'read a spreadsheet', hint: 'Matches descriptions too, so you can look for what you want done.' },
      { section: 'built in' },
      { label: 'read_file · apply_diff · execute_command', control: 'list', value: 'the nine that always exist' },
      { section: 'mcp servers' },
      { label: 'filesystem__read_file', control: 'chips', value: 'mcp|filesystem|looked up' },
      { section: 'python tools' },
      { label: 'py__parse_report', control: 'chips', value: 'edits|looked up' },
      { label: '“looked up” means hidden from the prompt', control: 'list', value: 'still callable — it finds it first', hint: 'A shorter prompt is not a shorter tool list. Withholding a capability is what Approvals is for.' },
    ],
  },

  appearance: {
    tab: 'appearance',
    note: 'The panel follows your editor theme. These two colours are the part that is yours.',
    rows: [
      { label: 'Accent colour', control: 'chips', value: 'green|blue|purple|amber' , hint: 'Text on it is computed, so it stays readable whatever you pick.' },
      { label: 'Expert colour', control: 'chips', value: 'violet|teal|rose', hint: 'Marks authorship: text in this colour is Claude\u2019s words, not your model\u2019s.' },
      { label: 'Reduced motion', control: 'toggle', value: 'off', hint: 'Also honoured automatically from your OS setting.' },
    ],
  },
}

function render(name, spec, themeName) {
  const t = THEMES[themeName]
  const width = spec.custom ? 640 : 700
  const { height, body } = spec.custom ? spec.custom(t, width) : tabDiagram(t, spec, width)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">` +
    rect(0, 0, width, height, { fill: t.page, r: 0 }) + body + '</svg>\n'
}

mkdirSync(OUT, { recursive: true })
let count = 0
for (const [name, spec] of Object.entries(STEPS)) {
  for (const theme of ['light', 'dark']) {
    writeFileSync(path.join(OUT, `${name}-${theme}.svg`), render(name, spec, theme), 'utf8')
    count++
  }
}
process.stdout.write(`walkthrough art: ${String(count)} files in ${path.relative(process.cwd(), OUT)}\n`)
