// Renders assets/sun.svg to the PNG and the multi-size ICO the exe embeds.
//
// Only Windows' own tools: headless Edge rasterises the SVG once at 512px, and System.Drawing
// (through Windows PowerShell) scales it to each icon size. An image library would be one more
// dependency for a step that runs only when the icon changes. The outputs are committed, so
// building Sun never needs this.
//
//   node apps/sun/scripts/make-icon.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '../native/assets')
const svg = fs.readFileSync(path.join(assets, 'sun.svg'), 'utf8')

const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p))
if (edge === undefined) throw new Error('Microsoft Edge was not found; it is used to rasterise the icon.')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sun-icon-'))
const page = path.join(work, 'icon.html')
const master = path.join(work, 'master.png')
fs.writeFileSync(
  page,
  `<!doctype html><html><body style="margin:0;background:transparent">${svg.replace('width="128" height="128"', 'width="512" height="512"')}</body></html>`,
)
execFileSync(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    '--window-size=512,512',
    `--screenshot=${master}`,
    `--user-data-dir=${path.join(work, 'profile')}`,
    `file:///${page.replace(/\\/g, '/')}`,
  ],
  { stdio: 'ignore' },
)
// msedge.exe can hand the work to a child and return before the file is written.
for (let waited = 0; !fs.existsSync(master) && waited < 30_000; waited += 250) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
}
if (!fs.existsSync(master)) throw new Error('Edge did not produce a screenshot.')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500) // let the write finish

const sizes = [16, 20, 24, 32, 40, 48, 64, 256]
const script = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${master}')
foreach ($size in @(${sizes.join(',')})) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($src, 0, 0, $size, $size)
  $bmp.Save('${work}\\' + $size + '.png', [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
$src.Dispose()
`
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit' })

const images = sizes.map((size) => ({ size, png: fs.readFileSync(path.join(work, `${size}.png`)) }))
fs.writeFileSync(path.join(assets, 'icon-256.png'), images.at(-1).png)

// ICO: a directory of entries, each pointing at a PNG. Windows has read PNG entries since Vista.
const header = Buffer.alloc(6 + 16 * images.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
let offset = header.length
images.forEach(({ size, png }, i) => {
  const at = 6 + 16 * i
  header.writeUInt8(size >= 256 ? 0 : size, at)
  header.writeUInt8(size >= 256 ? 0 : size, at + 1)
  header.writeUInt16LE(1, at + 4)
  header.writeUInt16LE(32, at + 6)
  header.writeUInt32LE(png.length, at + 8)
  header.writeUInt32LE(offset, at + 12)
  offset += png.length
})
fs.writeFileSync(path.join(assets, 'sun.ico'), Buffer.concat([header, ...images.map((i) => i.png)]))
fs.rmSync(work, { recursive: true, force: true })
console.log(`wrote sun.ico (${sizes.join(', ')}px) and icon-256.png`)
