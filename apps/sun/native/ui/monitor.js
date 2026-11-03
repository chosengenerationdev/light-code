// Fire Code - one monitor's grid, in a window of its own.
//
// Plain DOM like the shell. Talks to Rust through `window.ipc.postMessage` ({cmd, ...}); Rust answers
// through `window.__sun.receive`, and pushes a fresh `grid` whenever the monitor checks again. Everything
// shown is the engine's own judgement (monitor.rs): which rows and cells are coloured, and why.
'use strict'

const $ = (selector) => document.querySelector(selector)
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (key === 'style') node.style.cssText = value
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child)
  return node
}
const send = (cmd, args = {}) => window.ipc.postMessage(JSON.stringify({ cmd, ...args }))
/** `replaceChildren` without the absent ones: given `null` it would write the word "null". */
const put = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false))
const ICON = {
  run: '<path d="M5 3.25v9.5L12.75 8z"/>',
  check: '<path d="m3.5 8.25 3 3 6-6.5"/>',
  bell: '<path d="M4 11.25V7.5a4 4 0 0 1 8 0v3.75l1.25 1.25H2.75z"/><path d="M6.5 13.75a1.5 1.5 0 0 0 3 0"/>',
  more: '<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  file: '<path d="M3.75 1.75h6l2.5 2.5v10H3.75z"/>',
  clock: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/>',
  changes: '<path d="M4.5 2.25h7M4.5 13.75h7"/><path d="M8 4.75v6.5"/><path d="m5.75 9 2.25 2.25L10.25 9"/>',
  funnel: '<path d="M2.25 3h11.5L9.25 8.5v4.25l-2.5 1V8.5z"/>',
  columns: '<rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.25"/><path d="M6 2.75v10.5M10 2.75v10.5"/>',
  copy: '<rect x="5.25" y="5.25" width="8" height="8.5" rx="1.25"/><path d="M10.75 5.25V3.5c0-.7-.55-1.25-1.25-1.25H3.5c-.7 0-1.25.55-1.25 1.25v6.25c0 .7.55 1.25 1.25 1.25h1.75"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
}
const svg = (name) => {
  const span = document.createElement('span')
  span.innerHTML = `<svg viewBox="0 0 16 16">${ICON[name]}</svg>`
  return span.firstChild
}
const LEVELS = ['red', 'amber', 'purple', 'blue', 'green', 'grey']
const LEVEL_NAMES = { red: 'Failure', amber: 'Warning', purple: 'No data', blue: 'Info', green: 'OK', grey: 'Off' }
const MODES = [
  ['default', 'As Settings say for each level'],
  ['off', 'Off - never'],
  ['dashboard', 'Dashboard only - counted, no notification'],
  ['silent', 'Silent notification'],
  ['toast', 'Notification with sound'],
  ['urgent', 'Stays on screen until dismissed'],
  ['alarm', 'Alarm - loops until dismissed'],
]

const state = {
  data: undefined,
  search: '',
  only: 'all',
  filters: {},
  sort: undefined,
  selected: undefined,
  details: undefined,
  /** 'now' (the last check's grid) or 'history'. */
  view: 'now',
  historyDays: 14,
  history: undefined,
  /** A past check opened from the history list: its index there. */
  historyCheck: undefined,
  /** The agent's explanation of the selected row: { row, pending } or { row, ok, text | error }. */
  explanation: undefined,
  chatCodebase: undefined,
  /** Past checks' whole grids, fetched when chosen in History: { pending } | { evaluation } | { error }, by time. */
  pastGrids: {},
  /** The schedule editor or the delete check, over the grid: { kind: 'schedule', draft } | { kind: 'delete', saving, error }. */
  sheet: undefined,
}

// ─── Appearance ─────────────────────────────────────────────────────────────

const darkQuery = matchMedia('(prefers-color-scheme: dark)')
const validHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const mix = (hex, target, amount) => {
  const t = target === 'white' ? 255 : 0
  return '#' + rgb(hex).map((c) => Math.round(c + (t - c) * amount).toString(16).padStart(2, '0')).join('')
}
let appearance = { theme: 'system', accent: '#f26b1d' }
function applyAppearance(next) {
  if (next !== undefined) appearance = { ...appearance, ...next }
  const accent = validHex(appearance.accent) ? appearance.accent : '#f26b1d'
  const dark = appearance.theme === 'dark' || (appearance.theme !== 'light' && darkQuery.matches)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  const base = dark ? mix(accent, 'white', 0.18) : accent
  const [r, g, b] = rgb(base)
  root.style.setProperty('--accent', base)
  root.style.setProperty('--accent-strong', dark ? mix(accent, 'white', 0.3) : mix(accent, 'black', 0.1))
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, ${dark ? 0.16 : 0.13})`)
}
darkQuery.addEventListener('change', () => applyAppearance())

// ─── Values ─────────────────────────────────────────────────────────────────

function cellOf(row, key) {
  if (row === undefined || row === null) return undefined
  if (key in row) return row[key]
  let at = row
  for (const part of key.split('.')) {
    if (at === null || typeof at !== 'object') return undefined
    at = at[part]
  }
  return at
}
const textOf = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
const asNumber = (v) => {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return undefined
  const n = Number(v.replace(/[, %]/g, ''))
  return v.trim() !== '' && Number.isFinite(n) ? n : undefined
}
function asDate(v) {
  if (typeof v === 'number') return new Date(v > 1e11 ? v : v * 1000)
  if (typeof v !== 'string') return undefined
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v.trim())
  if (us) return new Date(+us[3], +us[1] - 1, +us[2], +(us[4] ?? 0), +(us[5] ?? 0), +(us[6] ?? 0))
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}
function format(v, kind) {
  if (v === undefined || v === null || v === '') return ''
  switch (kind) {
    case 'number': {
      const n = asNumber(v)
      return n === undefined ? textOf(v) : n.toLocaleString()
    }
    case 'percent': {
      const n = asNumber(v)
      return n === undefined ? textOf(v) : `${(Math.abs(n) <= 1 && !String(v).includes('%') ? n * 100 : n).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    }
    case 'datetime': {
      const d = asDate(v)
      return d === undefined ? textOf(v) : d.toLocaleString()
    }
    case 'duration': {
      const n = asNumber(v)
      if (n === undefined) return textOf(v)
      const h = Math.floor(n / 3600)
      const m = Math.floor((n % 3600) / 60)
      const s = Math.round(n % 60)
      return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
    }
    case 'bytes': {
      let n = asNumber(v)
      if (n === undefined) return textOf(v)
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let u = 0
      while (n >= 1024 && u < units.length - 1) {
        n /= 1024
        u++
      }
      return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[u]}`
    }
    default:
      return textOf(v)
  }
}
function ago(seconds) {
  if (seconds === undefined || seconds === null) return 'never'
  const d = Math.round(Date.now() / 1000 - seconds)
  if (d < 0) {
    const ahead = -d
    return ahead < 60 ? 'in a moment' : ahead < 3600 ? `in ${Math.round(ahead / 60)} min` : `in ${Math.round(ahead / 3600)} h`
  }
  return d < 45 ? 'just now' : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : new Date(seconds * 1000).toLocaleString()
}
const every = (s) => (s === undefined || s === null ? '' : s % 86400 === 0 ? `${s / 86400} d` : s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`)

// ─── Rendering ──────────────────────────────────────────────────────────────

/** Every column the monitor defines. */
function allColumns() {
  const e = state.data?.record?.evaluation
  if (e?.columns?.length) return e.columns
  return (state.data?.columns ?? []).length ? state.data.columns : []
}
/** The columns shown: all but those hidden with the column chooser (never none). */
function columns() {
  const all = allColumns()
  const hidden = hiddenColumns()
  const shown = all.filter((c) => !hidden.has(c.key))
  return shown.length ? shown : all.slice(0, 1)
}

/** Alerts by row, and by row and cell - worked out once per check. */
let alertIndexFor
let alertIndexMemo
function alertIndex() {
  const alerts = state.data?.record?.evaluation?.alerts
  if (alertIndexMemo !== undefined && alertIndexFor === alerts) return alertIndexMemo
  alertIndexFor = alerts
  alertIndexMemo = buildAlertIndex()
  return alertIndexMemo
}
function buildAlertIndex() {
  const byRow = new Map()
  const byCell = new Map()
  for (const a of state.data?.record?.evaluation?.alerts ?? []) {
    if (!byRow.has(a.row)) byRow.set(a.row, [])
    byRow.get(a.row).push(a)
    if (!a.wholeRow && a.column) {
      const key = `${a.row}|${a.column}`
      if (!byCell.has(key)) byCell.set(key, [])
      byCell.get(key).push(a)
    }
  }
  return { byRow, byCell }
}
const worst = (alerts) => {
  const open = alerts.filter((a) => !a.acknowledged)
  const list = open.length ? open : alerts
  return LEVELS.find((l) => list.some((a) => a.level === l))
}

/** History's "as it was": the grid shows that check, read-only, until "Back to now". */
function showPast(at, evaluation) {
  const live = state.past ? state.past.live : state.data.record
  state.past = { at, live, record: { at, level: evaluation.level, headline: evaluation.headline, evaluation } }
  state.data = { ...state.data, record: state.past.record }
  state.selected = undefined
  $('#g-drawer').hidden = true
  switchView('now')
  render()
}
function backToNow() {
  if (!state.past) return
  state.data = { ...state.data, record: state.past.live }
  state.past = undefined
  state.selected = undefined
  render()
}

function renderHeader() {
  const d = state.data
  const m = d.monitor
  document.title = `${m.title} - Fire Code monitoring`
  $('#g-orb').className = `orb lv-${m.level}`
  $('#g-name').textContent = m.title
  $('#g-headline').textContent = m.headline
  const actions = $('#g-actions')
  const open = state.past ? [] : (d.record?.evaluation?.alerts ?? []).filter((a) => !a.acknowledged)
  /** An icon button: what it does on hover and to a screen reader, so the row fits a narrow window. */
  const icon = (name, tip, onclick, extra = {}, badge) =>
    el('button', { class: `hbtn${extra.on ? ' on' : ''}${extra.busy ? ' busy' : ''}`, title: tip, 'aria-label': tip, onclick, ...(extra.disabled ? { disabled: true } : {}) }, svg(name), badge !== undefined ? el('span', { class: 'hbtn-badge', text: String(badge) }) : null)
  put(actions,
    icon('run', !m.approved ? 'Approve it on the dashboard before it runs' : m.running ? 'Checking now…' : 'Run now - check it this moment', () => send('run'), { disabled: !m.approved || m.running, busy: m.running }),
    open.length > 0 ? icon('check', `Acknowledge ${open.length} alert${open.length === 1 ? '' : 's'} - they stop counting until they get worse`, () => send('ack', {}), {}, open.length) : null,
    icon('bell', m.snoozeUntil ? `Snoozed - ends ${ago(m.snoozeUntil)}. Click to change` : 'Snooze notifications', (e) => snoozeMenu(e.currentTarget), { on: Boolean(m.snoozeUntil) }),
    icon('clock', m.schedule ? `Schedule: runs ${m.schedule} - click to change` : 'Schedule - change when it runs', openSchedule),
    icon('changes', 'Changes - who changed this monitor, and when', openChanges),
    icon('copy', 'Copy the grid - every row the filters show, with headers (Ctrl+C copies selected cells)', copyWholeGrid),
    icon('more', 'More - pause, notifications, the skill file, delete', (e) => moreMenu(e.currentTarget)),
  )
  const meta = $('#g-meta')
  const record = d.record
  put(meta,
    el('span', { class: `pill ${m.team ? 'team' : 'mine'}`, text: m.team ? 'Team' : 'Personal' }),
    el('span', {}, 'From ', el('b', { text: m.origin })),
    m.every ? el('span', {}, 'Every ', el('b', { text: every(m.every) })) : null,
    el('span', {}, 'Checked ', el('b', { text: ago(m.lastRun) }), record?.durationMs !== undefined ? ` in ${(record.durationMs / 1000).toFixed(1)} s` : ''),
    m.waitingFor
      ? el('span', { class: 'waiting', title: m.waitingFor }, 'Waiting: ', el('b', { text: m.waitingFor }))
      : m.running
        ? null
        : m.overdueSince && m.overdueSince < Date.now() / 1000 - 90
          ? el('span', { class: 'waiting', title: 'Due and not started yet - the dashboard’s Scheduler line says whether checks are being started' }, 'Due since ', el('b', { text: when(m.overdueSince) }))
          : m.nextRun
            ? el('span', {}, 'Next ', el('b', { text: m.nextRun <= Date.now() / 1000 + 30 ? 'now' : ago(m.nextRun) }))
            : null,
    m.source ? el('span', { title: m.source }, 'Reads ', el('b', { text: m.source.length > 60 ? m.source.slice(0, 60) + '…' : m.source })) : null,
    m.author ? el('span', {}, 'By ', el('b', { text: m.author })) : null,
    m.updatedAt || m.updatedBy
      ? el('button', { class: 'meta-link', title: 'Every change, and who made it', onclick: openChanges },
          'Updated ', m.updatedAt ? el('b', { text: ago(m.updatedAt), title: when(m.updatedAt) }) : null, m.updatedBy ? [' by ', el('b', { text: m.updatedBy })] : null, m.updatedFrom ? ` (${m.updatedFrom})` : '', m.version ? ` · v${m.version}` : '')
      : null,
    m.paused ? el('span', { class: 'pill lv-grey', text: 'Paused' }) : null,
    m.mode ? el('span', { class: 'pill', text: `Notifies: ${m.mode}` }) : null,
    record?.error ? el('span', { class: 'pill lv-purple', title: record.error, text: `Last check failed - ${record.error.split('\n')[0].slice(0, 90)}` }) : null,
    record?.partial ? el('span', { class: 'pill', title: 'A team check keeps only the rows that had an alert.', text: `Checked by ${record.by ?? 'a team member'} - rows with alerts only` }) : null,
  )
  renderViews()
  const banner = $('#g-past')
  banner.hidden = !state.past
  if (state.past) put(banner, el('span', { text: `Showing the check of ${when(state.past.at)} - as it was then, read-only.` }), el('button', { class: 'btn small', onclick: backToNow }, 'Back to now'))
  put($('#g-alerts'),
    ...(d.record?.evaluation?.alerts ?? [])
      .slice()
      .sort((a, b) => Number(a.acknowledged) - Number(b.acknowledged) || LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
      .slice(0, 60)
      .map((a) =>
        el(
          'button',
          { class: `alert-chip lv-${a.level}${a.acknowledged ? ' acked' : ''}`, title: `${a.message}${a.acknowledged ? ' (acknowledged)' : ''}`, onclick: () => selectRow(a.row, true) },
          el('i', { class: 'dot' }),
          el('span', { text: a.message }),
        ),
      ),
  )
}

function renderChips(index) {
  const counts = {}
  for (const alerts of index.byRow.values()) {
    for (const l of new Set(alerts.map((a) => a.level))) counts[l] = (counts[l] ?? 0) + 1
  }
  const total = state.data?.record?.evaluation?.rows?.length ?? 0
  const alerted = [...index.byRow.values()].filter((list) => list.some((a) => !a.acknowledged)).length
  const chip = (id, label, n, level) =>
    el('button', { class: `chip${state.only === id ? ' on' : ''}${level ? ` lv-${level}` : ''}`, onclick: () => ((state.only = state.only === id && id !== 'all' ? 'all' : id), render()) }, level ? el('i', { class: 'dot' }) : null, `${label} ${n}`)
  put($('#g-chips'),
    chip('all', 'All rows', total),
    alerted > 0 ? chip('alerts', 'Open alerts', alerted) : null,
    ...LEVELS.filter((l) => counts[l]).map((l) => chip(l, LEVEL_NAMES[l], counts[l], l)),
  )
}

// ─── The grid's engine ──────────────────────────────────────────────────────
//
// Asked for: filters under every column, a value list to tick or search, conditions such as > 50, a column chooser,
// and "an efficient datagrid with good performance including lazy loading". Three things make it fast:
//   - each column's shown text, its lower case and its number are worked out once per check (`colCache`), so a
//     filter or a search compares prepared values instead of formatting every cell again on every key;
//   - typing in a filter waits 120 ms for the next key before filtering (`queueBody`);
//   - only the rows in view, and a margin either side, are in the page (`renderWindow`): spacer rows stand in for
//     the rest, at a fixed row height, with fixed column widths so a scroll never reflows the table. Before, rows
//     were appended as the bottom came near and never removed, so a long scroll built the whole table.

/** History's past-check table draws this many rows at a time as it is scrolled. */
const ROW_CHUNK = 200
const ROW_H = 29
const BUFFER = 30
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

let cache = { ev: undefined, cols: new Map(), rowText: undefined, filters: new Map() }
/** The cache of the check on screen; a new check starts a new one. */
function freshCache() {
  const ev = state.data?.record?.evaluation
  if (cache.ev !== ev) cache = { ev, cols: new Map(), rowText: undefined, filters: new Map() }
  return cache
}

/** One column's values, prepared: what the grid shows, in lower case, and as a number (a time: its ms). */
function colCache(c) {
  const k = freshCache()
  let entry = k.cols.get(c.key)
  if (entry) return entry
  const rows = k.ev?.rows ?? []
  const text = new Array(rows.length)
  const lower = new Array(rows.length)
  const num = new Array(rows.length)
  for (let i = 0; i < rows.length; i += 1) {
    const v = cellOf(rows[i], c.key)
    const t = format(v, c.format)
    text[i] = t
    lower[i] = t.toLowerCase()
    const n = asNumber(v)
    num[i] = n !== undefined ? n : c.format === 'datetime' ? asDate(v)?.getTime() : undefined
  }
  entry = { text, lower, num }
  k.cols.set(c.key, entry)
  return entry
}

/** Every row's shown text, in lower case, for the search box - across every column, shown or hidden. */
function rowTexts() {
  const k = freshCache()
  if (k.rowText) return k.rowText
  const rows = k.ev?.rows ?? []
  const caches = allColumns().map(colCache)
  k.rowText = rows.map((row, i) => {
    const parts = caches.map((cc) => cc.lower[i])
    // Fields no column names are searched too.
    for (const [key, value] of Object.entries(row ?? {})) if (!allColumns().some((c) => c.key === key)) parts.push(textOf(value).toLowerCase())
    return parts.join('\u0001')
  })
  return k.rowText
}

/**
 * A column filter, typed: text to find, or a condition.
 *   >50  >=50  <50  <=50  =x  !=x      compare (as numbers when both are; a time column compares times)
 *   10..50                             between, inclusive
 *   !text                              does not contain
 *   "exact"                            is exactly
 *   =   /   !=                         is empty / is not empty
 *   a, b                               either (OR)        >10 & <50    both (AND)
 * Case does not matter. Returns (lowerText, number) => boolean, or undefined for an empty filter.
 */
function compileFilter(expr, isTime) {
  const source = String(expr ?? '').trim()
  if (!source) return undefined
  const k = freshCache()
  const id = `${isTime ? 't' : 'n'}:${source}`
  if (k.filters.has(id)) return k.filters.get(id)
  const value = (s) => {
    const n = asNumber(s)
    if (n !== undefined) return n
    return isTime ? asDate(s)?.getTime() : undefined
  }
  const term = (raw) => {
    const s = raw.trim()
    let m
    if ((m = /^(.+?)\s*\.\.\s*(.+)$/.exec(s))) {
      const a = value(m[1])
      const b = value(m[2])
      if (a !== undefined && b !== undefined) {
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        return (_t, n) => n !== undefined && n >= lo && n <= hi
      }
    }
    if ((m = /^(>=|<=|!=|>|<|=)\s*(.*)$/.exec(s))) {
      const op = m[1]
      const rhs = m[2].trim()
      if (rhs === '') return op === '=' ? (t) => t === '' : op === '!=' ? (t) => t !== '' : () => true
      const rn = value(rhs)
      const rt = rhs.replace(/^"(.*)"$/, '$1').toLowerCase()
      return (t, n) => {
        if (rn !== undefined && n !== undefined) {
          return op === '>' ? n > rn : op === '<' ? n < rn : op === '>=' ? n >= rn : op === '<=' ? n <= rn : op === '!=' ? n !== rn : n === rn
        }
        const c = collator.compare(t, rt)
        return op === '>' ? c > 0 : op === '<' ? c < 0 : op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '!=' ? t !== rt : t === rt
      }
    }
    if (s.length > 1 && s.startsWith('!')) {
      const w = s.slice(1).trim().toLowerCase()
      return (t) => !t.includes(w)
    }
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
      const w = s.slice(1, -1).toLowerCase()
      return (t) => t === w
    }
    const w = s.toLowerCase()
    return (t) => t.includes(w)
  }
  const ors = source
    .split(',')
    .map((part) => part.split('&').map((s) => s.trim()).filter(Boolean).map(term))
    .filter((ands) => ands.length > 0)
  const fn = ors.length === 0 ? undefined : (t, n) => ors.some((ands) => ands.every((p) => p(t, n)))
  k.filters.set(id, fn)
  return fn
}

/** Which filters are in force, for the count line and the funnels. */
const filterActive = (f) => f !== undefined && ((f.text ?? '').trim() !== '' || f.values !== undefined)
const activeFilterCount = () => Object.values(state.filters).filter(filterActive).length + (state.search.trim() ? 1 : 0)

/** The rows the chips, the search and every column filter leave, sorted - optionally ignoring one column's filter. */
function filteredIndices(index, exceptKey) {
  const rows = freshCache().ev?.rows ?? []
  let idx = []
  for (let i = 0; i < rows.length; i += 1) idx.push(i)
  if (state.only === 'alerts') idx = idx.filter((i) => (index.byRow.get(i) ?? []).some((a) => !a.acknowledged))
  else if (LEVELS.includes(state.only)) idx = idx.filter((i) => (index.byRow.get(i) ?? []).some((a) => a.level === state.only))
  const needle = state.search.trim().toLowerCase()
  if (needle) {
    const texts = rowTexts()
    idx = idx.filter((i) => texts[i].includes(needle))
  }
  for (const c of allColumns()) {
    if (c.key === exceptKey) continue
    const f = state.filters[c.key]
    if (!filterActive(f)) continue
    const cc = colCache(c)
    if (f.values !== undefined) {
      const wanted = f.values
      idx = idx.filter((i) => wanted.has(cc.text[i]))
    }
    const pred = compileFilter(f.text, c.format === 'datetime')
    if (pred) idx = idx.filter((i) => pred(cc.lower[i], cc.num[i]))
  }
  return idx
}

function visibleRows(index) {
  const rows = freshCache().ev?.rows ?? []
  const idx = filteredIndices(index)
  if (state.sort) {
    const col = allColumns().find((c) => c.key === state.sort.key)
    if (col) {
      const cc = colCache(col)
      const dir = state.sort.dir === 'asc' ? 1 : -1
      idx.sort((x, y) => {
        const a = cc.num[x]
        const b = cc.num[y]
        const r = a !== undefined && b !== undefined ? a - b : collator.compare(cc.text[x], cc.text[y])
        return r * dir || x - y
      })
    }
  } else {
    // Unsorted: the alerted rows first, worst first - what somebody opening this came to see.
    const rank = (i) => {
      const l = worst(index.byRow.get(i) ?? [])
      return l === undefined ? LEVELS.length : LEVELS.indexOf(l)
    }
    idx.sort((x, y) => rank(x) - rank(y) || x - y)
  }
  return idx.map((i) => ({ row: rows[i], i }))
}

/** A column's width from its header and a sample of its values, so the table never reflows as it scrolls. */
function columnWidth(c) {
  if (c.width) return c.width
  const cc = colCache(c)
  const step = Math.max(1, Math.floor(cc.text.length / 400))
  let longest = (c.label ?? c.key).length + 3
  for (let i = 0; i < cc.text.length; i += step) longest = Math.max(longest, cc.text[i].length)
  return Math.max(84, Math.min(440, Math.round(longest * 7.4 + 26)))
}

/** One row of the table. */
function rowNode({ row, i }, d) {
  const rowAlerts = d.index.byRow.get(i) ?? []
  const whole = rowAlerts.filter((a) => a.wholeRow)
  const rowLevel = whole.length ? worst(whole) : undefined
  const tr = el('tr', {
    class: [rowLevel ? `row-alert lv-${rowLevel}` : '', whole.length && whole.every((a) => a.acknowledged) ? 'acked' : '', state.selected === i ? 'selected' : ''].filter(Boolean).join(' '),
    'data-row': i,
  })
  for (const c of d.cols) {
    const cc = colCache(c)
    const shownText = cc.text[i]
    const cellAlerts = d.index.byCell.get(`${i}|${c.key}`) ?? []
    const level = cellAlerts.length ? worst(cellAlerts) : undefined
    const numeric = ['number', 'percent', 'bytes', 'duration'].includes(c.format) || (c.format === undefined && typeof cellOf(row, c.key) === 'number')
    tr.append(
      el('td', {
        class: [numeric ? 'num' : '', level ? `cell-alert lv-${level}` : '', cellAlerts.length && cellAlerts.every((a) => a.acknowledged) ? 'acked' : ''].filter(Boolean).join(' '),
        text: shownText,
        'data-col': c.key,
        // A value wider than its column can be read whole on hover.
        ...(shownText.length > 48 ? { title: shownText } : {}),
      }),
    )
  }
  return tr
}

const spacerRow = (height, span) => el('tr', { class: 'g-spacer', 'aria-hidden': 'true' }, el('td', { colspan: String(span), style: `height:${height}px;padding:0;border:0` }))

/** Puts the rows in view (and a margin) in the page; the rest are spacers of the right height. */
function renderWindow(force) {
  const d = state.drawing
  if (!d) return
  const wrap = $('#g-table-wrap')
  const view = wrap.clientHeight || 600
  const top = Math.max(0, wrap.scrollTop - d.headH)
  const first = Math.max(0, Math.floor(top / d.rowH) - BUFFER)
  const last = Math.min(d.list.length, Math.ceil((top + view) / d.rowH) + BUFFER)
  if (!force && first === d.first && last === d.last) return
  d.first = first
  d.last = last
  const frag = document.createDocumentFragment()
  if (first > 0) frag.append(spacerRow(first * d.rowH, d.cols.length))
  for (let p = first; p < last; p += 1) frag.append(rowNode(d.list[p], d))
  if (last < d.list.length) frag.append(spacerRow((d.list.length - last) * d.rowH, d.cols.length))
  d.body.replaceChildren(frag)
  // The real row height, once: a font or zoom other than expected must not leave the spacers wrong.
  if (!d.measured) {
    d.measured = true
    const real = d.body.querySelector('tr[data-row]')?.getBoundingClientRect?.().height ?? 0
    const head = d.body.parentElement?.querySelector('thead')?.getBoundingClientRect?.().height ?? 0
    if (head > 0) d.headH = head
    if (real > 4 && Math.abs(real - d.rowH) > 0.5) {
      d.rowH = real
      renderWindow(true)
      return
    }
  }
  if (state.cellSel) paintSelection()
}

/** Scrolls row `i` into the middle of the view, drawing it - an alert chosen far down the grid. */
function scrollToRow(i) {
  const d = state.drawing
  if (!d) return
  const at = d.list.findIndex((entry) => entry.i === i)
  if (at < 0) return
  const wrap = $('#g-table-wrap')
  wrap.scrollTop = Math.max(0, d.headH + at * d.rowH - (wrap.clientHeight || 600) / 2)
  renderWindow(true)
}

/** The rows again after a filter, the search or a sort changed - the header (and a filter being typed in) stays. */
function renderBody() {
  const table = $('#g-table')
  const index = alertIndex()
  const cols = columns()
  const list = visibleRows(index)
  const total = freshCache().ev?.rows?.length ?? 0
  const count = $('#g-count')
  const filters = activeFilterCount()
  put(count,
    el('span', { text: list.length === total ? `${total} row${total === 1 ? '' : 's'}` : `${list.length} of ${total} rows` }),
    filters > 0 ? el('button', { class: 'link-btn', title: 'Clear every column filter and the search', onclick: clearFilters }, `Clear ${filters} filter${filters === 1 ? '' : 's'}`) : null,
  )
  let body = table.querySelector('tbody')
  if (!body) {
    body = el('tbody')
    table.append(body)
  }
  const old = state.drawing
  state.drawing = { list, index, cols, body, first: -1, last: -1, rowH: old?.rowH ?? ROW_H, headH: old?.headH ?? 62, measured: old?.measured ?? false }
  renderWindow(true)
  for (const th of table.querySelectorAll('th[data-col]')) {
    const f = state.filters[th.dataset.col]
    th.classList.toggle('filtered', filterActive(f))
  }
  renderEmpty(total, list.length)
}

let bodyTimer
/** Typing in a filter: the rows follow once the typing pauses, not on every key. */
function queueBody() {
  clearTimeout(bodyTimer)
  bodyTimer = setTimeout(renderBody, 120)
}

function clearFilters() {
  state.filters = {}
  state.search = ''
  $('#g-search').value = ''
  renderTable()
}

function renderTable() {
  const index = alertIndex()
  renderChips(index)
  const cols = columns()
  const table = $('#g-table')
  const focused = document.activeElement?.dataset?.filter
  const colgroup = el('colgroup', {}, ...cols.map((c) => el('col', { style: `width:${columnWidth(c)}px` })))
  const head = el(
    'thead',
    {},
    el(
      'tr',
      {},
      ...cols.map((c) => {
        const sorted = state.sort?.key === c.key ? (state.sort.dir === 'asc' ? '▲' : '▼') : ''
        const f = state.filters[c.key]
        const input = el('input', {
          type: 'text',
          placeholder: 'Filter',
          value: f?.text ?? '',
          'data-filter': c.key,
          spellcheck: 'false',
          title: 'Text to find, or a condition: >50  >=50  <50  10..50  =x  !=x  !text  "exact"  = (empty)  != (not empty).  a, b for either; >10 & <50 for both.',
        })
        input.addEventListener('input', () => {
          state.filters[c.key] = { ...(state.filters[c.key] ?? {}), text: input.value }
          queueBody()
        })
        return el(
          'th',
          { 'data-col': c.key, class: filterActive(f) ? 'filtered' : '' },
          el('div', { class: 'h' },
            el('span', { class: 'h-label', onclick: () => sortBy(c.key), title: 'Sort by this column (again for descending, a third time to stop)' }, c.label ?? c.key, el('span', { class: 'sort', text: sorted })),
            el('button', { class: 'funnel', title: 'Filter by value: tick the values to show, search them, or write a condition', 'aria-label': `Filter ${c.label ?? c.key}`, onclick: (e) => (e.stopPropagation(), valuesPopup(c, e.currentTarget)) }, svg('funnel')),
          ),
          input,
        )
      }),
    ),
  )
  put(table, colgroup, head, el('tbody'))
  table.style.width = `${cols.reduce((sum, c) => sum + columnWidth(c), 0)}px`
  renderBody()
  if (focused !== undefined) {
    const again = table.querySelector(`input[data-filter="${CSS.escape(focused)}"]`)
    if (again) {
      again.focus()
      again.setSelectionRange(again.value.length, again.value.length)
    }
  }
}

function renderEmpty(total, shownCount) {
  const empty = $('#g-empty')
  if (!state.data.monitor.approved) {
    empty.hidden = false
    put(empty,
      el('h2', { text: 'This monitor has not been approved on this computer' }),
      el('p', { class: 'muted', text: 'It runs unattended once approved. This is exactly what it will run:' }),
      el('pre', { class: 'raw', style: 'text-align:left; max-width: 760px; margin: 12px auto', text: state.data.monitor.block ?? '' }),
      el('button', { class: 'btn primary', onclick: () => send('approve') }, svg('check'), 'Approve and run'),
    )
  } else if (total === 0) {
    empty.hidden = false
    put(empty, el('p', { text: state.data.record ? 'The last check returned no rows.' : 'Waiting for the first check…' }))
  } else if (shownCount === 0) {
    empty.hidden = false
    put(empty, el('p', {}, 'No rows match the filters. ', el('button', { class: 'link-btn', onclick: clearFilters }, 'Clear them')))
  } else empty.hidden = true
}

function sortBy(key) {
  state.sort = state.sort?.key !== key ? { key, dir: 'asc' } : state.sort.dir === 'asc' ? { key, dir: 'desc' } : undefined
  renderTable()
}

// ─── Popups: a column's values, and the column chooser ─────────────────────

let popup
function closePopup() {
  popup?.remove()
  popup = undefined
}
document.addEventListener('mousedown', (e) => {
  if (popup && !popup.contains(e.target) && !e.target.closest?.('.funnel, .cols-btn')) closePopup()
})

function placePopup(node, anchor) {
  closePopup()
  popup = node
  document.body.append(node)
  const r = anchor.getBoundingClientRect()
  const w = node.offsetWidth || 300
  node.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`
  node.style.top = `${Math.min(r.bottom + 4, Math.max(8, innerHeight - (node.offsetHeight || 360) - 8))}px`
}

/**
 * A column's values, Excel's way: each distinct value with how many rows have it (among the rows the other filters
 * leave), a search box over them, ticks, and the column's condition. Ticking applies at once.
 */
function valuesPopup(c, anchor) {
  const cc = colCache(c)
  const others = filteredIndices(alertIndex(), c.key)
  const counts = new Map()
  for (const i of others) counts.set(cc.text[i], (counts.get(cc.text[i]) ?? 0) + 1)
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))
  const f = () => state.filters[c.key] ?? {}
  const isOn = (v) => f().values === undefined || f().values.has(v)
  const setValues = (values) => {
    state.filters[c.key] = { ...f(), values }
    renderBody()
  }
  const search = el('input', { type: 'search', placeholder: `Search ${all.length} value${all.length === 1 ? '' : 's'}`, spellcheck: 'false', class: 'pop-search' })
  const condition = el('input', { type: 'text', placeholder: 'Condition: >50, 10..50, !text', value: f().text ?? '', spellcheck: 'false', class: 'pop-search' })
  condition.addEventListener('input', () => {
    state.filters[c.key] = { ...f(), text: condition.value }
    const inline = $(`#g-table input[data-filter="${CSS.escape(c.key)}"]`)
    if (inline) inline.value = condition.value
    queueBody()
  })
  const list = el('div', { class: 'pop-list', role: 'listbox' })
  const LIMIT = 500
  const matching = () => {
    const q = search.value.trim().toLowerCase()
    return q ? all.filter(([v]) => (v || '(empty)').toLowerCase().includes(q)) : all
  }
  const draw = () => {
    const shown = matching()
    put(list,
      ...shown.slice(0, LIMIT).map(([v, n]) => {
        const box = el('input', { type: 'checkbox', checked: isOn(v) })
        box.addEventListener('change', () => {
          const values = new Set(f().values ?? all.map(([x]) => x))
          if (box.checked) values.add(v)
          else values.delete(v)
          setValues(values.size === all.length ? undefined : values)
        })
        return el('label', { class: 'pop-item' }, box, el('span', { class: v ? '' : 'muted', text: v || '(empty)' }), el('span', { class: 'pop-count', text: String(n) }))
      }),
      shown.length > LIMIT ? el('p', { class: 'muted pop-more', text: `${shown.length - LIMIT} more - type to narrow them down.` }) : null,
      shown.length === 0 ? el('p', { class: 'muted pop-more', text: 'No value matches.' }) : null,
    )
  }
  search.addEventListener('input', draw)
  draw()
  const node = el('div', { class: 'pop', role: 'dialog', 'aria-label': `Filter ${c.label ?? c.key}` },
    el('div', { class: 'pop-head' }, el('b', { text: c.label ?? c.key }), el('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closePopup }, svg('close'))),
    condition,
    search,
    el('div', { class: 'pop-actions' },
      el('button', { class: 'link-btn', onclick: () => (setValues(undefined), draw()) }, 'Select all'),
      el('button', { class: 'link-btn', onclick: () => (setValues(new Set()), draw()) }, 'Clear'),
      el('button', { class: 'link-btn', title: 'Show only the values the search found', onclick: () => (setValues(new Set(matching().map(([v]) => v))), draw()) }, 'Only these'),
      el('button', { class: 'link-btn', title: "Remove this column's filter", onclick: () => { delete state.filters[c.key]; closePopup(); renderTable() } }, 'Reset'),
    ),
    list,
  )
  placePopup(node, anchor)
  search.focus()
}

/** Which columns are shown, remembered per monitor on this computer. */
const hiddenKey = () => `fire-code.grid.hidden.${state.data?.monitor?.name ?? ''}`
function hiddenColumns() {
  if (state.hiddenFor !== hiddenKey()) {
    state.hiddenFor = hiddenKey()
    try {
      state.hidden = new Set(JSON.parse(localStorage.getItem(hiddenKey()) ?? '[]'))
    } catch {
      state.hidden = new Set()
    }
  }
  return state.hidden
}
function saveHidden() {
  try {
    localStorage.setItem(hiddenKey(), JSON.stringify([...hiddenColumns()]))
  } catch {
    // Storage refused: the choice lasts while the window is open.
  }
}

function columnsPopup(anchor) {
  const all = allColumns()
  const hidden = hiddenColumns()
  const search = el('input', { type: 'search', placeholder: `Search ${all.length} columns`, spellcheck: 'false', class: 'pop-search' })
  const list = el('div', { class: 'pop-list' })
  const summary = el('span', { class: 'muted' })
  const changed = () => {
    saveHidden()
    renderTable()
    draw()
  }
  const draw = () => {
    const q = search.value.trim().toLowerCase()
    summary.textContent = `${all.length - [...hidden].filter((k) => all.some((c) => c.key === k)).length} of ${all.length} shown`
    put(list,
      ...all
        .filter((c) => !q || (c.label ?? c.key).toLowerCase().includes(q) || c.key.toLowerCase().includes(q))
        .map((c) => {
          const box = el('input', { type: 'checkbox', checked: !hidden.has(c.key) })
          box.addEventListener('change', () => {
            if (box.checked) hidden.delete(c.key)
            else if (all.filter((x) => !hidden.has(x.key)).length > 1) hidden.add(c.key)
            else box.checked = true
            changed()
          })
          return el('label', { class: 'pop-item' }, box, el('span', { text: c.label ?? c.key }), c.label && c.label !== c.key ? el('span', { class: 'pop-count', text: c.key }) : null)
        }),
    )
  }
  search.addEventListener('input', draw)
  draw()
  const node = el('div', { class: 'pop', role: 'dialog', 'aria-label': 'Columns' },
    el('div', { class: 'pop-head' }, el('b', { text: 'Columns' }), summary, el('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closePopup }, svg('close'))),
    search,
    el('div', { class: 'pop-actions' },
      el('button', { class: 'link-btn', onclick: () => (hidden.clear(), changed()) }, 'Show all'),
      el('button', { class: 'link-btn', title: 'Only the columns with an alert in them, and the first', onclick: () => {
        const alerted = new Set((state.data?.record?.evaluation?.alerts ?? []).map((a) => a.column).filter(Boolean))
        hidden.clear()
        all.forEach((c, n) => { if (n > 0 && !alerted.has(c.key)) hidden.add(c.key) })
        changed()
      } }, 'Only alerted'),
    ),
    list,
  )
  placePopup(node, anchor)
  search.focus()
}

function render() {
  if (state.data === undefined) return
  if (state.data.missing) {
    $('#g-name').textContent = 'This monitor is gone'
    $('#g-headline').textContent = 'Its skill file was removed or renamed.'
    return
  }
  renderHeader()
  renderTable()
  if (state.selected !== undefined) renderDrawer()
}

// ─── Details ────────────────────────────────────────────────────────────────

function selectRow(i, scroll) {
  state.selected = i
  state.details = undefined
  const alerted = (alertIndex().byRow.get(i) ?? []).length > 0
  state.explanation = alerted && !state.past ? { row: i, pending: true } : undefined
  renderTable()
  renderDrawer()
  if (state.past) return
  // The agent explains an alerted row - the author's advice, the row and the alert's history.
  if (alerted) send('explain', { row: i })
  if (state.data.hasDetails) send('details', { row: i })
  if (scroll) scrollToRow(i)
}

function renderDrawer() {
  const drawer = $('#g-drawer')
  const i = state.selected
  const row = state.data?.record?.evaluation?.rows?.[i]
  if (i === undefined || row === undefined) {
    drawer.hidden = true
    return
  }
  drawer.hidden = false
  const index = alertIndex()
  const alerts = index.byRow.get(i) ?? []
  const keyColumn = columns()[0]?.key
  const title = textOf(cellOf(row, keyColumn)) || `Row ${i + 1}`
  const cellLevel = (key) => worst(alerts.filter((a) => a.column === key || a.wholeRow))
  const kv = el('dl', { class: 'kv' })
  for (const [key, value] of Object.entries(row)) {
    const level = alerts.some((a) => a.column === key) ? cellLevel(key) : undefined
    kv.append(el('dt', { text: key }), el('dd', { class: level ? `lv-cell lv-${level}` : '', text: typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : textOf(value) }))
  }
  const breakdown = []
  if (state.data.hasDetails) {
    breakdown.push(el('h3', { text: 'Breakdown' }))
    const d = state.details
    if (d === undefined || d.row !== i || d.pending) breakdown.push(el('p', { class: 'muted', text: 'Reading the breakdown…' }))
    else if (!d.ok) breakdown.push(el('p', { class: 'muted', text: d.error }))
    else if (!d.rows?.length) breakdown.push(el('p', { class: 'muted', text: 'Nothing more to show.' }))
    else {
      const cols = (d.columns ?? []).map((c) => c.key)
      breakdown.push(
        el(
          'div',
          { class: 'mini-wrap' },
          el(
            'table',
            { class: 'mini' },
            el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { text: c })))),
            el('tbody', {}, ...d.rows.slice(0, 500).map((r) => el('tr', {}, ...cols.map((c) => el('td', { text: textOf(cellOf(r, c)) }))))),
          ),
        ),
      )
    }
  }
  // The author's own words for the rules that fired here, and for the monitor as a whole.
  const advice = []
  for (const a of alerts) {
    const rule = (state.data.rules ?? [])[Number(a.id.split('|')[0])]
    if (rule?.advice && !advice.some((x) => x.text === rule.advice)) advice.push({ level: a.level, text: rule.advice })
  }
  const explanation = state.explanation?.row === i ? state.explanation : undefined
  const codebases = state.data.codebases ?? []
  const chosen = state.chatCodebase ?? codebases[0]?.id
  put(drawer,
    el('header', {}, el('h2', { text: title }), el('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeDrawer }, svg('close'))),
    alerts.length ? el('h3', {}, 'Alerts', state.past ? null : el('button', { class: 'btn small h3-action', onclick: (e) => rowSnoozeMenu(e.currentTarget, i) }, svg('bell'), 'Snooze row')) : null,
    ...alerts.map((a) =>
      el(
        'div',
        { class: `drawer-alert lv-${a.level}` },
        el('i', { class: 'dot' }),
        el('span', { text: `${a.message}${a.acknowledged ? (state.data.acks?.[a.id]?.until ? ` - snoozed until ${when(state.data.acks[a.id].until)}` : ' - acknowledged') : ''}` }),
        state.past
          ? null
          : a.acknowledged
            ? el('button', { class: 'btn', onclick: () => send('unack', { ids: [a.id] }) }, 'Undo')
            : el('button', { class: 'btn', onclick: () => send('ack', { ids: [a.id] }) }, svg('check'), 'Acknowledge'),
      ),
    ),
    advice.length > 0 || state.data.runbook ? el('h3', { text: 'What the author says' }) : null,
    ...advice.map((x) => el('div', { class: `advice lv-${x.level}` }, ...markdown(x.text))),
    state.data.runbook ? el('div', { class: 'advice' }, ...markdown(state.data.runbook)) : null,
    alerts.length ? el('h3', {}, 'Explained', el('span', { class: 'by-agent', text: 'by the agent' })) : null,
    alerts.length
      ? explanation === undefined || explanation.pending
        ? el('p', { class: 'muted thinking', text: 'Looking at the alert, the author\u2019s advice and its history…' })
        : explanation.ok
          ? el('div', { class: 'explanation' }, ...markdown(explanation.text ?? ''))
          : el('p', { class: 'muted', text: `No explanation: ${explanation.error ?? 'it failed'}.` })
      : null,
    alerts.length && codebases.length > 0
      ? el(
          'div',
          { class: 'start-chat' },
          el('span', { class: 'muted', text: 'Talk it through with the agent in' }),
          el('div', { class: 'choice' }, ...codebases.map((c) => el('button', { class: c.id === chosen ? 'on' : '', onclick: () => ((state.chatCodebase = c.id), renderDrawer()) }, c.name))),
          el('button', { class: 'btn primary', onclick: () => send('startChat', { row: i, codebase: chosen }) }, 'Start a chat'),
        )
      : null,
    el('h3', { text: 'Fields' }),
    kv,
    ...breakdown,
  )
}

/** A little Markdown, as DOM (never HTML): paragraphs, - and 1. lists, **bold**, `code`. Model text is shown here. */
function markdown(text) {
  const inline = (line) => {
    const out = []
    const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
    let last = 0
    let m
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) out.push(line.slice(last, m.index))
      out.push(m[1] !== undefined ? el('b', { text: m[1] }) : el('code', { text: m[2] }))
      last = m.index + m[0].length
    }
    if (last < line.length) out.push(line.slice(last))
    return out
  }
  const blocks = []
  let list
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd()
    const item = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      if (!list) {
        list = el(/^\s*\d/.test(line) ? 'ol' : 'ul')
        blocks.push(list)
      }
      list.append(el('li', {}, ...inline(item[1])))
      continue
    }
    list = undefined
    if (line.trim() === '') continue
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    blocks.push(heading ? el('p', {}, el('b', { text: heading[1] })) : el('p', {}, ...inline(line)))
  }
  return blocks
}

// ─── History ────────────────────────────────────────────────────────────────

function renderViews() {
  const views = $('#g-views')
  const view = (id, label) => el('button', { class: state.view === id ? 'on' : '', onclick: () => switchView(id) }, label)
  put(
    views,
    view('now', 'Now'),
    view('history', 'History'),
    state.view === 'history'
      ? el(
          'span',
          { class: 'days' },
          ...[1, 7, 14, 30, 90].map((d) => el('button', { class: !state.historyDate && state.historyDays === d ? 'on' : '', onclick: () => ((state.historyDays = d), (state.historyDate = undefined), askHistory()) }, d === 1 ? '24 h' : `${d} d`)),
          el('label', { class: `on-day${state.historyDate ? ' on' : ''}`, title: 'Every check on one day' }, 'On ', el('input', {
            type: 'date',
            value: state.historyDate ?? '',
            max: dayString(new Date()),
            'aria-label': 'Checks on this day',
            onchange: (e) => ((state.historyDate = e.target.value || undefined), askHistory()),
          })),
        )
      : null,
  )
}

function switchView(id) {
  state.view = id
  if (state.wantCheckAt === undefined) state.historyCheck = undefined
  $('#g-table-wrap').hidden = id !== 'now'
  $('#g-history').hidden = id !== 'history'
  $('#g-chips').hidden = id !== 'now'
  $('.g-search').hidden = id !== 'now'
  if (id === 'history') {
    closeDrawer()
    askHistory()
  }
  renderViews()
}

function askHistory() {
  state.history = { pending: true }
  renderHistory()
  renderViews()
  if (state.historyDate) {
    // That day in this computer's time: from its midnight to the next.
    const [y, m, d] = state.historyDate.split('-').map(Number)
    const from = Math.floor(new Date(y, m - 1, d).getTime() / 1000)
    const until = Math.floor(new Date(y, m - 1, d + 1).getTime() / 1000)
    send('history', { days: Math.max(1, Math.ceil((Date.now() / 1000 - from) / 86_400)), from, until })
  } else send('history', { days: state.historyDays })
}

/** "2026-10-27" for a date box, in local time. */
const dayString = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const when = (s) => new Date(s * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const VERDICT = { new: 'New', ongoing: 'Ongoing', recurring: 'Recurring', intermittent: 'Comes and goes', cleared: 'Cleared' }

function renderHistory() {
  const box = $('#g-history')
  const h = state.history
  if (h === undefined) return put(box)
  if (h.pending) return put(box, el('p', { class: 'muted pad', text: 'Reading the history…' }))
  if (h.ok === false) return put(box, el('p', { class: 'muted pad', text: `The history could not be read: ${h.error}` }))
  const checks = h.checks ?? []
  if (state.wantCheckAt !== undefined) {
    // The nearest check to the bar that was clicked (the tile shows the same checks).
    let best
    checks.forEach((c, i) => {
      if (best === undefined || Math.abs(c.at - state.wantCheckAt) < Math.abs(checks[best].at - state.wantCheckAt)) best = i
    })
    state.historyCheck = best
    state.wantCheckAt = undefined
  }
  const period = h.from ? `on ${new Date(h.from * 1000).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}` : `in the last ${h.days === 1 ? '24 hours' : `${h.days} days`}`
  if (checks.length === 0) return put(box, el('p', { class: 'muted pad', text: `No checks ${period}.` }))
  // Oldest on the left: each check a bar in its colour, its height how many alerts it had.
  const ordered = [...checks].reverse()
  const most = Math.max(1, ...ordered.map((c) => c.alerts ?? 0))
  const strip = el(
    'div',
    { class: 'timeline', role: 'list', 'aria-label': 'Checks, oldest first' },
    ...ordered.map((c, n) => {
      const at = checks.length - 1 - n
      return el('button', {
        class: `tick lv-${c.level}${state.historyCheck === at ? ' on' : ''}`,
        style: `height: ${Math.round(18 + ((c.alerts ?? 0) / most) * 42)}px`,
        title: `${when(c.at)} - ${c.headline}${c.by ? ` (by ${c.by})` : ''}`,
        onclick: () => pickCheck(at),
      })
    }),
  )
  const patterns = (h.patterns ?? [])
    .slice()
    .sort((a, b) => Number(b.active) - Number(a.active) || b.occurrences - a.occurrences)
  const picked = state.historyCheck === undefined ? undefined : checks[state.historyCheck]
  put(
    box,
    el('div', { class: 'hist-head' }, el('b', { text: `${h.total ?? checks.length} checks` }), el('span', { class: 'muted', text: ` ${period} - click a bar or a time to see that check` })),
    strip,
    // The chosen check right under the bars, where the click was - it used to sit below the patterns, out of sight.
    picked ? checkView(picked) : null,
    patterns.length
      ? el(
          'div',
          { class: 'patterns' },
          el('h3', { text: 'Alerts in this period' }),
          ...patterns.slice(0, 50).map((p) =>
            el(
              'div',
              { class: `pattern lv-${p.level}` },
              el('i', { class: 'dot' }),
              el('span', { class: `verdict v-${p.verdict}`, text: VERDICT[p.verdict] ?? p.verdict }),
              el('span', { class: 'p-key', text: p.key }),
              el('span', { class: 'p-summary', text: p.summary }),
            ),
          ),
        )
      : el('p', { class: 'muted pad', text: 'No alerts in this period.' }),
    el('div', { class: 'checks' }, el('h3', { text: 'Checks, newest first' }), ...checks.slice(0, 200).map((c, at) => el('button', { class: `check-row lv-${c.level}${state.historyCheck === at ? ' on' : ''}`, onclick: () => pickCheck(at) }, el('i', { class: 'dot' }), el('span', { class: 'c-when', text: when(c.at) }), el('span', { class: 'c-head', text: c.headline }), c.by ? el('span', { class: 'muted', text: c.by }) : null))),
  )
}

/**
 * One check chosen in History: shown under the bars with its whole grid, fetched at once - clicking a check is
 * asking to see it (reported: a button to press first was one step too many).
 */
function pickCheck(at) {
  state.historyCheck = at
  const c = state.history?.checks?.[at]
  if (c && c.grid && state.pastGrids[c.at] === undefined) {
    state.pastGrids[c.at] = { pending: true }
    send('pastGrid', { at: c.at, hash: c.grid, by: c.by ?? '' })
  }
  renderHistory()
  $('#g-history .past-check')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
}

/** A past check's whole grid, as a table in History: every row, coloured where an alert fired. */
function pastTable(e) {
  const cols = (e.columns ?? []).map((c) => c.key).slice(0, 20)
  const byRow = new Map()
  for (const a of e.alerts ?? []) {
    if (!byRow.has(a.row)) byRow.set(a.row, [])
    byRow.get(a.row).push(a)
  }
  const worst = (alerts) => LEVELS.find((l) => alerts.some((a) => a.level === l))
  const rows = e.rows ?? []
  const rowEl = (row, i) => {
    const alerts = byRow.get(i) ?? []
    const whole = alerts.find((a) => a.wholeRow || !a.column)
    return el(
      'tr',
      { class: whole ? `lv-${whole.level} row-alert` : '', title: alerts.map((a) => a.message).join(' / ') || null },
      ...cols.map((k) => {
        const hit = alerts.filter((a) => a.column === k)
        return el('td', { class: hit.length ? `hl lv-${worst(hit)}` : '', text: textOf(cellOf(row, k)) })
      }),
    )
  }
  // Drawn as it is scrolled to, like the grid: every row is here, the next ones drawn as the bottom comes near.
  const body = el('tbody')
  let next = 0
  const more = () => {
    const until = Math.min(rows.length, next + ROW_CHUNK)
    for (; next < until; next += 1) body.append(rowEl(rows[next], next))
  }
  more()
  const wrap = el('div', { class: 'mini-wrap past-grid' }, el('table', { class: 'mini' }, el('thead', {}, el('tr', {}, ...cols.map((k) => el('th', { text: k })))), body))
  wrap.addEventListener('scroll', () => {
    if (wrap.scrollTop + wrap.clientHeight > wrap.scrollHeight - 300) more()
  })
  return wrap
}

function checkView(c) {
  const past = state.pastGrids[c.at]
  const found = c.found ?? []
  const cols = [...new Set(found.flatMap((a) => Object.keys(a.row ?? {})))].slice(0, 12)
  const facts = [
    LEVEL_NAMES[c.level] ?? c.level,
    c.by ? `checked by ${c.by}` : null,
    typeof c.rowCount === 'number' ? `${c.rowCount} row${c.rowCount === 1 ? '' : 's'} read` : null,
    typeof c.durationMs === 'number' && c.durationMs > 0 ? `took ${(c.durationMs / 1000).toFixed(1)} s` : null,
    `${c.alerts ?? 0} alert${c.alerts === 1 ? '' : 's'}`,
  ].filter(Boolean)
  return el(
    'div',
    { class: `past-check lv-${c.level}` },
    el('h3', {}, el('i', { class: 'dot' }), ` ${new Date(c.at * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}`),
    el('p', { class: 'facts', text: facts.join(' · ') }),
    el('p', { text: c.error ? `The check failed: ${c.error}` : c.headline }),
    gridPart(c),
    el('div', { class: 'past-actions' },
      past && past.evaluation
        ? el('button', { class: 'btn', title: 'With filters, sorting and each row\'s details', onclick: () => showPast(c.at, past.evaluation) }, 'Open in grid view')
        : null,
      state.confirmDelete === c.at
        ? el('span', { class: 'confirm' },
            el('span', { text: 'Delete this check from the history?' }),
            el('button', { class: 'btn primary danger', onclick: () => ((state.confirmDelete = undefined), send('deleteCheck', { at: c.at })) }, 'Delete'),
            el('button', { class: 'btn', onclick: () => ((state.confirmDelete = undefined), renderHistory()) }, 'Cancel'))
        : el('button', { class: 'btn', title: 'Remove this one check - here, and your own record of it in the team history', onclick: () => ((state.confirmDelete = c.at), renderHistory()) }, 'Delete this check'),
    ),
    // No whole grid: the alerted rows, which every check keeps.
    !(past && past.evaluation) && found.length
      ? el(
          'div',
          { class: 'mini-wrap' },
          el(
            'table',
            { class: 'mini' },
            el('thead', {}, el('tr', {}, el('th', { text: 'Alert' }), ...cols.map((k) => el('th', { text: k })))),
            el('tbody', {}, ...found.map((a) => el('tr', { class: `lv-${a.level}` }, el('td', {}, el('i', { class: 'dot' }), ' ', a.message), ...cols.map((k) => el('td', { class: a.column === k ? 'hl' : '', text: textOf(cellOf(a.row, k)) }))))),
          ),
        )
      : null,
  )

  /** The check's whole grid, or plainly why there is none here. */
  function gridPart(check) {
    if (check.error) return null
    if (past?.pending) return el('p', { class: 'muted', text: 'Loading the grid as it was…' })
    if (past?.evaluation) return pastTable(past.evaluation)
    const why = past?.error
      ? past.error
      : check.grid
        ? null
        : check.by
          ? `This check ran on ${check.by}'s computer, which keeps its whole grid; here are the rows it alerted on.`
          : 'This check was recorded before Fire Code 0.64.0, which keeps each check\'s whole grid; here are the rows it alerted on.'
    const quiet = found.length === 0 && check.alerts === 0 && check.level !== 'red' && check.level !== 'amber'
    return why ? el('p', { class: 'muted', text: quiet ? `${why.replace(/; here are the rows it alerted on\.$/, '.')} Nothing was alerting.` : why }) : null
  }
}

function closeDrawer() {
  state.selected = undefined
  state.details = undefined
  $('#g-drawer').hidden = true
  renderTable()
}

// ─── Menus ──────────────────────────────────────────────────────────────────

let menu
function closeMenu() {
  menu?.remove()
  menu = undefined
}
function showMenu(anchor, items) {
  closeMenu()
  const r = anchor.getBoundingClientRect()
  menu = el('div', { class: 'menu' }, ...items.map((item) => (item === '-' ? el('hr') : el('button', { onclick: () => (closeMenu(), item[1]()) }, item[0]))))
  document.body.append(menu)
  const w = menu.offsetWidth
  menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`
  menu.style.top = `${r.bottom + 4}px`
}
function snoozeMenu(anchor) {
  const m = state.data.monitor
  showMenu(anchor, [
    ['Snooze 1 hour', () => send('snooze', { minutes: 60 })],
    ['Snooze 4 hours', () => send('snooze', { minutes: 240 })],
    ['Snooze until tomorrow (24 h)', () => send('snooze', { minutes: 1440 })],
    ['Snooze until…', () => openUntil(`Snooze "${m.title}" until`, 'No notifications from this monitor, and it does not colour the dashboard, until then.', (until) => send('snooze', { until }))],
    ...(m.snoozeUntil ? ['-', ['End the snooze', () => send('snooze', { minutes: 0 })]] : []),
  ])
}

/** A row's alerts, snoozed together: quiet until then - unless one gets worse, which counts again at once. */
function rowSnoozeMenu(anchor, row) {
  const items = rowSnoozeItems(row)
  if (items.length === 0) return notice('This row has no alerts to snooze.')
  showMenu(anchor, items)
}

function rowSnoozeItems(row) {
  const ids = (alertIndex().byRow.get(row) ?? []).map((a) => a.id)
  if (ids.length === 0) return []
  const at = (minutes) => () => send('ack', { ids, minutes, note: 'snoozed' })
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  return [
    ['Snooze this row 1 hour', at(60)],
    ['Snooze this row 4 hours', at(240)],
    ['Snooze this row until tomorrow 09:00', () => send('ack', { ids, until: Math.floor(tomorrow.getTime() / 1000), note: 'snoozed' })],
    ['Snooze this row until…', () => openUntil('Snooze this row until', 'Its alerts stop counting until then - unless one gets worse, which counts again at once.', (until) => send('ack', { ids, until, note: 'snoozed' }))],
    '-',
    ['Acknowledge this row', () => send('ack', { ids })],
    ['Undo acknowledge / snooze', () => send('unack', { ids })],
  ]
}

// ─── Copying ────────────────────────────────────────────────────────────────
//
// Asked for: "data should be selectable and copyable from the datagrid, a cell or the full grid". Click a cell to
// select it, Shift+click another to select the block between, Ctrl+C to copy; right-click for a cell, its row, its
// column or the whole grid; the header's copy button takes the whole grid. The whole grid is every row the filters
// and sort leave, drawn or not, with the headers. Copied as tab-separated text (Excel pastes it into cells) and as
// an HTML table (Word, Outlook, OneNote), in the text the grid shows.

/** Rows in the order shown, and the columns: what positions in a selection refer to. */
const shown = () => ({ list: state.drawing?.list ?? [], cols: state.drawing?.cols ?? [] })

/** The selected block as list positions and column indexes, or undefined. */
function selectionBox() {
  const s = state.cellSel
  if (!s) return undefined
  const { list, cols } = shown()
  const pos = (i) => list.findIndex((entry) => entry.i === i)
  const col = (key) => cols.findIndex((c) => c.key === key)
  const a = { r: pos(s.anchor.row), c: col(s.anchor.col) }
  const b = { r: pos(s.focus.row), c: col(s.focus.col) }
  if (a.r < 0 || b.r < 0 || a.c < 0 || b.c < 0) return undefined
  return { r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) }
}

/** Marks the selected cells among those drawn. */
function paintSelection() {
  for (const td of document.querySelectorAll('#g-table td.cell-on, #g-table td.cell-range')) td.classList.remove('cell-on', 'cell-range')
  const box = selectionBox()
  if (!box) return
  const { list, cols } = shown()
  for (let r = box.r0; r <= box.r1; r += 1) {
    const tr = document.querySelector(`#g-table tr[data-row="${list[r].i}"]`)
    if (!tr) continue
    for (let c = box.c0; c <= box.c1; c += 1) {
      const td = tr.querySelector(`td[data-col="${CSS.escape(cols[c].key)}"]`)
      td?.classList.add(box.r0 === box.r1 && box.c0 === box.c1 ? 'cell-on' : 'cell-range')
    }
  }
}

/** A block of the grid as text and as a table. `withHeads`: the column names first. */
function gridText(r0, r1, c0, c1, withHeads) {
  const { list, cols } = shown()
  const use = cols.slice(c0, c1 + 1)
  const rows = list.slice(r0, r1 + 1).map(({ row }) => use.map((c) => format(cellOf(row, c.key), c.format)))
  const heads = use.map((c) => c.label ?? c.key)
  const tsvCell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ')
  const text = [...(withHeads ? [heads] : []), ...rows].map((line) => line.map(tsvCell).join('\t')).join('\r\n')
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const cell = (tag, v) => `<${tag} style="border:1px solid #bbb;padding:2px 6px;text-align:left">${esc(v)}</${tag}>`
  const html =
    '<table style="border-collapse:collapse">' +
    (withHeads ? `<tr>${heads.map((h) => cell('th', h)).join('')}</tr>` : '') +
    rows.map((line) => `<tr>${line.map((v) => cell('td', v)).join('')}</tr>`).join('') +
    '</table>'
  return { text, html, cells: rows.length * use.length, rows: rows.length }
}

let pendingCopy
/** Puts text and a table on the clipboard, from a click or a key - WebView2 allows copying in a user's gesture. */
function copyOut(payload, said) {
  pendingCopy = payload
  let done
  try {
    done = document.execCommand('copy')
  } catch {
    done = false
  }
  pendingCopy = undefined
  if (!done && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(payload.text).then(() => notice(said), () => notice('Could not copy - the clipboard refused.'))
    return
  }
  notice(done ? said : 'Could not copy - the clipboard refused.')
}
document.addEventListener('copy', (e) => {
  let payload = pendingCopy
  // Ctrl+C with cells selected and no text selected by hand: the cells.
  if (!payload && state.cellSel && String(window.getSelection?.() ?? '').length === 0 && !e.target.closest?.('input, textarea')) {
    const box = selectionBox()
    if (box) {
      payload = gridText(box.r0, box.r1, box.c0, box.c1, false)
      setTimeout(() => notice(payload.cells === 1 ? 'Copied the cell.' : `Copied ${payload.cells} cells.`))
    }
  }
  if (!payload) return
  e.preventDefault()
  e.clipboardData?.setData('text/plain', payload.text)
  e.clipboardData?.setData('text/html', payload.html)
})

function copyWholeGrid() {
  const { list, cols } = shown()
  if (list.length === 0 || cols.length === 0) return notice('There are no rows to copy.')
  const out = gridText(0, list.length - 1, 0, cols.length - 1, true)
  copyOut(out, `Copied ${out.rows} row${out.rows === 1 ? '' : 's'} with their headers${list.length < (state.data?.record?.evaluation?.rows?.length ?? 0) ? ' - the rows the filters show' : ''}.`)
}

/** The copy items for a right-click on a cell. */
function copyItems(i, key) {
  const { list, cols } = shown()
  const r = list.findIndex((entry) => entry.i === i)
  const c = cols.findIndex((col) => col.key === key)
  if (r < 0) return []
  const box = selectionBox()
  return [
    ...(c >= 0 ? [['Copy cell', () => copyOut(gridText(r, r, c, c, false), 'Copied the cell.')]] : []),
    ...(box && (box.r0 !== box.r1 || box.c0 !== box.c1) ? [['Copy selected cells', () => { const out = gridText(box.r0, box.r1, box.c0, box.c1, false); copyOut(out, `Copied ${out.cells} cells.`) }]] : []),
    ['Copy row', () => copyOut(gridText(r, r, 0, cols.length - 1, true), 'Copied the row with its headers.')],
    ...(c >= 0 ? [['Copy column', () => { const out = gridText(0, list.length - 1, c, c, true); copyOut(out, `Copied the column - ${out.rows} rows.`) }]] : []),
    ['Copy whole grid', copyWholeGrid],
  ]
}


/** "Until…": a date and a time, tomorrow 09:00 to start from, at most 30 days ahead (Rust checks it too). */
function openUntil(title, about, pick) {
  closeMenu()
  const start = new Date()
  start.setDate(start.getDate() + 1)
  start.setHours(9, 0, 0, 0)
  const pad = (n) => String(n).padStart(2, '0')
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  const latest = new Date(Date.now() + 30 * 86_400_000)
  state.sheet = { kind: 'until', title, about, pick, value: local(start), min: local(new Date()), max: local(latest), saving: false, error: undefined }
  renderSheet()
}

function untilBody(s) {
  const set = () => {
    const chosen = new Date(s.value)
    if (Number.isNaN(chosen.getTime())) s.error = 'Choose a date and a time.'
    else if (chosen.getTime() <= Date.now()) s.error = 'That time has already passed.'
    else if (chosen.getTime() > Date.now() + 30 * 86_400_000) s.error = 'At most 30 days ahead - to stop it for longer, pause it.'
    else {
      s.pick(Math.floor(chosen.getTime() / 1000))
      return closeSheet()
    }
    renderSheet()
  }
  return [
    el('h2', { text: s.title }),
    el('p', { class: 'sheet-sub', text: s.about }),
    el('section', { class: 'sheet-sec' },
      el('div', { class: 'sheet-row' },
        el('input', { type: 'datetime-local', class: 'sheet-time sheet-when', value: s.value, min: s.min, max: s.max, 'aria-label': 'Until', oninput: (e) => (s.value = e.target.value) }),
      ),
    ),
    s.error ? el('p', { class: 'sheet-error', role: 'alert', text: s.error }) : null,
    el('footer', { class: 'sheet-foot' },
      el('button', { class: 'btn', onclick: closeSheet }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: set }, 'Snooze'),
    ),
  ]
}
function moreMenu(anchor) {
  const m = state.data.monitor
  showMenu(anchor, [
    [m.paused ? 'Resume checks' : 'Pause checks', () => send(m.paused ? 'resume' : 'pause')],
    '-',
    ...MODES.map(([mode, label]) => [`${(m.mode ?? 'default') === mode ? '● ' : ''}${label}`, () => send('notify', { mode })]),
    '-',
    ['Edit schedule…', openSchedule],
    ['Show the skill file', () => send('openFile')],
    '-',
    ['Delete this monitor…', openDelete],
  ])
}
document.addEventListener('mousedown', (e) => {
  if (menu && !menu.contains(e.target)) closeMenu()
})

// ─── Schedule and delete ───────────────────────────────────────────────────
//
// A person's own edit, written into the monitor's skill file by Rust (`setSchedule`), which changes only the
// schedule fields and refuses one that cannot run. A monitor that was approved stays approved: the values
// are the ones on screen. A copy from the team's bucket or repository is changed there, by the host (`teamCopy`).

const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']]
/** "7:30" → "07:30", which a time box needs. */
const clock = (t) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim())
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : ''
}

/** The editor's working copy, from what the block says now. */
function scheduleDraft(m) {
  const spec = m.scheduleSpec ?? {}
  const secs = m.every ?? 0
  const hours = secs > 0 && secs % 3600 === 0
  const at = spec.at === undefined || spec.at === null ? [] : [spec.at].flat().map(clock).filter(Boolean)
  const [from = '', to = ''] = typeof spec.activeHours === 'string' ? spec.activeHours.split('-').map(clock) : []
  const days = Array.isArray(spec.days) ? spec.days.map((d) => String(d).slice(0, 3).toLowerCase()) : DAYS.map(([d]) => d)
  return {
    useEvery: secs > 0,
    amount: secs > 0 ? (hours ? secs / 3600 : Math.max(1, Math.round(secs / 60))) : 15,
    unit: hours ? 'h' : 'm',
    from,
    to,
    useAt: at.length > 0,
    at: at.length > 0 ? at : ['07:30'],
    days: new Set(days),
  }
}

/** What is sent: null removes a field from the block. Every day is no "days" at all. */
function scheduleOut(d) {
  const times = d.at.filter(Boolean)
  return {
    every: d.useEvery ? `${d.amount}${d.unit}` : null,
    activeHours: d.useEvery && (d.from || d.to) ? `${d.from}-${d.to}` : null,
    at: d.useAt ? (times.length === 1 ? times[0] : times) : null,
    days: d.days.size === 7 ? null : DAYS.map(([k]) => k).filter((k) => d.days.has(k)),
  }
}

/** What the dashboard asked the window to open with: the schedule, the delete check, or History at a check. */
function openAsked(asked) {
  if (asked.kind === 'schedule') openSchedule()
  else if (asked.kind === 'delete') openDelete()
  else if (asked.kind === 'history') openHistoryAt(asked.at)
}

/** A bar on the dashboard tile: History, far enough back to hold that check, with it chosen. */
function openHistoryAt(at) {
  state.historyDate = undefined
  if (typeof at === 'number') {
    const days = Math.ceil((Date.now() / 1000 - at) / 86_400) + 1
    state.historyDays = [1, 7, 14, 30, 90].find((d) => d >= days) ?? 90
    state.wantCheckAt = at
  }
  if (state.view !== 'history') switchView('history')
  else askHistory()
}

function openSchedule() {
  if (!state.data || state.data.missing) return
  closeMenu()
  state.sheet = { kind: 'schedule', draft: scheduleDraft(state.data.monitor), saving: false, error: undefined }
  renderSheet()
}
function openDelete() {
  if (!state.data || state.data.missing) return
  closeMenu()
  state.sheet = { kind: 'delete', saving: false, error: undefined }
  renderSheet()
}
function openChanges() {
  if (!state.data || state.data.missing) return
  closeMenu()
  state.sheet = { kind: 'changes', local: undefined, team: undefined, teamPending: false, teamError: undefined, history: undefined, historyPending: false }
  send('revisions')
  renderSheet()
}
function closeSheet() {
  state.sheet = undefined
  renderSheet()
}

/**
 * The answer to the sheet's own save or delete closes it (`sheetDone`) - not any fresh grid, which arrives
 * whenever the monitor checks; one Rust opened the window with opens it.
 */
function sheetAnswered(message) {
  if (state.sheet?.saving && message.sheetDone === state.sheet.kind) {
    const kind = state.sheet.kind
    state.sheet = undefined
    renderSheet()
    if (message.doneText) notice(message.doneText)
    else if (kind === 'delete') notice('Deleted. Its file, results and history here are gone.')
    else notice(message.monitor?.approved ? `Saved - it runs ${message.monitor.schedule ?? 'on the new schedule'}.` : 'Saved. Approve it on the dashboard before it runs.')
  }
  if (message.sheet) setTimeout(() => openAsked(typeof message.sheet === 'string' ? { kind: message.sheet } : message.sheet))
}

function saveSchedule() {
  const s = state.sheet
  const d = s.draft
  const times = d.at.filter(Boolean)
  s.error = !d.useEvery && !d.useAt
    ? 'Choose an interval, times of day, or both.'
    : d.useEvery && !(Number.isFinite(d.amount) && d.amount >= 1)
      ? 'The interval is at least 1 minute.'
      : d.useAt && times.length === 0
        ? 'Add a time, or untick "At set times".'
        : d.days.size === 0
          ? 'Choose at least one day.'
          : undefined
  if (s.error) return renderSheet()
  s.saving = true
  renderSheet()
  send('setSchedule', { schedule: scheduleOut(d) })
}

function renderSheet() {
  const node = $('#g-sheet')
  const s = state.sheet
  if (!s || !state.data || state.data.missing) {
    node.hidden = true
    put(node)
    return
  }
  node.hidden = false
  const m = state.data.monitor
  const body = s.kind === 'schedule' ? scheduleBody(m, s) : s.kind === 'until' ? untilBody(s) : s.kind === 'changes' ? changesBody(m, s) : deleteBody(m, s)
  const label = { schedule: 'Schedule', until: 'Snooze until', changes: 'Changes', delete: 'Delete' }[s.kind] ?? 'Delete'
  put(node, el('div', { class: `sheet-card${s.kind === 'changes' ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, ...body))
  node.querySelector('input:not([disabled]), button.primary:not([disabled])')?.focus()
}

/**
 * Every change to the monitor, newest first (asked: "audit of when and who updated the check"): those this computer
 * saw arrive, and for a team monitor the team's record - the same change seen by several members is one row.
 */
function mergedRevisions(s) {
  const seen = new Map()
  for (const r of [...(s.team ?? []), ...(s.local ?? [])]) {
    const key = `${r.version ?? ''}:${r.hash}:${r.change.startsWith('First seen') ? '' : r.at}`
    // The team's row wins: it names whoever saw it first, with the saver's own label.
    if (!seen.has(key)) seen.set(key, r)
  }
  // "First seen" rows of the same version from several members say nothing new: one is enough.
  const rows = [...seen.values()].sort((a, b) => b.at - a.at)
  return rows.filter((r, i) => !(r.change.startsWith('First seen') && rows.some((o, j) => j !== i && o.hash === r.hash && o.version === r.version && !o.change.startsWith('First seen'))))
}

/**
 * The file's commits, from where it is kept (asked: "if the Bitbucket repo is where the skill or tool lives, take
 * it from git"): the team repository, else the git checkout holding it. Who and when are the commit's.
 */
function commitsSection(s) {
  const h = s.history
  if (s.historyPending && !h) return el('p', { class: 'muted', text: 'Reading its history in the repository\u2026' })
  if (!h || !Array.isArray(h.commits) || h.commits.length === 0) return null
  const from = h.source === 'bitbucket' ? 'the team repository (Bitbucket)' : 'git'
  return el('section', { class: 'sheet-sec' },
    el('h3', { text: `Commits in ${from}` }),
    el('p', { class: 'sheet-hint', text: `${h.where}${h.uncommitted ? ' \u00b7 changed here since the newest commit' : ''}` }),
    el('ol', { class: 'changes' },
      ...h.commits.slice(0, 50).map((c) =>
        el('li', {},
          el('div', { class: 'change-head' }, el('b', { text: when(c.at) }), el('span', { text: ` \u00b7 ${c.by}`, title: c.email ?? '' }), el('span', { class: 'pill', text: c.id })),
          c.message ? el('div', { class: 'change-what', text: c.message }) : null,
        ),
      ),
    ),
  )
}

function changesBody(m, s) {
  const rows = s.local === undefined ? undefined : mergedRevisions(s)
  return [
    el('div', { class: 'sheet-head' }, el('h2', { text: 'Changes' }), el('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeSheet }, svg('close'))),
    el('p', { class: 'sheet-sub' },
      m.author ? ['Written by ', el('b', { text: m.author })] : 'No author on the skill',
      m.updatedAt ? [' · last saved ', el('b', { text: when(m.updatedAt) })] : null,
      m.updatedBy ? [' by ', el('b', { text: m.updatedBy })] : null,
      m.updatedFrom ? ` (from ${m.updatedFrom})` : null,
      m.version ? ` · version ${m.version}` : null,
    ),
    commitsSection(s),
    rows === undefined
      ? el('p', { class: 'muted', text: 'Reading…' })
      : rows.length === 0
        ? el('p', { class: 'muted', text: 'No changes recorded yet.' })
        : el('ol', { class: 'changes' },
            ...rows.map((r) =>
              el('li', {},
                el('div', { class: 'change-head' },
                  el('b', { text: when(r.at) }),
                  el('span', { text: r.by ? ` · ${r.by}` : ' · who saved it is not recorded' }),
                  r.version ? el('span', { class: 'pill', text: `v${r.version}` }) : null,
                ),
                el('div', { class: 'change-what', text: r.change }),
                r.block ? el('details', {}, el('summary', { text: 'The monitor as it was' }), el('pre', { class: 'change-block', text: r.block })) : null,
              ),
            ),
          ),
    s.teamPending ? el('p', { class: 'muted', text: 'Reading the team\u2019s record…' }) : null,
    s.teamError ? el('p', { class: 'sheet-note', text: `The team\u2019s record could not be read - showing what this computer saw. ${s.teamError}` }) : null,
    el('p', { class: 'sheet-hint', text: m.team ? 'Recorded by every member\u2019s Fire Code as a version arrives, and kept in the team\u2019s history. Who saved it comes from the skill\u2019s own labels.' : 'Recorded on this computer as each version arrives. Who saved it comes from the skill\u2019s own labels.' }),
  ]
}

function scheduleBody(m, s) {
  const d = s.draft
  const locked = s.saving
  const check = (on, label, set) =>
    el('label', { class: 'sheet-check' }, el('input', { type: 'checkbox', checked: on, disabled: locked, onchange: (e) => (set(e.target.checked), renderSheet()) }), label)
  const time = (value, set, label) => el('input', { type: 'time', class: 'sheet-time', value, disabled: locked, 'aria-label': label, oninput: (e) => set(e.target.value) })
  const seg = (value, current, label, set) => el('button', { class: `seg${value === current ? ' on' : ''}`, disabled: locked || !d.useEvery, onclick: () => (set(value), renderSheet()) }, label)
  return [
    el('h2', { text: 'When this check runs' }),
    el('p', { class: 'sheet-sub' }, 'Now: ', el('b', { text: m.schedule ?? 'not set' })),
    m.teamCopy ? el('p', { class: 'sheet-note', text: `A copy from ${m.teamCopy}: saving changes it there, for the whole team - colleagues get it at their next sync and approve it once.` }) : null,
    el('section', { class: 'sheet-sec' },
      el('div', { class: 'sheet-row' },
        check(d.useEvery, 'Every', (v) => (d.useEvery = v)),
        el('input', { type: 'number', min: '1', step: '1', class: 'sheet-num', value: String(d.amount), disabled: locked || !d.useEvery, 'aria-label': 'How often', oninput: (e) => (d.amount = Number(e.target.value)) }),
        el('span', { class: 'segs' }, seg('m', d.unit, 'minutes', (v) => (d.unit = v)), seg('h', d.unit, 'hours', (v) => (d.unit = v))),
      ),
      d.useEvery
        ? el('div', { class: 'sheet-row sheet-indent' },
            el('span', { text: 'Only between' }),
            time(d.from, (v) => (d.from = v), 'From'),
            el('span', { text: 'and' }),
            time(d.to, (v) => (d.to = v), 'Until'),
            el('span', { class: 'sheet-hint', text: 'Both empty: all day. One empty: from, or until.' }),
          )
        : null,
    ),
    el('section', { class: 'sheet-sec' },
      el('div', { class: 'sheet-row' }, check(d.useAt, 'At set times of day', (v) => (d.useAt = v))),
      d.useAt
        ? el('div', { class: 'sheet-row sheet-indent sheet-times' },
            ...d.at.map((t, i) =>
              el('span', { class: 'sheet-timechip' },
                time(t, (v) => (d.at[i] = v), `Time ${i + 1}`),
                d.at.length > 1 ? el('button', { class: 'icon', title: 'Remove this time', 'aria-label': 'Remove this time', disabled: locked, onclick: () => (d.at.splice(i, 1), renderSheet()) }, svg('close')) : null,
              ),
            ),
            d.at.length < 48 ? el('button', { class: 'btn small', disabled: locked, onclick: () => (d.at.push(''), renderSheet()) }, '+ Add a time') : null,
          )
        : null,
      el('p', { class: 'sheet-hint', text: 'Set times run on their days whatever the hours above say. A time missed while Fire Code was closed is not run late.' }),
    ),
    el('section', { class: 'sheet-sec' },
      el('div', { class: 'sheet-row' },
        el('span', { text: 'On' }),
        ...DAYS.map(([key, label]) =>
          el('button', { class: `seg day${d.days.has(key) ? ' on' : ''}`, disabled: locked, 'aria-pressed': d.days.has(key) ? 'true' : 'false', onclick: () => (d.days.has(key) ? d.days.delete(key) : d.days.add(key), renderSheet()) }, label),
        ),
      ),
    ),
    s.error ? el('p', { class: 'sheet-error', role: 'alert', text: s.error }) : null,
    s.saving && s.progress ? el('p', { class: 'sheet-hint', role: 'status', text: s.progress }) : null,
    m.team && !m.teamCopy ? el('p', { class: 'sheet-hint', text: 'A team monitor: the change goes wherever this skill file is shared, and each colleague approves the new version once.' }) : null,
    el('footer', { class: 'sheet-foot' },
      el('button', { class: 'btn', onclick: closeSheet }, 'Cancel'),
      el('button', { class: 'btn primary', disabled: locked, title: s.saving ? 'Saving…' : m.teamCopy ? `Save it to ${m.teamCopy}` : 'Write the new schedule into the skill file', onclick: saveSchedule }, s.saving ? 'Saving…' : 'Save'),
    ),
  ]
}

function deleteBody(m, s) {
  return [
    el('h2', { text: `Delete "${m.title}" for good?` }),
    el('p', { text: 'This removes:' }),
    el('ul', { class: 'sheet-list' },
      m.teamCopy
        ? el('li', { text: `the monitor from ${m.teamCopy}, for everyone - colleagues lose it at their next sync` })
        : el('li', {}, 'its skill file ', el('code', { text: m.file })),
      el('li', { text: 'its results and history on this computer' }),
      m.team ? el('li', { text: 'your own checks in the team history - colleagues’ checks are theirs and stay' }) : null,
    ),
    m.team && !m.teamCopy ? el('p', { class: 'sheet-hint', text: 'If the file is shared through a codebase in git, colleagues keep it until the deletion is committed.' }) : null,
    s.saving && s.progress ? el('p', { class: 'sheet-hint', role: 'status', text: s.progress }) : null,
    el('p', { class: 'sheet-hint', text: 'To stop it for a while instead, use Pause checks.' }),
    s.error ? el('p', { class: 'sheet-error', role: 'alert', text: s.error }) : null,
    el('footer', { class: 'sheet-foot' },
      el('button', { class: 'btn', onclick: closeSheet }, 'Cancel'),
      el('button', {
        class: 'btn primary danger',
        disabled: s.saving,
        title: s.saving ? 'Deleting…' : 'Delete the monitor and its history',
        onclick: () => ((s.saving = true), renderSheet(), send('delete')),
      }, s.saving ? 'Deleting…' : 'Delete for good'),
    ),
  ]
}

$('#g-sheet').addEventListener('mousedown', (e) => {
  if (e.target === e.currentTarget && !state.sheet?.saving) closeSheet()
})

// ─── Events ─────────────────────────────────────────────────────────────────

$('#g-search').addEventListener('input', (e) => {
  state.search = e.target.value
  renderTable()
})
$('#g-table').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr[data-row]')
  if (tr) selectRow(Number(tr.dataset.row), false)
})
// The rows in view follow the scroll (`renderWindow`); a frame at a time, however fast the wheel turns.
let scrollFrame
$('#g-table-wrap').addEventListener('scroll', () => {
  if (scrollFrame !== undefined) return
  const next = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0)
  scrollFrame = next(() => {
    scrollFrame = undefined
    renderWindow(false)
  })
})
// The column chooser sits in the toolbar, after the search box.
$('.g-search').after(el('button', { class: 'btn small cols-btn', title: 'Choose the columns shown - remembered for this monitor', onclick: (e) => columnsPopup(e.currentTarget) }, svg('columns'), 'Columns'))
$('#g-table').addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('tr[data-row]')
  if (!tr) return
  e.preventDefault()
  const i = Number(tr.dataset.row)
  const key = e.target.closest('td')?.dataset.col
  const snooze = state.past ? [] : rowSnoozeItems(i)
  showMenu({ getBoundingClientRect: () => ({ right: e.clientX + 200, bottom: e.clientY }) }, [...copyItems(i, key), ...(snooze.length ? ['-', ...snooze] : [])])
})
$('#g-table').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-row]')
  const td = e.target.closest('td[data-col]')
  if (tr && td) {
    const here = { row: Number(tr.dataset.row), col: td.dataset.col }
    // Shift+click: the block from the first cell chosen to this one.
    state.cellSel = e.shiftKey && state.cellSel ? { anchor: state.cellSel.anchor, focus: here } : { anchor: here, focus: here }
    if (e.shiftKey) window.getSelection?.()?.removeAllRanges()
    paintSelection()
  }
  if (tr && state.selected !== undefined) selectRow(Number(tr.dataset.row), false)
})

// The alerts behind a coloured cell or row, on hover.
const tip = $('#g-tip')
$('#g-table').addEventListener('mousemove', (e) => {
  const td = e.target.closest('td')
  const tr = e.target.closest('tr[data-row]')
  if (!td || !tr) return (tip.hidden = true)
  const i = Number(tr.dataset.row)
  const alerts = (alertIndex().byRow.get(i) ?? []).filter((a) => a.wholeRow || a.column === td.dataset.col)
  if (!alerts.length) return (tip.hidden = true)
  put(tip, ...alerts.map((a) => el('div', { class: `line lv-${a.level}` }, el('i', { class: 'dot' }), el('span', { text: `${a.message}${a.acknowledged ? ' (acknowledged)' : ''}` }))))
  tip.hidden = false
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8)
  const y = e.clientY + 18 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 18
  tip.style.left = `${x}px`
  tip.style.top = `${y}px`
})
$('#g-table').addEventListener('mouseleave', () => (tip.hidden = true))

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (popup) closePopup()
    else if (menu) closeMenu()
    else if (state.sheet) {
      if (!state.sheet.saving) closeSheet()
    } else if (state.selected !== undefined) closeDrawer()
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    $('#g-search').focus()
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
    e.preventDefault()
    send('close')
  } else if (e.key === 'F5') {
    e.preventDefault()
    send('run')
  }
})

let noticeTimer
function notice(text) {
  const n = $('#g-notice')
  n.textContent = text
  n.hidden = false
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (n.hidden = true), 6000)
}

window.__sun = {
  receive(message) {
    switch (message.type) {
      case 'grid':
        if (message.appearance) applyAppearance(message.appearance)
        // While a past check is on screen, a fresh check is kept aside for "Back to now".
        if (state.past && !message.missing) {
          state.past.live = message.record
          state.data = { ...message, record: state.past.record }
        } else state.data = message
        sheetAnswered(message)
        // A row chosen before a new check may now be a different row; the breakdown is asked again.
        if (state.selected !== undefined && state.selected >= (message.record?.evaluation?.rows?.length ?? 0)) state.selected = undefined
        render()
        break
      case 'appearance':
        applyAppearance(message)
        break
      case 'revisions':
        if (state.sheet?.kind === 'changes') {
          if (message.revisions) state.sheet.local = message.revisions
          if (message.team) state.sheet.team = message.team
          if (message.teamError) state.sheet.teamError = message.teamError
          if ('history' in message) {
            state.sheet.history = message.history ?? undefined
            state.sheet.historyPending = Boolean(message.historyPending)
          }
          state.sheet.teamPending = Boolean(message.teamPending)
          renderSheet()
        }
        break
      case 'fileHistory':
        if (state.sheet?.kind === 'changes') {
          state.sheet.history = message.history ?? undefined
          state.sheet.historyPending = false
          renderSheet()
        }
        break
      case 'pastGrid':
        state.pastGrids[message.at] = message.ok ? { evaluation: message.evaluation } : { error: message.error }
        renderHistory()
        break
      case 'checkDeleted':
        notice('That check was deleted.')
        state.historyCheck = undefined
        askHistory()
        break
      case 'explanation':
        if (message.pending) state.explanation = { row: message.row, pending: true }
        else state.explanation = message
        if (state.selected === message.row) renderDrawer()
        break
      case 'history':
        state.history = message
        renderHistory()
        break
      case 'chatStarted':
        notice(`The chat is open in ${message.codebase} - Fire Code's window is in front.`)
        break
      case 'details':
        if (message.pending) state.details = { row: message.row, pending: true }
        else state.details = message
        if (state.selected === message.row) renderDrawer()
        break
      case 'notice':
        if (state.sheet?.saving) {
          // The refusal belongs on the sheet the user is looking at, not in a passing notice.
          state.sheet.saving = false
          state.sheet.error = message.text
          renderSheet()
        } else notice(message.text)
        break
      case 'sheetPending':
        // A team copy: the host is writing it where the team keeps it.
        if (state.sheet?.saving) {
          state.sheet.progress = message.text
          renderSheet()
        }
        break
      case 'sheet':
        openAsked(message)
        break
    }
  },
}

// Relative times stay true while the window is open.
setInterval(() => state.data && !state.data.missing && renderHeader(), 30_000)
applyAppearance()
send('ready')
