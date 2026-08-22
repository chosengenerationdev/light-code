#!/usr/bin/env node
/**
 * Writes `contributes.walkthroughs` in `apps/vscode/package.json`.
 *
 * The content is **not here** — it is `packages/core/src/guide/steps.ts`, because the browser
 * host renders the same tour and two copies of onboarding prose is two copies that go stale.
 * This script is the VS Code *rendering* of it: markdown descriptions, media paths in two
 * palettes, completion events, and the command URI that opens a settings tab.
 *
 * Reads core's built output, so build core first:
 *
 *   pnpm --filter @light-code/core build
 *   node scripts/generate-walkthrough-art.mjs && node scripts/generate-walkthrough.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUIDE_DESCRIPTION, GUIDE_STEPS, GUIDE_TITLE } from '../packages/core/dist/browser.js'

const MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'vscode', 'package.json')

const media = (step) => ({
  image: {
    light: `walkthrough/media/${step.id}-light.svg`,
    dark: `walkthrough/media/${step.id}-dark.svg`,
    // High contrast reuses the palette it is closest to. Two more files per step would be two
    // more things to keep in step for a variant almost nobody selects.
    hc: `walkthrough/media/${step.id}-dark.svg`,
    hcLight: `walkthrough/media/${step.id}-light.svg`,
  },
  altText: step.altText,
})

/**
 * The button that makes this a tour rather than a document.
 *
 * VS Code passes arguments to a command from a markdown link as a URI-encoded JSON array —
 * `?["mcp"]`. The step records only the tab name; this is where it becomes a command URI, and
 * the browser renderer turns the same field into an ordinary click handler.
 */
function action(step) {
  if (step.tab !== undefined) {
    const label = `Open the ${step.tab[0].toUpperCase()}${step.tab.slice(1)} tab`
    return `[${label}](command:lightCode.openSettings?%5B%22${step.tab}%22%5D)`
  }
  if (step.opensPanel === true) return '[Open the panel](command:lightCode.openPanel)'
  return undefined
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const walkthrough = manifest.contributes.walkthroughs[0]
walkthrough.title = GUIDE_TITLE
walkthrough.description = GUIDE_DESCRIPTION
walkthrough.steps = GUIDE_STEPS.map((step) => {
  const link = action(step)
  return {
    id: step.id,
    title: step.title,
    description: [...step.body, ...(link === undefined ? [] : [link])].join('\n\n'),
    media: media(step),
    completionEvents: step.completionEvents,
  }
})

writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(`walkthrough: ${String(walkthrough.steps.length)} steps written to apps/vscode/package.json\n`)
