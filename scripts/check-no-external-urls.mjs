#!/usr/bin/env node
/**
 * Invariant 4: **no telemetry, no update checks, no remote assets.**
 *
 * CLAUDE.md has said "CI fails if built output contains an absolute external URL" since
 * Phase 0, and until now that check did not exist. This is it.
 *
 * The hard part is that the built output legitimately contains URLs. Provider presets carry
 * `https://api.openai.com/v1`, form fields show example placeholders, and error messages
 * name documentation. None of those cause a connection — a preset prefills a field the user
 * must save, and a placeholder is grey text.
 *
 * So the check is not "no URL strings". It is:
 *
 *   1. Every host appearing in built output must be on the allowlist below, and each entry
 *      states *why* it is harmless. A new host is a deliberate decision, not a diff nobody
 *      noticed.
 *   2. The webview bundle must contain **no network primitives at all** — the UI has no
 *      business opening a connection, and its CSP is `default-src 'none'` precisely so it
 *      cannot. A `fetch(` appearing there is the real signal, and it does not depend on
 *      recognising a URL.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(repoRoot, 'apps', 'vscode', 'dist')

/**
 * Hosts permitted to appear as a literal in built output, each with the reason. Presets and
 * placeholders only: nothing here is contacted unless the user configures and saves it.
 */
const ALLOWED_HOSTS = new Map([
  // --- Provider presets. These are the only entries that name a real inference endpoint,
  // and a preset only prefills a form field: nothing is contacted until the user saves a
  // profile. Adding one here is adding a preset, which is a deliberate product decision.
  ['api.openai.com', 'provider preset'],
  ['api.deepseek.com', 'provider preset'],
  ['api.anthropic.com', 'provider preset'],
  ['generativelanguage.googleapis.com', 'provider preset (Gemini)'],

  // --- Inside a dependency, never contacted.
  //
  // undici's Cache API builds a `new Request("https://a")` as a throwaway object and immediately
  // replaces its internal state; nothing is ever fetched from it. It appeared when the Node floor
  // dropped to 17 and undici went from 8 to 5 — worth recording precisely because a *new* host
  // showing up should be a decision rather than an unnoticed diff, which is what this list is for.
  ['a', 'undici 5 Cache API placeholder Request — never fetched'],

  // The MCP SDK's SSE transport carries the DOM `EventSource` typings, whose JSDoc links to MDN.
  // Arrived with SSE support; the extension bundle is not minified, so the comments survive into
  // the output. Verified before adding: all seven occurrences are on comment lines and none is in
  // code — the only URL that transport ever opens is the one in the user's own MCP config.
  ['developer.mozilla.org', 'MDN links in EventSource JSDoc — comments, never fetched'],

  /*
   * A MAPI property identifier, not an address.
   *
   * `http://schemas.microsoft.com/mapi/proptag/0x3712001F` is the documented *name* of
   * PR_ATTACH_CONTENT_ID_W, which is what `outlook_create_draft` sets to make an attachment an
   * embedded image rather than a paperclip. It is passed to `PropertyAccessor.SetProperty` as a
   * string and is never dereferenced - by us, by Outlook, or by anything else. Microsoft chose a
   * URL shape for these names; nothing on the other end has ever been contacted.
   *
   * Verified before adding: it appears in the inlined PowerShell worker and nowhere else, and
   * the worker is `powershell.exe` driving COM, which has no HTTP in it at all.
   */
  ['schemas.microsoft.com', 'MAPI property name (PR_ATTACH_CONTENT_ID_W) — a string, never fetched'],

  /*
   * S3's own endpoint, and it is a preset in exactly the sense the block at the top describes.
   *
   * `s3.` is the template `https://s3.${region}.amazonaws.com` seen by a scanner that cannot
   * substitute the region; the fully-formed one is placeholder text in the endpoint field.
   *
   * Invariant 3 holds: a fresh install has no S3 connection, so nothing is contacted. The host is
   * only formed once somebody has configured a bucket and a region — both of which they typed —
   * and an internal or S3-compatible address replaces it entirely via the endpoint field.
   */
  ['s3.', 'template for the default AWS S3 endpoint; the region is substituted at run time'],
  ['s3.eu-west-1.amazonaws.com', 'placeholder in the S3 endpoint field'],

  // --- Placeholders shown as grey text in form fields.
  ['gateway.example.com', 'placeholder in the Apigee token URL field'],
  ['gw.example.com', 'placeholder'],
  ['example.com', 'generic documentation example'],
  ['opensearch.internal', 'placeholder in the OpenSearch cluster URL field'],
  ['mcp.internal', 'placeholder in the MCP server URL field'],
  ['artifactory.corp', 'placeholder in the Python package index field'],

  // --- Identifiers that look like URLs but are names. Never dereferenced.
  ['json-schema.org', '$schema identifier'],
  ['spec.openapis.org', 'OpenAPI dialect identifier (from zod / ajv)'],
  ['www.w3.org', 'SVG and XML namespace identifiers'],
  ['modelcontextprotocol.io', 'MCP schema identifier'],

  // --- Documentation links inside bundled dependencies: specs undici cites, React's error
  // page, and comments in transitive code. Present as text in the bundle; nothing fetches
  // them. Grouped rather than individually justified because they arrive as a set with the
  // dependency, and the check's job is to flag a *new* host for a human to classify.
  ['datatracker.ietf.org', 'spec reference (undici)'],
  ['tools.ietf.org', 'spec reference (undici)'],
  ['www.ietf.org', 'spec reference (undici)'],
  ['www.rfc-editor.org', 'spec reference (undici)'],
  ['fetch.spec.whatwg.org', 'spec reference (undici)'],
  ['html.spec.whatwg.org', 'spec reference (undici)'],
  ['mimesniff.spec.whatwg.org', 'spec reference (undici)'],
  ['webidl.spec.whatwg.org', 'spec reference (undici)'],
  ['websockets.spec.whatwg.org', 'spec reference (undici)'],
  ['whatpr.org', 'spec pull-request reference (undici)'],
  ['w3c.github.io', 'spec reference (undici)'],
  ['mathiasbynens.be', 'comment link in a bundled dependency'],
  ['jimmy.warting.se', 'comment link in a bundled dependency (fetch-blob)'],
  ['stackoverflow.com', 'comment link in a bundled dependency'],
  ['www.safaribooksonline.com', 'comment link in a bundled dependency'],
  ['gist.github.com', 'comment link in a bundled dependency'],
  ['raw.githubusercontent.com', 'comment link in a bundled dependency'],
  ['react.dev', "React's error documentation link, shown in a thrown message"],

  // --- Ours.
  ['github.com', 'repository link shown to the user'],
  ['localhost', 'loopback'],
  ['127.0.0.1', 'loopback'],
])

/** Network primitives that must never appear in the webview bundle. */
const WEBVIEW_FORBIDDEN = [
  { pattern: /\bfetch\s*\(/, name: 'fetch(' },
  { pattern: /new\s+XMLHttpRequest\b/, name: 'XMLHttpRequest' },
  { pattern: /new\s+WebSocket\b/, name: 'WebSocket' },
  { pattern: /new\s+EventSource\b/, name: 'EventSource' },
  { pattern: /navigator\.sendBeacon\b/, name: 'sendBeacon' },
  { pattern: /\bimportScripts\s*\(/, name: 'importScripts' },
]

const problems = []

function hostsIn(text) {
  const hosts = new Set()
  for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9._:-]+)/g)) {
    // Strip a port so `127.0.0.1:8080` matches the loopback entry.
    hosts.add((match[1] ?? '').split(':')[0].toLowerCase())
  }
  return hosts
}

if (!fs.existsSync(distDir)) {
  console.error(`No built output at ${distDir}. Run \`pnpm build\` first.`)
  process.exit(1)
}

for (const name of fs.readdirSync(distDir)) {
  if (!name.endsWith('.js')) continue
  const filePath = path.join(distDir, name)
  const contents = fs.readFileSync(filePath, 'utf8')

  for (const host of hostsIn(contents)) {
    if (!ALLOWED_HOSTS.has(host)) {
      problems.push(
        `${name}: unexpected host "${host}".\n` +
          '    If it is a preset or placeholder, add it to ALLOWED_HOSTS with a reason.\n' +
          '    If something actually connects to it, that breaks invariant 4.',
      )
    }
  }

  if (name === 'webview.js') {
    for (const { pattern, name: primitive } of WEBVIEW_FORBIDDEN) {
      if (pattern.test(contents)) {
        problems.push(
          `webview.js contains ${primitive}. The webview must not open connections — its CSP\n` +
            '    is `default-src \'none\'`, so this would fail at runtime anyway, but it means\n' +
            '    something is reaching for the network from the wrong layer.',
        )
      }
    }
  }
}

if (problems.length > 0) {
  console.error('Invariant 4 check failed:\n')
  for (const problem of problems) console.error(`  - ${problem}\n`)
  process.exit(1)
}

console.log('Invariant 4: built output contains no unexpected hosts, and the webview has no network primitives.')
