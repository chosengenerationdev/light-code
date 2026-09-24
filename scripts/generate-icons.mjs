#!/usr/bin/env node
/**
 * Draws the Light Code icons into `apps/vscode/resources/`.
 *
 * ## Why a generator rather than checked-in art
 *
 * The reason `generate-walkthrough-art.mjs` and the GIF scripts exist: a binary dropped into the
 * repository can only be replaced, never reviewed. When the mark changes, this file is what gets
 * edited and the diff says what the picture now claims.
 *
 * ## The mark
 *
 * A bulb, with light coming off it, and a cross inside. From a hand-drawn sketch. Two decisions
 * in it are worth not undoing:
 *
 * - **The cross is the filament, not a badge.** Drawn as a bold filled cross it reads as a
 *   first-aid symbol and takes the whole icon over — that was the first draft and it was rejected
 *   on sight. Drawn as the wire inside the glass it is what a filament actually looks like, and it
 *   is noticed rather than announced.
 * - **The activity-bar icon has no rays, and fills its box.** Shown a screenshot of the real
 *   activity bar, the old mark stood about half the height of its neighbours, which is not a style
 *   choice — it is the icon looking like it matters less. VS Code's own codicons use very nearly
 *   the whole 24-unit box. Rays at 24 pixels are grey fuzz, so they stay on the marketplace icon
 *   where there is room.
 *
 * ## Running it
 *
 * By hand, never in CI, like the GIF generators — it rasterises by screenshotting SVG in Edge,
 * which is a thing a developer machine has and a build agent may not.
 *
 *     node scripts/generate-icons.mjs
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'apps', 'vscode', 'resources')

// --- the mark ------------------------------------------------------------------------------

/** The bulb glass: a dome that tapers to a flat bottom where the base begins. */
const GLASS =
  'M 64 26 C 48.5 26 36 38 36 53.5 C 36 63 40.5 70 45.5 76.5 L 82.5 76.5 C 87.5 70 92 63 92 53.5 C 92 38 79.5 26 64 26 Z'

/** The screw base, narrowing downwards. */
const BASE = 'M 50 80 L 78 80 L 74.5 94 L 53.5 94 Z'

/**
 * Rays, none below the horizontal.
 *
 * A bulb throws light upward and sideways; rays under the base read as the thing falling rather
 * than shining. Seven is what fits before they start touching at this size — the sketch has a
 * dozen, which at 128 units would be a haze.
 */
function rays({ cx, cy, inner, outer, angles }) {
  return angles
    .map((degrees) => {
      const radians = (degrees * Math.PI) / 180
      const at = (r) => [cx + Math.cos(radians) * r, cy - Math.sin(radians) * r]
      const [x1, y1] = at(inner)
      const [x2, y2] = at(outer)
      return `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`
    })
    .join(' ')
}

const RAY_ANGLES = [0, 30, 60, 90, 120, 150, 180]
/** How much of the tile the mark takes, and how far the rays reach. See the note on sizing. */
const SCALE = 1.16
const RAY_INNER = 38
const RAY_OUTER = 49

/** Support wires from the base, crossed near the top: the filament. */
const filament = (ink) => `<path d="M 56.5 76.5 C 56.5 68 58 64 58 58 M 71.5 76.5 C 71.5 68 70 64 70 58"
      fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round" opacity="0.75"/>
    <g fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round" opacity="0.95">
      <path d="M 64 40 L 64 66"/>
      <path d="M 54.5 51 L 73.5 51"/>
    </g>`

/**
 * The mark's own vertical middle, which is not the bulb's middle: the base hangs below and the
 * rays reach above. Scaling about the wrong point walks the whole thing up or down the tile.
 */
const MARK_CENTRE_Y = (Math.min(52 - RAY_OUTER, 26) + 94) / 2

function markBody({ ink = '#FFFFFF', socket = '#4338CA', glow = true } = {}) {
  return `<g transform="translate(64 64) scale(${SCALE}) translate(-64 ${(-MARK_CENTRE_Y).toFixed(2)})">
    ${glow ? '<circle cx="64" cy="52" r="21" fill="#BAF5FD" opacity="0.5" filter="url(#lc-glow)"/>' : ''}
    <g fill="none" stroke="${ink}" stroke-width="5" stroke-linecap="round" opacity="0.9">
      <path d="${rays({ cx: 64, cy: 52, inner: RAY_INNER, outer: RAY_OUTER, angles: RAY_ANGLES })}"/>
    </g>
    <path d="${GLASS}" fill="none" stroke="${ink}" stroke-width="6" stroke-linejoin="round"/>
    ${filament(ink)}
    <path d="${BASE}" fill="${ink}"/>
    <g stroke="${socket}" stroke-width="3" stroke-linecap="round">
      <path d="M 51.5 85 L 76.5 85"/>
      <path d="M 52.5 90 L 75.5 90"/>
    </g>
  </g>`
}

/** The product icon: the brand tile with the mark on it. */
function tileIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Light Code">
  <defs>
    <linearGradient id="lc-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4338CA"/>
      <stop offset="1" stop-color="#A855F7"/>
    </linearGradient>
    <filter id="lc-glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="7"/>
    </filter>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#lc-bg)"/>
  ${markBody()}
</svg>`
}

/**
 * The mark alone, white, on nothing.
 *
 * For dark backgrounds that are not the tile — a README header, a slide. The socket lines are
 * cut out rather than drawn in the brand indigo, which would be a purple smear on anything else.
 */
function whiteMark() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Light Code">
  <defs>
    <filter id="lc-glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="7"/>
    </filter>
    <mask id="lc-socket">
      <rect width="128" height="128" fill="#fff"/>
      <g transform="translate(64 64) scale(${SCALE}) translate(-64 ${(-MARK_CENTRE_Y).toFixed(2)})"
         stroke="#000" stroke-width="3" stroke-linecap="round">
        <path d="M 51.5 85 L 76.5 85"/>
        <path d="M 52.5 90 L 75.5 90"/>
      </g>
    </mask>
  </defs>
  <g mask="url(#lc-socket)">
    <g transform="translate(64 64) scale(${SCALE}) translate(-64 ${(-MARK_CENTRE_Y).toFixed(2)})">
      <g fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round" opacity="0.9">
        <path d="${rays({ cx: 64, cy: 52, inner: RAY_INNER, outer: RAY_OUTER, angles: RAY_ANGLES })}"/>
      </g>
      <path d="${GLASS}" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linejoin="round"/>
      ${filament('#FFFFFF')}
      <path d="${BASE}" fill="#FFFFFF"/>
    </g>
  </g>
</svg>`
}

// --- the activity bar ----------------------------------------------------------------------

/**
 * One colour, 24 units, and it has to survive being 24 pixels.
 *
 * VS Code tints this itself, so everything is `currentColor` and nothing may rely on a
 * background. The artwork spans roughly 2 to 22 including the stroke — see the note at the top
 * for why filling the box is the point rather than a preference.
 */
function activityBarIcon() {
  const cx = 12
  const cy = 10.6
  const r = 7.4
  const stroke = 1.8
  const flat = cy + r * 0.82
  const half = r * 0.5
  const top = flat + 1.6

  const glass =
    `M ${cx} ${(cy - r).toFixed(1)} ` +
    `C ${(cx - r).toFixed(1)} ${(cy - r).toFixed(1)} ${(cx - r).toFixed(1)} ${(cy + r * 0.2).toFixed(1)} ${(cx - r * 0.62).toFixed(1)} ${flat.toFixed(1)} ` +
    `L ${(cx + r * 0.62).toFixed(1)} ${flat.toFixed(1)} ` +
    `C ${(cx + r).toFixed(1)} ${(cy + r * 0.2).toFixed(1)} ${(cx + r).toFixed(1)} ${(cy - r).toFixed(1)} ${cx} ${(cy - r).toFixed(1)} Z`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img" aria-label="Light Code">
  <path d="${glass}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linejoin="round"/>
  <g fill="none" stroke="currentColor" stroke-width="${(stroke * 0.85).toFixed(2)}" stroke-linecap="round">
    <path d="M ${cx} ${(cy - r * 0.58).toFixed(1)} L ${cx} ${(cy + r * 0.68).toFixed(1)}"/>
    <path d="M ${(cx - r * 0.4).toFixed(1)} ${(cy - r * 0.08).toFixed(1)} L ${(cx + r * 0.4).toFixed(1)} ${(cy - r * 0.08).toFixed(1)}"/>
  </g>
  <g stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" fill="none">
    <path d="M ${(cx - half).toFixed(1)} ${top.toFixed(1)} L ${(cx + half).toFixed(1)} ${top.toFixed(1)}"/>
    <path d="M ${(cx - half * 0.68).toFixed(1)} ${(top + 2.7).toFixed(1)} L ${(cx + half * 0.68).toFixed(1)} ${(top + 2.7).toFixed(1)}"/>
  </g>
</svg>`
}

// --- rasterising ---------------------------------------------------------------------------

/**
 * Edge, wherever this machine keeps it.
 *
 * Searched rather than hardcoded: it is under `Program Files` on one machine and
 * `Program Files (x86)` on another, and a script that only knows one of them fails with a path
 * nobody recognises.
 */
function findEdge() {
  const candidates = [
    process.env['EDGE_PATH'],
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter((candidate) => candidate !== undefined)
  return candidates.find((candidate) => fsSync.existsSync(candidate))
}

async function raster(edge, svg, size, file) {
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  const page = path.join(out, `.__icon-${size}.html`)
  await fs.writeFile(page, html, 'utf8')
  try {
    await run(edge, [
      '--headless=new',
      '--disable-gpu',
      `--screenshot=${path.join(out, file)}`,
      `--window-size=${size},${size}`,
      '--default-background-color=00000000',
      '--hide-scrollbars',
      `file:///${page.replace(/\\/g, '/')}`,
    ])
  } catch {
    // Edge exits non-zero after screenshotting often enough that its status says nothing; the
    // file being there is the check that matters, and it is made below.
  }
  await fs.rm(page, { force: true })
}

async function main() {
  const tile = tileIcon()
  await fs.writeFile(path.join(out, 'icon.svg'), `${tile}\n`, 'utf8')
  await fs.writeFile(path.join(out, 'activity-bar-icon.svg'), `${activityBarIcon()}\n`, 'utf8')
  console.log('[icons] wrote icon.svg and activity-bar-icon.svg')

  const edge = findEdge()
  if (edge === undefined) {
    console.error(
      '[icons] no Edge found, so the PNGs were not redrawn. Set EDGE_PATH, or run this on a\n' +
        '        machine that has it. The SVGs above are the source and are up to date.',
    )
    process.exitCode = 1
    return
  }

  const wanted = [
    [tile, 512, 'icon-512.png'],
    [tile, 256, 'icon-256.png'],
    [tile, 128, 'icon.png'],
    [whiteMark(), 256, 'mark-white.png'],
  ]
  for (const [svg, size, file] of wanted) {
    await raster(edge, svg, size, file)
    const written = await fs
      .stat(path.join(out, file))
      .then((stat) => stat.size)
      .catch(() => 0)
    // Checked rather than assumed: a screenshot that silently produced nothing would leave the
    // old mark in place while this said it had redrawn it.
    if (written === 0) throw new Error(`${file} was not written`)
    console.log(`[icons] ${file} (${size}px, ${String(Math.round(written / 1024))} KB)`)
  }
}

await main()
