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

function columns() {
  const e = state.data?.record?.evaluation
  if (e?.columns?.length) return e.columns
  return (state.data?.columns ?? []).length ? state.data.columns : []
}

/** Alerts by row, and by row and cell. */
function alertIndex() {
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

function visibleRows(index) {
  const rows = state.data?.record?.evaluation?.rows ?? []
  const cols = columns()
  const needle = state.search.trim().toLowerCase()
  let list = rows.map((row, i) => ({ row, i }))
  if (state.only === 'alerts') list = list.filter(({ i }) => (index.byRow.get(i) ?? []).some((a) => !a.acknowledged))
  else if (LEVELS.includes(state.only)) list = list.filter(({ i }) => (index.byRow.get(i) ?? []).some((a) => a.level === state.only))
  if (needle) list = list.filter(({ row }) => Object.values(row).some((v) => textOf(v).toLowerCase().includes(needle)))
  for (const [key, wanted] of Object.entries(state.filters)) {
    const w = wanted.trim().toLowerCase()
    if (!w) continue
    // `>10`, `<5`, `=x` compare; anything else is "contains".
    const cmp = /^(>=|<=|>|<|=|!=)\s*(.+)$/.exec(w)
    list = list.filter(({ row }) => {
      const v = cellOf(row, key)
      if (cmp) {
        const [, op, rhs] = cmp
        const a = asNumber(v)
        const b = asNumber(rhs)
        if (a !== undefined && b !== undefined) {
          return op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : op === '<=' ? a <= b : op === '!=' ? a !== b : a === b
        }
        const t = textOf(v).toLowerCase()
        return op === '!=' ? t !== rhs : op === '=' ? t === rhs : true
      }
      return textOf(v).toLowerCase().includes(w)
    })
  }
  if (state.sort) {
    const { key, dir } = state.sort
    const kind = cols.find((c) => c.key === key)?.format
    list.sort((x, y) => {
      const a = cellOf(x.row, key)
      const b = cellOf(y.row, key)
      const na = asNumber(a)
      const nb = asNumber(b)
      let r
      if (na !== undefined && nb !== undefined) r = na - nb
      else if (kind === 'datetime' && asDate(a) && asDate(b)) r = asDate(a) - asDate(b)
      else r = textOf(a).localeCompare(textOf(b), undefined, { numeric: true })
      return dir === 'asc' ? r : -r
    })
  } else {
    // Unsorted: the alerted rows first, worst first - what somebody opening this came to see.
    const rank = (i) => {
      const l = worst(index.byRow.get(i) ?? [])
      return l === undefined ? LEVELS.length : LEVELS.indexOf(l)
    }
    list.sort((x, y) => rank(x.i) - rank(y.i) || x.i - y.i)
  }
  return list
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
    icon('more', 'More - pause, notifications, the skill file, delete', (e) => moreMenu(e.currentTarget)),
  )
  const meta = $('#g-meta')
  const record = d.record
  put(meta,
    el('span', { class: `pill ${m.team ? 'team' : 'mine'}`, text: m.team ? 'Team' : 'Personal' }),
    el('span', {}, 'From ', el('b', { text: m.origin })),
    m.every ? el('span', {}, 'Every ', el('b', { text: every(m.every) })) : null,
    el('span', {}, 'Checked ', el('b', { text: ago(m.lastRun) }), record?.durationMs !== undefined ? ` in ${(record.durationMs / 1000).toFixed(1)} s` : ''),
    m.waitingFor ? el('span', { class: 'waiting', title: m.waitingFor }, 'Waiting: ', el('b', { text: m.waitingFor })) : m.nextRun ? el('span', {}, 'Next ', el('b', { text: ago(m.nextRun) })) : null,
    m.source ? el('span', { title: m.source }, 'Reads ', el('b', { text: m.source.length > 60 ? m.source.slice(0, 60) + '…' : m.source })) : null,
    m.author ? el('span', {}, 'By ', el('b', { text: m.author })) : null,
    m.updatedAt || m.updatedBy
      ? el('button', { class: 'meta-link', title: 'Every change, and who made it', onclick: openChanges },
          'Updated ', m.updatedAt ? el('b', { text: ago(m.updatedAt), title: when(m.updatedAt) }) : null, m.updatedBy ? [' by ', el('b', { text: m.updatedBy })] : null, m.version ? ` · v${m.version}` : '')
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

const ROW_CHUNK = 200

/** Draws the next `count` rows of the table being shown; called again as the bottom is scrolled near. */
function drawMoreRows(count) {
  const d = state.drawing
  if (!d) return
  const until = Math.min(d.list.length, d.next + count)
  for (; d.next < until; d.next += 1) {
    const { row, i } = d.list[d.next]
    const index = d.index
    const cols = d.cols
    const rowAlerts = index.byRow.get(i) ?? []
    const whole = rowAlerts.filter((a) => a.wholeRow)
    const rowLevel = whole.length ? worst(whole) : undefined
    const tr = el('tr', {
      class: [rowLevel ? `row-alert lv-${rowLevel}` : '', whole.length && whole.every((a) => a.acknowledged) ? 'acked' : '', state.selected === i ? 'selected' : ''].filter(Boolean).join(' '),
      'data-row': i,
    })
    for (const c of cols) {
      const v = cellOf(row, c.key)
      const cellAlerts = index.byCell.get(`${i}|${c.key}`) ?? []
      const level = cellAlerts.length ? worst(cellAlerts) : undefined
      const numeric = ['number', 'percent', 'bytes', 'duration'].includes(c.format) || (c.format === undefined && typeof v === 'number')
      tr.append(
        el('td', {
          class: [numeric ? 'num' : '', level ? `cell-alert lv-${level}` : '', cellAlerts.length && cellAlerts.every((a) => a.acknowledged) ? 'acked' : ''].filter(Boolean).join(' '),
          text: format(v, c.format),
          'data-col': c.key,
        }),
      )
    }
    d.body.append(tr)
  }
}

/** Draws rows until row `i` is in the table, so jumping to an alert far down finds it drawn. */
function drawUntilRow(i) {
  const d = state.drawing
  if (!d) return
  const at = d.list.findIndex((entry) => entry.i === i)
  if (at >= d.next) drawMoreRows(at - d.next + ROW_CHUNK)
}

function renderTable() {
  const index = alertIndex()
  renderChips(index)
  const cols = columns()
  const list = visibleRows(index)
  const total = state.data?.record?.evaluation?.rows?.length ?? 0
  $('#g-count').textContent = list.length === total ? `${total} row${total === 1 ? '' : 's'}` : `${list.length} of ${total} rows`
  const table = $('#g-table')
  const focused = document.activeElement?.dataset?.filter
  const head = el(
    'thead',
    {},
    el(
      'tr',
      {},
      ...cols.map((c) => {
        const sorted = state.sort?.key === c.key ? (state.sort.dir === 'asc' ? '▲' : '▼') : ''
        const input = el('input', { type: 'text', placeholder: 'Filter', value: state.filters[c.key] ?? '', 'data-filter': c.key, spellcheck: 'false', title: 'Text to find, or >10, <5, =value, !=value' })
        input.addEventListener('input', () => {
          state.filters[c.key] = input.value
          renderTable()
        })
        return el(
          'th',
          { style: c.width ? `min-width: ${c.width}px` : '' },
          el('div', { class: 'h', onclick: () => sortBy(c.key) }, c.label ?? c.key, el('span', { class: 'sort', text: sorted })),
          input,
        )
      }),
    ),
  )
  const body = el('tbody')
  // Drawn as it is scrolled to (asked for): the first rows now, the next as the bottom comes near - filters, sort
  // and counts still cover every row, since all of them are here; only drawing is staged. It used to draw at most
  // 3000 rows and never the rest.
  state.drawing = { list, index, cols, body, next: 0 }
  drawMoreRows(ROW_CHUNK)
  put(table, head, body)
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
  } else if (list.length === 0) {
    empty.hidden = false
    put(empty, el('p', { text: 'No rows match the filters.' }))
  } else empty.hidden = true
  if (focused !== undefined) {
    const again = table.querySelector(`input[data-filter="${CSS.escape(focused)}"]`)
    if (again) {
      again.focus()
      again.setSelectionRange(again.value.length, again.value.length)
    }
  }
}

function sortBy(key) {
  state.sort = state.sort?.key !== key ? { key, dir: 'asc' } : state.sort.dir === 'asc' ? { key, dir: 'desc' } : undefined
  renderTable()
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
  if (scroll) {
    drawUntilRow(i)
    document.querySelector(`tr[data-row="${i}"]`)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }
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
  const ids = (alertIndex().byRow.get(row) ?? []).map((a) => a.id)
  if (ids.length === 0) return notice('This row has no alerts to snooze.')
  const at = (minutes) => () => send('ack', { ids, minutes, note: 'snoozed' })
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  showMenu(anchor, [
    ['Snooze this row 1 hour', at(60)],
    ['Snooze this row 4 hours', at(240)],
    ['Snooze this row until tomorrow 09:00', () => send('ack', { ids, until: Math.floor(tomorrow.getTime() / 1000), note: 'snoozed' })],
    ['Snooze this row until…', () => openUntil('Snooze this row until', 'Its alerts stop counting until then - unless one gets worse, which counts again at once.', (until) => send('ack', { ids, until, note: 'snoozed' }))],
    '-',
    ['Acknowledge this row', () => send('ack', { ids })],
    ['Undo acknowledge / snooze', () => send('unack', { ids })],
  ])
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
  state.sheet = { kind: 'changes', local: undefined, team: undefined, teamPending: false, teamError: undefined }
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

function changesBody(m, s) {
  const rows = s.local === undefined ? undefined : mergedRevisions(s)
  return [
    el('div', { class: 'sheet-head' }, el('h2', { text: 'Changes' }), el('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeSheet }, svg('close'))),
    el('p', { class: 'sheet-sub' },
      m.author ? ['Written by ', el('b', { text: m.author })] : 'No author on the skill',
      m.updatedAt ? [' · last saved ', el('b', { text: when(m.updatedAt) })] : null,
      m.updatedBy ? [' by ', el('b', { text: m.updatedBy })] : null,
      m.version ? ` · version ${m.version}` : null,
    ),
    rows === undefined
      ? el('p', { class: 'muted', text: 'Reading…' })
      : rows.length === 0
        ? el('p', { class: 'muted', text: 'No changes recorded yet.' })
        : el('ol', { class: 'changes' },
            ...rows.map((r) =>
              el('li', {},
                el('div', { class: 'change-head' },
                  el('b', { text: when(r.at) }),
                  el('span', { text: r.by ? ` · ${r.by}` : ' · someone unnamed' }),
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
// More rows as the bottom of the table comes near.
$('#g-table-wrap').addEventListener('scroll', (e) => {
  const wrap = e.currentTarget
  if (wrap.scrollTop + wrap.clientHeight > wrap.scrollHeight - 400) drawMoreRows(ROW_CHUNK)
})
$('#g-table').addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('tr[data-row]')
  if (!tr) return
  e.preventDefault()
  rowSnoozeMenu({ getBoundingClientRect: () => ({ right: e.clientX + 200, bottom: e.clientY }) }, Number(tr.dataset.row))
})
$('#g-table').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-row]')
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
    if (menu) closeMenu()
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
          state.sheet.teamPending = Boolean(message.teamPending)
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
