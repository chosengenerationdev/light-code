// Fire Code — the sidebar, the panes and the dialogs.
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
/**
 * Disables a control and says why when hovered; `reason` undefined enables it again with its own title.
 * Asked for: a greyed control should tell you why. Its own title is remembered on first use.
 */
function why(node, reason) {
  if (node.dataset.enabledTitle === undefined) node.dataset.enabledTitle = node.getAttribute('title') ?? ''
  node.disabled = reason !== undefined
  if (reason !== undefined) node.title = reason
  else if (node.dataset.enabledTitle !== '') node.title = node.dataset.enabledTitle
  else node.removeAttribute('title')
  return node
}
const COG = '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'
const svg = (paths, extra = '') =>
  paths === 'cog' ? `<svg viewBox="0 0 24 24" class="cog" ${extra}>${COG}</svg>` :
  paths === 'key24' ? `<svg viewBox="0 0 24 24" class="cog" ${extra}><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>` : `<svg viewBox="0 0 16 16" ${extra}>${paths}</svg>`
const ICONS = {
  clock: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/>',
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
  push: '<circle cx="8" cy="11" r="2.25"/><path d="M8 8.75V2.5M5.5 5 8 2.5 10.5 5"/>',
  pull: '<path d="M8 2.5v7M5 6.5l3 3 3-3M3 12.5h10"/>',
  alert: '<path d="M8 1.75 14.5 13.5h-13z"/><path d="M8 6.25v3.5M8 11.6v.01"/>',
  archive: '<rect x="1.75" y="2.75" width="12.5" height="3" rx=".75"/><path d="M2.75 5.75v6.75c0 .41.34.75.75.75h9c.41 0 .75-.34.75-.75V5.75M6.5 8.5h3"/>',
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
  /** Git counts for JupyterHub codebases, reported by their own host: the repository is on the hub. */
  hubGit: {},
}

window.__sun = {
  receive(message) {
    const handler = HANDLERS[message.type]
    if (handler !== undefined) handler(message)
  },
  // For shell.test.ts: the branch label rule, held to the same cases as Light Code's.
  branchLabel: (name) => branchLabel(name),
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
  branches(m) {
    if (openModal?.kind === 'branch' && openModal.project === m.id) openModal.fill?.(m)
  },
  branchFailed(m) {
    if (openModal?.kind === 'branch' && openModal.project === m.id) openModal.fail?.(m.error)
    else notice(m.error, 'error')
  },
  branchCheck(m) {
    confirmCloseBranch(m)
  },
  url(m) {
    model.urls[m.id] = m.url
    renderPanes()
  },
  unload(m) {
    delete model.urls[m.id]
    parked.delete(m.id)
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
    if (['credentials', 'environment', 'add', 'hub'].includes(openModal?.kind)) openModal.refresh?.()
  },
  report(m) {
    if (openModal?.kind === 'report') openModal.show(m)
    else openReport(m)
  },
  reports(m) {
    if (openModal?.kind === 'reportList') openModal.list(m.reports)
  },
  fileSaved(m) {
    const frame = $(`.pane[data-id="${m.id}"] iframe`)
    const url = model.urls[m.id]
    if (frame?.contentWindow == null || url === undefined) return
    frame.contentWindow.postMessage({ source: 'sun', saved: { requestId: m.requestId, path: m.path, error: m.error } }, new URL(url).origin)
  },
  pathPicked(m) {
    const frame = $(`.pane[data-id="${m.id}"] iframe`)
    const url = model.urls[m.id]
    if (frame?.contentWindow == null || url === undefined) return
    frame.contentWindow.postMessage({ source: 'sun', picked: { purpose: m.purpose, path: m.path } }, new URL(url).origin)
  },
  instructions(m) {
    if (openModal?.kind === 'instructions' && openModal.projectId === m.id) openModal.onInstructions(typeof m.text === 'string' ? m.text : '')
  },
  instructionsSaved(m) {
    if (openModal?.kind === 'instructions' && openModal.projectId === m.id) openModal.onInstructionsSaved(m.ok === true, m.error)
    else if (m.ok !== true) notice(m.error || 'The instructions could not be saved.', 'error')
  },
  gitDone(m) {
    notice(m.text, m.ok ? 'info' : 'error')
    if (openModal?.kind === 'commit' && openModal.projectId === m.id) openModal.onGitDone(m.ok)
  },
  git(m) {
    const before = JSON.stringify(model.git ?? {})
    model.git = m.git ?? {}
    if (JSON.stringify(model.git) !== before && !busyEditing()) renderList()
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
// Fire Code's theme and accent, applied here and handed to every chat pane, which follows them (see
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
 * To one pane, addressed to its own origin only: Fire Code's theme, and the codebase's own accent when
 * it was given one in its Appearance tab, Fire Code's otherwise.
 */
function sendAppearance(frame) {
  const url = frame?.dataset.url
  if (url === undefined || frame.contentWindow === null) return
  const project = model.projects.find((p) => p.id === projectOf(frame.closest('.pane')?.dataset.id ?? ''))
  const own = validHex(project?.accent)
  const message = { ...appearance(), ...(own ? { accent: project.accent } : {}), own }
  frame.contentWindow.postMessage({ source: 'sun', appearance: message }, new URL(url).origin)
}

/** The accent a codebase is drawn in: its own, or Fire Code's. */
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
  if (!key.includes('~')) return p?.firstChatName ?? 'Chat 1'
  return p?.chats?.find((c) => `${p.id}~${c.id}` === key)?.name ?? 'Chat'
}
/**
 * The branch a chat works on: a branch chat's own, or - for the first chat - the codebase's current one.
 * Shown under the chat's name; renaming the chat never changes it.
 */
const chatBranch = (key) => {
  const p = model.projects.find((x) => x.id === projectOf(key))
  if (p === undefined) return undefined
  const chat = key.includes('~') ? p.chats?.find((c) => `${p.id}~${c.id}` === key) : undefined
  // A chat without a folder of its own works in the codebase's folder, so it is on the codebase's branch.
  return chat?.branch ?? gitOf(p)?.branch ?? undefined
}
/** A chat working in its own branch folder (a git worktree), which "Close branch" may remove. */
const isBranchChat = (key) => {
  const p = model.projects.find((x) => x.id === projectOf(key))
  return key.includes('~') && p?.chats?.find((c) => `${p.id}~${c.id}` === key)?.folder !== undefined
}
/**
 * A long branch name, trimmed - never through a leading Jira key, the part people look for. The same rule
 * as Light Code's packages/core/src/git/branchLabel.ts; shell.test.ts holds the two to the same cases.
 */
function branchLabel(branch, max = 28) {
  if (branch.length <= max) return branch
  const jira = /^([A-Za-z][A-Za-z0-9]+-\d+)([-_/].*)?$/.exec(branch)
  if (jira !== null) {
    const key = jira[1]
    const rest = (jira[2] ?? '').replace(/^[-_/]/, '')
    const room = Math.max(max - key.length - 2, 4)
    return rest.length === 0 ? key : `${key} ${rest.length > room ? `${rest.slice(0, room - 1)}…` : rest}`
  }
  return `${branch.slice(0, max - 1)}…`
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
    // Chats waiting for you, and what the first one waits for.
    waitingChats: all.filter((s) => s.phase === 'running' && s.agent === 'attention').length,
    waitingFor: all.find((s) => s.phase === 'running' && s.agent === 'attention')?.waiting,
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

/** The chat whose tab is being renamed: the tabs are not redrawn under the box while it is open. */
let renamingChat

function renderTabs() {
  if (renamingChat !== undefined) return
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
          class: `tab${k === key ? ' active' : ''}${s.phase === 'running' && s.agent === 'attention' ? ' waiting' : ''}`,
          role: 'tab',
          'aria-selected': String(k === key),
          title: k.includes('~')
            ? 'Double-click or right-click to rename · middle-click to close'
            : "The first chat, which runs this codebase's schedules · double-click or right-click to rename",
          'data-key': k,
          /*
           * Clicking the tab already open does nothing. It used to select it again, and selecting moves
           * focus into the chat on the next frame - so the second click of a double-click took focus
           * away from the rename box it had just opened, and the rename ended before anything was typed.
           */
          onclick: () => k !== model.active && select(k),
          onauxclick: (e) => {
            if (e.button === 1 && k.includes('~')) closeChat(k)
          },
          ondblclick: () => renameChat(k, tab),
          oncontextmenu: (e) => {
            e.preventDefault()
            showChatMenu(p, k, tab, e.clientX, e.clientY)
          },
        },
        el('span', { class: `dot ${dotClass(k)}` }),
        el(
          'span',
          { class: 'tab-text' },
          el('span', { class: 'tab-name', text: chatName(k) }),
          chatBranch(k) !== undefined
            ? el('span', { class: 'tab-branch', text: branchLabel(chatBranch(k)), title: `Branch ${chatBranch(k)}${isBranchChat(k) ? ' - in its own folder' : ''}` })
            : null,
        ),
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
      title: (p.archived ?? []).length > 0
        ? 'New chat - blank, on a branch, or an archived one (Ctrl+T: blank)'
        : 'New chat - blank, or on a branch in its own folder (Ctrl+T: blank)',
      'aria-label': 'New chat',
      html: svg(ICONS.plus),
      onclick: (e) => newChat(p, e.currentTarget),
    }),
  )
}

/**
 * Closing a chat asks what to do with it (asked for: "user should be able to select close the chat or
 * archive the chat"). Archive keeps its conversation and offers it again from New chat; Close deletes
 * its folder. Either stops its agent. Archive is the default button, because it loses nothing.
 */
function closeChat(key) {
  const s = statusOf(key)
  const working = s.phase === 'running' && s.agent !== 'idle'
  const name = chatName(key)
  showModal('closeChat', (scrim) => {
    const done = (archive) => {
      closeModal()
      send('closeChat', { id: key, archive })
    }
    const archive = el('button', { class: 'primary', text: 'Archive', title: 'Keep its conversation; open it again from New chat', onclick: () => done(true) })
    scrim.append(
      el(
        'div',
        { class: 'modal', style: 'width: min(480px, calc(100vw - 48px))' },
        el('header', {}, el('h2', { text: `Close ${name}?` })),
        el(
          'div',
          { class: 'body' },
          working ? el('p', { class: 'sub form-error', text: `${name} is still working - either choice stops it.` }) : null,
          el('p', { class: 'sub', text: 'Archive takes the tab away and keeps the conversation: New chat offers it again, exactly where it was left.' }),
          el('p', { class: 'sub', text: "Close deletes this chat's conversations, reports and log for good. Files it changed in the codebase stay as they are." }),
        ),
        el(
          'footer',
          {},
          el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }),
          el('button', { class: 'secondary danger', text: 'Close and delete', onclick: () => done(false) }),
          archive,
        ),
      ),
    )
    setTimeout(() => archive.focus())
  })
}

/**
 * New chat: blank, or one brought back from the archive. With nothing archived it simply opens a
 * blank chat, as before; Ctrl+T is always blank.
 */
function newChat(project, anchor) {
  const archived = project.archived ?? []
  // Ctrl+T, with no button to anchor a menu to, is a quick blank chat; the + button always offers the choice.
  if (anchor === undefined) return send('newChat', { id: project.id })
  closeMenu()
  const box = anchor.getBoundingClientRect()
  const when = (ms) => (ms > 0 ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')
  const menu = el(
    'div',
    { class: 'menu', role: 'menu' },
    el('button', { onclick: () => { closeMenu(); send('newChat', { id: project.id }) } }, el('span', { html: svg(ICONS.plus) }), 'New blank chat'),
    el('button', { onclick: () => { closeMenu(); openBranchDialog(project) } }, el('span', { html: svg(ICONS.plus) }), 'New chat on a branch…'),
    archived.length > 0 ? el('hr') : null,
    archived.length > 0 ? el('div', { class: 'menu-label', text: 'Open an archived chat' }) : null,
    ...archived.map((chat) =>
      el(
        'div',
        { class: 'menu-row' },
        el(
          'button',
          { title: `Archived ${when(chat.archivedAt)}`, onclick: () => { closeMenu(); send('newChat', { id: project.id, archived: chat.id }) } },
          el('span', { html: svg(ICONS.archive) }),
          el('span', { class: 'menu-row-name', text: chat.name }),
          el('span', { class: 'menu-row-when', text: when(chat.archivedAt) }),
        ),
        el('button', {
          class: 'danger menu-row-delete',
          title: `Delete ${chat.name} and its conversation for good`,
          'aria-label': `Delete ${chat.name}`,
          html: svg(ICONS.remove),
          onclick: () => {
            if (!confirm(`Delete the archived chat "${chat.name}" and its conversation for good?`)) return
            closeMenu()
            send('deleteArchivedChat', { id: project.id, chat: chat.id })
          },
        }),
      ),
    ),
  )
  document.body.append(menu)
  const size = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - size.width - 8))}px`
  menu.style.top = `${Math.min(box.bottom + 4, innerHeight - size.height - 8)}px`
  dismissOnOutside(menu)
}

/** Right-click on a chat tab: what can be done to that one chat. */
function showChatMenu(project, key, tab, x, y) {
  closeMenu()
  const item = (icon, label, action, danger = false) =>
    el(
      'button',
      {
        class: danger ? 'danger' : '',
        onclick: () => {
          closeMenu()
          action()
        },
      },
      el('span', { html: svg(ICONS[icon]) }),
      label,
    )
  const menu = el(
    'div',
    { class: 'menu', role: 'menu' },
    item('rename', 'Rename chat', () => renameChat(key, tab)),
    item('plus', 'New chat', () => newChat(project, tabs.querySelector('.tab-new') ?? undefined)),
    item('plus', 'New chat on a branch…', () => openBranchDialog(project)),
    item('log', 'View agent log', () => send('openLog', { id: key })),
    // This chat's own folder - a branch chat's branch folder - to run and debug it in VS Code.
    item('vscode', isBranchChat(key) ? 'Open this branch in VS Code' : 'Open in VS Code', () => send('openVsCode', { id: key })),
    item('explorer', 'Open in File Explorer', () => send('openExplorer', { id: key })),
    key.includes('~') ? el('hr') : null,
    key.includes('~') ? item('remove', 'Close chat', () => closeChat(key), true) : null,
    isBranchChat(key) ? item('remove', 'Close branch… (remove its folder)', () => send('checkBranch', { id: key }), true) : null,
  )
  document.body.append(menu)
  const box = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, innerWidth - box.width - 8)}px`
  menu.style.top = `${Math.min(y, innerHeight - box.height - 8)}px`
  dismissOnOutside(menu)
}

/**
 * New chat on a branch (asked for: "work in different branches under same repo ... run and test the changes
 * in different branches too"). Each branch chat works in its own folder beside the repository - a git
 * worktree - so it can be edited, run and tested while other chats work on other branches.
 */
function openBranchDialog(project) {
  showModal('branch', (scrim, modal) => {
    modal.project = project.id
    const body = el('div', { class: 'body' }, el('p', { class: 'sub', text: 'Reading branches…' }))
    const error = el('p', { class: 'sub form-error', hidden: true })
    const open = (branch, from) => {
      error.hidden = true
      body.replaceChildren(el('p', { class: 'sub', text: from === undefined ? `Opening ${branch}…` : `Making ${branch} from ${from}…` }))
      send('newBranchChat', { id: project.id, branch, ...(from !== undefined ? { from } : {}) })
      setTimeout(() => openModal?.kind === 'branch' && closeModal(), 400)
    }
    modal.fail = (text) => {
      error.textContent = text
      error.hidden = false
    }
    modal.fill = (m) => {
      if (m.error !== undefined) return modal.fail(m.error)
      const b = m.branches
      // Git makes a branch with the first commit: an empty repository has nothing to open or start from.
      if (b.noCommits === true) {
        body.replaceChildren(
          el('p', { class: 'sub', text: `${project.name} has no commits yet, so there is no branch to open or to start a new one from - git makes a branch with the first commit.` }),
          el('p', { class: 'sub', text: 'Make a first commit (Commit and push in the sidebar, or ask the agent to commit), then open branches here.' }),
        )
        return
      }
      const openIn = new Map(b.open.map((o) => [o.branch, o]))
      const row = (branch, note, onclick) =>
        el('button', { class: 'branch-row', title: branch, onclick }, el('span', { class: 'branch-name', text: branch }), note ? el('span', { class: 'branch-note', text: note }) : null)
      const name = el('input', { type: 'text', placeholder: 'e.g. PAY-1234-add-retry', 'aria-label': 'New branch name' })
      // Starts from the main branch by default (the remote's default, else main or master) - not from what is checked out.
      const bases = [...new Set([b.defaultBranch, b.current, ...b.local, ...b.remote].filter(Boolean))]
      const base = el(
        'select',
        { 'aria-label': 'Start the new branch from', title: 'The branch the new one starts from' },
        ...bases.map((x) => el('option', { value: x, text: x === b.defaultBranch ? `${x} (main branch)` : x === b.current ? `${x} (the codebase is on it)` : x })),
      )
      const make = el('button', { class: 'primary', text: 'Make branch', onclick: () => name.value.trim() !== '' && base.value !== '' && open(name.value.trim(), base.value) })
      if (bases.length === 0) why(make, 'There is no branch to start from.')
      body.replaceChildren(
        el('p', { class: 'sub', text: 'Each branch chat works in its own folder beside the repository, so it can run and test that branch while other chats work on others. The codebase itself stays on its branch.' }),
        el('div', { class: 'field-label', text: 'New branch' }),
        el('div', { class: 'branch-new' }, name, el('span', { class: 'sub', text: 'starting from' }), base, make),
        el('div', { class: 'field-label', text: 'Branches' }),
        el(
          'div',
          { class: 'branch-list' },
          ...b.local.map((branch) => {
            const where = openIn.get(branch)
            return row(branch, where === undefined ? '' : where.main ? 'the codebase is on it' : 'open in a folder - opens its chat', () => open(branch))
          }),
          ...b.remote.map((branch) => row(branch, 'remote - opened as a local branch tracking it', () => open(branch))),
        ),
      )
      setTimeout(() => name.focus())
    }
    scrim.append(
      el(
        'div',
        { class: 'modal', style: 'width: min(560px, calc(100vw - 48px))' },
        el('header', {}, el('h2', { text: `New chat on a branch — ${project.name}` })),
        body,
        error,
        el('footer', {}, el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal })),
      ),
    )
    send('listBranches', { id: project.id })
  })
}

/** "Close branch": says what would be lost, then removes the folder - never the branch - and the chat. */
function confirmCloseBranch(m) {
  const name = chatName(m.id)
  const branch = chatBranch(m.id) ?? ''
  const st = m.status ?? { uncommitted: 0 }
  const losing = [
    st.uncommitted > 0 ? `${st.uncommitted} uncommitted change${st.uncommitted === 1 ? '' : 's'} will be lost.` : '',
    st.unpushed > 0 ? `${st.unpushed} commit${st.unpushed === 1 ? ' is' : 's are'} not pushed - they stay on the branch.` : '',
    st.noUpstream ? 'This branch has never been pushed - its commits stay in the repository on this computer.' : '',
  ].filter(Boolean)
  showModal('closeBranch', (scrim) => {
    const go = el('button', {
      class: losing.length > 0 && st.uncommitted > 0 ? 'secondary danger' : 'primary',
      text: st.uncommitted > 0 ? 'Remove anyway' : 'Remove folder',
      onclick: () => {
        closeModal()
        send('closeBranch', { id: m.id, force: st.uncommitted > 0 })
      },
    })
    scrim.append(
      el(
        'div',
        { class: 'modal', style: 'width: min(500px, calc(100vw - 48px))' },
        el('header', {}, el('h2', { text: `Close branch ${branch}?` })),
        el(
          'div',
          { class: 'body' },
          el('p', { class: 'sub', text: `Removes the folder ${m.folder} and deletes ${name}'s conversation. The branch ${branch} and its commits stay in the repository - open it again any time.` }),
          m.error !== undefined ? el('p', { class: 'sub form-error', text: `Could not check the folder: ${m.error}` }) : null,
          ...losing.map((text) => el('p', { class: 'sub form-error', text })),
        ),
        el('footer', {}, el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }), go),
      ),
    )
  })
}

function renameChat(key, tab) {
  // By key, not by the node passed in: a redraw between the two clicks replaces every tab.
  const current = tabs.querySelector(`.tab[data-key="${CSS.escape(key)}"]`) ?? tab
  const name = $('.tab-name', current)
  if (name === null || renamingChat !== undefined) return
  renamingChat = key
  const input = el('input', { class: 'tab-rename', value: chatName(key), maxlength: '60', 'aria-label': 'Chat name' })
  name.replaceWith(input)
  input.focus()
  input.select()
  // Enter, then the blur that redrawing the tabs causes, would otherwise save twice.
  let finished = false
  const done = (save) => {
    if (finished) return
    finished = true
    renamingChat = undefined
    if (save && input.value.trim() !== '' && input.value.trim() !== chatName(key)) send('renameChat', { id: key, name: input.value.trim() })
    renderTabs()
  }
  // The box sits inside the tab's button: its clicks and keys must not reach the button.
  input.addEventListener('click', (e) => e.stopPropagation())
  input.addEventListener('dblclick', (e) => e.stopPropagation())
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') done(true)
    if (e.key === 'Escape') done(false)
  })
  input.addEventListener('keyup', (e) => e.stopPropagation())
  // Focus taken in the first moments (a chat pane claiming it as it is selected) is taken back, not
  // read as "finished" - that is how the rename used to close before anything was typed.
  const opened = Date.now()
  input.addEventListener('blur', () => {
    if (!finished && Date.now() - opened < 300) requestAnimationFrame(() => input.focus())
    else done(true)
  })
}

const WAITING_WORDS = {
  approval: 'Waiting for your approval',
  question: 'Asked you a question',
  form: 'Waiting for you to fill in a form',
}

/** A badge on top of a codebase's tile while its agent is waiting for you to do something. */
const waitingBadge = (count) =>
  el('span', { class: 'waiting-badge', title: 'Waiting for you', text: count > 1 ? String(count) : '!' })

const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
/** Where a codebase lives: a folder on this computer, or folders on JupyterHub. */
const whereIs = (project) => (project.hub ? `JupyterHub · ${project.hub.user}@${hostOf(project.hub.url)}` : shortPath(project.path))

/** What the row says under the name: the agent's state when it has one, otherwise where it lives. */
const describe = (project) => {
  const s = projectStatus(project)
  if (project.missing) return ['Folder not found', 'failed']
  if (s.phase === 'failed') return ['Agent stopped — open to see why', 'failed']
  if (s.phase === 'starting') return ['Starting…', 'busy']
  if (s.phase === 'sleeping') return ['Sleeping to save memory', '']
  if (s.phase === 'running' && s.agent === 'attention') {
    if (s.waitingChats > 1) return [`${s.waitingChats} chats are waiting for you`, 'attention']
    return [WAITING_WORDS[s.waitingFor] ?? 'Waiting for you', 'attention']
  }
  if (s.schedule && s.phase === 'running') return ['Woken to run a schedule — sleeps again after', 'busy']
  if (s.phase === 'running' && s.agent === 'busy') return [s.working > 1 ? `${s.working} chats working…` : 'Working…', 'busy']
  return [s.chats > 1 ? `${s.chats} chats · ${whereIs(project)}` : whereIs(project), '']
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
      if (s.waitingChats > 0) face.append(waitingBadge(s.waitingChats))
      const row = el(
        'button',
        {
          class: `item${here ? ' active' : ''}${s.waitingChats > 0 ? ' waiting' : ''}`,
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
        gitBadge(p),
        gitButtons(p),
        s.phase === 'sleeping' ? el('span', { class: 'moon', html: svg(ICONS.moon), title: 'Sleeping' }) : null,
        p.keepAwake ? el('span', { class: 'pin', html: svg(ICONS.pin), title: 'Kept awake' }) : null,
      )
      return row
    }),
  )
  renderRail()
}

/**
 * A hub codebase's repository is on the hub, so its counts and actions come from its own host, which
 * runs git there; everything else is Fire Code's own git, run here.
 */
const gitOf = (project) => (project.hub ? model.hubGit[project.id] : model.git?.[project.id])

/** Asks a codebase's first chat to run git on its hub. False when that chat is not running. */
function askHubGit(project, op, message) {
  const frame = $(`.pane[data-id="${project.id}"] iframe`)
  const url = model.urls[project.id]
  if (frame?.contentWindow == null || url === undefined) return false
  frame.contentWindow.postMessage({ source: 'sun', ask: 'hubGit', op, ...(message !== undefined ? { message } : {}) }, new URL(url).origin)
  return true
}

/** Hub counts go stale like any others; asked again now and then, for the hub codebases that are running. */
function refreshHubGit() {
  for (const project of model.projects) if (project.hub) askHubGit(project, 'status')
}
setInterval(refreshHubGit, 60_000)

/**
 * What git says has changed: +new ~modified −deleted, only the kinds that are non-zero. Nothing
 * at all for a clean repository or a folder git does not manage - a badge with nothing to say is
 * noise on every row.
 */
function gitBadge(project) {
  const g = gitOf(project)
  if (g === undefined) return null
  const parts = [
    [g.added, 'add', '+', 'new'],
    [g.modified, 'mod', '~', 'modified'],
    [g.deleted, 'del', '−', 'deleted'],
  ].filter(([n]) => n > 0)
  if (parts.length === 0) return null
  const words = parts.map(([n, , , word]) => `${n} ${word}`).join(', ')
  const total = g.added + g.modified + g.deleted
  const listed = (g.files ?? []).join('\n')
  const more = total > (g.files ?? []).length ? `\n… and ${total - g.files.length} more` : ''
  return el(
    'span',
    { class: 'git', title: `${words}${g.branch ? ` — on ${g.branch}` : ''}, not yet committed\n\n${listed}${more}` },
    ...parts.map(([n, cls, sign]) => el('span', { class: cls, text: `${sign}${n}` })),
  )
}

/**
 * Commit and push, and pull - on the row of a codebase git manages. Small and quiet: shown on hover
 * and on the selected row, so a list of codebases does not become a list of buttons.
 */
function gitButtons(project) {
  const g = gitOf(project)
  if (g === undefined) return null
  const changed = g.added + g.modified + g.deleted > 0
  const stop = (fn) => (e) => {
    e.stopPropagation()
    fn()
  }
  return el(
    'span',
    { class: 'git-actions' },
    changed || g.ahead > 0
      ? el('button', {
          class: 'icon-btn tiny',
          title: changed ? 'Commit and push…' : `Push ${g.ahead} waiting commit${g.ahead === 1 ? '' : 's'}`,
          'aria-label': 'Commit and push',
          html: svg(ICONS.push),
          onclick: stop(() => openCommit(project)),
        })
      : null,
    g.upstream
      ? el('button', {
          class: 'icon-btn tiny',
          title: `Pull the latest changes${g.behind > 0 ? ` (${g.behind} waiting)` : ''} — fast-forward only, never a merge`,
          'aria-label': 'Pull latest changes',
          html: svg(ICONS.pull),
          onclick: stop(() => {
            if (project.hub) {
              if (!askHubGit(project, 'pull')) return notice('Open the codebase first - git runs on the hub through its agent.', 'error')
              notice(`Pulling ${project.name} on the hub…`)
              return
            }
            notice(`Pulling ${project.name}…`)
            send('gitPull', { id: project.id })
          }),
        })
      : null,
  )
}

/**
 * The commit dialog: what will be committed, a message, and an agent to write one. The message the
 * agent suggests is only filled in - nothing is committed until Commit and push is pressed.
 */
function openCommit(project) {
  showModal('commit', (scrim, modal) => {
    const g = gitOf(project) ?? { files: [], added: 0, modified: 0, deleted: 0, ahead: 0 }
    const state = { message: '', busy: false, writing: false }
    const card = el('div', { class: 'modal', style: 'width: min(620px, calc(100vw - 48px))' })
    scrim.append(card)
    const box = el('textarea', { rows: '6', placeholder: 'What changed, and why', spellcheck: 'true', 'aria-label': 'Commit message' })
    box.addEventListener('input', () => {
      state.message = box.value
      why(button, state.busy ? 'Committing and pushing - wait for it to finish.' : state.message.trim().length === 0 ? 'Write a commit message first.' : undefined)
    })
    const write = el('button', {
      class: 'secondary',
      text: 'Write with agent',
      title: "Ask this codebase's agent to write a message from the changes. You can edit it before committing.",
      onclick: () => {
        const frame = $(`.pane[data-id="${project.id}"] iframe`)
        const url = model.urls[project.id]
        if (frame?.contentWindow == null || url === undefined) return notice('Open the codebase first - its agent writes the message.', 'error')
        state.writing = true
        why(write, 'The agent is writing a message.')
        write.textContent = 'Writing…'
        frame.contentWindow.postMessage({ source: 'sun', ask: 'commitMessage' }, new URL(url).origin)
      },
    })
    const button = el('button', {
      class: 'primary',
      text: 'Commit and push',
      onclick: () => {
        state.busy = true
        why(button, 'Committing and pushing - wait for it to finish.')
        button.textContent = 'Pushing…'
        if (!project.hub) return send('gitCommitPush', { id: project.id, message: state.message })
        if (!askHubGit(project, 'commit', state.message)) {
          notice('Open the codebase first - git runs on the hub through its agent.', 'error')
          modal.onGitDone(false)
        }
      },
    })
    why(button, 'Write a commit message first.')
    const total = g.added + g.modified + g.deleted
    card.append(
      el('header', {}, el('h2', { text: `Commit and push — ${project.name}` }), el('p', { class: 'sub', text: `${total} changed file${total === 1 ? '' : 's'}${g.branch ? ` on ${g.branch}` : ''}${g.ahead > 0 ? `, ${g.ahead} commit${g.ahead === 1 ? '' : 's'} waiting to push` : ''}. Everything changed is committed.` })),
      el(
        'div',
        { class: 'body' },
        el('pre', { class: 'commit-files', text: (g.files ?? []).join('\n') + (total > (g.files ?? []).length ? `\n… and ${total - g.files.length} more` : '') }),
        el('label', { class: 'field-label', text: 'Message' }),
        box,
        el('div', { class: 'commit-tools' }, write),
      ),
      el('footer', {}, el('span', { class: 'spacer' }), el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }), button),
    )
    modal.projectId = project.id
    modal.onCommitMessage = (text, error) => {
      why(write, undefined)
      write.textContent = 'Write with agent'
      if (typeof text === 'string' && text.trim().length > 0) {
        box.value = text.trim()
        state.message = box.value
        why(button, state.busy ? 'Committing and pushing - wait for it to finish.' : undefined)
        box.focus()
      } else notice(error || 'The agent could not write a message.', 'error')
    }
    modal.onGitDone = (ok) => {
      if (ok) closeModal()
      else {
        state.busy = false
        button.textContent = 'Commit and push'
        why(button, state.message.trim().length === 0 ? 'Write a commit message first.' : undefined)
      }
    }
    requestAnimationFrame(() => box.focus())
  })
}

/**
 * "2 waiting" beside the Codebases heading, while any agent is waiting for you. Each click opens the
 * next one, so working through them is one button.
 */
function renderWaitingChip() {
  const chip = $('#waiting-chip')
  if (chip === null) return
  const waiting = model.projects.filter((p) => projectStatus(p).waitingChats > 0)
  chip.hidden = waiting.length === 0
  chip.textContent = waiting.length === 0 ? '' : `${waiting.length} waiting`
  chip.title = waiting.map((p) => `${p.name}: ${describe(p)[0]}`).join('\n')
  chip.onclick = () => {
    if (waiting.length === 0) return
    const current = model.active === undefined ? -1 : waiting.findIndex((p) => p.id === projectOf(model.active))
    const next = waiting[(current + 1) % waiting.length]
    // The chat that is waiting, not just the codebase.
    const key = chatKeys(next).find((k) => statusOf(k).agent === 'attention') ?? next.id
    select(key)
  }
}

function renderRail() {
  renderWaitingChip()
  $('#rail-list').replaceChildren(
    ...model.projects.map((p) => {
      const face = avatar(p.name, model.active !== undefined && projectOf(model.active) === p.id ? 'active' : '', accentOf(p))
      face.append(el('span', { class: `dot ${projectDot(p)}` }))
      const waitingHere = projectStatus(p).waitingChats
      if (waitingHere > 0) face.append(waitingBadge(waitingHere))
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

/*
 * Chat pages that are hidden and idle are unloaded; the agent behind them keeps running.
 *
 * Every chat page is a whole copy of the chat UI - React, the transcript, highlighted code - and all
 * of them stayed loaded for as long as their agents ran, so ten chats meant ten pages in memory
 * while one was on screen. The agent is a separate process and its session outlives the page (the
 * Node host buffers what happens while nothing is attached and replays the transcript when a page
 * attaches again), so the page can go and come back. Only an idle one: a page reports when its agent
 * is working or waiting for you, and that report is what drives the badges and notifications.
 * Opening it again reloads it; the spent launch link is answered with a fresh one, as on a reload.
 */
const parked = new Set()
const hiddenSince = {}
/** A request for a chat page that may not be loaded yet, sent once it reports ready. */
const pendingAsks = {}

function deliverPendingAsk(key) {
  const ask = pendingAsks[key]
  const frame = $(`.pane[data-id="${key}"] iframe`)
  const url = model.urls[key]
  if (ask === undefined || frame?.contentWindow == null || url === undefined || frame.dataset.ready !== 'true') return
  delete pendingAsks[key]
  deliveredAsks[key] = { ask, at: Date.now() }
  frame.contentWindow.postMessage({ source: 'sun', ask }, new URL(url).origin)
}
/*
 * An unloaded page comes back with its spent launch link, says it is ready, and is then replaced by
 * the page the fresh link opens - taking anything just asked of it along. An ask delivered moments
 * before the link changed is asked again of the new page.
 */
const deliveredAsks = {}

function parkIdlePages() {
  const minutes = model.settings.unloadMinutes ?? 5
  if (!(minutes > 0)) return
  const now = Date.now()
  for (const pane of panes.querySelectorAll('.pane')) {
    const key = pane.dataset.id
    const frame = $('iframe', pane)
    if (frame === null || key === model.active || parked.has(key)) continue
    const s = statusOf(key)
    if (s.phase !== 'running' || s.agent !== 'idle') continue
    if (hiddenSince[key] === undefined || now - hiddenSince[key] < minutes * 60_000) continue
    // A dialog waiting on this codebase's page (a commit message, hub git) keeps it.
    if (openModal?.projectId === projectOf(key)) continue
    parked.add(key)
    frame.remove()
  }
}
setInterval(parkIdlePages, 30_000)

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
    if (key === model.active) {
      parked.delete(key)
      delete hiddenSince[key]
    } else if (hiddenSince[key] === undefined) hiddenSince[key] = Date.now()

    const s = statusOf(key)
    const url = model.urls[key]
    let frame = $('iframe', pane)
    if (url !== undefined && s.phase === 'running' && !parked.has(key)) {
      if (frame === null) {
        frame = el('iframe', {
          title: `Light Code — ${project.name}${key.includes('~') || project.firstChatName ? ` — ${chatName(key)}` : ''}`,
          allow: 'clipboard-read; clipboard-write',
          src: url,
        })
        frame.dataset.url = url
        pane.prepend(frame)
      } else if (frame.dataset.url !== url) {
        // A fresh launch link: the old one was spent (a reload) or the host restarted.
        if (frame.dataset.connected === 'true' && sameOrigin(frame.dataset.url, url)) {
          // This page already has its session: keep it, and keep the link for the next load.
          frame.dataset.url = url
        } else {
          /*
           * A new frame, not a new address. The fresh link differs from the spent one only after the
           * `#`, and assigning such an address does not reload the page - so a page showing "that link
           * has already been used" stayed on it for good. A new frame always loads.
           */
          const recent = deliveredAsks[key]
          if (recent !== undefined && Date.now() - recent.at < 15_000 && pendingAsks[key] === undefined) pendingAsks[key] = recent.ask
          delete deliveredAsks[key]
          const fresh = el('iframe', { title: frame.title, allow: frame.getAttribute('allow') ?? '', src: url })
          fresh.dataset.url = url
          frame.replaceWith(fresh)
          frame = fresh
        }
      }
    }
    renderPaneState(pane, project, s, frame !== null && s.phase === 'running', key)
  }
  for (const pane of panes.querySelectorAll('.pane')) {
    if (!keys.includes(pane.dataset.id)) pane.remove()
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
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
      el('p', { text: `${project.path} no longer exists. Restore it, or remove this codebase from Fire Code.` }),
      el('div', { class: 'actions' }, el('button', { class: 'secondary', text: 'Remove from Fire Code', onclick: () => confirmRemove(project) })),
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
    const reason = ['approval', 'form', 'question'].includes(data.reason) ? data.reason : undefined
    send('agentState', { id: key, state: data.state, finished: data.finished === true, ...(reason ? { reason } : {}) })
  }
  if (typeof data.shortcut === 'string') shortcut(data.shortcut)
  // An accent picked in that codebase's own Appearance tab, or null to follow Fire Code's again.
  if (data.accent === null || validHex(data.accent)) send('projectAccent', { id: project.id, accent: data.accent })
  if (data.connected === true) frame.dataset.connected = 'true'
  // A Browse button: the page's agent has no dialog of its own, so Fire Code opens one.
  if (data.pick !== null && typeof data.pick === 'object' && typeof data.pick.purpose === 'string') {
    const kind = data.pick.kind === 'folder' ? 'folder' : 'file'
    const extensions = Array.isArray(data.pick.extensions) ? data.pick.extensions.filter((e) => typeof e === 'string').slice(0, 20) : []
    send('pickPath', { id: key, purpose: data.pick.purpose.slice(0, 200), kind, extensions })
  }
  // A Save button in the page (a diagram): Fire Code opens a Windows Save dialog and writes the file.
  if (data.save !== null && typeof data.save === 'object' && typeof data.save.requestId === 'string' && typeof data.save.base64 === 'string') {
    const name = typeof data.save.name === 'string' ? data.save.name.slice(0, 120) : 'file'
    send('saveFile', { id: key, requestId: data.save.requestId.slice(0, 80), name, data: data.save.base64 })
  }
  if (data.ready === true) {
    frame.dataset.ready = 'true'
    sendAppearance(frame)
    deliverPendingAsk(key)
    // The counts for a hub codebase arrive only from its host, so ask as soon as it is up.
    if (project.hub && key === project.id) askHubGit(project, 'status')
  }
  // Git run on the hub: counts for the sidebar, or how a commit or pull went.
  if (data.hubGit !== null && typeof data.hubGit === 'object' && project.hub) {
    const result = data.hubGit
    if (result.op === 'status') {
      const before = JSON.stringify(model.hubGit[project.id] ?? null)
      if (result.ok === true && result.counts !== null && typeof result.counts === 'object') model.hubGit[project.id] = result.counts
      else delete model.hubGit[project.id]
      if (JSON.stringify(model.hubGit[project.id] ?? null) !== before && !busyEditing()) renderList()
    } else {
      HANDLERS.gitDone({ id: project.id, ok: result.ok === true, text: typeof result.text === 'string' ? result.text.slice(0, 2000) : '' })
      askHubGit(project, 'status')
    }
  }
  // A commit message the codebase's agent wrote, for the commit dialog to fill in.
  if ('commitMessage' in data && openModal?.kind === 'commit' && openModal.projectId === project.id) {
    openModal.onCommitMessage(typeof data.commitMessage === 'string' ? data.commitMessage.slice(0, 5000) : undefined, typeof data.error === 'string' ? data.error : undefined)
  }
})

// ─── Reports: Fire Code's Markdown viewer ──────────────────────────────────────────
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
    /(`+)([\s\S]*?[^`])\1(?!`)|!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<)\]]+[^\s<)\].,;:!?'"])|\*\*([\s\S]+?)\*\*|(?<![\w])__([\s\S]+?)__(?![\w])|~~([\s\S]+?)~~|\*([^\s*][\s\S]*?)\*|(?<![\w])_([^\s_][\s\S]*?)_(?![\w])/g
  let last = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)))
    if (m[1] !== undefined) out.push(el('code', { class: 'md-inline', text: m[2].replace(/^ (.*) $/, '$1') }))
    else if (m[4] !== undefined) {
      const image = m[0].startsWith('!')
      // Images are not fetched: a report may name any URL, and Fire Code loads nothing remote.
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
          li.append(el('input', { type: 'checkbox', disabled: true, title: 'A checklist in the report - shown as written, not something to tick here.', checked: task[1] !== ' ' }))
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
        // Served by Fire Code under its own policy: the report's styles, and no script or request.
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
  if (name === 'm') return dash.open ? closeDashboard() : openDashboard()
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
      if (dash.open) return closeDashboard()
    }
    if (!event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (['b', 'k', 'n', ',', 'tab', 't', 'w', 'm'].includes(key) || /^[1-9]$/.test(key)) {
      event.preventDefault()
      shortcut(`${event.shiftKey && key === 'tab' ? 'shift+' : ''}${key}`)
    }
  },
  true,
)

// ─── Context menu ────────────────────────────────────────────────────────────

/*
 * A menu closes on any press outside it, for as long as it is open. It used to listen for one press only
 * ({ once: true }), so a press inside the menu - a disabled item, a separator - used the listener up and the
 * menu then stayed until Esc (reported). Capturing, so nothing below can stop it; and on the window losing
 * focus, because a press in a chat's frame never reaches this document.
 */
let menuDismiss
function dismissOnOutside(menu) {
  setTimeout(() => {
    if (!menu.isConnected) return
    menuDismiss = (e) => {
      if (e.type === 'blur' || !menu.contains(e.target)) closeMenu()
    }
    document.addEventListener('pointerdown', menuDismiss, true)
    window.addEventListener('blur', menuDismiss)
  })
}
function closeMenu() {
  $('.menu')?.remove()
  if (menuDismiss !== undefined) {
    document.removeEventListener('pointerdown', menuDismiss, true)
    window.removeEventListener('blur', menuDismiss)
    menuDismiss = undefined
  }
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
  // How other codebases' chats refer to this one - shown so it can be typed after @.
  const mention = project.mention ? `@${project.mention}` : undefined
  const menu = el(
    'div',
    { class: 'menu', role: 'menu' },
    mention
      ? el('div', { class: 'menu-label', title: 'Type this in a chat on another codebase to refer to this one' }, 'In other chats: ', el('code', { text: mention }))
      : null,
    mention ? item('copy', `Copy ${mention}`, () => navigator.clipboard?.writeText(mention)) : null,
    mention ? el('hr') : null,
    item('vscode', 'Open in VS Code', () => send('openVsCode', { id: project.id })),
    item('explorer', 'Open in File Explorer', () => send('openExplorer', { id: project.id })),
    el('hr'),
    item('plus', 'New chat', () => send('newChat', { id: project.id })),
    item('plus', 'New chat on a branch…', () => openBranchDialog(project)),
    (project.archived ?? []).length > 0
      ? item('archive', `Open an archived chat (${String(project.archived.length)})…`, () => {
          select(project.id)
          setTimeout(() => newChat(project, tabs.querySelector('.tab-new') ?? undefined))
        })
      : null,
    running
      ? item('sleep', s.chats > 1 ? 'Sleep all chats' : 'Sleep now', each('sleep'))
      : item('play', 'Start agent', () => send('start', { id: current })),
    item('restart', s.chats > 1 ? 'Restart all chats' : 'Restart agent', each('restart')),
    item('pin', 'Keep awake', () => send('keepAwake', { id: project.id, on: !project.keepAwake }), { checked: project.keepAwake }),
    el('hr'),
    item('settings', 'Settings source…', () => openConfigChooser(project)),
    item('rename', 'Codebase instructions…', () => openInstructions(project)),
    project.hub ? item('link', 'JupyterHub settings…', () => openHubSettings(project)) : null,
    item('rename', 'Rename', () => startRename(project)),
    item('log', 'Reports…', () => openReportList(project)),
    item('log', 'View agent log', () => send('openLog', { id: current })),
    el('hr'),
    item('remove', 'Remove from Fire Code…', () => confirmRemove(project), { danger: true }),
  )
  document.body.append(menu)
  const box = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, innerWidth - box.width - 8)}px`
  menu.style.top = `${Math.min(y, innerHeight - box.height - 8)}px`
  dismissOnOutside(menu)
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

/**
 * Codebase instructions: what every chat on this codebase is told, ahead of the standing
 * instructions (a skill marked `always: true`, which may come from a team bucket and apply
 * everywhere). Kept in Fire Code's data folder, not the repository, and read by each chat's host at
 * its next message - so a save here reaches every chat without restarting anything.
 */
const INSTRUCTIONS_SENT_IN_FULL = 20000

function openInstructions(project) {
  showModal('instructions', (scrim, modal) => {
    const state = { loaded: false, saved: '', saving: false }
    const card = el('div', { class: 'modal', style: 'width: min(720px, calc(100vw - 48px))' })
    scrim.append(card)
    const box = el('textarea', {
      class: 'instructions-box',
      rows: '16',
      spellcheck: 'true',
      'aria-label': 'Codebase instructions',
      placeholder:
        'How this codebase works, for every chat on it. For example:\n- Run the tests with: pnpm test\n- Never edit generated files under src/generated\n- Use our logging helper, not print',
    })
    const count = el('span', { class: 'sub' })
    const dirty = () => state.loaded && box.value !== state.saved
    const refresh = () => {
      const n = box.value.length
      count.textContent = `${n.toLocaleString()} characters${n > INSTRUCTIONS_SENT_IN_FULL ? ` - only the first ${INSTRUCTIONS_SENT_IN_FULL.toLocaleString()} are sent` : ''}`
      count.classList.toggle('form-error', n > INSTRUCTIONS_SENT_IN_FULL)
      why(save, !state.loaded ? 'Still reading the saved instructions.' : state.saving ? 'Saving.' : !dirty() ? 'Nothing has changed since the last save.' : undefined)
    }
    box.disabled = true
    box.addEventListener('input', refresh)
    box.addEventListener('keydown', (e) => {
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (dirty() && !state.saving) save.click()
      }
    })
    const save = el('button', {
      class: 'primary',
      text: 'Save',
      onclick: () => {
        state.saving = true
        save.textContent = 'Saving…'
        refresh()
        send('saveInstructions', { id: project.id, text: box.value })
      },
    })
    // The standing instructions are a skill, and only the codebase's own agent knows which folder
    // holds it - so its chat opens it, in the same editor as any other skill.
    const current = model.lastChat[project.id] ?? project.id
    const running = model.urls[current] !== undefined && statusOf(current).phase === 'running'
    const standing = el('button', {
      class: 'secondary',
      text: 'Edit standing instructions',
      title: 'Opens the standing instructions in this codebase\'s chat.',
      onclick: () => {
        if (model.urls[current] === undefined) return notice('Start the codebase first - its agent finds the standing instructions.', 'error')
        if (dirty()) return notice('Save or cancel the codebase instructions first.', 'error')
        closeModal()
        // Delivered when the page says it is ready: it may have been unloaded while hidden.
        pendingAsks[current] = 'openStandingSkill'
        if (model.active !== current) select(current)
        deliverPendingAsk(current)
      },
    })
    why(standing, running ? undefined : 'Start this codebase first - its agent finds the standing instructions.')
    card.append(
      el(
        'header',
        {},
        el('h2', { text: `Codebase instructions — ${project.name}` }),
        el('p', {
          class: 'sub',
          text:
            'Every chat on this codebase gets these with every message, before the standing instructions. Where the two disagree these win, and what you say in a chat wins over both. Kept on this machine, not in the repository. Keep them short - they are paid for on every request.',
        }),
      ),
      el('div', { class: 'body' }, box, el('div', { class: 'instructions-meta' }, count)),
      el('footer', {}, standing, el('span', { class: 'spacer' }), el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }), save),
    )
    modal.projectId = project.id
    modal.keepOpen = dirty
    modal.onInstructions = (text) => {
      state.loaded = true
      state.saved = text
      box.value = text
      box.disabled = false
      refresh()
      box.focus()
    }
    modal.onInstructionsSaved = (ok, error) => {
      state.saving = false
      save.textContent = 'Save'
      if (ok) {
        state.saved = box.value
        closeModal()
        notice(`Saved. Every chat on ${project.name} uses them from its next message.`)
      } else {
        notice(error || 'The instructions could not be saved.', 'error')
        refresh()
      }
    }
    refresh()
    send('instructions', { id: project.id })
  })
}

function closeModal() {
  openModal?.node.remove()
  openModal = undefined
  $(`.pane[data-id="${model.active}"] iframe`)?.focus()
}

function showModal(kind, build) {
  closeModal()
  const scrim = el('div', { class: 'scrim' })
  // A modal holding unsaved typing says so through keepOpen, so a stray click beside it loses nothing.
  scrim.addEventListener('pointerdown', (e) => e.target === scrim && openModal?.keepOpen?.() !== true && closeModal())
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
        html: `${svg(ICONS.key)}<span>API keys and passwords are not inside a config file. Ones kept by VS Code cannot be read by another app, so enter each once in this window's Settings — Fire Code then shares it with every codebase.</span>`,
      }),
    )
  }
  return parts
}

/** A draft of JupyterHub settings, from a codebase's or empty. */
function hubDraft(hub) {
  return {
    url: hub?.url ?? '',
    user: hub?.user ?? '',
    server: hub?.server ?? '',
    folders: (hub?.folders ?? []).map((f) => (f === '' ? '/' : f)).join('\n'),
    kernel: hub?.kernel ?? '',
    token: '',
    credential: hub?.credential ?? '',
    tokenMode: hub?.credential ? 'keep' : 'paste',
    credentialLabel: hub?.credentialLabel,
  }
}

/** What is sent for a draft; the token only when one was typed, and only to Fire Code itself. */
function hubPayload(draft) {
  return {
    url: draft.url.trim(),
    user: draft.user.trim(),
    server: draft.server.trim() || null,
    folders: draft.folders.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0),
    kernel: draft.kernel.trim() || null,
    token: draft.tokenMode === 'paste' ? draft.token.trim() || null : null,
    credential: draft.tokenMode === 'saved' ? draft.credential || null : null,
  }
}

/** What the hub form still needs, in words for the button's tooltip; undefined when it is complete. */
const hubMissing = (draft) =>
  !/^https?:\/\/\S+/.test(draft.url.trim())
    ? 'Enter the hub address, starting with https://.'
    : draft.user.trim().length === 0
      ? 'Enter your hub user name.'
      : draft.folders.trim().length === 0
        ? 'Enter at least one folder.'
        : draft.tokenMode === 'keep' || (draft.tokenMode === 'paste' ? draft.token.trim().length > 0 : draft.credential.length > 0)
          ? undefined
          : draft.tokenMode === 'paste'
            ? 'Paste the hub token.'
            : 'Choose the saved credential holding the hub token.'

function hubFields(draft, render) {
  const field = (key, label, placeholder, hint, type = 'text') => {
    const input = el(type === 'area' ? 'textarea' : 'input', {
      ...(type === 'area' ? { rows: '4' } : { type }),
      placeholder,
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': label,
    })
    input.value = draft[key]
    input.addEventListener('input', () => {
      draft[key] = input.value
      render.soft?.()
    })
    return [el('label', { class: 'field-label', text: label }), input, hint ? el('div', { class: 'field-hint', text: hint }) : null]
  }
  const secrets = (model.credentials ?? []).filter((c) => c.kind !== 'login')
  const tokenModes = [
    ...(draft.credentialLabel || draft.tokenMode === 'keep' ? [['keep', 'Keep current']] : []),
    ['paste', 'Paste a token'],
    ['saved', 'Saved credential'],
  ]
  let tokenField
  if (draft.tokenMode === 'paste') {
    const input = el('input', { type: 'password', placeholder: 'From the hub: Token page (…/hub/token)', autocomplete: 'off', 'aria-label': 'JupyterHub token' })
    input.value = draft.token
    input.addEventListener('input', () => {
      draft.token = input.value
      render.soft?.()
    })
    tokenField = input
  } else if (draft.tokenMode === 'saved') {
    if (secrets.length === 0) {
      tokenField = el('div', { class: 'field-hint', text: 'No saved credentials yet — paste the token instead, and it is saved as one.' })
    } else {
      const select = el('select', { 'aria-label': 'Credential holding the token', class: 'env-select' },
        el('option', { value: '', text: 'Choose…', selected: draft.credential === '' }),
        ...secrets.map((c) => el('option', { value: c.id, text: c.label, title: c.label, selected: c.id === draft.credential })),
      )
      select.addEventListener('change', () => {
        draft.credential = select.value
        render.soft?.()
      })
      tokenField = select
    }
  } else {
    tokenField = el('div', { class: 'field-hint', text: `Using ${draft.credentialLabel ?? 'the saved token'}. Replace it in Credentials, or paste a new one here.` })
  }
  return [
    el('div', { class: 'note', html: `${svg(ICONS.info)}<span>Fire Code keeps a copy of these folders on this computer so search is fast. Your agent's edits are saved back to the hub, never over a newer change made there, and code runs <b>on the hub</b>, where its libraries are.</span>` }),
    ...field('url', 'Hub address', 'https://jupyter.example.com', null),
    ...field('user', 'Your JupyterHub user name', 'e.g. ann', null),
    ...field('folders', 'Folders on your hub server', 'projects/risk\nshared/reports', 'One per line, from your home folder on the hub. Write / for all of it.', 'area'),
    el('label', { class: 'field-label', text: 'API token' }),
    el('div', { class: 'segmented small' },
      ...tokenModes.map(([mode, label]) =>
        el('button', { class: draft.tokenMode === mode ? 'on' : '', text: label, onclick: () => { draft.tokenMode = mode; render() } }),
      ),
    ),
    tokenField,
    el('div', { class: 'field-hint', text: 'Kept encrypted in Credentials and only ever sent to this hub. Never shown again.' }),
    ...field('server', 'Named server (optional)', 'Leave empty for your default server', null),
    ...field('kernel', 'Kernel (optional)', 'e.g. python3 — empty uses the hub\'s default', null),
  ]
}

function openHubSettings(project) {
  showModal('hub', (scrim, modal) => {
    const draft = hubDraft(project.hub)
    const card = el('div', { class: 'modal' })
    scrim.append(card)
    let save
    const render = () => {
      // A redraw (choosing settings, switching the token field) keeps the place being read.
      const scrolled = card.querySelector('.body')?.scrollTop ?? 0
      save = why(el('button', {
        class: 'primary',
        text: 'Save and restart agent',
        onclick: () => {
          send('updateHub', { id: project.id, hub: hubPayload(draft) })
          closeModal()
        },
      }), hubMissing(draft))
      card.replaceChildren(
        el('header', {}, el('h2', { text: `JupyterHub — ${project.name}` }), el('p', { class: 'sub', text: 'Where these folders are, and how to reach them.' })),
        el('div', { class: 'body' }, ...hubFields(draft, render)),
        el('footer', {}, el('span', { class: 'spacer' }), el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }), save),
      )
      const body = card.querySelector('.body')
      if (body) body.scrollTop = scrolled
    }
    render.soft = () => {
      if (save) why(save, hubMissing(draft))
    }
    modal.refresh = render
    render()
    send('credentials')
  })
}

function openAdd() {
  showModal('add', (scrim, modal) => {
    const state = { folder: undefined, name: '', mode: 'new', source: undefined, sources: [], recent: [], loading: true, busy: false, where: 'local', hub: hubDraft() }
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

      // A redraw (choosing settings, switching the token field) keeps the place being read.
      const scrolled = card.querySelector('.body')?.scrollTop ?? 0
      const onHub = state.where === 'hub'
      const settingsReady = state.mode === 'new' || state.source !== undefined
      const addBlocked = () =>
        state.busy
          ? 'Adding - wait a moment.'
          : onHub
            ? hubMissing(state.hub) ?? (settingsReady ? undefined : 'Choose which settings file to link or copy.')
            : state.folder === undefined
              ? 'Choose the folder first.'
              : settingsReady
                ? undefined
                : 'Choose which settings file to link or copy.'
      const nameInput = el('input', { type: 'text', value: state.name, placeholder: 'Shown in the sidebar (optional)' })
      nameInput.addEventListener('input', () => (state.name = nameInput.value))
      const hubPart = [
        ...hubFields(state.hub, render),
        el('label', { class: 'field-label', text: 'Name' }),
        nameInput,
        el('label', { class: 'field-label', text: 'Light Code settings' }),
        ...configChooser(state, render),
      ]
      card.replaceChildren(
        el('header', {}, el('h2', { text: 'Add a codebase' }), el('p', { class: 'sub', text: 'It gets its own Light Code agent, running beside the others.' })),
        el(
          'div',
          { class: 'body' },
          el('div', { class: 'segmented' },
            el('button', { class: onHub ? '' : 'on', text: 'On this computer', onclick: () => { state.where = 'local'; render() } }),
            el('button', { class: onHub ? 'on' : '', text: 'On JupyterHub', onclick: () => { state.where = 'hub'; render() } }),
          ),
          ...(onHub ? hubPart : folderPart),
        ),
        el(
          'footer',
          {},
          el('span', { class: 'spacer' }),
          el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }),
          why(el('button', {
            class: 'primary',
            text: state.busy ? 'Adding…' : 'Add codebase',
            onclick: () => {
              state.busy = true
              render()
              if (state.where === 'hub') send('addHub', { name: state.name, hub: hubPayload(state.hub), mode: state.mode, source: state.mode === 'new' ? null : state.source })
              else send('add', { path: state.folder, name: state.name, mode: state.mode, source: state.mode === 'new' ? null : state.source })
              setTimeout(() => {
                state.busy = false
                if (openModal === modal) render()
              }, 4000)
            },
          }), addBlocked()),
        ),
      )
      const body = card.querySelector('.body')
      if (body) body.scrollTop = scrolled
    }
    // Typing in the hub form only re-checks the button, so the box being typed in keeps its focus.
    render.soft = () => {
      const button = card.querySelector('footer .primary')
      if (button)
        why(button, state.busy
          ? 'Adding - wait a moment.'
          : hubMissing(state.hub) ?? (state.mode === 'new' || state.source !== undefined ? undefined : 'Choose which settings file to link or copy.'))
    }
    modal.refresh = render
    modal.onFolder = (m) => {
      if (m.existingId) {
        closeModal()
        select(m.existingId)
        notice(`${m.name} is already in Fire Code.`)
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
    send('credentials')
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
          why(el('button', {
            class: 'primary',
            text: 'Apply and restart agent',
            onclick: () => {
              send('changeConfig', { id: project.id, mode: state.mode, source: state.mode === 'new' ? null : state.source })
              closeModal()
            },
          }), state.mode !== 'new' && state.source === undefined ? 'Choose which settings file to link or copy.' : undefined),
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
        el('header', {}, el('h2', { text: 'Settings' }), el('p', { class: 'sub', text: `Fire Code ${model.version}` })),
        el(
          'div',
          { class: 'body' },
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'meta' }, el('b', { text: 'Theme' }), el('span', { text: "Fire Code and every codebase's chat follow it." })),
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
            el('span', { class: 'meta' }, el('b', { text: 'Accent colour' }), el('span', { text: "Buttons, selection and your messages, in Fire Code and every chat. Role colours stay each chat's own." })),
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
            el('span', { class: 'meta' }, el('b', { text: 'Unload hidden chat pages after' }), el('span', { text: 'Frees the memory of a chat page you are not looking at, while its agent keeps running. Never while it is working or waiting for you. Opening it again takes a moment.' })),
            el(
              'div',
              { class: 'segmented' },
              ...[[0, 'Never'], [2, '2 min'], [5, '5 min'], [15, '15 min']].map(([value, label]) =>
                el('button', { class: (s.unloadMinutes ?? 5) === value ? 'on' : '', text: label, onclick: () => patch({ unloadMinutes: value }) }),
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
              el('b', { text: 'Monitoring' }),
              el('span', {
                text:
                  model.monitoring?.enabled === true
                    ? `On — ${(model.monitoring.monitors ?? []).length} monitor(s). Agents can create and control monitors; idle chats were restarted to get the tools.`
                    : 'A dashboard of checks that run on a schedule, coloured by alert rules, with Windows notifications at the levels you choose. Agents create them.',
              }),
            ),
            el(
              'div',
              { class: 'inline' },
              model.monitoring?.enabled === true ? el('button', { class: 'secondary', text: 'Open', onclick: () => (closeModal(), openDashboard()) }) : null,
              el('button', { class: 'secondary', text: 'Settings…', onclick: openMonitorSettings }),
              toggle(model.monitoring?.enabled === true, (on) => monitorOp('settings', { patch: { enabled: on } })),
            ),
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

/** One line for the Settings row: what Fire Code adds to every agent's environment. */
function environmentSummary(s) {
  const folders = (s.pathPrefix ?? []).length
  const vars = (s.env ?? []).length
  const script = s.startupScript ? 1 : 0
  if (folders === 0 && vars === 0 && script === 0) return 'A startup script, folders to put on PATH and variables for every agent. None set.'
  const parts = []
  if (script) parts.push('startup script')
  if (folders > 0) parts.push(`${folders} folder${folders === 1 ? '' : 's'} on PATH`)
  if (vars > 0) parts.push(`${vars} variable${vars === 1 ? '' : 's'}`)
  return `${parts.join(' · ')} — given to every agent Fire Code starts.`
}

/**
 * Settings → Environment. Edited as a draft and saved as a whole, because Rust validates it as a
 * whole (a name listed twice is a property of the list). Values typed here are stored in Fire Code's
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

    const iconButton = (title, icon, onclick, disabledBecause) =>
      why(el('button', { class: 'icon-btn small', title, 'aria-label': title, html: svg(ICONS[icon]), onclick }), disabledBecause)

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
          }, index === 0 ? 'Already first on the PATH.' : undefined),
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
        why(el('button', { class: 'secondary', text: 'Run now', title: 'Runs the saved script again', onclick: () => send('runScript') }),
          (model.settings.startupScript ?? '') === '' ? 'Save a startup script first.' : model.scriptStatus?.state === 'running' ? 'The script is running now.' : undefined),
      )
    }

    const render = () => {
      card.replaceChildren(
        el('header', {}, el('h2', { text: 'Environment' }), el('p', { class: 'sub', text: 'Given to every agent Fire Code starts, in every codebase and chat.' })),
        el(
          'div',
          { class: 'body' },
          el('label', { class: 'field-label', text: 'Startup script' }),
          el('p', { class: 'env-hint', text: 'A .cmd, .bat or .ps1 run when Fire Code starts. The variables it sets and the folders it adds to PATH are given to every codebase\'s agents; it cannot change Fire Code itself. It must finish on its own — nothing can answer a pause or a prompt. The variables below are applied after it, so they win.' }),
          scriptInput(),
          scriptLine(),
          el('label', { class: 'field-label', text: 'Folders put in front of PATH' }),
          el('p', { class: 'env-hint', text: 'Searched first, in this order, before the PATH Fire Code was started with — so a tool here wins over another copy. Python tools and MCP servers see these too. %NAME% expands.' }),
          ...folderRows(),
          el('button', { class: 'secondary', text: 'Add folder', onclick: () => { draft.folders.push(''); render() } }),
          el('label', { class: 'field-label', text: 'Variables' }),
          el('p', { class: 'env-hint', text: 'Every command an agent runs sees these — so can the model, if a command prints them. Python tools and MCP servers do not, unless their own settings name them. Use a saved credential for anything secret: a typed value is stored in Fire Code\'s settings file.' }),
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
// "Use a saved credential". Write-only: values go to Fire Code and are never shown again - replacing is
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
              why(el('button', {
                class: draft.kind === value ? 'on' : '',
                text,
                onclick: () => {
                  draft.kind = value
                  renderBody()
                },
              }), !isNew && draft.kind !== value ? 'The kind of a saved credential cannot change. Add a new one instead.' : undefined),
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
            : el('div', { class: 'note', html: `${svg(ICONS.key)}<span>No saved credentials yet. Add one here, press <b>From IntelliJ / PyCharm</b> below, or in VS Code run <b>Light Code: Share credentials with Fire Code</b> to bring them all over at once.</span>` }),
          rows.length > 0
            ? el('div', { class: 'note', html: `${svg(ICONS.info)}<span>Credentials from VS Code: run <b>Light Code: Share credentials with Fire Code</b> in VS Code while Fire Code is open.</span>` })
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
        why(go, chosen.size === 0 ? 'Tick at least one credential to export.' : undefined)
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

// ─── Monitoring ──────────────────────────────────────────────────────────────
//
// The dashboard: one glowing tile per monitor, Team and Personal, over the whole window. The monitors,
// their colours and every number come from Rust (monitor.rs, monitoring.rs); this only draws them and
// sends the user's clicks back as monitoring operations. A tile opens the monitor's grid in its own window.

const MON_LEVELS = ['red', 'amber', 'purple', 'blue', 'green', 'grey']
const MON_LABEL = { red: 'Failure', amber: 'Warning', purple: 'No data', blue: 'Information', green: 'All clear', grey: 'Off or to review' }
const MON_MODES = [
  ['off', 'Off', 'Never'],
  ['dashboard', 'Count', 'Only counted on the dashboard button and title bar'],
  ['silent', 'Silent', 'A notification without sound'],
  ['toast', 'Sound', 'A notification with its sound; the taskbar flashes'],
  ['urgent', 'Stays', 'Stays on screen until dismissed, with the reminder sound'],
  ['alarm', 'Alarm', 'Stays on screen with a looping alarm until dismissed'],
]
const dash = { open: false, search: '', tab: 'all', level: undefined }
const monitorOp = (op, args = {}) => send('monitor', { op, args })

function monAgo(seconds) {
  if (seconds === undefined || seconds === null) return 'not checked yet'
  const d = Math.round(Date.now() / 1000 - seconds)
  if (d < 0) return -d < 90 ? 'in a moment' : -d < 3600 ? `in ${Math.round(-d / 60)} min` : `in ${Math.round(-d / 3600)} h`
  return d < 45 ? 'just now' : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`
}
const monEvery = (s) => (s == null ? '' : s % 86400 === 0 ? `every ${s / 86400} d` : s % 3600 === 0 ? `every ${s / 3600} h` : `every ${Math.round(s / 60)} min`)

/** The worst colour among monitors that are running, and how many are red or amber. */
function monitorSummary() {
  const list = model.monitoring?.monitors ?? []
  // Snoozed and paused monitors keep their own tile's colour, but do not colour the whole dashboard: a
  // snoozed red is somebody having said "I know".
  const live = list.filter((m) => m.approved && !m.paused && !m.snoozeUntil)
  const worst = MON_LEVELS.find((l) => live.some((m) => m.level === l)) ?? (list.length > 0 ? 'green' : 'grey')
  const alerting = list.filter((m) => (m.level === 'red' || m.level === 'amber') && !m.snoozeUntil).length
  const review = list.filter((m) => m.status === 'review').length
  return { worst, alerting, review }
}

function renderMonitorButton() {
  const on = model.monitoring?.enabled === true
  const { worst, alerting, review } = monitorSummary()
  for (const [btn, orb] of [['#monitoring-btn', '#monitoring-orb'], ['#rail-monitoring', '#rail-monitoring-orb']]) {
    $(btn).hidden = !on
    $(orb).className = `orb lv-${worst}`
  }
  const count = $('#monitoring-count')
  count.hidden = alerting === 0 && review === 0
  count.textContent = alerting > 0 ? String(alerting) : review > 0 ? `${review} to review` : ''
  count.className = `monitor-count${alerting > 0 ? ` lv-${worst}` : ' review'}`
  $('#monitoring-btn').title = alerting > 0 ? `Monitoring — ${alerting} alerting (Ctrl+M)` : 'Monitoring dashboard (Ctrl+M)'
  if (!on && dash.open) closeDashboard()
}

function openDashboard() {
  if (model.monitoring?.enabled !== true) {
    notice('Monitoring is off. Switch it on in Settings → Monitoring.')
    return
  }
  dash.open = true
  $('#monitoring').hidden = false
  document.body.classList.add('dashboard-open')
  renderDashboard()
  monitorOp('rescan')
  setTimeout(() => $('#dash-search')?.focus(), 0)
}

function closeDashboard() {
  dash.open = false
  $('#monitoring').hidden = true
  $('#dash-tip').hidden = true
  document.body.classList.remove('dashboard-open')
  $(`.pane[data-id="${model.active}"] iframe`)?.focus()
}

/** A row of small bars, one per recent check, in that check's colour - how it has been lately. */
/**
 * The run history, as a wide button across the bottom of a tile (asked for): a bar per recent check, oldest on
 * the left. Pressing it opens the monitor's window on History - every check kept, earlier days too (90 days by
 * default); pressing one bar opens it on that check.
 */
function historyStrip(m) {
  const points = (m.history ?? []).slice(-24)
  const open = (at) => {
    $('#dash-tip').hidden = true
    monitorOp('open', { name: m.name, sheet: 'history', ...(at !== undefined ? { at } : {}) })
  }
  const stamp = (at) => new Date(at * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const strip = el(
    'span',
    {
      class: 'spark-btn',
      role: 'button',
      tabindex: '0',
      'aria-label': `Run history of ${m.title}`,
      title: points.length > 0 ? 'Run history - the last checks, oldest on the left. Click for every check, earlier days too; click a bar for that check.' : 'Run history - no checks yet',
    },
    el('span', { class: 'spark' }, ...points.map(([at, level]) => el('i', { class: `lv-${level}`, 'data-at': String(at), title: `${stamp(at)} - ${MON_LABEL[level] ?? level} - open this check` }))),
  )
  // Inside the tile, which is a button too: the tile's own click (its grid) must not also fire.
  strip.addEventListener('click', (e) => {
    e.stopPropagation()
    const at = e.target instanceof HTMLElement ? e.target.dataset.at : undefined
    open(at !== undefined ? Number(at) : undefined)
  })
  strip.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopPropagation()
    open()
  })
  return strip
}

function monitorMatches(m) {
  if (dash.tab === 'team' && !m.team) return false
  if (dash.tab === 'personal' && m.team) return false
  if (dash.level !== undefined && m.level !== dash.level) return false
  const needle = dash.search.trim().toLowerCase()
  if (!needle) return true
  return [m.title, m.name, m.summary, m.headline, m.origin, m.source, MON_LABEL[m.level]].some((t) => (t ?? '').toLowerCase().includes(needle))
}

function tile(m) {
  const node = el(
    'button',
    {
      class: `tile lv-${m.level}${m.status === 'review' ? ' review' : ''}${m.paused ? ' paused' : ''}${m.running ? ' running' : ''}`,
      'data-name': m.name,
      'aria-label': `${m.title}: ${MON_LABEL[m.level]}. ${m.headline}`,
      onclick: () => clickTile(m),
    },
    el('span', { class: 'tile-glow', 'aria-hidden': 'true' }),
    el(
      'span',
      { class: 'tile-top' },
      el('span', { class: `orb lv-${m.level}` }),
      m.status === 'review'
        ? el('span', { class: 'tile-flag', text: 'Review' })
        : m.status === 'noTeam'
          ? el('span', { class: 'tile-flag', text: 'Needs team history' })
        : m.snoozeUntil
          ? el('span', { class: 'tile-flag', text: 'Snoozed' })
          : m.paused
            ? el('span', { class: 'tile-flag', text: 'Paused' })
            : m.notHere
              // A team monitor this computer cannot run: colleagues' Fire Code does - the reason on hover.
              ? el('span', { class: 'tile-flag', text: 'Runs elsewhere', title: m.notHere })
            : m.offline > 0
              ? el('span', { class: 'tile-flag', text: `Offline · ${m.offline} not shared`, title: 'Checked on this computer while the team history could not be reached. Offered to the team when it can be - unless a colleague already has that check.' })
            : m.openAlerts
              ? el('span', { class: 'tile-count', text: String(m.openAlerts) })
              : null,
    ),
    el('span', { class: 'tile-title', text: m.title }),
    el('span', { class: 'tile-headline', text: m.headline }),
    el('span', { class: 'tile-foot' }, el('span', { class: `tile-when${m.waitingFor || monLate(m) ? ' late' : ''}`, text: m.waitingFor ? 'waiting…' : m.running ? 'checking…' : monLate(m) ? `due ${monAgo(m.nextRun)}` : monAgo(m.lastRun), title: m.waitingFor || '' })),
    historyStrip(m),
  )
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    tileMenu(m, e.clientX, e.clientY)
  })
  node.addEventListener('mouseenter', () => showTileTip(m, node))
  node.addEventListener('mouseleave', () => ($('#dash-tip').hidden = true))
  return node
}

/** A check more than a minute and a half past when it should have started, and not running: said on the tile. */
function monLate(m) {
  return !m.running && !m.paused && m.approved && m.nextRun && m.nextRun < Date.now() / 1000 - 90
}

function showTileTip(m, node) {
  const tip = $('#dash-tip')
  tip.className = `dash-tip lv-${m.level}`
  tip.replaceChildren(
    el('div', { class: 'tip-head' }, el('span', { class: `orb lv-${m.level}` }), el('b', { text: m.title }), el('span', { class: 'tip-level', text: MON_LABEL[m.level] })),
    el('p', { class: 'tip-summary', text: m.summary || m.description || '' }),
    el('p', { class: 'tip-headline', text: m.headline }),
    el(
      'dl',
      {},
      el('dt', { text: 'For' }),
      el('dd', { text: `${m.team ? 'The team' : 'You only'} · ${m.origin}` }),
      m.source ? [el('dt', { text: 'Reads' }), el('dd', { text: m.source })] : null,
      m.schedule ? [el('dt', { text: 'Checks' }), el('dd', { text: `${m.schedule} · last ${monAgo(m.lastRun)}${m.lastBy ? ` by ${m.lastBy}` : ''}${m.nextRun ? ` · next ${monAgo(m.nextRun)}` : ''}` })] : null,
      m.waitingFor ? [el('dt', { text: 'Waiting' }), el('dd', { text: m.waitingFor })] : null,
      m.author || m.updatedBy ? [el('dt', { text: 'Written by' }), el('dd', { text: `${m.author ?? 'not named'}${m.updatedAt || m.updatedBy ? ` · updated ${m.updatedAt ? monAgo(m.updatedAt) : ''}${m.updatedBy ? ` by ${m.updatedBy}` : ''}` : ''}${m.version ? ` · v${m.version}` : ''}` })] : null,
      m.snoozeUntil ? [el('dt', { text: 'Snoozed' }), el('dd', { text: `until ${new Date(m.snoozeUntil * 1000).toLocaleTimeString()}` })] : null,
      m.mode ? [el('dt', { text: 'Notifies' }), el('dd', { text: MON_MODES.find(([id]) => id === m.mode)?.[2] ?? m.mode })] : null,
    ),
    el('p', { class: 'tip-hint', text: m.status === 'review' ? 'Click to review what it runs, and approve it.' : 'Click to open its grid · right-click for more' }),
  )
  tip.hidden = false
  const r = node.getBoundingClientRect()
  const w = tip.offsetWidth
  const h = tip.offsetHeight
  const left = r.right + 12 + w < innerWidth ? r.right + 12 : Math.max(8, r.left - w - 12)
  tip.style.left = `${left}px`
  tip.style.top = `${Math.max(8, Math.min(r.top, innerHeight - h - 8))}px`
}

function clickTile(m) {
  $('#dash-tip').hidden = true
  if (m.status === 'review') return reviewMonitor(m)
  if (m.status === 'broken') return brokenMonitor(m)
  monitorOp('open', { name: m.name })
}

function tileMenu(m, x, y) {
  closeMenu()
  $('#dash-tip').hidden = true
  const item = (icon, label, action, extra = {}) =>
    why(
      el('button', { class: extra.danger ? 'danger' : '', onclick: () => (closeMenu(), action()) }, el('span', { html: svg(ICONS[icon]) }), label, extra.checked ? el('span', { class: 'check', html: svg(ICONS.check) }) : null),
      extra.disabled,
    )
  const menu = el(
    'div',
    { class: 'menu', role: 'menu' },
    m.status === 'review'
      ? item('check', 'Review and approve…', () => reviewMonitor(m))
      : [item('play', 'Open grid', () => monitorOp('open', { name: m.name })), item('restart', 'Check now', () => monitorOp('run', { name: m.name }))],
    el('hr'),
    m.paused ? item('play', 'Resume checks', () => monitorOp('resume', { name: m.name })) : item('sleep', 'Pause checks', () => monitorOp('pause', { name: m.name })),
    item('moon', 'Snooze 1 hour', () => monitorOp('snooze', { name: m.name, minutes: 60 })),
    item('moon', 'Snooze until tomorrow', () => monitorOp('snooze', { name: m.name, minutes: 1440 })),
    item('moon', 'Snooze until…', () => snoozeUntil(m)),
    m.snoozeUntil ? item('sun', 'End the snooze', () => monitorOp('snooze', { name: m.name, minutes: 0 })) : null,
    el('hr'),
    el('div', { class: 'menu-label', text: 'How this one notifies' }),
    item('info', 'As Settings say', () => monitorOp('notify', { name: m.name, mode: 'default' }), { checked: !m.mode }),
    ...MON_MODES.map(([id, label, about]) => item('info', `${label} — ${about.toLowerCase()}`, () => monitorOp('notify', { name: m.name, mode: id }), { checked: m.mode === id })),
    el('hr'),
    // In the monitor's own window, where the schedule it changes is in view.
    item('clock', 'Edit schedule…', () => monitorOp('open', { name: m.name, sheet: 'schedule' })),
    item('explorer', 'Show the skill file', () => monitorOp('openFile', { name: m.name })),
    item('remove', 'Delete its history…', () => confirmDeleteHistory(m), { danger: true }),
    item('remove', 'Delete this monitor…', () => confirmDeleteMonitor(m), { danger: true }),
    m.approved ? item('remove', 'Take back the approval', () => monitorOp('revoke', { name: m.name }), { danger: true }) : null,
  )
  document.body.append(menu)
  const box = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, innerWidth - box.width - 8)}px`
  menu.style.top = `${Math.min(y, innerHeight - box.height - 8)}px`
  dismissOnOutside(menu)
}

/** What approving a monitor lets run, shown whole (invariant 8: the spec itself, not a description). */
function reviewMonitor(m) {
  showModal('monitorReview', (scrim) => {
    scrim.append(
      el(
        'div',
        { class: 'modal', style: 'width: min(720px, calc(100vw - 48px))' },
        el('header', {}, el('h2', { text: `Review “${m.title}”` }), el('p', { class: 'sub', text: `${m.team ? 'A team monitor' : 'A personal monitor'} from ${m.origin}. It runs on this computer, unattended, once you approve it.` })),
        el(
          'div',
          { class: 'body' },
          el('p', { text: m.summary || m.description || '' }),
          m.source ? el('p', {}, 'It reads ', el('b', { text: m.source }), ` ${monEvery(m.every)}.`) : null,
          el('pre', { class: 'mon-spec', text: m.block ?? '(the definition could not be read)' }),
          el('p', { class: 'hint', text: 'A tool it names is still subject to its own approval: a Python tool must already be approved here, and monitors may never run tools that change things.' }),
        ),
        el(
          'footer',
          {},
          el('button', { class: 'secondary', text: 'Show the file', onclick: () => monitorOp('openFile', { name: m.name }) }),
          el('span', { class: 'spacer' }),
          el('button', { class: 'secondary', text: 'Not now', onclick: closeModal }),
          el('button', { class: 'primary', text: 'Approve and run', onclick: () => (monitorOp('approve', { name: m.name }), closeModal()) }),
        ),
      ),
    )
  })
}

function brokenMonitor(m) {
  showModal('monitorBroken', (scrim) => {
    scrim.append(
      el(
        'div',
        { class: 'modal', style: 'width: min(600px, calc(100vw - 48px))' },
        el('header', {}, el('h2', { text: `“${m.title}” cannot run` })),
        el('div', { class: 'body' }, el('p', { text: m.specError ?? m.headline }), el('p', { class: 'hint', text: 'Ask the agent to fix it with monitor_create under the same name, or edit its skill file.' })),
        el('footer', {}, el('button', { class: 'secondary', text: 'Show the file', onclick: () => monitorOp('openFile', { name: m.name }) }), el('span', { class: 'spacer' }), el('button', { class: 'primary', text: 'Close', onclick: closeModal })),
      ),
    )
  })
}

function renderDashboard() {
  const root = $('#monitoring')
  const data = model.monitoring ?? { monitors: [] }
  const all = data.monitors ?? []
  const sorted = [...all].sort((a, b) => MON_LEVELS.indexOf(a.level) - MON_LEVELS.indexOf(b.level) || a.title.localeCompare(b.title))
  const shown = sorted.filter(monitorMatches)
  const count = (pred) => all.filter(pred).length
  const focused = document.activeElement?.id === 'dash-search'
  const search = el('input', { id: 'dash-search', type: 'search', placeholder: 'Search alerts', value: dash.search, spellcheck: 'false', 'aria-label': 'Search alerts' })
  search.addEventListener('input', () => {
    dash.search = search.value
    renderDashboard()
  })
  const tab = (id, label, n) => el('button', { class: dash.tab === id ? 'on' : '', onclick: () => ((dash.tab = id), renderDashboard()) }, label, el('span', { class: 'tab-n', text: String(n) }))
  const levelChip = (level) => {
    const n = all.filter((m) => m.level === level && (dash.tab === 'all' || (dash.tab === 'team') === m.team)).length
    if (n === 0 && dash.level !== level) return null
    return el('button', { class: `level-chip lv-${level}${dash.level === level ? ' on' : ''}`, title: MON_LABEL[level], onclick: () => ((dash.level = dash.level === level ? undefined : level), renderDashboard()) }, el('i', { class: 'mon-dot' }), `${MON_LABEL[level]} ${n}`)
  }
  const grid = (list) => el('div', { class: 'tiles' }, ...list.map(tile))
  const section = (title, list, hint) =>
    list.length === 0 ? null : el('section', { class: 'dash-section' }, el('h3', {}, title, el('span', { class: 'dash-section-n', text: String(list.length) }), hint ? el('span', { class: 'dash-section-hint', text: hint }) : null), grid(list))
  const executor = data.executor ?? {}
  const body =
    all.length === 0
      ? el(
          'div',
          { class: 'dash-empty' },
          el('div', { class: 'dash-empty-orbs', 'aria-hidden': 'true' }, ...['green', 'blue', 'amber', 'red', 'purple'].map((l) => el('span', { class: `orb lv-${l}` }))),
          el('h2', { text: 'No monitors yet' }),
          el('p', { text: 'A monitor checks something on a schedule — a job, a table, a log, an API — colours what needs attention, and tells you the way you choose. Ask an agent in any codebase to make one:' }),
          el(
            'ul',
            {},
            el('li', { text: '“Monitor the PAY_* AutoSys jobs every 15 minutes: red when one fails, amber when one runs over an hour.”' }),
            el('li', { text: '“Watch C:\\data\\positions.db: amber when yesterday’s count drops by more than 10%, just for me.”' }),
            el('li', { text: '“Make a team monitor of the disk space on our build servers, red under 10% free.”' }),
          ),
          el('p', { class: 'hint', text: 'It reuses a tool you already have, or writes one; you approve the monitor before it runs.' }),
        )
      : shown.length === 0
        ? el('div', { class: 'dash-empty small' }, el('p', { text: 'Nothing matches.' }))
        : dash.tab === 'all'
          ? el('div', {}, section('Team alerts', shown.filter((m) => m.team), 'shared with the team · each person’s Fire Code runs them'), section('Personal', shown.filter((m) => !m.team), 'only on this computer'))
          : grid(shown)
  // Through el(), which leaves out what is absent: replaceChildren given null writes the word "null".
  const parts = el(
    'div',
    {},
    el(
      'header',
      { class: 'dash-head' },
      el('div', { class: 'dash-brand' }, el('span', { class: `orb big lv-${monitorSummary().worst}` }), el('div', {}, el('h1', { text: 'Monitoring' }), el('p', { class: 'sub', text: dashSubtitle(all) }))),
      el('label', { class: 'dash-search' }, el('span', { html: svg('<circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3 3" />') }), search),
      el('div', { class: 'segmented dash-tabs' }, tab('all', 'All', all.length), tab('team', 'Team', count((m) => m.team)), tab('personal', 'Personal', count((m) => !m.team))),
      el('div', { class: 'dash-tools' }, el('button', { class: `icon-btn${dash.refreshing ? ' spinning' : ''}`, title: dash.refreshing ? 'Refreshing…' : 'Refresh - sync the team\u2019s skills and show monitors added or deleted since', 'aria-label': 'Refresh', disabled: dash.refreshing, onclick: refreshMonitors, html: svg(ICONS.restart) }), el('button', { class: 'icon-btn', title: 'Monitoring settings', 'aria-label': 'Monitoring settings', onclick: openMonitorSettings, html: svg('cog') }), el('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeDashboard, html: svg(ICONS.close) })),
    ),
    el('div', { class: 'dash-levels' }, ...MON_LEVELS.map(levelChip)),
    reviewBanner(all),
    schedulerBar(data.scheduler),
    executor.error ? el('div', { class: 'dash-banner lv-purple' }, el('span', { class: 'orb lv-purple' }), el('span', { text: `Monitors that use a tool cannot run: ${executor.error}` })) : null,
    el('div', { class: 'dash-body' }, body),
    el('footer', { class: 'dash-legend' }, ...MON_LEVELS.map((l) => el('span', {}, el('span', { class: `orb small lv-${l}` }), (data.levels ?? []).find((x) => x.level === l)?.meaning ?? MON_LABEL[l]))),
  )
  root.replaceChildren(...parts.childNodes)
  if (focused) {
    search.focus()
    search.setSelectionRange(search.value.length, search.value.length)
  }
}

/**
 * Whether checks are being started on time (asked for: "a way to check if scheduler is working or running, if not
 * user can start it", and to stop it). Rust looks every 3 seconds and the dashboard hears it at least every 30;
 * not heard from for 90 seconds is not working.
 */
function schedulerBar(s) {
  if (!s) return null
  const stale = !s.stopped && (s.lastTick == null || Date.now() / 1000 - s.lastTick > 90)
  const state = s.stopped ? 'stopped' : stale ? 'stale' : 'ok'
  const text = {
    ok: `Scheduler running \u00b7 looked ${monAgo(s.lastTick)}${s.running ? ` \u00b7 ${s.running} checking now` : ''}${s.waiting ? ` \u00b7 ${s.waiting} waiting` : ''}`,
    stopped: 'Scheduler stopped \u2014 no check starts by itself. Run now still works.',
    stale: `Scheduler not responding \u2014 it last looked ${monAgo(s.lastTick)}. Start it again.`,
  }[state]
  const act = (op, label, cls, tip) => el('button', { class: cls, text: label, title: tip, onclick: () => monitorOp(op) })
  return el(
    'div',
    { class: `dash-scheduler ${state}`, role: 'status' },
    el('span', { class: `orb small lv-${state === 'ok' ? 'green' : state === 'stopped' ? 'grey' : 'amber'}` }),
    el('span', { text }),
    el('span', { class: 'spacer' }),
    state === 'ok'
      ? act('schedulerStop', 'Stop', 'secondary small', 'Stop starting checks by themselves - until you start it again, also after a restart')
      : act('schedulerStart', state === 'stale' ? 'Start again' : 'Start', 'primary small', 'Start checks when they are due again, letting go of anything stuck'),
  )
}

/** Monitors waiting for approval on this computer - colleagues' new ones, and any whose definition changed. */
function reviewBanner(all) {
  const waiting = all.filter((m) => m.status === 'review')
  if (waiting.length === 0) return null
  return el(
    'div',
    { class: 'dash-banner lv-blue' },
    el('span', { class: 'orb lv-blue' }),
    el('span', { text: `${waiting.length} monitor${waiting.length === 1 ? '' : 's'} waiting for your review before ${waiting.length === 1 ? 'it runs' : 'they run'} on this computer.` }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'primary small', text: waiting.length === 1 ? 'Review…' : 'Review all…', onclick: () => reviewMonitors(waiting) }),
  )
}

/**
 * Several monitors at once (asked for: accept all, or choose which). Each definition is on screen - what
 * approving runs, unattended (invariant 8) - with a tick per monitor; only the ticked ones are approved.
 * Nothing is ticked at first, so approving is something done, not a default accepted.
 */
function reviewMonitors(list) {
  const chosen = new Set()
  showModal('monitorReviewMany', (scrim) => {
    const count = el('span', { class: 'muted' })
    const approve = el('button', { class: 'primary' })
    const all = el('input', { type: 'checkbox', 'aria-label': 'Select all' })
    const boxes = []
    const refresh = () => {
      approve.textContent = chosen.size === 0 ? 'Approve selected' : `Approve ${chosen.size} selected`
      why(approve, chosen.size === 0 ? 'Tick the monitors to approve first' : undefined)
      all.checked = chosen.size === list.length
      all.indeterminate = chosen.size > 0 && chosen.size < list.length
      count.textContent = `${chosen.size} of ${list.length} selected`
      for (const [name, box] of boxes) box.checked = chosen.has(name)
    }
    all.addEventListener('change', () => {
      if (all.checked) list.forEach((m) => chosen.add(m.name))
      else chosen.clear()
      refresh()
    })
    approve.addEventListener('click', () => {
      for (const name of chosen) monitorOp('approve', { name })
      closeModal()
      notice(`Approved ${chosen.size} monitor${chosen.size === 1 ? '' : 's'}; ${chosen.size === 1 ? 'it starts' : 'they start'} at the next check.`)
    })
    const rows = list.map((m) => {
      const box = el('input', { type: 'checkbox', 'aria-label': `Approve ${m.title}` })
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(m.name)
        else chosen.delete(m.name)
        refresh()
      })
      boxes.push([m.name, box])
      return el(
        'div',
        { class: 'review-item' },
        el('label', { class: 'review-pick' }, box, el('b', { text: m.title }), el('span', { class: 'muted', text: ` ${m.team ? 'team' : 'personal'} · from ${m.origin}${m.schedule ? ` · ${m.schedule}` : ''}` })),
        m.summary ? el('p', { class: 'review-summary', text: m.summary }) : null,
        el('pre', { class: 'mon-spec', text: m.block ?? '(the definition could not be read)' }),
      )
    })
    refresh()
    scrim.append(
      el(
        'div',
        { class: 'modal', style: 'width: min(760px, calc(100vw - 48px))' },
        el('header', {}, el('h2', { text: 'Review monitors' }), el('p', { class: 'sub', text: 'Each runs on this computer, unattended, once approved. Read what each one runs, then tick the ones to approve.' })),
        el('div', { class: 'body review-list' }, el('label', { class: 'review-all' }, all, 'Select all'), ...rows),
        el(
          'footer',
          {},
          count,
          el('span', { class: 'spacer' }),
          el('button', { class: 'secondary', text: 'Not now', onclick: closeModal }),
          approve,
        ),
      ),
    )
  })
}

/** "Snooze until…": a date and time, tomorrow 09:00 to start from, at most 30 days ahead (Rust checks it too). */
function snoozeUntil(m) {
  const pad = (n) => String(n).padStart(2, '0')
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  const start = new Date()
  start.setDate(start.getDate() + 1)
  start.setHours(9, 0, 0, 0)
  showModal('monitorSnooze', (scrim) => {
    const input = el('input', { type: 'datetime-local', value: local(start), min: local(new Date()), max: local(new Date(Date.now() + 30 * 86_400_000)), 'aria-label': 'Until' })
    const problem = el('p', { class: 'form-error', hidden: true })
    const go = () => {
      const chosen = new Date(input.value)
      const fail = Number.isNaN(chosen.getTime())
        ? 'Choose a date and a time.'
        : chosen.getTime() <= Date.now()
          ? 'That time has already passed.'
          : chosen.getTime() > Date.now() + 30 * 86_400_000
            ? 'At most 30 days ahead - to stop it for longer, pause it.'
            : undefined
      if (fail) {
        problem.textContent = fail
        problem.hidden = false
        return
      }
      monitorOp('snooze', { name: m.name, until: Math.floor(chosen.getTime() / 1000) })
      closeModal()
    }
    scrim.append(
      el(
        'div',
        { class: 'modal', style: 'width: min(420px, calc(100vw - 48px))' },
        el('header', {}, el('h2', { text: `Snooze \u201c${m.title}\u201d until` })),
        el('div', { class: 'body' }, el('p', { class: 'sub', text: 'No notifications from it, and it does not colour the Monitoring button, until then.' }), input, problem),
        el('footer', {}, el('span', { class: 'spacer' }), el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }), el('button', { class: 'primary', text: 'Snooze', onclick: go })),
      ),
    )
  })
}

function dashSubtitle(all) {
  if (all.length === 0) return 'Nothing is being watched yet'
  const { alerting, review } = monitorSummary()
  const parts = [`${all.length} monitor${all.length === 1 ? '' : 's'}`]
  if (alerting > 0) parts.push(`${alerting} alerting`)
  else parts.push('nothing alerting')
  if (review > 0) parts.push(`${review} to review`)
  return parts.join(' · ')
}

function openMonitorSettings() {
  showModal('monitorSettings', (scrim, modal) => {
    const card = el('div', { class: 'modal', style: 'width: min(640px, calc(100vw - 48px))' })
    scrim.append(card)
    let newFolder = ''
    const patch = (changes) => monitorOp('settings', { patch: changes })
    modal.refresh = () => {
      const data = model.monitoring ?? {}
      const s = data.settings ?? {}
      const levelRow = (level) =>
        el(
          'div',
          { class: 'row' },
          el('span', { class: 'meta' }, el('b', {}, el('span', { class: `orb small lv-${level}` }), ` ${MON_LABEL[level]}`), el('span', { text: MON_MODES.find(([id]) => id === s[level])?.[2] ?? '' })),
          el('div', { class: 'segmented small' }, ...MON_MODES.map(([id, label, about]) => el('button', { class: s[level] === id ? 'on' : '', text: label, title: about, onclick: () => patch({ [level]: id }) }))),
        )
      const folderInput = el('input', { type: 'text', placeholder: 'C:\\team\\monitors', value: newFolder, spellcheck: 'false' })
      folderInput.addEventListener('input', () => (newFolder = folderInput.value))
      const quiet = el('input', { type: 'text', placeholder: '22:00-07:00', value: s.quietHours ?? '', spellcheck: 'false', style: 'width: 130px' })
      const teamIndex = el('input', { type: 'text', value: s.teamIndex ?? 'fire-code-monitoring', spellcheck: 'false', style: 'width: 220px' })
      teamIndex.addEventListener('change', () => patch({ teamIndex: teamIndex.value.trim().toLowerCase() }))
      quiet.addEventListener('change', () => patch({ quietHours: quiet.value.trim() === '' ? null : quiet.value.trim() }))
      card.replaceChildren(
        el('header', {}, el('h2', { text: 'Monitoring' }), el('p', { class: 'sub', text: 'How monitors tell you, and what their tools run with.' })),
        el(
          'div',
          { class: 'body' },
          el('h3', { class: 'group', text: 'Windows notifications, by level' }),
          ...['red', 'amber', 'purple', 'blue', 'green'].map(levelRow),
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'meta' }, el('b', { text: 'Remind me while it stays red or amber' }), el('span', { text: 'A reminder is a plain notification, never an alarm again.' })),
            el('div', { class: 'segmented small' }, ...[[0, 'Never'], [15, '15 min'], [30, '30 min'], [60, '1 h'], [240, '4 h']].map(([v, label]) => el('button', { class: s.repeatMinutes === v ? 'on' : '', text: label, onclick: () => patch({ repeatMinutes: v }) }))),
          ),
          el('div', { class: 'row' }, el('span', { class: 'meta' }, el('b', { text: 'Tell me when it clears' }), el('span', { text: 'A quiet notification when a red or amber monitor is clear again.' })), monToggle(s.recovery !== false, (on) => patch({ recovery: on }))),
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'meta' }, el('b', { text: 'Quiet hours' }), el('span', { text: 'Only counted then — failures still get through if you say so.' })),
            el('div', { class: 'inline' }, quiet, el('label', { class: 'check-label' }, monToggle(s.quietLetsRedThrough !== false, (on) => patch({ quietLetsRedThrough: on })), ' Failures get through')),
          ),
          el('h3', { class: 'group', text: 'Team history (OpenSearch)' }),
          el(
            'div',
            { class: 'row stacked' },
            el(
              'span',
              { class: 'meta' },
              el('b', { text: 'Where the team keeps its checks' }),
              el('span', {
                text:
                  'Team monitors run only with this: every member\u2019s Fire Code writes its checks to one shared index, a check runs once across the team, and everyone sees the newest. Choose an OpenSearch connection from the search connections of the codebase below.',
              }),
            ),
            (data.teamStores ?? []).length === 0
              ? el('p', { class: 'hint', text: 'That codebase has no OpenSearch connection. Add one in its chat: Settings → Search.' })
              : el(
                  'div',
                  { class: 'choice-list' },
                  el('button', { class: !s.teamStore ? 'on' : '', onclick: () => patch({ teamStore: null }) }, 'None - no team monitors'),
                  ...data.teamStores.map((store) => el('button', { class: s.teamStore === store.id ? 'on' : '', onclick: () => patch({ teamStore: store.id }) }, store.label)),
                ),
            el('div', { class: 'inline' }, el('span', { class: 'hint', text: 'Index (the same for the whole team):' }), teamIndex),
            data.teamReady ? el('p', { class: 'hint', text: data.teamError ? `Last problem: ${data.teamError}` : 'Ready.' }) : el('p', { class: 'hint', text: data.teamProblem ?? '' }),
          ),
          el('h3', { class: 'group', text: 'History' }),
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'meta' }, el('b', { text: 'Keep check history for' }), el('span', { text: 'Older checks are removed here and - only your own - from the team\u2019s index, every few hours.' })),
            el('div', { class: 'segmented small' }, ...[[30, '30 d'], [90, '90 d'], [180, '180 d'], [365, '1 year']].map(([v, label]) => el('button', { class: (s.retentionDays ?? 90) === v ? 'on' : '', text: label, onclick: () => patch({ retentionDays: v }) }))),
          ),
          el('div', { class: 'row' }, el('span', { class: 'meta' }, el('b', { text: 'Clean up now' }), el('span', { text: 'Remove what is older than that - or older than a number of days you choose - without waiting.' })), el('button', { class: 'secondary', text: 'Clean up…', onclick: () => confirmCleanup(s.retentionDays ?? 90) })),
          el('h3', { class: 'group', text: 'Running checks' }),
          el(
            'div',
            { class: 'row stacked' },
            el('span', { class: 'meta' }, el('b', { text: 'Run tools with the settings of' }), el('span', { text: 'A monitor that uses a tool runs it in the background with this codebase’s MCP servers, Python and connections. SQLite and file monitors are read by Fire Code itself.' })),
            el(
              'div',
              { class: 'choice-list' },
              ...(data.codebases ?? []).map((c, i) =>
                el('button', { class: (s.executor ?? (data.codebases[0]?.id)) === c.id ? 'on' : '', onclick: () => patch({ executor: c.id }) }, c.name, i === 0 && !s.executor ? el('span', { class: 'muted', text: ' (default)' }) : null),
              ),
            ),
          ),
          el(
            'div',
            { class: 'row stacked' },
            el('span', { class: 'meta' }, el('b', { text: 'More folders to find monitors in' }), el('span', { text: 'Besides your personal skills, each codebase’s skills and the team’s bucket and repository copies. A monitor found here counts as a team one.' })),
            ...(s.extraFolders ?? []).map((f) => el('div', { class: 'inline' }, el('code', { text: f }), el('button', { class: 'secondary', text: 'Remove', onclick: () => patch({ extraFolders: s.extraFolders.filter((x) => x !== f) }) }))),
            el('div', { class: 'inline' }, folderInput, el('button', { class: 'secondary', text: 'Add', onclick: () => newFolder.trim() && (patch({ extraFolders: [...(s.extraFolders ?? []), newFolder.trim()] }), (newFolder = '')) })),
          ),
        ),
        el('footer', {}, el('span', { class: 'spacer' }), el('button', { class: 'primary', text: 'Done', onclick: closeModal })),
      )
    }
    modal.refresh()
  })
}

const monToggle = (on, change) => el('button', { class: `toggle${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), onclick: () => change(!on) })

HANDLERS.monitors = (m) => {
  model.monitoring = m
  renderMonitorButton()
  if (dash.open) renderDashboard()
  if (openModal?.kind === 'monitorSettings' || openModal?.kind === 'settings') openModal.refresh()
}
/** The dashboard's refresh: Rust reads the folders, the host syncs the bucket and repository, and Rust reads again. */
function refreshMonitors() {
  dash.refreshing = true
  renderDashboard()
  monitorOp('refresh')
  // An answer that never comes must not leave the button spinning.
  setTimeout(() => {
    if (!dash.refreshing) return
    dash.refreshing = false
    renderDashboard()
  }, 200_000)
}

HANDLERS.monitorReply = (m) => {
  if (m.data?.refreshed || (m.op === 'refresh' && !m.ok)) {
    dash.refreshing = false
    renderDashboard()
  }
  if (!m.ok) notice(m.error, 'error')
  // A team copy is changed or deleted by the host: said when it starts and when it is done.
  else if (typeof m.data?.message === 'string' && m.data.message.length > 0) notice(m.data.message)
}
HANDLERS.showMonitoring = () => openDashboard()
/*
 * "Start a chat" from an alert: Rust opened the chat; its page may still be loading, so the text waits with
 * the other requests for a page (deliverPendingAsk) and the dashboard steps aside to show the chat.
 */
HANDLERS.prefillChat = (m) => {
  if (dash.open) closeDashboard()
  pendingAsks[m.id] = { ask: 'prefill', text: m.text }
  deliverPendingAsk(m.id)
  notice('The chat is open with what is known about the alert - press Enter to send it.')
}

/**
 * "Older than": a choice of 7, 30 or 90 days, or a number typed - for one monitor's history (`m`) or, without one,
 * every monitor's (Clean up). Asked for: "delete history older than a month or N days".
 */
function olderThanPicker(initial) {
  const state = { mode: initial === undefined ? 'all' : 'older', days: initial ?? 30 }
  const custom = el('input', { type: 'number', min: '1', max: '3650', value: String(state.days), 'aria-label': 'Days', class: 'days-box' })
  const node = el('div', { class: 'older-picker' })
  const draw = () => {
    node.replaceChildren(
      el(
        'div',
        { class: 'segmented small' },
        ...(initial === undefined ? [el('button', { class: state.mode === 'all' ? 'on' : '', text: 'Everything', onclick: () => ((state.mode = 'all'), draw()) })] : []),
        ...[7, 30, 90].map((d) => el('button', { class: state.mode === 'older' && state.days === d ? 'on' : '', text: `Older than ${d} days`, onclick: () => ((state.mode = 'older'), (state.days = d), (custom.value = String(d)), draw()) })),
      ),
      el('label', { class: `older-custom${state.mode === 'older' && ![7, 30, 90].includes(state.days) ? ' on' : ''}` }, 'or older than ', custom, ' days'),
    )
  }
  custom.addEventListener('input', () => {
    state.mode = 'older'
    state.days = Number(custom.value)
    draw()
    custom.focus()
  })
  draw()
  return {
    node,
    /** Days, or undefined for everything; a problem in words when the number is not one. */
    read: () => (state.mode === 'all' ? { days: undefined } : Number.isInteger(state.days) && state.days >= 1 && state.days <= 3650 ? { days: state.days } : { problem: 'Older than how many days? A whole number, 1 or more.' }),
  }
}

function confirmDeleteHistory(m) {
  showModal('monitorDelete', (scrim) => {
    const picker = olderThanPicker(undefined)
    const problem = el('p', { class: 'form-error', hidden: true })
    const go = () => {
      const chosen = picker.read()
      if (chosen.problem) {
        problem.textContent = chosen.problem
        problem.hidden = false
        return
      }
      monitorOp('deleteHistory', { name: m.name, ...(chosen.days !== undefined ? { olderThanDays: chosen.days } : {}) })
      closeModal()
      notice(chosen.days !== undefined ? `Deleting checks of \u201c${m.title}\u201d older than ${chosen.days} days.` : `Deleting the history of \u201c${m.title}\u201d.`)
    }
    scrim.append(
      el(
        'div',
        { class: 'modal', style: 'width: min(560px, calc(100vw - 48px))' },
        el('header', {}, el('h2', { text: `Delete the history of \u201c${m.title}\u201d` })),
        el(
          'div',
          { class: 'body' },
          picker.node,
          el('p', { class: 'muted', text: m.team ? 'Its checks on this computer, and your own checks in the team\u2019s index (with the grids they kept). Colleagues\u2019 checks are theirs and stay.' : 'Its checks on this computer, with the grids they kept. The monitor itself stays.' }),
          problem,
        ),
        el('footer', {}, el('span', { class: 'spacer' }), el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }), el('button', { class: 'primary danger', text: 'Delete', onclick: go })),
      ),
    )
  })
}

/** "Clean up now" with a choice: the retention, or older than N days - every monitor, here and your own team records. */
function confirmCleanup(retention) {
  showModal('monitorCleanup', (scrim) => {
    const picker = olderThanPicker(retention)
    const problem = el('p', { class: 'form-error', hidden: true })
    const go = () => {
      const chosen = picker.read()
      if (chosen.problem || chosen.days === undefined) {
        problem.textContent = chosen.problem ?? 'Choose how old.'
        problem.hidden = false
        return
      }
      monitorOp('cleanup', { olderThanDays: chosen.days })
      closeModal()
    }
    scrim.append(
      el(
        'div',
        { class: 'modal', style: 'width: min(560px, calc(100vw - 48px))' },
        el('header', {}, el('h2', { text: 'Clean up every monitor\u2019s history' })),
        el('div', { class: 'body' }, picker.node, el('p', { class: 'muted', text: 'On this computer, and your own checks in the team\u2019s index. Colleagues\u2019 checks are theirs and stay.' }), problem),
        el('footer', {}, el('span', { class: 'spacer' }), el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }), el('button', { class: 'primary danger', text: 'Clean up', onclick: go })),
      ),
    )
  })
}

/** Deleting a monitor for good: its file, results and history (pausing is the way to stop it for a while). */
function confirmDeleteMonitor(m) {
  showModal('monitorDelete', (scrim) => {
    scrim.append(
      el(
        'div',
        { class: 'modal', style: 'width: min(520px, calc(100vw - 48px))' },
        el('header', {}, el('h2', { text: `Delete “${m.title}” for good?` })),
        el(
          'div',
          { class: 'body' },
          el('p', { text: 'This removes:' }),
          el(
            'ul',
            {},
            m.teamCopy
              ? el('li', { text: `the monitor from ${m.teamCopy}, for everyone - colleagues lose it at their next sync` })
              : el('li', {}, 'its skill file ', el('code', { text: m.file })),
            el('li', { text: 'its results and history on this computer' }),
            m.team ? el('li', { text: 'your own checks in the team’s index - colleagues’ checks are theirs and stay' }) : null,
          ),
          m.team && !m.teamCopy ? el('p', { class: 'muted', text: 'If the file is shared through a codebase in git, colleagues keep it until the deletion is committed.' }) : null,
          el('p', { class: 'muted', text: 'To stop it for a while instead, pause it.' }),
        ),
        el(
          'footer',
          {},
          el('span', { class: 'spacer' }),
          el('button', { class: 'secondary', text: 'Cancel', onclick: closeModal }),
          el('button', { class: 'primary danger', text: 'Delete for good', onclick: () => (monitorOp('delete', { name: m.name }), closeModal()) }),
        ),
      ),
    )
  })
}

// Relative times on the tiles stay true while the dashboard is open.
setInterval(() => dash.open && !$('.menu') && renderDashboard(), 30_000)

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
$('#monitoring-btn').addEventListener('click', openDashboard)
$('#rail-monitoring').addEventListener('click', openDashboard)
document.addEventListener('contextmenu', (e) => {
  // The browser's own menu (Reload, Inspect) has nothing for anyone here.
  if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
})

send('ready')
