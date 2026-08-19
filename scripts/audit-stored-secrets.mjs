#!/usr/bin/env node
/**
 * Searches Light Code's own storage for anything secret-shaped.
 *
 * This is `MANUAL_VERIFICATION.md` A6, which is the one check in Session A that needs no
 * human judgement — it is a grep over real files, and a person doing it by hand will do it
 * once and never again. Everything else in Session A is about what the *UI* shows, which
 * cannot be checked from here.
 *
 * ## Why this looks at real storage rather than a fixture
 *
 * Redaction is applied at the boundary where content reaches disk (`DiskTruncationStore.save`),
 * with the known secret values supplied by the bridge. A unit test can only prove the redactor
 * redacts what it is told about; only the actual files can show whether the *right things were
 * passed to it* during a real session. Phase 6b found exactly that gap — the transcript was
 * redacted and the spilled tool results were not.
 *
 * ## What a finding means
 *
 * A hit is not automatically a leak. `sk-` appears in provider documentation and a user may
 * legitimately have pasted a public example. The script prints the file, the line and enough
 * context to judge, and exits non-zero so it cannot pass unnoticed in CI or a release check.
 *
 * Usage:
 *   node scripts/audit-stored-secrets.mjs                 # the default VS Code location
 *   node scripts/audit-stored-secrets.mjs <storage-dir>   # an explicit globalStorage path
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const EXTENSION_ID = 'chosengeneration.light-code-vscode'

/**
 * Patterns that should never survive into stored output.
 *
 * Deliberately shaped rather than exhaustive: a list of *your* secrets would have to read them
 * to search for them, which is the one thing a tool like this must not do. These are the
 * shapes §15's redaction helper already keys on, so a hit means redaction did not reach this
 * file rather than that a new kind of secret exists.
 */
const PATTERNS = [
  { name: 'Bearer token', re: /Bearer\s+[A-Za-z0-9._~+/-]{16,}/g },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'Anthropic-style key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'Google-style key', re: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'basic-auth URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
]

/** Where a real install keeps the things this audits. */
function defaultStorageDir() {
  const appData = process.env.APPDATA
  if (appData !== undefined) return path.join(appData, 'Code', 'User', 'globalStorage', EXTENSION_ID)
  const home = process.env.HOME ?? ''
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', EXTENSION_ID)
  }
  return path.join(home, '.config', 'Code', 'User', 'globalStorage', EXTENSION_ID)
}

async function* walk(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

/** One line of context, trimmed, with the match itself masked so this output is safe to paste. */
function describe(content, index, match) {
  const start = content.lastIndexOf('\n', index) + 1
  const end = content.indexOf('\n', index)
  const line = content.slice(start, end === -1 ? undefined : end)
  const lineNumber = content.slice(0, index).split('\n').length
  const masked = line.replace(match, `${match.slice(0, 6)}…${match.slice(-2)}`)
  return { lineNumber, text: masked.trim().slice(0, 200) }
}

const storageDir = process.argv[2] ?? defaultStorageDir()

console.log(`Auditing ${storageDir}`)

const findings = []
let scanned = 0

for await (const file of walk(storageDir)) {
  const relative = path.relative(storageDir, file)
  // Config holds *references* by design (`apiKeyRef`), never values, and the audit should say
  // so rather than skipping it silently — a value appearing there is exactly a finding.
  if (relative.startsWith('checkpoints')) continue
  let content
  try {
    content = await fs.readFile(file, 'utf8')
  } catch {
    continue
  }
  scanned++
  for (const { name, re } of PATTERNS) {
    for (const match of content.matchAll(re)) {
      const { lineNumber, text } = describe(content, match.index ?? 0, match[0])
      findings.push({ file: relative, name, lineNumber, text })
    }
  }
}

if (scanned === 0) {
  console.log('Nothing to audit — no stored transcripts or tool results at that path.')
  console.log('Run a session with the extension installed first, or pass the storage directory.')
  process.exit(0)
}

if (findings.length === 0) {
  console.log(`No secret-shaped content in ${String(scanned)} stored files.`)
  process.exit(0)
}

console.error(`\nFound ${String(findings.length)} secret-shaped string(s) in stored output:\n`)
for (const finding of findings) {
  console.error(`  ${finding.file}:${String(finding.lineNumber)} — ${finding.name}`)
  console.error(`    ${finding.text}`)
}
console.error(
  '\nRedaction happens where content reaches disk. A hit means it did not reach this file —\n' +
    'or that the value was never registered as a known secret. Both are worth chasing.',
)
process.exit(1)
