// Sun Light Code — the sidebar, the panes and the dialogs.
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
  alert: '<path d="M8 1.75 14.5 13.5h-13z"/><path d="M8 6.25v3.5M8 11.6v.01"/>',
}

// ─── Bridge to Rust ──────────────────────────────────────────────────────────

const send = (cmd, args = {}) => window.ipc.postMessage(JSON.stringify({ cmd, ...args }))

const model = {
  projects: [],
  statuses: {},
  urls: {},
  settings: {},
  active: undefined,
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
    delete model.urls[m.id]
    $(`.pane[data-id="${m.id}"]`)?.remove()
    if (model.active === m.id) {
      model.active = undefined
      const next = model.projects[0]
      if (next !== undefined) select(next.id)
    }
    renderEmpty()
  },
  select(m) {
    model.active = m.id
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
    renderList()
    renderPanes()
  },
  notice(m) {
    notice(m.text, m.level)
  },
  credentials(m) {
    model.credentials = m.credentials
    model.pipe = m.pipe
    if (openModal?.kind === 'credentials') openModal.refresh()
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
  const project = model.projects.find((p) => p.id === frame.closest('.pane')?.dataset.id)
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

/** What the row says under the name: the agent's state when it has one, otherwise where it lives. */
const describe = (project) => {
  const s = statusOf(project.id)
  if (project.missing) return ['Folder not found', 'failed']
  if (s.phase === 'failed') return ['Agent stopped — open to see why', 'failed']
  if (s.phase === 'starting') return ['Starting…', 'busy']
  if (s.phase === 'sleeping') return ['Sleeping to save memory', '']
  if (s.phase === 'running' && s.agent === 'attention') return ['Needs your approval', 'attention']
  if (s.phase === 'running' && s.agent === 'busy') return ['Working…', 'busy']
  return [shortPath(project.path), '']
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
      const s = statusOf(p.id)
      const face = avatar(p.name, '', accentOf(p))
      face.append(el('span', { class: `dot ${dotClass(p.id)}` }))
      const row = el(
        'button',
        {
          class: `item${p.id === model.active ? ' active' : ''}`,
          role: 'option',
          'aria-selected': String(p.id === model.active),
          'data-id': p.id,
          title: `${p.name}\n${p.path}${s.memory > 0 ? `\n${megabytes(s.memory)}` : ''}${index < 9 ? `\nCtrl+${index + 1}` : ''}`,
          draggable: 'true',
          onclick: () => select(p.id),
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
        s.unread && p.id !== model.active ? el('span', { class: 'unread', title: 'Something happened here' }) : null,
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
      const face = avatar(p.name, p.id === model.active ? 'active' : '', accentOf(p))
      face.append(el('span', { class: `dot ${dotClass(p.id)}` }))
      face.title = `${p.name} — ${describe(p)[0]}`
      face.addEventListener('click', () => select(p.id))
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
  if (model.projects.every((p) => p.id !== id)) return
  model.active = id
  send('select', { id })
  renderList()
  renderPanes()
  // Focus follows: typing goes straight into that codebase's composer.
  requestAnimationFrame(() => $(`.pane[data-id="${id}"] iframe`)?.focus())
}

function selectRelative(step) {
  if (model.projects.length === 0) return
  const at = model.projects.findIndex((p) => p.id === model.active)
  const next = model.projects[(at + step + model.projects.length) % model.projects.length]
  select(next.id)
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
  for (const project of model.projects) {
    let pane = $(`.pane[data-id="${project.id}"]`, panes)
    if (pane === null) {
      pane = el('div', { class: 'pane', 'data-id': project.id })
      panes.append(pane)
    }
    pane.classList.toggle('active', project.id === model.active)

    const s = statusOf(project.id)
    const url = model.urls[project.id]
    let frame = $('iframe', pane)
    if (url !== undefined && s.phase === 'running') {
      if (frame === null) {
        frame = el('iframe', {
          title: `Light Code — ${project.name}`,
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
    renderPaneState(pane, project, s, frame !== null && s.phase === 'running')
  }
  for (const pane of panes.querySelectorAll('.pane')) {
    if (model.projects.every((p) => p.id !== pane.dataset.id)) pane.remove()
  }
}

function renderPaneState(pane, project, s, live) {
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
      el('div', { class: 'actions' }, el('button', { class: 'primary', text: want === 'sleeping' ? 'Wake up' : 'Start', onclick: () => send('start', { id: project.id }) })),
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
        el('button', { class: 'primary', text: 'Restart', onclick: () => send('restart', { id: project.id }) }),
        el('button', { class: 'secondary', text: 'Open log', onclick: () => send('openLog', { id: project.id }) }),
      ),
    )
  }
  pane.append(state)
}

// Messages from the chat panes: a state word or a shortcut, nothing else.
window.addEventListener('message', (event) => {
  const data = event.data
  if (data === null || typeof data !== 'object' || data.source !== 'light-code') return
  const project = model.projects.find((p) => $(`.pane[data-id="${p.id}"] iframe`)?.contentWindow === event.source)
  if (project === undefined) return
  const url = model.urls[project.id]
  if (url === undefined || new URL(url).origin !== event.origin) return
  if (typeof data.state === 'string' && ['idle', 'busy', 'attention'].includes(data.state)) {
    send('agentState', { id: project.id, state: data.state, finished: data.finished === true })
  }
  if (typeof data.shortcut === 'string') shortcut(data.shortcut)
  // An accent picked in that codebase's own Appearance tab, or null to follow Sun's again.
  if (data.accent === null || validHex(data.accent)) send('projectAccent', { id: project.id, accent: data.accent })
  if (data.ready === true) sendAppearance($(`.pane[data-id="${project.id}"] iframe`))
})

// ─── Shortcuts ───────────────────────────────────────────────────────────────

function shortcut(name) {
  if (name === 'b') return toggleSidebar()
  if (name === 'k') return openSwitcher()
  if (name === 'n') return openAdd()
  if (name === ',') return openSettings()
  if (name === 'tab') return selectRelative(1)
  if (name === 'shift+tab') return selectRelative(-1)
  if (/^[1-9]$/.test(name)) {
    const project = model.projects[Number(name) - 1]
    if (project !== undefined) select(project.id)
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
    if (['b', 'k', 'n', ',', 'tab'].includes(key) || /^[1-9]$/.test(key)) {
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
  const s = statusOf(project.id)
  const running = s.phase === 'running' || s.phase === 'starting'
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
    running
      ? item('sleep', 'Sleep now', () => send('sleep', { id: project.id }))
      : item('play', 'Start agent', () => send('start', { id: project.id })),
    item('restart', 'Restart agent', () => send('restart', { id: project.id })),
    item('pin', 'Keep awake', () => send('keepAwake', { id: project.id, on: !project.keepAwake }), { checked: project.keepAwake }),
    el('hr'),
    item('settings', 'Settings source…', () => openConfigChooser(project)),
    item('rename', 'Rename', () => startRename(project)),
    item('log', 'View agent log', () => send('openLog', { id: project.id })),
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
        el('header', {}, el('h2', { text: 'Settings' }), el('p', { class: 'sub', text: `Sun Light Code ${model.version}` })),
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
            el('span', { class: 'meta' }, el('b', { text: 'Sleep idle codebases after' }), el('span', { text: 'Frees memory. Never while an agent is working, waiting for you, or has schedules.' })),
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
            : el('div', { class: 'note', html: `${svg(ICONS.key)}<span>No saved credentials yet. Add one here, press <b>From IntelliJ / PyCharm</b> below, or in VS Code run <b>Light Code: Share API keys with Sun Light Code</b> to bring every key over at once.</span>` }),
          rows.length > 0
            ? el('div', { class: 'note', html: `${svg(ICONS.info)}<span>Keys from VS Code: run <b>Light Code: Share API keys with Sun Light Code</b> in VS Code while Sun is open.</span>` })
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
    const exportForm = () => {
      const credentials = model.credentials ?? []
      const chosen = new Set(credentials.map((c) => c.id))
      const pass = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Passphrase' })
      const again = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Passphrase again' })
      editing = { export: true }
      card.replaceChildren(
        el('header', {}, el('h2', { text: 'Export credentials' }), el('p', { class: 'sub', text: 'For another computer or a colleague. The file is encrypted with the passphrase you choose — it is only as safe as that passphrase, so send the two separately.' })),
        el(
          'div',
          { class: 'body' },
          ...credentials.map((c) => {
            const box = el('input', { type: 'checkbox', checked: true })
            box.addEventListener('change', () => (box.checked ? chosen.add(c.id) : chosen.delete(c.id)))
            return el('label', { class: 'row', style: 'padding: 6px 0' }, box, el('span', { class: 'meta' }, el('b', { text: c.label })))
          }),
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
          el('button', {
            class: 'primary',
            text: 'Export…',
            onclick: () => {
              if (pass.value !== again.value) return modal.failed('The two passphrases differ.')
              if ([...pass.value].length < 12) return modal.failed('Use a passphrase of at least 12 characters.')
              error = undefined
              send('exportCredentials', { ids: [...chosen], passphrase: pass.value })
            },
          }),
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
