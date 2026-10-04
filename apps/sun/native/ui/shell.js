// Sun Code — the sidebar, the panes and the dialogs.
//
// Plain DOM, no framework: this page has to be on screen in the first frame, and the heavy UI is
// the chat inside each pane, which is the Light Code UI served by that codebase's own host.
//
// Talks to the Rust side through `window.ipc.postMessage` (commands) and `window.__sun.receive`
// (state). Every chat pane talks to it through `postMessage`, saying only a state word or a
// shortcut — see apps/host/src/client/main.tsx.
'use strict'

const $ = (selector, root = document) => root.querySelector(selector)
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'html') node.innerHTML = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (key === 'style') node.style.cssText = value
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child)
  return node
}
const COG = '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'
const svg = (paths, extra = '') =>
  paths === 'cog' ? `<svg viewBox="0 0 24 24" class="cog" ${extra}>${COG}</svg>` :
  paths === 'key24' ? `<svg viewBox="0 0 24 24" class="cog" ${extra}><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>` : `<svg viewBox="0 0 16 16" ${extra}>${paths}</svg>`
const ICONS = {
  folder: '<path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h3l1.5 1.75h5c.83 0 1.5.67 1.5 1.5v5.75c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5z"/>',
  moon: '<path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85z"/>',
  pin: '<path d="M9.75 1.75 14.25 6.25 11.5 7.5 8.5 10.5 8.75 13 3 7.25 5.5 7.5 8.5 4.5z"/><path d="m5.75 10.25-4 4"/>',
  vscode: '<path d="m11.5 1.75 2.75 1.3v9.9l-2.75 1.3L4.6 9.6 2.25 11.4 1.75 11V5l.5-.4L4.6 6.4zM11.5 5.1 7.6 8l3.9 2.9z"/>',
  explorer: '<path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h3l1.5 1.75h5c.83 0 1.5.67 1.5 1.5v5.75c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5z"/>',
  restart: '<path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M13.25 2.25v3h-3"/>',
  sleep: '<path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85z"/>',
  play: '<path d="M5 3.25v9.5L12.75 8z"/>',
  settings: 'cog',
  rename: '<path d="M10.5 2.75 13.25 5.5 5.5 13.25H2.75V10.5z"/>',
  log: '<path d="M3.75 1.75h6l2.5 2.5v10H3.75z"/><path d="M6 7h4M6 9.5h4M6 12h2.5"/>',
  remove: '<path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 9h6.3l.6-9"/>',
  check: '<path d="m3.5 8.25 3 3 6-6.5"/>',
  info: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v4M8 5v.01"/>',
  key: 'key24',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06"/>',
  link: '<path d="M6.75 9.25a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-.75.75"/><path d="M9.25 6.75a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l.75-.75"/>',
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5"/><path d="M10.75 5.25v-1.5c0-.83-.67-1.5-1.5-1.5h-5.5c-.83 0-1.5.67-1.5 1.5v5.5c0 .83.67 1.5 1.5 1.5h1.5"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  up: '<path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/>',
  alert: '<path d="M8 1.75 14.5 13.5h-13z"/><path d="M8 6.25v3.5M8 11.6v.01"/>',
}

// ─── Bridge to Rust ──────────────────────────────────────────────────────────

const send = (cmd, args = {}) => window.ipc.postMessage(JSON.stringify({ cmd, ...args }))

const model = {
  projects: [],
  statuses: {},
  urls: {},
  settings: {},
  /** The chat on screen: a codebase id for its first chat, `<id>~<n>` for the others. */
  active: undefined,
  /** The chat last open in each codebase, so clicking the codebase returns to it. */
  lastChat: {},
  version: '',
  hasSource: false,
  dataFolder: '',
  totalMemory: 0,
}

window.__sun = {
  receive(message) {
    const handler = HANDLERS[message.type]
    if (handler !== undefined) handler(message)
  },
}

const HANDLERS = {
  init(m) {
    Object.assign(model, {
      projects: m.projects,
      settings: m.settings,
      version: m.version,
      hasSource: m.hasSource,
      dataFolder: m.dataFolder,
    })
    applySidebar()
    applyAppearance()
    renderList()
    renderEmpty()
  },
  projects(m) {
    model.projects = m.projects
    renderTabs()
    renderList()
    renderEmpty()
    renderPanes()
    // A codebase's own accent may have changed; each pane is told what it now is.
    for (const frame of document.querySelectorAll('.pane iframe')) sendAppearance(frame)
  },
  status(m) {
    // Memory changes every few seconds; only a change of state redraws the list, so a rename or a
    // drag in progress is never interrupted by the meter.
    const shape = (all) => JSON.stringify(Object.entries(all).map(([id, s]) => [id, s.phase, s.agent, s.unread, s.error]))
    const changed = shape(m.statuses) !== shape(model.statuses)
    model.statuses = m.statuses
    model.totalMemory = m.totalMemory
    if (changed && !busyEditing()) renderList()
    if (changed) renderPanes()
    if (changed) renderTabs()
    renderMemory()
  },
  url(m) {
    model.urls[m.id] = m.url
    renderPanes()
  },
  unload(m) {
    delete model.urls[m.id]
    const frame = $(`.pane[data-id="${m.id}"] iframe`)
    if (frame !== null) frame.remove()
    renderPanes()
  },
  removed(m) {
    // A codebase takes all its chats with it; a chat key takes only itself.
    const gone = (key) => key === m.id || (!m.id.includes('~') && projectOf(key) === m.id)
    for (const key of Object.keys(model.urls)) if (gone(key)) delete model.urls[key]
    for (const pane of panes.querySelectorAll('.pane')) if (gone(pane.dataset.id)) pane.remove()
    if (model.lastChat[projectOf(m.id)] === m.id) delete model.lastChat[projectOf(m.id)]
    if (model.active !== undefined && gone(model.active)) {
      model.active = undefined
      const next = model.projects.find((p) => p.id !== m.id)
      if (next !== undefined) openProject(next.id)
    }
    renderEmpty()
    renderTabs()
  },
  select(m) {
    model.active = m.id
    model.lastChat[projectOf(m.id)] = m.id
    renderTabs()
    renderList()
    renderPanes()
    renderEmpty()
  },
  settings(m) {
    model.settings = m.settings
    applySidebar()
    applyAppearance()
    // The codebase tiles are drawn in the accent's family.
    if (!busyEditing()) renderList()
    if (openModal?.kind === 'settings') openModal.refresh()
  },
  folderPicked(m) {
    if (openModal?.onFolder !== undefined) openModal.onFolder(m)
  },
  configPicked(m) {
    if (openModal?.onConfigFile !== undefined) openModal.onConfigFile(m.path)
  },
  sources(m) {
    if (openModal?.onSources !== undefined) openModal.onSources(m)
  },
  addResult(m) {
    if (!m.ok) return notice(m.text, 'error')
    closeModal()
    model.active = m.id
    renderTabs()
    renderList()
    renderPanes()
  },
  notice(m) {
    notice(m.text, m.level)
  },
  credentials(m) {
    model.credentials = m.credentials
    model.pipe = m.pipe
    if (openModal?.kind === 'credentials' || openModal?.kind === 'environment') openModal.refresh()
  },
  report(m) {
    if (openModal?.kind === 'report') openModal.show(m)
    else openReport(m)
  },
  reports(m) {
    if (openModal?.kind === 'reportList') openModal.list(m.reports)
  },
  scriptStatus(m) {
    model.scriptStatus = m
    if (openModal?.kind === 'environment') openModal.refresh()
    if (openModal?.kind === 'settings') openModal.refresh()
  },
  scriptPicked(m) {
    if (openModal?.kind === 'environment') openModal.scriptPicked(m.path)
  },
  scriptRanWithAgents(m) {
    if (openModal?.kind === 'environment') openModal.saved({ ok: true, running: m.running, folders: undefined })
    else notice(`The startup script finished. ${m.running} agent${m.running === 1 ? ' is' : 's are'} still running with the environment from before — restart them from Settings → Environment.`)
  },
  environmentSaved(m) {
    if (openModal?.kind === 'environment') openModal.saved(m)
  },
  folderStatus(m) {
    if (openModal?.kind === 'environment') openModal.folders(m.folders)
  },
  envFolderPicked(m) {
    if (openModal?.kind === 'environment') openModal.picked(m.index, m.path)
  },
  credentialSaved() {
    if (openModal?.kind === 'credentials') openModal.saved()
  },
  importNeedsPassphrase(m) {
    if (openModal?.kind === 'credentials') openModal.askPassphrase(m.file)
  },
  jetbrainsPreview(m) {
    if (openModal?.kind === 'credentials') openModal.preview(m.items, 'importJetBrains', 'Keys found for Light Code in IntelliJ / PyCharm')
  },
  importPreview(m) {
    if (openModal?.kind === 'credentials') openModal.preview(m.items)
  },
  credentialError(m) {
    if (openModal?.kind === 'credentials') openModal.failed(m.text)
    else notice(m.text, 'error')
  },
}

// ─── Appearance ──────────────────────────────────────────────────────────────
//
// Sun's theme and accent, applied here and handed to every chat pane, which follows them (see
// apps/host/src/client/main.tsx). Role colours stay each pane's own.

const ACCENTS = ['#f26b1d', '#f59e0b', '#e11d48', '#db2777', '#9333ea', '#4f46e5', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#64748b']
const DEFAULT_ACCENT = '#f26b1d'
const darkQuery = matchMedia('(prefers-color-scheme: dark)')

const validHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const mix = (hex, target, amount) => {
  const t = target === 'white' ? 255 : 0
  const to = (c) => Math.round(c + (t - c) * amount).toString(16).padStart(2, '0')
  return '#' + rgb(hex).map(to).join('')
}
const appearance = () => ({
  theme: ['system', 'light', 'dark'].includes(model.settings.theme) ? model.settings.theme : 'system',
  accent: validHex(model.settings.accent) ? model.settings.accent.toLowerCase() : DEFAULT_ACCENT,
})

function applyAppearance() {
  const { theme, accent } = appearance()
  const dark = theme === 'dark' || (theme === 'system' && darkQuery.matches)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  // A touch lighter on dark, where the same colour reads as heavier.
  const base = dark ? mix(accent, 'white', 0.18) : accent
  const [r, g, b] = rgb(base)
  root.style.setProperty('--accent', base)
  root.style.setProperty('--accent-strong', dark ? mix(accent, 'white', 0.3) : mix(accent, 'black', 0.1))
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, ${dark ? 0.16 : 0.13})`)
  root.style.setProperty('--accent-ring', `rgba(${r}, ${g}, ${b}, 0.45)`)
  root.style.setProperty(
    '--sun-gradient',
    `linear-gradient(135deg, ${mix(accent, 'black', 0.08)} 0%, ${accent} 55%, ${mix(accent, 'white', 0.32)} 100%)`,
  )
  for (const frame of document.querySelectorAll('.pane iframe')) sendAppearance(frame)
  renderIcon(accent)
}

/**
 * To one pane, addressed to its own origin only: Sun's theme, and the codebase's own accent when
 * it was given one in its Appearance tab, Sun's otherwise.
 */
function sendAppearance(frame) {
  const url = frame?.dataset.url
  if (url === undefined || frame.contentWindow === null) return
  const project = model.projects.find((p) => p.id === projectOf(frame.closest('.pane')?.dataset.id ?? ''))
  const own = validHex(project?.accent)
  const message = { ...appearance(), ...(own ? { accent: project.accent } : {}), own }
  frame.contentWindow.postMessage({ source: 'sun', appearance: message }, new URL(url).origin)
}

/** The accent a codebase is drawn in: its own, or Sun's. */
const accentOf = (project) => (validHex(project?.accent) ? project.accent : appearance().accent)

darkQuery.addEventListener('change', applyAppearance)

/*
 * The icon in the accent colour: the same mark as assets/sun.svg, with the accent's gradient.
 * Shown in the sidebar and the welcome screen, and drawn to pixels for the title bar, the taskbar
 * and notifications. The exe's own icon is fixed when it is built and stays orange.
 */
const iconSvg = (accent) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${mix(accent, 'black', 0.08)}"/><stop offset="0.55" stop-color="${accent}"/><stop offset="1" stop-color="${mix(accent, 'white', 0.35)}"/>
</linearGradient><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5.8"/></filter></defs>
<rect width="128" height="128" rx="28" fill="url(#g)"/>
<circle cx="64" cy="64" r="17.3" fill="${mix(accent, 'white', 0.82)}" opacity="0.7" filter="url(#f)"/>
<g fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"><path d="M48 44 L36 64 L48 84"/><path d="M80 44 L92 64 L80 84"/></g>
<path d="M64 53.5 L74.5 64 L64 74.5 L53.5 64 Z" fill="#fff"/></svg>`

let iconAccent
function renderIcon(accent) {
  if (iconAccent === accent) return
  iconAccent = accent
  const url = 'data:image/svg+xml;base64,' + btoa(iconSvg(accent))
  for (const mark of document.querySelectorAll('.brand-mark, .empty-mark')) mark.src = url
  const image = new Image()
  image.onload = () => {
    if (iconAccent !== accent) return
    const draw = (size) => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const g = canvas.getContext('2d')
      g.imageSmoothingQuality = 'high'
      g.drawImage(image, 0, 0, size, size)
      return canvas
    }
    // 64px covers the taskbar at 200% scaling; Windows scales down for the title bar.
    const small = draw(64)
    const pixels = small.getContext('2d').getImageData(0, 0, 64, 64).data
    let binary = ''
    for (let i = 0; i < pixels.length; i += 0x8000) binary += String.fromCharCode(...pixels.subarray(i, i + 0x8000))
    send('setIcon', { size: 64, rgba: btoa(binary), png: draw(256).toDataURL('image/png').split(',')[1] })
  }
  image.src = url
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const hueFor = (text) => {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360
  return h
}
const initials = (name) => {
  const words = name.replace(/[-_.]+/g, ' ').trim().split(/\s+|(?=[A-Z][a-z])/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)
  return letters.toUpperCase()
}
/** The accent as hue, saturation and lightness, so avatars can vary around it. */
const hslOf = (hex) => {
  const [r, g, b] = rgb(hex).map((c) => c / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s * 100, l * 100]
}

/*
 * A codebase's tile, in the accent's family: the name nudges the hue and depth a little either
 * way, so a sidebar of them reads as one set and each is still told apart at a glance.
 */
const avatar = (name, extraClass = '', accent = appearance().accent) => {
  const [h, s] = hslOf(accent)
  const seed = hueFor(name)
  const hue = (h + ((seed % 7) - 3) * 9 + 360) % 360
  const sat = s < 12 ? 12 : Math.max(28, Math.min(85, s - 4 + (seed % 3) * 4))
  const light = 40 + ((seed >> 2) % 4) * 4
  return el('span', {
    class: `avatar ${extraClass}`,
    style: `background: linear-gradient(135deg, hsl(${hue} ${sat}% ${light + 8}%), hsl(${(hue + 14) % 360} ${sat}% ${light - 4}%))`,
    text: initials(name),
  })
}
const megabytes = (bytes) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
const shortPath = (p) => {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length <= 3 ? p : `${parts[0]}\\…\\${parts.slice(-2).join('\\')}`
}
const busyEditing = () => dragId !== undefined || document.querySelector(".item-rename") !== null
const statusOf = (id) => model.statuses[id] ?? { phase: 'stopped', agent: 'idle', memory: 0 }

// ─── Chats ───────────────────────────────────────────────────────────────────
//
// Each codebase can hold several chats, each its own agent on the same folder, settings and keys.
// The first chat is the codebase id itself; the others are `<id>~<n>`.

const projectOf = (key) => key.split('~')[0]
const chatKeys = (p) => [p.id, ...(p.chats ?? []).map((c) => `${p.id}~${c.id}`)]
const chatName = (key) => {
  const p = model.projects.find((x) => x.id === projectOf(key))
  if (!key.includes('~')) return 'Chat 1'
  return p?.chats?.find((c) => `${p.id}~${c.id}` === key)?.name ?? 'Chat'
}
const PHASE_RANK = ['stopped', 'sleeping', 'failed', 'starting', 'running']
const AGENT_RANK = ['idle', 'busy', 'attention']

/** A codebase's state across its chats: the liveliest phase, the most urgent agent state. */
const projectStatus = (p) => {
  const all = chatKeys(p).map(statusOf)
  const first = statusOf(p.id)
  const running = all.filter((s) => s.phase === 'running')
  return {
    phase: all.reduce((best, s) => (PHASE_RANK.indexOf(s.phase) > PHASE_RANK.indexOf(best) ? s.phase : best), first.phase),
    agent: running.reduce((best, s) => (AGENT_RANK.indexOf(s.agent) > AGENT_RANK.indexOf(best) ? s.agent : best), 'idle'),
    memory: all.reduce((sum, s) => sum + (s.memory ?? 0), 0),
    unread: all.some((s) => s.unread),
    schedule: statusOf(p.id).schedule === true,
    error: first.error,
    chats: all.length,
    working: running.filter((s) => s.agent !== 'idle').length,
  }
}

/** The sidebar dot for a codebase: its chats taken together. */
const projectDot = (p) => {
  const s = projectStatus(p)
  return s.phase === 'running' ? (s.agent === 'idle' ? 'running' : s.agent) : s.phase
}

/** Opens a codebase at the chat last open in it. */
function openProject(id) {
  const p = model.projects.find((x) => x.id === id)
  if (p === undefined) return
  const last = model.lastChat[id]
  select(last !== undefined && chatKeys(p).includes(last) ? last : id)
}

const tabs = $('#tabs')

function renderTabs() {
  const key = model.active
  const p = key === undefined ? undefined : model.projects.find((x) => x.id === projectOf(key))
  tabs.hidden = p === undefined
  $('#main').classList.toggle('with-tabs', p !== undefined)
  if (p === undefined) return tabs.replaceChildren()
  tabs.replaceChildren(
    ...chatKeys(p).map((k) => {
      const s = statusOf(k)
      const tab = el(
        'button',
        {
          class: `tab${k === key ? ' active' : ''}`,
          role: 'tab',
          'aria-selected': String(k === key),
          title: k.includes('~') ? 'Double-click to rename · middle-click to close' : 'The first chat',
          onclick: () => select(k),
          onauxclick: (e) => {
            if (e.button === 1 && k.includes('~')) closeChat(k)
          },
          ondblclick: () => k.includes('~') && renameChat(k, tab),
        },
        el('span', { class: `dot ${dotClass(k)}` }),
        el('span', { class: 'tab-name', text: chatName(k) }),
        s.unread && k !== key ? el('span', { class: 'unread' }) : null,
        k.includes('~')
          ? el('span', {
              class: 'tab-close',
              title: 'Close this chat',
              html: svg(ICONS.close),
              onclick: (e) => {
                e.stopPropagation()
                closeChat(k)
              },
            })
          : null,
      )
      return tab
    }),
    el('button', {
      class: 'tab-new',
      title: 'New chat (Ctrl+T) - another agent on this codebase',
      'aria-label': 'New chat',
      html: svg(ICONS.plus),
      onclick: () => send('newChat', { id: p.id }),
    }),
  )
}

function closeChat(key) {
  const s = statusOf(key)
  if (s.phase === 'running' && s.agent !== 'idle' && !confirm(`${chatName(key)} is still working. Stop it and close the chat?`)) return
  send('closeChat', { id: key })
}

function renameChat(key, tab) {
  const name = $('.tab-name', tab)
  const input = el('input', { class: 'tab-rename', value: chatName(key) })
  name.replaceWith(input)
  input.focus()
  input.select()
  const done = (save) => {
    if (save && input.value.trim() !== '') send('renameChat', { id: key, name: input.value.trim() })
    renderTabs()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true)
    if (e.key === 'Escape') done(false)
  })
  input.addEventListener('blur', () => done(true))
}

/** What the row says under the name: the agent's state when it has one, otherwise where it lives. */
const describe = (project) => {
  const s = projectStatus(project)
  if (project.missing) return ['Folder not found', 'failed']
  if (s.phase === 'failed') return ['Agent stopped — open to see why', 'failed']
  if (s.phase === 'starting') return ['Starting…', 'busy']
  if (s.phase === 'sleeping') return ['Sleeping to save memory', '']
  if (s.phase === 'running' && s.agent === 'attention') return ['Needs your approval', 'attention']
  if (s.schedule && s.phase === 'running') return ['Woken to run a schedule — sleeps again after', 'busy']
  if (s.phase === 'running' && s.agent === 'busy') return [s.working > 1 ? `${s.working} chats working…` : 'Working…', 'busy']
  return [s.chats > 1 ? `${s.chats} chats · ${shortPath(project.path)}` : shortPath(project.path), '']
}

const dotClass = (id) => {
  const s = statusOf(id)
  if (s.phase === 'running') return s.agent === 'idle' ? 'running' : s.agent
  return s.phase
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

const list = $('#list')
let dragId

function renderList() {
  list.replaceChildren(
    ...model.projects.map((p, index) => {
      const [sub, tone] = describe(p)
      const s = projectStatus(p)
      const here = model.active !== undefined && projectOf(model.active) === p.id
      const face = avatar(p.name, '', accentOf(p))
      face.append(el('span', { class: `dot ${projectDot(p)}` }))
      const row = el(
        'button',
        {
          class: `item${here ? ' active' : ''}`,
          role: 'option',
          'aria-selected': String(here),
          'data-id': p.id,
          title: `${p.name}\n${p.path}${s.memory > 0 ? `\n${megabytes(s.memory)}` : ''}${index < 9 ? `\nCtrl+${index + 1}` : ''}`,
          draggable: 'true',
          onclick: () => openProject(p.id),
          oncontextmenu: (e) => {
            e.preventDefault()
            showMenu(p, e.clientX, e.clientY)
          },
          ondragstart: (e) => {
            dragId = p.id
            e.dataTransfer.effectAllowed = 'move'
            row.classList.add('dragging')
          },
          ondragend: () => {
            dragId = undefined
            renderList()
          },
          ondragover: (e) => {
            if (dragId === undefined || dragId === p.id) return
            e.preventDefault()
            for (const r of list.querySelectorAll('.drop-before')) r.classList.remove('drop-before')
            row.classList.add('drop-before')
          },
          ondrop: (e) => {
            e.preventDefault()
            if (dragId === undefined || dragId === p.id) return
            const ids = model.projects.map((x) => x.id).filter((x) => x !== dragId)
            ids.splice(ids.indexOf(p.id), 0, dragId)
            model.projects = ids.map((id) => model.projects.find((x) => x.id === id))
            send('reorder', { ids })
            renderList()
          },
        },
        face,
        el('span', { class: 'item-text' }, el('span', { class: 'item-name', text: p.name }), el('span', { class: `item-sub ${tone}`, text: sub })),
        s.unread && !here ? el('span', { class: 'unread', title: 'Something happened here' }) : null,
        s.phase === 'sleeping' ? el('span', { class: 'moon', html: svg(ICONS.moon), title: 'Sleeping' }) : null,
        p.keepAwake ? el('span', { class: 'pin', html: svg(ICONS.pin), title: 'Kept awake' }) : null,
      )
      return row
    }),
  )
  renderRail()
}

function renderRail() {
  $('#rail-list').replaceChildren(
    ...model.projects.map((p) => {
      const face = avatar(p.name, model.active !== undefined && projectOf(model.active) === p.id ? 'active' : '', accentOf(p))
      face.append(el('span', { class: `dot ${projectDot(p)}` }))
      face.title = `${p.name} — ${describe(p)[0]}`
      face.addEventListener('click', () => openProject(p.id))
      face.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        showMenu(p, e.clientX, e.clientY)
      })
      return face
    }),
  )
}

function renderMemory() {
  const running = Object.values(model.statuses).filter((s) => s.phase === 'running' || s.phase === 'starting').length
  $('#memory').textContent =
    running === 0 ? 'No agents running' : `${running} running · ${megabytes(model.totalMemory)}`
}

function renderEmpty() {
  $('#empty').hidden = model.projects.length > 0
}

function select(id) {
  const project = model.projects.find((p) => p.id === projectOf(id))
  if (project === undefined || !chatKeys(project).includes(id)) return
  model.active = id
  model.lastChat[project.id] = id
  send('select', { id })
  renderTabs()
  renderList()
  renderPanes()
  // Focus follows: typing goes straight into that codebase's composer.
  requestAnimationFrame(() => $(`.pane[data-id="${id}"] iframe`)?.focus())
}

function selectRelative(step) {
  if (model.projects.length === 0) return
  const at = model.projects.findIndex((p) => model.active !== undefined && p.id === projectOf(model.active))
  const next = model.projects[(at + step + model.projects.length) % model.projects.length]
  openProject(next.id)
}

// ─── Sidebar: hide, show, resize ─────────────────────────────────────────────

function applySidebar() {
  const width = Math.min(440, Math.max(200, model.settings.sidebarWidth ?? 264))
  document.documentElement.style.setProperty('--side-width', `${width}px`)
  $('#app').classList.toggle('collapsed', model.settings.sidebarHidden === true)
}

function toggleSidebar() {
  model.settings.sidebarHidden = !model.settings.sidebarHidden
  applySidebar()
  send('settings', { patch: { sidebarHidden: model.settings.sidebarHidden } })
}

$('#collapse').addEventListener('click', toggleSidebar)
$('#expand').addEventListener('click', toggleSidebar)

$('#resizer').addEventListener('pointerdown', (event) => {
  const resizer = event.currentTarget
  resizer.setPointerCapture(event.pointerId)
  // The frames would swallow the pointer as it crosses them.
  document.body.style.pointerEvents = 'none'
  resizer.style.pointerEvents = 'auto'
  const move = (e) => {
    model.settings.sidebarWidth = Math.round(Math.min(440, Math.max(200, e.clientX)))
    applySidebar()
  }
  const up = () => {
    resizer.removeEventListener('pointermove', move)
    resizer.removeEventListener('pointerup', up)
    document.body.style.pointerEvents = ''
    send('settings', { patch: { sidebarWidth: model.settings.sidebarWidth } })
  }
  resizer.addEventListener('pointermove', move)
  resizer.addEventListener('pointerup', up)
})

// ─── Panes ───────────────────────────────────────────────────────────────────

const panes = $('#panes')

function renderPanes() {
  const keys = []
  for (const project of model.projects) for (const key of chatKeys(project)) {
    keys.push(key)
    let pane = $(`.pane[data-id="${key}"]`, panes)
    if (pane === null) {
      pane = el('div', { class: 'pane', 'data-id': key })
      panes.append(pane)
    }
    pane.classList.toggle('active', key === model.active)

    const s = statusOf(key)
    const url = model.urls[key]
    let frame = $('iframe', pane)
    if (url !== undefined && s.phase === 'running') {
      if (frame === null) {
        frame = el('iframe', {
          title: `Light Code — ${project.name}${key.includes('~') ? ` — ${chatName(key)}` : ''}`,
          allow: 'clipboard-read; clipboard-write',
          src: url,
        })
        frame.dataset.url = url
        pane.prepend(frame)
      } else if (frame.dataset.url !== url) {
        // A fresh launch link: the old one was spent (a reload) or the host restarted.
        frame.dataset.url = url
        frame.src = url
      }
    }
    renderPaneState(pane, project, s, frame !== null && s.phase === 'running', key)
  }
  for (const pane of panes.querySelectorAll('.pane')) {
    if (!keys.includes(pane.dataset.id)) pane.remove()
  }
}

function renderPaneState(pane, project, s, live, key) {
  const want = project.missing
    ? 'missing'
    : live
      ? 'live'
      : s.phase === 'failed'
        ? 'failed'
        : s.phase === 'sleeping'
          ? 'sleeping'
          : s.phase === 'stopped'
            ? 'stopped'
            : 'starting'
  const current = pane.dataset.state
  if (current === want && want !== 'failed') return
  pane.dataset.state = want
  $('.pane-state', pane)?.remove()
  $('.skeleton', pane)?.remove()
  if (want === 'live') return

  if (want === 'starting') {
    pane.append(
      el(
        'div',
        { class: 'skeleton' },
        el('div', { class: 'bar' }),
        el('div', { class: 'bubble right' }),
        el('div', { class: 'bubble' }),
        el('div', { class: 'spacer' }),
        el('div', { class: 'composer' }),
        el('div', { class: 'caption' }, el('span', { class: 'spinner' }), `Starting Light Code for ${project.name}…`),
      ),
    )
    return
  }
  const state = el('div', { class: 'pane-state' })
  if (want === 'sleeping' || want === 'stopped') {
    state.append(
      el('span', { html: svg(want === 'sleeping' ? ICONS.moon : ICONS.play, 'class="state-icon"') }),
      el('h2', { text: want === 'sleeping' ? `${project.name} is sleeping` : `${project.name} is not running` }),
      el('p', {
        text:
          want === 'sleeping'
            ? 'It was idle, so its agent was stopped to save memory. Your chats are saved; waking it takes a moment.'
            : 'Start its agent to continue. Your chats are saved.',
      }),
      el('div', { class: 'actions' }, el('button', { class: 'primary', text: want === 'sleeping' ? 'Wake up' : 'Start', onclick: () => send('start', { id: key }) })),
    )
  } else if (want === 'missing') {
    state.append(
      el('span', { html: svg(ICONS.folder, 'class="state-icon"') }),
      el('h2', { text: 'Folder not found' }),
      el('p', { text: `${project.path} no longer exists. Restore it, or remove this codebase from Sun.` }),
      el('div', { class: 'actions' }, el('button', { class: 'secondary', text: 'Remove from Sun', onclick: () => confirmRemove(project) })),
    )
  } else {
    state.append(
      el('span', { html: svg(ICONS.alert, 'class="state-icon"') }),
      el('h2', { text: 'The agent stopped' }),
      el('pre', { text: s.error ?? 'No details were reported.' }),
      el(
        'div',
        { class: 'actions' },
        el('button', { class: 'primary', text: 'Restart', onclick: () => send('restart', { id: key }) }),
        el('button', { class: 'secondary', text: 'Open log', onclick: () => send('openLog', { id: key }) }),
      ),
    )
  }
  pane.append(state)
}

// Messages from the chat panes: a state word or a shortcut, nothing else.
window.addEventListener('message', (event) => {
  const data = event.data
  if (data === null || typeof data !== 'object' || data.source !== 'light-code') return
  const frame = [...panes.querySelectorAll('.pane iframe')].find((f) => f.contentWindow === event.source)
  const key = frame?.closest('.pane')?.dataset.id
  const project = key === undefined ? undefined : model.projects.find((p) => p.id === projectOf(key))
  if (project === undefined) return
  const url = model.urls[key]
  if (url === undefined || new URL(url).origin !== event.origin) return
  if (typeof data.state === 'string' && ['idle', 'busy', 'attention'].includes(data.state)) {
    send('agentState', { id: key, state: data.state, finished: data.finished === true })
  }
  if (typeof data.shortcut === 'string') shortcut(data.shortcut)
  // An accent picked in that codebase's own Appearance tab, or null to follow Sun's again.
  if (data.accent === null || validHex(data.accent)) send('projectAccent', { id: project.id, accent: data.accent })
  if (data.ready === true) sendAppearance(frame)
})

// ─── Reports: Sun's Markdown viewer ──────────────────────────────────────────
//
// Agent reports (scheduled runs, notify) are Markdown files in the codebase's data folder. Shown
// here rather than handed to whatever Windows associates with .md. The renderer builds DOM nodes
// and never assigns report text as HTML: a report is model-written, and this page can talk to Rust.

const MD_KEYWORDS = new Set(
  ('and as assert async await break case catch class const continue def default del do elif else enum except export ' +
    'extends false final finally fn for from func function go if impl import in interface is lambda let loop match mod ' +
    'module mut new nil none not null or package pass private protected pub public raise return self select static ' +
    'struct super switch then this throw true try type typeof use var void where while with yield True False None')
    .split(' '),
)

/** A code block, lightly coloured: comments, strings, numbers, keywords. Text nodes only. */
function mdCode(code, lang) {
  const pre = el('pre', { class: 'md-pre' })
  const block = el('code', {})
  const hashComments = /^(py|python|sh|bash|shell|yaml|yml|toml|ps1|powershell|r|rb|ruby|perl|make|dockerfile|ini|conf)$/i.test(lang)
  const pattern = new RegExp(
    [
      '(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*' + (hashComments ? '|#[^\\n]*' : '') + (/^sql$/i.test(lang) ? '|--[^\\n]*' : '') + ')',
      '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)',
      '(\\b\\d+(?:\\.\\d+)?\\b)',
      '([A-Za-z_][A-Za-z0-9_]*)',
    ].join('|'),
    'g',
  )
  let last = 0
  for (const m of code.matchAll(pattern)) {
    if (m.index > last) block.append(document.createTextNode(code.slice(last, m.index)))
    const kind = m[1] !== undefined ? 'c' : m[2] !== undefined ? 's' : m[3] !== undefined ? 'n' : MD_KEYWORDS.has(m[4]) ? 'k' : undefined
    block.append(kind === undefined ? document.createTextNode(m[0]) : el('span', { class: `tk-${kind}`, text: m[0] }))
    last = m.index + m[0].length
  }
  if (last < code.length) block.append(document.createTextNode(code.slice(last)))
  pre.append(block)
  const wrap = el('div', { class: 'md-code' }, lang ? el('span', { class: 'md-lang', text: lang }) : null, pre)
  wrap.append(
    el('button', {
      class: 'md-copy',
      text: 'Copy',
      onclick: (e) => {
        navigator.clipboard?.writeText(code)
        e.currentTarget.textContent = 'Copied'
      },
    }),
  )
  return wrap
}

/** Where a link inside a report goes: the web in the browser, another report in this viewer. */
function mdLink(href, label, base) {
  const a = el('a', { href: '#', title: href })
  a.append(...label)
  a.addEventListener('click', (e) => {
    e.preventDefault()
    if (/^https?:\/\//i.test(href)) return send('openExternal', { url: href })
    if (/^[a-z]+:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return
    const path = /^[a-z]:[\\/]|^\\\\/i.test(href) ? href : mdJoin(base, decodeURIComponent(href.split('#')[0]))
    if (path) send('openReport', { path })
  })
  return a
}

function mdJoin(base, relative) {
  if (!base || !relative) return undefined
  const parts = base.split(/[\\/]/)
  parts.pop()
  for (const part of relative.split(/[\\/]/)) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('\\')
}

/** Inline Markdown: code, links, emphasis. Returns nodes; never HTML. */
function mdInline(text, base) {
  const out = []
  const pattern =
    /(`+)([\s\S]*?[^`])\1(?!`)|!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<)\]]+[^\s<)\].,;:!?'"])|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^\s*][\s\S]*?)\*|(?<![\w])_([^\s_][\s\S]*?)_(?![\w])/g
  let last = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)))
    if (m[1] !== undefined) out.push(el('code', { class: 'md-inline', text: m[2].replace(/^ (.*) $/, '$1') }))
    else if (m[4] !== undefined) {
      const image = m[0].startsWith('!')
      // Images are not fetched: a report may name any URL, and Sun loads nothing remote.
      out.push(mdLink(m[4], image ? [`[image: ${m[3] || m[4]}]`] : mdInline(m[3] || m[4], base), base))
    } else if (m[5] !== undefined || m[6] !== undefined) out.push(mdLink(m[5] ?? m[6], [m[5] ?? m[6]], base))
    else if (m[7] !== undefined || m[8] !== undefined) out.push(el('strong', {}, ...mdInline(m[7] ?? m[8], base)))
    else if (m[9] !== undefined) out.push(el('del', {}, ...mdInline(m[9], base)))
    else out.push(el('em', {}, ...mdInline(m[10] ?? m[11], base)))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)))
  return out
}

const MD_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const MD_TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const mdCells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))
const mdStartsBlock = (line, next) =>
  /^\s*(```|~~~)/.test(line) || /^#{1,6}\s/.test(line) || /^\s*>/.test(line) || MD_LIST.test(line) ||
  /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || (line.includes('|') && next !== undefined && MD_TABLE_RULE.test(next))

/** Block Markdown into a fragment. */
function renderMarkdown(text, base) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out = document.createDocumentFragment()
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)/.exec(line)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[2])) body.push(lines[i++].slice(fence[1].length))
      i++
      out.append(mdCode(body.join('\n'), fence[3]))
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      out.append(el(`h${heading[1].length}`, { class: 'md-h' }, ...mdInline(heading[2], base)))
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.append(el('hr'))
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const quoted = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*> ?/, ''))
      const quote = el('blockquote')
      quote.append(renderMarkdown(quoted.join('\n'), base))
      out.append(quote)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && MD_TABLE_RULE.test(lines[i + 1])) {
      const head = mdCells(line)
      const align = mdCells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'))
      i += 2
      const table = el('table', { class: 'md-table' })
      table.append(el('thead', {}, el('tr', {}, ...head.map((c, k) => el('th', { style: `text-align: ${align[k] ?? 'left'}` }, ...mdInline(c, base))))))
      const body = el('tbody')
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = mdCells(lines[i++])
        body.append(el('tr', {}, ...head.map((_, k) => el('td', { style: `text-align: ${align[k] ?? 'left'}` }, ...mdInline(cells[k] ?? '', base)))))
      }
      table.append(body)
      out.append(el('div', { class: 'md-table-wrap' }, table))
      continue
    }
    const item = MD_LIST.exec(line)
    if (item) {
      const indent = item[1].length
      const ordered = /\d/.test(item[2])
      const list = el(ordered ? 'ol' : 'ul', ordered && parseInt(item[2], 10) !== 1 ? { start: String(parseInt(item[2], 10)) } : {})
      while (i < lines.length) {
        const m = MD_LIST.exec(lines[i])
        if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break
        const content = [m[3]]
        i++
        // Continuation and nested lines: indented past the marker, or blank lines followed by such.
        while (i < lines.length) {
          const next = lines[i]
          if (next.trim() === '') {
            if (i + 1 < lines.length && /^\s+/.test(lines[i + 1]) && lines[i + 1].search(/\S/) > indent) {
              content.push('')
              i++
              continue
            }
            break
          }
          const nested = MD_LIST.exec(next)
          if (nested && nested[1].length <= indent) break
          if (!nested && next.search(/\S/) <= indent && mdStartsBlock(next, lines[i + 1])) break
          content.push(next.replace(new RegExp(`^\\s{0,${indent + 4}}`), ''))
          i++
        }
        const li = el('li')
        const task = /^\[([ xX])\]\s+/.exec(content[0])
        if (task) {
          content[0] = content[0].slice(task[0].length)
          li.classList.add('md-task')
          li.append(el('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ' }))
        }
        const inner = renderMarkdown(content.join('\n'), base)
        // A one-paragraph item reads as text, not as a paragraph with margins.
        if (inner.childNodes.length === 1 && inner.firstChild.tagName === 'P') li.append(...inner.firstChild.childNodes)
        else li.append(inner)
        list.append(li)
      }
      out.append(list)
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() !== '' && (para.length === 0 || !mdStartsBlock(lines[i], lines[i + 1]))) para.push(lines[i++])
    const p = el('p')
    para.forEach((l, k) => {
      p.append(...mdInline(l.trim(), base))
      if (k < para.length - 1) p.append(/ {2,}$|\\$/.test(l) ? el('br') : document.createTextNode(' '))
    })
    out.append(p)
  }
  return out
}

function openReport(report) {
  showModal('report', (scrim, modal) => {
    let source = false
    const card = el('div', { class: 'modal report-modal' })
    scrim.append(card)
    const render = () => {
      const body = el('div', { class: 'report-body' })
      if (source || report.kind === 'text') body.append(el('pre', { class: 'md-source', text: report.text }))
      else if (report.kind === 'html') {
        // Served by Sun under its own policy: the report's styles, and no script or request.
        body.classList.add('html')
        body.append(el('iframe', { class: 'report-frame', sandbox: '', title: report.name, src: `report?p=${encodeURIComponent(report.path)}` }))
      } else {
        const doc = el('article', { class: 'md' })
        doc.append(renderMarkdown(report.text, report.path))
        body.append(doc)
      }
      card.replaceChildren(
        el(
          'header',
          { class: 'report-head' },
          el('span', { class: 'meta' }, el('h2', { text: report.name }), el('span', { class: 'sub', text: report.path })),
          el(
            'div',
            { class: 'report-actions' },
            report.kind === 'text' ? null : el('div', { class: 'segmented small' },
              el('button', { class: source ? '' : 'on', text: 'Rendered', onclick: () => { source = false; render() } }),
              el('button', { class: source ? 'on' : '', text: 'Source', onclick: () => { source = true; render() } }),
            ),
            el('button', { class: 'secondary', text: 'Copy', onclick: (e) => { navigator.clipboard?.writeText(report.text); e.currentTarget.textContent = 'Copied' } }),
            el('button', { class: 'secondary', text: 'Show in folder', onclick: () => send('revealReport', { path: report.path }) }),
            el('button', { class: 'secondary', text: 'Open with…', onclick: () => send('openReportExternally', { path: report.path }) }),
            el('button', { class: 'icon-btn small', title: 'Close', 'aria-label': 'Close', html: svg(ICONS.close), onclick: closeModal }),
          ),
        ),
        body,
      )
    }
    modal.show = (next) => {
      report = next
      source = false
      render()
    }
    render()
  })
}

/** A codebase's reports, newest first; each opens in the viewer. */
function openReportList(project) {
  showModal('reportList', (scrim, modal) => {
    const card = el('div', { class: 'modal', style: 'width: min(560px, calc(100vw - 48px))' })
    scrim.append(card)
    const render = (items) => {
      card.replaceChildren(
        el('header', {}, el('h2', { text: `Reports — ${project.name}` }), el('p', { class: 'sub', text: 'Markdown and HTML reports written by scheduled runs and the notify tool, in every chat on this codebase.' })),
        el(
          'div',
          { class: 'body' },
          items === undefined
            ? el('div', { class: 'note', html: '<span class="spinner"></span><span>Looking…</span>' })
            : items.length === 0
              ? el('div', { class: 'note', text: 'No reports yet.' })
              : el('div', { class: 'report-list' },
                  ...items.map((r) =>
                    el('button', { class: 'report-item', onclick: () => send('openReport', { path: r.path }) },
                      el('span', { html: svg(ICONS.log) }),
                      el('span', { class: 'meta' }, el('b', { text: r.name }), el('span', { text: new Date(r.modified).toLocaleString() })),
                    ),
                  ),
                ),
        ),
        el('footer', {}, el('span', { class: 'spacer' }), el('button', { class: 'secondary', text: 'Close', onclick: closeModal })),
      )
    }
    modal.list = render
    render(undefined)
    send('reports', { id: project.id })
  })
}

// ─── Shortcuts ───────────────────────────────────────────────────────────────

function shortcut(name) {
  if (name === 'b') return toggleSidebar()
  if (name === 'k') return openSwitcher()
  if (name === 'n') return openAdd()
  if (name === ',') return openSettings()
  if (name === 't' && model.active !== undefined) return send('newChat', { id: projectOf(model.active) })
  if (name === 'w' && model.active?.includes('~')) return closeChat(model.active)
  if (name === 'tab') return selectRelative(1)
  if (name === 'shift+tab') return selectRelative(-1)
  if (/^[1-9]$/.test(name)) {
    const project = model.projects[Number(name) - 1]
    if (project !== undefined) openProject(project.id)
  }
}

window.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Escape') {
      if ($('.menu') !== null) return closeMenu()
      if (openModal !== undefined) return closeModal()
    }
    if (!event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (['b', 'k', 'n', ',', 'tab', 't', 'w'].includes(key) || /^[1-9]$/.test(key)) {
      event.preventDefault()
      shortcut(`${event.shiftKey && key === 'tab' ? 'shift+' : ''}${key}`)
    }
  },
  true,
)

// ─── Context menu ────────────────────────────────────────────────────────────

function closeMenu() {
  $('.menu')?.remove()
}

function showMenu(project, x, y) {
  closeMenu()
  const s = projectStatus(project)
  const running = s.phase === 'running' || s.phase === 'starting'
  const each = (cmd) => () => chatKeys(project).forEach((id) => send(cmd, { id }))
  const current = model.lastChat[project.id] ?? project.id
  const item = (icon, label, action, extra = {}) =>
    el(
      'button',
      {
        class: extra.danger ? 'danger' : '',
        onclick: () => {
          closeMenu()
          action()
        },
      },
      el('span', { html: svg(ICONS[icon]) }),
      label,
      extra.checked ? el('span', { class: 'check', html: svg(ICONS.check) }) : null,
    )
  const menu = el(
    'div',
    { class: 'menu', role: 'menu' },
    item('vscode', 'Open in VS Code', () => send('openVsCode', { id: project.id })),
    item('explorer', 'Open in File Explorer', () => send('openExplorer', { id: project.id })),
    el('hr'),
    item('plus', 'New chat', () => send('newChat', { id: project.id })),
    running
      ? item('sleep', s.chats > 1 ? 'Sleep all chats' : 'Sleep now', each('sleep'))
      : item('play', 'Start agent', () => send('start', { id: current })),
    item('restart', s.chats > 1 ? 'Restart all chats' : 'Restart agent', each('restart')),
    item('pin', 'Keep awake', () => send('keepAwake', { id: project.id, on: !project.keepAwake }), { checked: project.keepAwake }),
    el('hr'),
    item('settings', 'Settings source…', () => openConfigChooser(project)),
    item('rename', 'Rename', () => startRename(project)),
    item('log', 'Reports…', () => openReportList(project)),
    item('log', 'View agent log', () => send('openLog', { id: current })),
    el('hr'),
    item('remove', 'Remove from Sun…', () => confirmRemove(project), { danger: true }),
  )
  document.body.append(menu)
  const box = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, innerWidth - box.width - 8)}px`
  menu.style.top = `${Math.min(y, innerHeight - box.height - 8)}px`
  setTimeout(() => document.addEventListener('pointerdown', (e) => !menu.contains(e.target) && closeMenu(), { once: true }))
}

function startRename(project) {
  if (model.settings.sidebarHidden) toggleSidebar()
  const row = $(`.item[data-id="${project.id}"] .item-name`, list)
  if (row === null) return
  const input = el('input', { type: 'text', class: 'item-rename', value: project.name })
  row.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = (save) => {
    if (done) return
    done = true
    if (save && input.value.trim() !== '' && input.value.trim() !== project.name) send('rename', { id: project.id, name: input.value.trim() })
    else renderList()
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') finish(true)
    if (e.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('click', (e) => e.stopPropagation())
}

// ─── Modals ──────────────────────────────────────────────────────────────────

let openModal

function closeModal() {
  openModal?.node.remove()
  openModal = undefined
  $(`.pane[data-id="${model.active}"] iframe`)?.focus()
}

function showModal(kind, build) {
  closeModal()
  const scrim = el('div', { class: 'scrim' })
  scrim.addEventListener('pointerdown', (e) => e.target === scrim && closeModal())
  openModal = { kind, node: scrim }
  build(scrim, openModal)
  $('#layer').append(scrim)
}

function confirmRemove(project) {
  showModal('remove', (scrim) => {
    scrim.append(
      el(
        'div',
        { class: 'modal', style: 'width: min(460px, calc(100vw - 48px))' },
        el('header', {}, el('h2', { text: `Remove ${project.name}?` })),
        el(
          'div',
          { class: 'body' },
          el('p', {
            class: 'sub',
            text: 'Its agent is stopped and it leaves the sidebar. Nothing is deleted: the folder, its chats and its settings stay on disk, and adding it again brings them back.',
          }),
        ),
        el(
          'footer',
          {},
          el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }),
          el('button', {
            class: 'primary',
            text: 'Remove',
            onclick: () => {
              closeModal()
              send('remove', { id: project.id })
            },
          }),
        ),
      ),
    )
  })
}

/**
 * The settings-source chooser, shared by the Add dialog and "Settings source…".
 *
 * Link uses an existing file in place; Copy takes a copy; New starts empty. Link is the default
 * when a Light Code config exists, because that is the case the user described: "use all the
 * connections that were added in that codebase".
 */
function configChooser(state, rerender) {
  const choice = (mode, icon, title, text) =>
    el(
      'button',
      {
        class: `choice${state.mode === mode ? ' selected' : ''}`,
        onclick: () => {
          state.mode = mode
          if (mode !== 'new' && state.source === undefined && state.sources.length > 0) state.source = state.sources[0].path
          rerender()
        },
      },
      el('b', { html: `${svg(ICONS[icon])}${title}` }),
      el('span', { text }),
    )
  const parts = [
    el(
      'div',
      { class: 'choices' },
      choice('link', 'link', 'Link', 'Use an existing config in place. Changes reach both.'),
      choice('copy', 'copy', 'Copy', 'Start from a copy. Independent afterwards.'),
      choice('new', 'plus', 'New', 'Empty settings, set up in this window.'),
    ),
  ]
  if (state.mode !== 'new') {
    const options = [...state.sources]
    if (state.source !== undefined && options.every((s) => s.path !== state.source)) {
      options.push({ label: 'Chosen file', detail: '', path: state.source })
    }
    parts.push(
      el(
        'div',
        { class: 'sources' },
        state.loading ? el('div', { class: 'note', html: `<span class="spinner"></span> Looking for Light Code settings on this machine…` }) : null,
        ...options.map((s) =>
          el(
            'button',
            {
              class: `source${state.source === s.path ? ' selected' : ''}`,
              title: s.path,
              onclick: () => {
                state.source = s.path
                rerender()
              },
            },
            el('span', { class: 'radio' }),
            el('span', { class: 'meta' }, el('b', { text: s.label }), el('span', { text: [s.detail, s.path].filter(Boolean).join(' · ') })),
          ),
        ),
        !state.loading && options.length === 0
          ? el('div', { class: 'note', html: `${svg(ICONS.info)}<span>No Light Code settings were found on this machine. Choose a file, or start with New.</span>` })
          : null,
        el('div', {}, el('button', { class: 'link', text: 'Choose a config.json…', onclick: () => send('pickConfig') })),
      ),
    )
    parts.push(
      el('div', {
        class: 'note',
        html: `${svg(ICONS.key)}<span>API keys and passwords are not inside a config file. Ones kept by VS Code cannot be read by another app, so enter each once in this window's Settings — Sun then shares it with every codebase.</span>`,
      }),
    )
  }
  return parts
}

function openAdd() {
  showModal('add', (scrim, modal) => {
    const state = { folder: undefined, name: '', mode: 'new', source: undefined, sources: [], recent: [], loading: true, busy: false }
    const card = el('div', { class: 'modal' })
    scrim.append(card)
    const render = () => {
      const folderPart =
        state.folder === undefined
          ? [
              el(
                'button',
                { class: 'folder-drop', onclick: () => send('pickFolder') },
                el('span', { html: svg(ICONS.folder) }),
                el('b', { text: 'Choose a folder…' }),
                el('span', { text: 'Any codebase on this machine — nothing is copied or moved.' }),
              ),
              state.recent.length > 0 ? el('label', { class: 'field-label', text: 'Recent projects' }) : null,
              state.recent.length > 0
                ? el(
                    'div',
                    { class: 'recent' },
                    ...state.recent.map((r) =>
                      el(
                        'button',
                        { class: 'recent-row', title: r.path, onclick: () => modal.onFolder({ path: r.path, name: r.name, hasWorkspaceConfig: false }) },
                        avatar(r.name),
                        el('span', { class: 'meta' }, el('b', { text: r.name }), el('span', { text: r.path })),
                        el('span', { class: 'tag', text: r.from }),
                      ),
                    ),
                  )
                : null,
            ]
          : [
              el(
                'div',
                { class: 'folder-card' },
                avatar(state.name || '?'),
                el('span', { class: 'path' }, el('b', { text: state.name }), el('span', { text: state.folder })),
                el('button', { class: 'secondary', text: 'Change', onclick: () => send('pickFolder') }),
              ),
              el('label', { class: 'field-label', text: 'Name' }),
              (() => {
                const input = el('input', { type: 'text', value: state.name, placeholder: 'Shown in the sidebar' })
                input.addEventListener('input', () => {
                  state.name = input.value
                })
                return input
              })(),
              state.hasWorkspaceConfig
                ? el('div', { class: 'note ok', html: `${svg(ICONS.check)}<span>This folder has its own <b>.lightcode/config.json</b>; its project settings are used automatically.</span>` })
                : null,
              el('label', { class: 'field-label', text: 'Light Code settings' }),
              ...configChooser(state, render),
            ]

      const ready = state.folder !== undefined && (state.mode === 'new' || state.source !== undefined) && !state.busy
      card.replaceChildren(
        el('header', {}, el('h2', { text: 'Add a codebase' }), el('p', { class: 'sub', text: 'It gets its own Light Code agent, running beside the others.' })),
        el('div', { class: 'body' }, ...folderPart),
        el(
          'footer',
          {},
          el('span', { class: 'spacer' }),
          el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }),
          el('button', {
            class: 'primary',
            text: state.busy ? 'Adding…' : 'Add codebase',
            disabled: !ready,
            onclick: () => {
              state.busy = true
              render()
              send('add', { path: state.folder, name: state.name, mode: state.mode, source: state.mode === 'new' ? null : state.source })
              setTimeout(() => {
                state.busy = false
                if (openModal === modal) render()
              }, 4000)
            },
          }),
        ),
      )
    }
    modal.onFolder = (m) => {
      if (m.existingId) {
        closeModal()
        select(m.existingId)
        notice(`${m.name} is already in Sun.`)
        return
      }
      state.folder = m.path
      state.name = m.name
      state.hasWorkspaceConfig = m.hasWorkspaceConfig
      render()
    }
    modal.onConfigFile = (path) => {
      state.source = path
      if (state.mode === 'new') state.mode = 'link'
      render()
    }
    modal.onSources = (m) => {
      state.sources = m.sources
      state.recent = m.recent
      state.loading = false
      if (state.sources.length > 0 && state.mode === 'new' && state.source === undefined) {
        state.mode = 'link'
        state.source = state.sources[0].path
      }
      render()
    }
    render()
    send('sources')
  })
}

function openConfigChooser(project) {
  showModal('config', (scrim, modal) => {
    const state = {
      mode: project.configMode,
      source: project.configSource ?? undefined,
      sources: [],
      loading: true,
    }
    const card = el('div', { class: 'modal' })
    scrim.append(card)
    const render = () => {
      card.replaceChildren(
        el('header', {}, el('h2', { text: `Settings source — ${project.name}` }), el('p', { class: 'sub', text: `Now: ${project.configMode === 'new' ? 'its own settings' : `${project.configMode === 'link' ? 'linked to' : 'copied from'} ${project.configSource}`}` })),
        el('div', { class: 'body' }, ...configChooser(state, render), state.mode === 'copy' ? el('div', { class: 'note', html: `${svg(ICONS.info)}<span>Copying replaces this codebase's own settings file. The current one is kept beside it as a backup.</span>` }) : null),
        el(
          'footer',
          {},
          el('span', { class: 'spacer' }),
          el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }),
          el('button', {
            class: 'primary',
            text: 'Apply and restart agent',
            disabled: state.mode !== 'new' && state.source === undefined,
            onclick: () => {
              send('changeConfig', { id: project.id, mode: state.mode, source: state.mode === 'new' ? null : state.source })
              closeModal()
            },
          }),
        ),
      )
    }
    modal.onConfigFile = (path) => {
      state.source = path
      render()
    }
    modal.onSources = (m) => {
      // Not offered its own file as a source.
      state.sources = m.sources.filter((s) => s.path.toLowerCase() !== project.configFile.toLowerCase())
      state.loading = false
      render()
    }
    render()
    send('sources')
  })
}

function openSettings() {
  showModal('settings', (scrim, modal) => {
    const card = el('div', { class: 'modal', style: 'width: min(560px, calc(100vw - 48px))' })
    scrim.append(card)
    const patch = (changes) => {
      Object.assign(model.settings, changes)
      send('settings', { patch: changes })
      modal.refresh()
    }
    const toggle = (on, change) => el('button', { class: `toggle${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), onclick: () => change(!on) })
    modal.refresh = () => {
      const s = model.settings
      const sleepOptions = [
        [0, 'Never'],
        [15, '15 min'],
        [30, '30 min'],
        [60, '1 hour'],
        [120, '2 hours'],
      ]
      const current = appearance()
      const hexInput = el('input', { type: 'text', value: current.accent, 'aria-label': 'Accent colour', spellcheck: 'false' })
      hexInput.addEventListener('change', () => {
        const typed = hexInput.value.trim()
        const value = typed.startsWith('#') ? typed : '#' + typed
        if (validHex(value)) patch({ accent: value.toLowerCase() })
        else {
          hexInput.value = current.accent
          notice('An accent colour is six hex digits, like #f26b1d.', 'error')
        }
      })
      card.replaceChildren(
        el('header', {}, el('h2', { text: 'Settings' }), el('p', { class: 'sub', text: `Sun Code ${model.version}` })),
        el(
          'div',
          { class: 'body' },
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'meta' }, el('b', { text: 'Theme' }), el('span', { text: "Sun and every codebase's chat follow it." })),
            el(
              'div',
              { class: 'segmented' },
              ...[
                ['system', 'System'],
                ['light', 'Light'],
                ['dark', 'Dark'],
              ].map(([value, label]) => el('button', { class: current.theme === value ? 'on' : '', text: label, onclick: () => patch({ theme: value }) })),
            ),
          ),
          el(
            'div',
            { class: 'row stacked' },
            el('span', { class: 'meta' }, el('b', { text: 'Accent colour' }), el('span', { text: "Buttons, selection and your messages, in Sun and every chat. Role colours stay each chat's own." })),
            el(
              'div',
              { class: 'swatches' },
              ...ACCENTS.map((hex) =>
                el('button', { class: 'swatch' + (current.accent === hex ? ' on' : ''), style: 'background: ' + hex, title: hex, 'aria-label': hex, onclick: () => patch({ accent: hex }) }),
              ),
              hexInput,
            ),
          ),
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'meta' }, el('b', { text: 'Sleep idle codebases after' }), el('span', { text: 'Frees memory. Never while an agent is working or waiting for you. A sleeping codebase is woken in time for its schedules.' })),
            el(
              'div',
              { class: 'segmented' },
              ...sleepOptions.map(([value, label]) =>
                el('button', { class: s.sleepMinutes === value ? 'on' : '', text: label, onclick: () => patch({ sleepMinutes: value }) }),
              ),
            ),
          ),
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'meta' }, el('b', { text: 'Start recent codebases at launch' }), el('span', { text: 'They are ready before you click them.' })),
            toggle(s.startRecent, (on) => patch({ startRecent: on })),
          ),
          el(
            'div',
            { class: 'row' },
            el(
              'span',
              { class: 'meta' },
              el('b', { text: 'Reach beyond the codebase' }),
              el('span', { text: 'Agents may read any drive or shared folder, and write anywhere — asking you every time they write outside the codebase. Keys, passwords and Windows folders stay off-limits. Applies when a codebase next starts.' }),
            ),
            toggle(s.reachAnywhere !== false, (on) => patch({ reachAnywhere: on })),
          ),
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'meta' }, el('b', { text: 'Windows notifications' }), el('span', { text: 'When a background agent finishes, needs approval, or sends one with notify.' })),
            toggle(s.notifications, (on) => patch({ notifications: on })),
          ),
          el(
            'div',
            { class: 'row' },
            el(
              'span',
              { class: 'meta' },
              el('b', { text: 'Environment' }),
              el('span', { text: environmentSummary(s) }),
            ),
            el('button', { class: 'secondary', text: 'Edit…', onclick: openEnvironment }),
          ),
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'meta' }, el('b', { text: 'Data folder' }), el('span', { text: model.dataFolder })),
            el('button', { class: 'secondary', text: 'Open', onclick: () => send('openDataFolder') }),
          ),
          model.hasSource
            ? el(
                'div',
                { class: 'row' },
                el('span', { class: 'meta' }, el('b', { text: 'Export source code' }), el('span', { text: 'The whole Light Code repository this build was made from, as a zip that builds offline.' })),
                el('button', { class: 'secondary', text: 'Export…', onclick: () => send('exportSource') }),
              )
            : null,
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'meta' }, el('b', { text: 'Keyboard' }), el('span', { html: '<kbd>Ctrl K</kbd> switch · <kbd>Ctrl N</kbd> add · <kbd>Ctrl B</kbd> sidebar · <kbd>Ctrl 1–9</kbd> jump · <kbd>Ctrl Tab</kbd> next · <kbd>Ctrl ,</kbd> settings' })),
          ),
        ),
        el('footer', {}, el('button', { class: 'primary', text: 'Done', onclick: closeModal })),
      )
    }
    modal.refresh()
  })
}

/** One line for the Settings row: what Sun adds to every agent's environment. */
function environmentSummary(s) {
  const folders = (s.pathPrefix ?? []).length
  const vars = (s.env ?? []).length
  const script = s.startupScript ? 1 : 0
  if (folders === 0 && vars === 0 && script === 0) return 'A startup script, folders to put on PATH and variables for every agent. None set.'
  const parts = []
  if (script) parts.push('startup script')
  if (folders > 0) parts.push(`${folders} folder${folders === 1 ? '' : 's'} on PATH`)
  if (vars > 0) parts.push(`${vars} variable${vars === 1 ? '' : 's'}`)
  return `${parts.join(' · ')} — given to every agent Sun starts.`
}

/**
 * Settings → Environment. Edited as a draft and saved as a whole, because Rust validates it as a
 * whole (a name listed twice is a property of the list). Values typed here are stored in Sun's
 * state file; a secret should come from a saved credential instead, which is resolved each time an
 * agent starts and never written here.
 */
function openEnvironment() {
  showModal('environment', (scrim, modal) => {
    const card = el('div', { class: 'modal', style: 'width: min(640px, calc(100vw - 48px))' })
    scrim.append(card)
    const draft = {
      script: model.settings.startupScript ?? '',
      folders: [...(model.settings.pathPrefix ?? [])],
      env: (model.settings.env ?? []).map((v) => ({ ...v })),
    }
    let status = {}
    let error
    let result
    send('credentials')
    if (draft.folders.length > 0) send('checkFolders', { pathPrefix: draft.folders })

    // Every credential field a variable can take: one for a secret, two for a login.
    const choices = () =>
      (model.credentials ?? []).flatMap((c) =>
        c.kind === 'login'
          ? [
              { value: `${c.id}#username`, label: `${c.label} — username` },
              { value: `${c.id}#password`, label: `${c.label} — password` },
            ]
          : [{ value: `${c.id}#value`, label: c.label }],
      )

    const iconButton = (title, icon, onclick, disabled = false) =>
      el('button', { class: 'icon-btn small', title, 'aria-label': title, html: svg(ICONS[icon]), disabled, onclick })

    const folderRows = () =>
      draft.folders.map((folder, index) => {
        const input = el('input', { type: 'text', value: folder, placeholder: 'C:\\tools\\bin  or  %USERPROFILE%\\bin', 'aria-label': `PATH folder ${index + 1}`, spellcheck: 'false' })
        input.addEventListener('input', () => (draft.folders[index] = input.value))
        input.addEventListener('change', () => send('checkFolders', { pathPrefix: draft.folders }))
        const known = status[folder.trim()]
        return el(
          'div',
          { class: 'env-row' },
          el('span', { class: 'env-order', text: String(index + 1) }),
          input,
          el('button', { class: 'secondary', text: 'Browse…', onclick: () => send('pickEnvFolder', { index }) }),
          iconButton('Move up', 'up', () => {
            ;[draft.folders[index - 1], draft.folders[index]] = [draft.folders[index], draft.folders[index - 1]]
            render()
          }, index === 0),
          iconButton('Remove', 'close', () => {
            draft.folders.splice(index, 1)
            render()
          }),
          known !== undefined && !known.exists
            ? el('div', { class: 'env-warning', text: `Not found${known.expanded !== folder.trim() ? ` (${known.expanded})` : ''} — kept, in case it is a share that is offline.` })
            : null,
        )
      })

    const varRows = () =>
      draft.env.map((v, index) => {
        const name = el('input', { type: 'text', value: v.name, placeholder: 'NAME', 'aria-label': `Variable ${index + 1} name`, spellcheck: 'false', class: 'env-name' })
        name.addEventListener('input', () => (v.name = name.value))
        const fromCredential = v.credential !== undefined
        const mode = el('div', { class: 'segmented small' },
          el('button', { class: fromCredential ? '' : 'on', text: 'Value', onclick: () => { v.value = v.value ?? ''; delete v.credential; render() } }),
          el('button', { class: fromCredential ? 'on' : '', text: 'Saved credential', onclick: () => { v.credential = v.credential ?? choices()[0]?.value ?? ''; delete v.value; render() } }),
        )
        let field
        if (fromCredential) {
          const options = choices()
          field =
            options.length === 0
              ? el('span', { class: 'env-hint', text: 'No saved credentials yet — add one on the Credentials page.' })
              : el('select', { 'aria-label': `Variable ${index + 1} credential`, class: 'env-select' },
                  ...options.map((o) => el('option', { value: o.value, text: o.label, selected: o.value === v.credential })),
                )
          if (field.tagName === 'SELECT') {
            if (!options.some((o) => o.value === v.credential)) v.credential = options[0].value
            field.addEventListener('change', () => (v.credential = field.value))
          }
        } else {
          field = el('input', { type: 'text', value: v.value ?? '', placeholder: 'value', 'aria-label': `Variable ${index + 1} value`, spellcheck: 'false' })
          field.addEventListener('input', () => (v.value = field.value))
        }
        return el('div', { class: 'env-row var' }, name, mode, field, iconButton('Remove', 'close', () => { draft.env.splice(index, 1); render() }))
      })

    // What the script left last time it ran: names only - a script may set a token.
    const scriptLine = () => {
      const st = model.scriptStatus
      if (st === undefined || st.state === 'none') return null
      if (st.state === 'running') return el('div', { class: 'note', html: '<span class="spinner"></span><span>Running the startup script… agents wait for it.</span>' })
      if (st.state === 'failed') return el('div', { class: 'form-error', style: 'white-space: pre-wrap', text: st.detail })
      const names = st.names ?? []
      const what = [names.length > 0 ? `set ${names.join(', ')}` : '', st.pathChanged ? 'changed PATH' : ''].filter(Boolean).join(' and ') || 'changed nothing'
      return el('div', { class: st.exitCode === 0 ? 'note ok' : 'form-error' },
        el('span', { text: `Last run ${st.exitCode === 0 ? '' : `(exit code ${st.exitCode}) `}${what}.` }),
      )
    }
    const scriptInput = () => {
      const input = el('input', { type: 'text', value: draft.script, placeholder: 'C:\\team\\setenv.cmd  or  %USERPROFILE%\\setup.ps1', 'aria-label': 'Startup script', spellcheck: 'false' })
      input.addEventListener('input', () => (draft.script = input.value))
      return el('div', { class: 'env-row' }, input,
        el('button', { class: 'secondary', text: 'Browse…', onclick: () => send('pickScript') }),
        el('button', { class: 'secondary', text: 'Run now', disabled: (model.settings.startupScript ?? '') === '' || model.scriptStatus?.state === 'running', title: 'Runs the saved script again', onclick: () => send('runScript') }),
      )
    }

    const render = () => {
      card.replaceChildren(
        el('header', {}, el('h2', { text: 'Environment' }), el('p', { class: 'sub', text: 'Given to every agent Sun starts, in every codebase and chat.' })),
        el(
          'div',
          { class: 'body' },
          el('label', { class: 'field-label', text: 'Startup script' }),
          el('p', { class: 'env-hint', text: 'A .cmd, .bat or .ps1 run when Sun starts. The variables it sets and the folders it adds to PATH are given to every codebase\'s agents; it cannot change Sun itself. It must finish on its own — nothing can answer a pause or a prompt. The variables below are applied after it, so they win.' }),
          scriptInput(),
          scriptLine(),
          el('label', { class: 'field-label', text: 'Folders put in front of PATH' }),
          el('p', { class: 'env-hint', text: 'Searched first, in this order, before the PATH Sun was started with — so a tool here wins over another copy. Python tools and MCP servers see these too. %NAME% expands.' }),
          ...folderRows(),
          el('button', { class: 'secondary', text: 'Add folder', onclick: () => { draft.folders.push(''); render() } }),
          el('label', { class: 'field-label', text: 'Variables' }),
          el('p', { class: 'env-hint', text: 'Every command an agent runs sees these — so can the model, if a command prints them. Python tools and MCP servers do not, unless their own settings name them. Use a saved credential for anything secret: a typed value is stored in Sun\'s settings file.' }),
          ...varRows(),
          el('button', { class: 'secondary', text: 'Add variable', onclick: () => { draft.env.push({ name: '', value: '' }); render() } }),
          error !== undefined ? el('div', { class: 'form-error', text: error }) : null,
          result !== undefined && result.running > 0
            ? el('div', { class: 'note ok', html: `${svg(ICONS.check)}<span>Saved. ${result.running} agent${result.running === 1 ? ' is' : 's are'} running with the old environment.</span>` },
                el('button', { class: 'secondary', text: 'Restart them', onclick: () => { send('restartAll'); result = undefined; render() } }))
            : result !== undefined
              ? el('div', { class: 'note ok', html: `${svg(ICONS.check)}<span>Saved. Agents get it the next time they start.</span>` })
              : null,
        ),
        el(
          'footer',
          {},
          el('span', { class: 'spacer' }),
          el('button', { class: 'secondary', text: 'Close', onclick: closeModal }),
          el('button', {
            class: 'primary',
            text: 'Save',
            onclick: () => {
              error = undefined
              result = undefined
              const env = draft.env.map((v) => (v.credential !== undefined ? { name: v.name, credential: v.credential } : { name: v.name, value: v.value ?? '' }))
              send('saveEnvironment', { pathPrefix: draft.folders, env, startupScript: draft.script.trim() === '' ? null : draft.script.trim() })
            },
          }),
        ),
      )
    }
    modal.saved = (m) => {
      if (m.ok) {
        result = m
        error = undefined
        if (m.folders !== undefined) status = Object.fromEntries(m.folders.map((f) => [f.path.trim(), f]))
      } else error = m.error
      render()
    }
    modal.scriptPicked = (path) => {
      draft.script = path
      render()
    }
    modal.folders = (folders) => {
      status = Object.fromEntries(folders.map((f) => [f.path.trim(), f]))
      render()
    }
    modal.picked = (index, path) => {
      draft.folders[index] = path
      send('checkFolders', { pathPrefix: draft.folders })
      render()
    }
    // A credential list arriving while open fills the pickers.
    modal.refresh = render
    render()
  })
}

function openSwitcher() {
  if (model.projects.length === 0) return openAdd()
  showModal('switcher', (scrim) => {
    let cursor = 0
    let matches = model.projects
    const input = el('input', { type: 'text', placeholder: 'Go to a codebase…', 'aria-label': 'Codebase' })
    const results = el('div', { class: 'results', role: 'listbox' })
    const render = () => {
      const q = input.value.trim().toLowerCase()
      matches = model.projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      cursor = Math.min(cursor, Math.max(0, matches.length - 1))
      results.replaceChildren(
        ...(matches.length === 0
          ? [el('div', { class: 'empty-result', text: 'No codebase matches.' })]
          : matches.map((p, i) => {
              const face = avatar(p.name, "", accentOf(p))
              face.append(el('span', { class: `dot ${dotClass(p.id)}` }))
              return el(
                'button',
                {
                  class: `item${i === cursor ? ' cursor' : ''}`,
                  onclick: () => {
                    closeModal()
                    select(p.id)
                  },
                },
                face,
                el('span', { class: 'item-text' }, el('span', { class: 'item-name', text: p.name }), el('span', { class: 'item-sub', text: describe(p)[0] })),
              )
            })),
      )
    }
    input.addEventListener('input', () => {
      cursor = 0
      render()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') cursor = Math.min(cursor + 1, matches.length - 1)
      else if (e.key === 'ArrowUp') cursor = Math.max(cursor - 1, 0)
      else if (e.key === 'Enter' && matches[cursor] !== undefined) {
        const id = matches[cursor].id
        closeModal()
        select(id)
        return
      } else return
      e.preventDefault()
      render()
    })
    scrim.append(el('div', { class: 'modal switcher' }, input, results))
    render()
    input.focus()
  })
}

// ─── Credentials ─────────────────────────────────────────────────────────────
//
// Saved once, used by any codebase: every secret field in a codebase's Light Code settings offers
// "Use a saved credential". Write-only: values go to Sun and are never shown again - replacing is
// typing a new one. Where each is used comes from the vault, so deleting one says what will stop.

function openCredentials() {
  showModal('credentials', (scrim, modal) => {
    const card = el('div', { class: 'modal', style: 'width: min(640px, calc(100vw - 48px))' })
    scrim.append(card)
    let editing // undefined = list; {} = new; credential = change that one
    let error
    const kinds = [
      ['secret', 'Key or token'],
      ['login', 'Username and password'],
    ]

    const form = () => {
      const isNew = editing.id === undefined
      const draft = { label: editing.label ?? '', kind: editing.kind ?? 'secret', note: editing.note ?? '', values: {} }
      const fieldsFor = (kind) => (kind === 'login' ? [['username', 'Username'], ['password', 'Password']] : [['value', 'Value']])
      const body = el('div', { class: 'body' })
      const renderBody = () => {
        const label = el('input', { type: 'text', value: draft.label, placeholder: 'Corp LDAP, DeepSeek key…', 'aria-label': 'Name' })
        label.addEventListener('input', () => (draft.label = label.value))
        const note = el('input', { type: 'text', value: draft.note, placeholder: 'Optional — what it is for', 'aria-label': 'Note' })
        note.addEventListener('input', () => (draft.note = note.value))
        body.replaceChildren(
          el('label', { class: 'field-label', text: 'Name' }),
          label,
          el('label', { class: 'field-label', text: 'Kind' }),
          el(
            'div',
            { class: 'segmented' },
            ...kinds.map(([value, text]) =>
              el('button', {
                class: draft.kind === value ? 'on' : '',
                text,
                disabled: !isNew && draft.kind !== value,
                onclick: () => {
                  draft.kind = value
                  renderBody()
                },
              }),
            ),
          ),
          ...fieldsFor(draft.kind).flatMap(([field, text]) => {
            const input = el('input', {
              type: field === 'username' ? 'text' : 'password',
              placeholder: isNew ? '' : 'Saved — leave blank to keep it',
              autocomplete: 'off',
              spellcheck: 'false',
              'aria-label': text,
            })
            input.value = draft.values[field] ?? ''
            input.addEventListener('input', () => (draft.values[field] = input.value))
            return [el('label', { class: 'field-label', text }), input]
          }),
          el('label', { class: 'field-label', text: 'Note' }),
          note,
          error !== undefined ? el('div', { class: 'form-error', text: error }) : null,
        )
        requestAnimationFrame(() => label.focus())
      }
      renderBody()
      card.replaceChildren(
        el('header', {}, el('h2', { text: isNew ? 'New credential' : `Change ${editing.label}` }), el('p', { class: 'sub', text: 'Stored encrypted for your Windows account. It cannot be shown again once saved.' })),
        body,
        el(
          'footer',
          {},
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'secondary',
            text: 'Back',
            onclick: () => {
              editing = undefined
              error = undefined
              modal.refresh()
            },
          }),
          el('button', {
            class: 'primary',
            text: 'Save',
            onclick: () => {
              error = undefined
              send('saveCredential', { id: editing.id ?? null, label: draft.label, kind: draft.kind, note: draft.note, values: draft.values })
            },
          }),
        ),
      )
    }

    const list = () => {
      const credentials = model.credentials ?? []
      const rows = credentials.map((c) =>
        el(
          'div',
          { class: 'credential' },
          el('span', { class: 'glyph', html: svg(ICONS.key) }),
          el(
            'span',
            { class: 'meta' },
            el('b', { text: c.label }),
            el('span', { class: 'tag', style: 'margin-left: 8px', text: c.kind === 'login' ? 'Username and password' : 'Key or token' }),
            c.note ? el('span', { class: 'detail', text: c.note }) : null,
            el('span', {
              class: 'detail',
              text: c.usedBy.length > 0 ? `Used by: ${c.usedBy.join(' · ')}` : 'Not used yet — pick it in any codebase\'s settings.',
            }),
            c.complete ? null : el('span', { class: 'detail warn', text: 'Has no value stored — change it to add one.' }),
          ),
          el(
            'span',
            { class: 'actions' },
            el('button', {
              class: 'secondary',
              text: 'Change',
              onclick: () => {
                editing = c
                form()
              },
            }),
            el('button', {
              class: 'icon-btn',
              title: 'Delete',
              'aria-label': `Delete ${c.label}`,
              html: svg(ICONS.remove),
              onclick: () => confirmDelete(c),
            }),
          ),
        ),
      )
      card.replaceChildren(
        el('header', {}, el('h2', { text: 'Credentials' }), el('p', { class: 'sub', text: 'Saved once, used by every codebase: each key or password field in a codebase\'s settings can pick one by name. Encrypted for your Windows account; values are never shown again.' })),
        el(
          'div',
          { class: 'body' },
          rows.length > 0
            ? el('div', {}, ...rows)
            : el('div', { class: 'note', html: `${svg(ICONS.key)}<span>No saved credentials yet. Add one here, press <b>From IntelliJ / PyCharm</b> below, or in VS Code run <b>Light Code: Share API keys with Sun Code</b> to bring every key over at once.</span>` }),
          rows.length > 0
            ? el('div', { class: 'note', html: `${svg(ICONS.info)}<span>Keys from VS Code: run <b>Light Code: Share API keys with Sun Code</b> in VS Code while Sun is open.</span>` })
            : null,
        ),
        el(
          'footer',
          {},
          el('button', {
            class: 'secondary',
            text: 'New credential',
            onclick: () => {
              editing = {}
              form()
            },
          }),
          el('button', { class: 'secondary', text: 'Import…', onclick: () => send('chooseCredentialImport') }),
          el('button', { class: 'secondary', text: 'From IntelliJ / PyCharm', title: 'Bring in the keys Light Code keeps for IntelliJ and PyCharm on this computer', onclick: () => send('scanJetBrains') }),
          rows.length > 0 ? el('button', { class: 'secondary', text: 'Export…', onclick: () => { error = undefined; exportForm() } }) : null,
          el('span', { class: 'spacer' }),
          el('button', { class: 'primary', text: 'Done', onclick: closeModal }),
        ),
      )
    }

    const confirmDelete = (c) => {
      card.replaceChildren(
        el('header', {}, el('h2', { text: `Delete ${c.label}?` })),
        el(
          'div',
          { class: 'body' },
          el('p', {
            class: 'sub',
            text:
              c.usedBy.length > 0
                ? `These stop working until they are given another credential or a typed value: ${c.usedBy.join(' · ')}.`
                : 'Nothing uses it. Its value is removed from the vault.',
          }),
        ),
        el(
          'footer',
          {},
          el('span', { class: 'spacer' }),
          el('button', { class: 'secondary', text: 'Cancel', onclick: () => modal.refresh() }),
          el('button', { class: 'primary', text: 'Delete', onclick: () => send('deleteCredential', { id: c.id }) }),
        ),
      )
    }

    // Export: pick credentials and a passphrase. The file opens only with that passphrase.
    // Nothing is ticked to begin with: what leaves this machine is chosen, one label at a time.
    const exportForm = (preselect = []) => {
      const credentials = model.credentials ?? []
      // Kept across a re-render (a failed passphrase check redraws the form).
      const chosen = editing?.export && editing.chosen !== undefined ? editing.chosen : new Set(preselect)
      const pass = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Passphrase' })
      const again = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Passphrase again' })
      const filter = el('input', { type: 'text', placeholder: 'Filter by label', 'aria-label': 'Filter credentials', spellcheck: 'false' })
      const count = el('span', { class: 'export-count' })
      const go = el('button', { class: 'primary', text: 'Export…' })
      const rows = credentials.map((c) => {
        const box = el('input', { type: 'checkbox', checked: chosen.has(c.id) })
        box.addEventListener('change', () => {
          if (box.checked) chosen.add(c.id)
          else chosen.delete(c.id)
          update()
        })
        const row = el('label', { class: 'row export-row' }, box,
          el('span', { class: 'meta' }, el('b', { text: c.label }), el('span', { text: c.kind === 'login' ? 'Username and password' : 'Secret' })))
        return { id: c.id, label: c.label.toLowerCase(), row, box }
      })
      const update = () => {
        count.textContent = `${chosen.size} of ${credentials.length} chosen`
        go.disabled = chosen.size === 0
        go.textContent = chosen.size === 0 ? 'Export…' : `Export ${chosen.size}…`
      }
      filter.addEventListener('input', () => {
        const q = filter.value.trim().toLowerCase()
        for (const r of rows) r.row.hidden = q !== '' && !r.label.includes(q)
      })
      go.addEventListener('click', () => {
        if (chosen.size === 0) return modal.failed('Choose at least one credential.')
        if (pass.value !== again.value) return modal.failed('The two passphrases differ.')
        if ([...pass.value].length < 12) return modal.failed('Use a passphrase of at least 12 characters.')
        error = undefined
        send('exportCredentials', { ids: [...chosen], passphrase: pass.value })
      })
      update()
      editing = { export: true, chosen }
      card.replaceChildren(
        el('header', {}, el('h2', { text: 'Export credentials' }), el('p', { class: 'sub', text: 'For another computer or a colleague. The file is encrypted with the passphrase you choose — it is only as safe as that passphrase, so send the two separately.' })),
        el(
          'div',
          { class: 'body' },
          el('label', { class: 'field-label', text: 'Credentials to export' }),
          filter,
          el('div', { class: 'export-tools' }, count, el('span', { class: 'spacer' }),
            el('button', { class: 'link', text: 'Select shown', onclick: () => { for (const r of rows) if (!r.row.hidden) { r.box.checked = true; chosen.add(r.id) } update() } }),
            el('button', { class: 'link', text: 'Clear', onclick: () => { chosen.clear(); for (const r of rows) r.box.checked = false; update() } }),
          ),
          el('div', { class: 'export-list' }, ...rows.map((r) => r.row)),
          el('label', { class: 'field-label', text: 'Passphrase (at least 12 characters)' }),
          pass,
          el('label', { class: 'field-label', text: 'Passphrase again' }),
          again,
          error !== undefined ? el('div', { class: 'form-error', text: error }) : null,
        ),
        el(
          'footer',
          {},
          el('span', { class: 'spacer' }),
          el('button', { class: 'secondary', text: 'Back', onclick: () => modal.saved() }),
          go,
        ),
      )
    }
    const importPassphrase = (file) => {
      editing = { importing: true, file }
      const pass = el('input', { type: 'password', 'aria-label': 'Passphrase' })
      card.replaceChildren(
        el('header', {}, el('h2', { text: 'Import credentials' }), el('p', { class: 'sub', text: file })),
        el('div', { class: 'body' }, el('label', { class: 'field-label', text: 'Passphrase the file was exported with' }), pass, error !== undefined ? el('div', { class: 'form-error', text: error }) : null),
        el(
          'footer',
          {},
          el('span', { class: 'spacer' }),
          el('button', { class: 'secondary', text: 'Cancel', onclick: () => modal.saved() }),
          el('button', { class: 'primary', text: 'Open', onclick: () => send('openCredentialImport', { passphrase: pass.value }) }),
        ),
      )
      requestAnimationFrame(() => pass.focus())
    }
    const importPreview = (items, command = 'importCredentials', title = 'Import credentials') => {
      editing = { importing: true }
      error = undefined
      const chosen = new Set(items.map((_, i) => i))
      card.replaceChildren(
        el('header', {}, el('h2', { text: title }), el('p', { class: 'sub', text: 'Choose which to bring in. One with the same name as a credential here replaces its value. Values are never shown.' })),
        el(
          'div',
          { class: 'body' },
          ...items.map((item, i) => {
            const box = el('input', { type: 'checkbox', checked: true })
            box.addEventListener('change', () => (box.checked ? chosen.add(i) : chosen.delete(i)))
            return el(
              'label',
              { class: 'row', style: 'padding: 6px 0' },
              box,
              el('span', { class: 'meta' }, el('b', { text: item.label }), el('span', { text: item.exists ? 'Replaces the value of the one here' : 'New' })),
            )
          }),
        ),
        el(
          'footer',
          {},
          el('span', { class: 'spacer' }),
          el('button', { class: 'secondary', text: 'Cancel', onclick: () => modal.saved() }),
          el('button', { class: 'primary', text: 'Import', onclick: () => send(command, { indexes: [...chosen] }) }),
        ),
      )
    }
    modal.askPassphrase = (file) => importPassphrase(file)
    modal.preview = (items, command, title) => importPreview(items, command, title)

    modal.refresh = () => (editing === undefined ? list() : editing.export ? exportForm() : editing.importing ? undefined : form())
    modal.saved = () => {
      editing = undefined
      error = undefined
      list()
    }
    modal.failed = (text) => {
      error = text
      if (editing?.export) exportForm()
      else if (editing?.importing) importPassphrase(editing.file ?? '')
      else if (editing !== undefined) form()
      else notice(text, 'error')
    }
    list()
    send('credentials')
  })
}

// ─── Notices ─────────────────────────────────────────────────────────────────

function notice(text, level = 'info') {
  const node = el('div', { class: `notice ${level}`, text })
  $('#notices').append(node)
  setTimeout(() => node.remove(), level === 'error' ? 9000 : 5000)
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

for (const id of ['#add', '#add-small', '#rail-add', '#empty-add']) $(id).addEventListener('click', openAdd)
$('#search').addEventListener('click', openSwitcher)
$('#settings-btn').addEventListener('click', openSettings)
$('#rail-settings').addEventListener('click', openSettings)
$('#credentials-btn').addEventListener('click', openCredentials)
$('#rail-credentials').addEventListener('click', openCredentials)
document.addEventListener('contextmenu', (e) => {
  // The browser's own menu (Reload, Inspect) has nothing for anyone here.
  if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
})

send('ready')
