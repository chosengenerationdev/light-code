// Deletes every .vsix in apps/vscode before a new one is packaged.
//
// Packaging only ever adds a file, so each build left the previous ones behind — eight of them by
// the time anybody asked why. The newest build is the only one worth keeping: any earlier version
// can be rebuilt from its commit, and the smoke test refuses to guess between several.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'vscode')
for (const entry of fs.readdirSync(folder)) {
  if (!entry.toLowerCase().endsWith('.vsix')) continue
  fs.rmSync(path.join(folder, entry))
  console.log(`removed old package ${entry}`)
}
