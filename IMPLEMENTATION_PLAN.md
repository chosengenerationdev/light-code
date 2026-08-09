# Light Code — Implementation Plan

Companion to `CLAUDE.md`. That file holds the durable decisions; this one holds the order
of work.

## How to use this

**Hand over one phase per session.** Paste the phase heading and body into Claude Code and
say "implement this phase." Do not hand over the whole plan — it produces shallow work
across all of it rather than finished work on one part.

Each phase has:

- **Goal** — what exists at the end that didn't before
- **Build** — files and modules, as a starting structure, not a straitjacket
- **Done when** — checkable acceptance criteria
- **Verify** — how to prove it, by hand or in CI
- **Not in this phase** — scope fences, to stop drift

At the end of every phase: update §19 of `CLAUDE.md`, commit, and note anything that
surprised you. If a phase's design turns out wrong, change `CLAUDE.md` in the same commit
rather than leaving the two out of sync.

Phases 0–8 are the product. Phase 9 is the differentiator. Phase 10 does not start until
the extension has shipped.

---

## Phase 0 — Scaffold and invariants

**Goal:** an empty monorepo that builds, tests, lints, and already enforces the two
mechanical invariants. Nothing works yet, and that is fine.

**Build**

```
package.json                 pnpm workspaces, packageManager pinned
pnpm-workspace.yaml
.nvmrc                       22.x
.gitattributes               * text=auto eol=lf
tsconfig.base.json           strict
eslint.config.js             flat config, incl. the two restricted-import rules
.prettierrc
vitest.config.ts
.github/workflows/ci.yml
packages/core/               src/index.ts, package.json, tsconfig
packages/ui/                 src/index.tsx, package.json, tsconfig
apps/vscode/                 src/extension.ts, package.json (manifest), tsconfig
LICENSE                      MIT
README.md                    stub
SECURITY.md                  disclosure contact
.gitignore                   incl. .registry.json
```

The extension manifest should register a single command that opens an empty webview, so
F5 does something visible.

**Done when**

- `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck` all pass on an empty repo
- ESLint fails on an added `import * as vscode from 'vscode'` in `packages/core`
- ESLint fails on an added `fetch(...)` in `packages/core` outside the HttpClient path
- CI runs on `ubuntu-latest` and `windows-latest`, using `pnpm install --ignore-scripts`
- F5 launches an Extension Development Host and the command opens an empty panel

**Verify**

Add the two violating imports on a scratch branch, confirm CI red, remove them.

**Not in this phase**

Any feature code. The webview stays empty.

---

## Phase 1 — Core interfaces, config, secrets, logging

**Goal:** the platform seam and the config system. Everything later reads from these, which
is why they come before anything visible.

**Build**

```
packages/core/src/platform/
  filesystem.ts     interface + types (plain string paths)
  terminal.ts       interface: run, stream, killTree
  secrets.ts        interface: async get/set/delete, backendName()
  config.ts         interface: load, save, watch, scope resolution
  transport.ts      interface: post, onMessage
  http.ts           HttpClient — the sole egress point

packages/core/src/config/
  schema.ts         zod schema for the whole config file
  scopes.ts         user vs workspace merge; enforces user-scope-only keys
  paths.ts          env-paths based; Windows-aware

packages/core/src/logging/
  redact.ts         single redaction helper
  logger.ts         all logging goes through redact

packages/core/src/fs/
  confine.ts        realpath + case-insensitive containment (CLAUDE.md §16)
  denylist.ts       cert/key path deny list

apps/vscode/src/platform/    VS Code implementations of all six interfaces
```

**Done when**

- Config loads, validates, saves, and hot-reloads on external file change
- User-scope-only keys present in workspace config are ignored **and reported**, not
  silently dropped
- `SecretStore` round-trips through VS Code `SecretStorage` and reports its backend
- `redact()` strips known secret values, `Bearer` tokens, and `sk-`-style keys
- Path confinement rejects `../` traversal, absolute paths outside the root, and symlinks
  pointing outside — on both Windows and Linux

**Verify**

Unit tests for confinement (including a symlink case), scope enforcement, and redaction.
These are permanent regression tests; their job is to fail in six months when someone
"simplifies" the middleware.

**Not in this phase**

Any UI. Any provider. `HttpClient` exists as an interface with a basic implementation but
has no callers yet.

---

## Phase 2 — OpenAI adapter and streaming chat

**Goal:** type a message, see tokens stream back. The first end-to-end path.

**Build**

```
packages/core/src/providers/
  types.ts          Provider, WireFormat, Auth interfaces
  openai.ts         OpenAI-compatible adapter
  auth/apiKey.ts    simplest auth strategy
  registry.ts       profile resolution

packages/core/src/agent/
  loop.ts           minimal: send, stream, render. No tools yet
  messages.ts       conversation state

packages/ui/src/
  App.tsx, Chat.tsx, MessageList.tsx, Composer.tsx
  transport.ts      Transport client side

apps/vscode/src/webview/     panel creation, CSP, message bridge
```

Config for this phase can be hand-written into the config file — the settings UI arrives
in 2b.

**Done when**

- A profile with base URL + API key + model streams a response into the webview
- Cancellation mid-stream works and leaves clean state
- Errors (bad key, wrong URL, network failure) surface as readable messages naming what
  failed
- Webview CSP is strict; no external asset loads

**Verify**

Point at a real endpoint. Then point at a deliberately wrong URL and confirm the error is
comprehensible.

**Not in this phase**

Tools, approval, settings UI, other providers, images.

---

## Phase 2b — Settings panel and Providers tab

**Goal:** configure a provider entirely in the UI. Do this early — it makes every later
phase easier to develop and test.

**Build**

```
packages/ui/src/settings/
  SettingsPanel.tsx        tabbed shell
  ProvidersTab.tsx         profile list; add/duplicate/delete
  ProviderForm.tsx         Simple fields; Advanced section collapsed (empty for now)
  ScopeBadge.tsx           shows user vs workspace, and "ignored" state
  SecretField.tsx          write-only: "Set — replace?"

packages/core/src/config/validate.ts    shared schema validation surfaced field-level
```

**Done when**

- A provider profile can be created, edited, and deleted entirely in the UI
- Preset selection prefills base URL and wire format; both remain editable
- Secrets are write-only — no code path returns a stored secret toward the UI
- Invalid input shows field-level errors from the same schema the file loader uses
- Fresh install shows a "configure a provider" state rather than an empty chat
- Config export omits secrets and preserves cert paths

**Verify**

Grep the message-bridge types for any message carrying a secret value host→UI. There must
be none. Delete a profile, confirm its secrets are gone from `SecretStorage`.

**Not in this phase**

Advanced auth fields, model dropdown fetching, MCP/Approvals/Modes tabs.

---

## Phase 3 — Core tools, approval, checkpoints

**Goal:** the agent can actually do things. This is the largest phase; consider splitting
it across two sessions at the natural seam between tools and approval.

**Build**

```
packages/core/src/tools/
  types.ts             Tool, ToolGroup, ToolResult
  registry.ts          registration, namespacing
  readFile.ts
  listFiles.ts         ripgrep-backed
  searchFiles.ts       ripgrep-backed
  writeToFile.ts
  applyDiff/
    parse.ts           marker format; reject markers after =======
    match.ts           the four-tier cascade — no fuzzy scoring
    apply.ts           validate all blocks before any write
    eol.ts             detect, normalise, restore
  executeCommand.ts
  askFollowupQuestion.ts
  attemptCompletion.ts

packages/core/src/agent/
  loop.ts              extended: tool calls, iteration cap, result feedback
  truncate.ts          result cap + disk store + re-read handle

packages/core/src/checkpoints/shadowGit.ts

packages/ui/src/approval/
  ApprovalPrompt.tsx   ground truth only
  DiffView.tsx
```

**Done when**

- All nine tools work; the loop runs multi-step and terminates on `attempt_completion`
- `apply_diff` handles: exact match; whitespace-only mismatch; a 6-line block with one
  altered interior line (anchor tier); a CRLF file; a non-unique SEARCH (rejected); a
  malformed block (rejected with useful text)
- No block applies if any block in the call fails validation
- Editing a file not read this session is refused
- Consecutive-mistake tracking stops a loop after N failures on one file
- Approval shows the literal command and the computed diff — never model prose
- Checkpoint created before first edit; rollback restores state
- Tool results are truncated with a working re-read handle
- On Windows, `execute_command` kills the full process tree

**Verify**

A fixture directory with CRLF and LF files, repeated code blocks, and a symlink escaping
the root. Test the matching cascade against all of them. Manually confirm a long `pytest`
or `npm test` output is truncated and re-readable.

**Not in this phase**

Auto-approve toggles (Phase 4), MCP tools, images.

---

## Phase 4 — Modes, tool groups, Approvals tab

**Goal:** control over what the agent may do.

**Build**

```
packages/core/src/modes/
  types.ts         Mode = { name, groups[] }
  builtin.ts       Code (all), Ask (read + mcp + always)
  resolve.ts       filters the registry by active mode

packages/core/src/approval/
  policy.ts        per-category auto-approve; workspace-scoped "always allow"
  commands.ts      exact-match command allowlist (no pattern matching, ever)

packages/ui/src/settings/ApprovalsTab.tsx
packages/ui/src/settings/ModesTab.tsx
packages/ui/src/ModeSelector.tsx      in the chat header
```

The approval *gate* already exists from Phase 3 (`ApprovalGate`, `runOneToolCall`); this
phase adds the policy that can answer without asking the user.

### Command allowlist is exact-match, on every platform

Revised during Phase 3 — the plan previously disabled command auto-approve on Windows
entirely. The real hazard was never Windows as such: it was that deciding whether a
command is *covered by a pattern* requires tokenising PowerShell (`;`, `&&`, `|`,
`$(...)`, nested quoting), and a parsing bug silently auto-approves a chained
destructive command.

Byte-for-byte comparison needs no parser, so the hazard and the platform carve-out both
disappear — `windows.ts` is no longer needed at all. **Never widen this to prefix or
glob matching**; that reintroduces precisely the problem it avoids.

**Done when**

- Switching to Ask mode removes edit and command tools from the system prompt entirely
- Auto-approve toggles all default off and persist per category
- "Always allow" scopes to tool + workspace, is visible in the UI, and is revocable
- Allowing `npm test` auto-approves exactly `npm test`; `npm test && echo hi`,
  `npm  test` (double space), and ` npm test` each still prompt — asserted by tests,
  since this is the whole safety property
- The allowlist is per workspace, listed in the UI, and individually revocable

**Verify**

Inspect the outgoing request in Ask mode and confirm no edit tools appear in the
definitions. Confirm a fresh profile auto-approves nothing.

**Not in this phase**

Custom user-defined modes.

---

## Phase 5 — MCP client

**Goal:** external tools alongside built-ins.

**Build**

```
packages/core/src/mcp/
  client.ts          @modelcontextprotocol/sdk wrapper
  stdio.ts
  http.ts            Streamable HTTP
  registry.ts        namespacing, per-tool enable state
  lifecycle.ts       lazy connect, health, restart, tools/list_changed
  schema.ts          JSON Schema → per-provider tool format

packages/ui/src/settings/McpTab.tsx      form + raw JSON editor with validation
```

**Check the current SDK and spec status before writing this** — the area moves quickly and
`CLAUDE.md`'s notes may be stale.

**Done when**

- Both a stdio and an HTTP server connect and their tools appear namespaced
- Two servers exposing the same tool name coexist without collision
- Per-server and per-tool toggles remove tools from the system prompt
- A server crash surfaces in the UI and restarts cleanly; the other server is unaffected
- A pasted config from another MCP client works unmodified
- `npx`-style commands produce a clear warning about fetching from the network
- Secrets in server env are interpolated from `SecretStorage`, not stored in config

**Verify**

Multi-server behaviour is where the bugs are. Test with two servers connected and kill one
mid-session.

**Not in this phase**

Resources, prompts, sampling.

---

## Phase 6 — Apigee auth, model dropdown, Test Connection

**Goal:** the corporate gateway path works end to end.

**Build**

```
packages/core/src/providers/auth/
  apigeeMtls.ts      token fetch, proactive refresh, single-flight, 401 retry
  certs.ts           load PEM or PFX; validate; report notAfter; watch for change
  factory.ts         config -> strategy; resolves secret refs at request time

packages/core/src/platform/tls.ts          CA merge; NODE_EXTRA_CA_CERTS
                                           (next to http.ts, its only consumer —
                                            platform importing providers would
                                            invert the layering)

packages/core/src/providers/models.ts          list models; local metadata table
packages/core/src/providers/testConnection.ts  three-step diagnosis

packages/ui/src/settings/
  AdvancedAuthSection.tsx
  ModelSelect.tsx           dropdown + free text + refresh
  TestConnectionPanel.tsx   reports which of three steps failed
```

**Done when**

- Token acquired via mTLS and attached to inference requests
- Proactive refresh fires before expiry; ten concurrent requests trigger exactly one refresh
- A 401 triggers one force-refresh retry, then a clear error — never a loop
- Both PEM and PFX load; passphrase comes from `SecretStorage`
- `certDir` inside the workspace is **rejected at config time** with an explanation
- Cert/key paths are unreadable by `read_file` and invisible to `search_files`
- Cert file change rebuilds the agent and drops the cached token without a restart
- Expiry warnings appear at 30 and 7 days
- Test Connection distinguishes load-certs / get-token / list-models failures
- Model dropdown populates where the endpoint supports it, with free-text always available
- Selecting `apigeeMtls` removes the API key field entirely

**Verify**

Mock Apigee endpoint tests for the refresh, concurrency, and retry cases. Then a real run
against the gateway. Confirm a missing CA produces a comprehensible message, not
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

> **Done, with one substitution.** No Apigee gateway is available to test against, so in
> addition to the mock tests the whole path was driven against a **local HTTPS server that
> genuinely requires a client certificate** (`requestCert` + `rejectUnauthorized`, certs
> minted with OpenSSL). That exercises the real undici TLS stack, a real handshake, a real
> `client_credentials` grant, and real CA-trust failures — everything except this specific
> gateway's quirks. It found two bugs the mocks could not; see CLAUDE.md §19.

---

## Phase 6b — Task history and session persistence

**Goal:** conversations survive closing the panel, reloading the window, and restarting
VS Code. The user can browse past tasks, reopen one, and delete it.

Added to the plan after Phase 3, when it became clear this was an omission rather than a
deliberate exclusion — the conversation currently lives only in memory in `bridge.ts` and
is lost the moment the webview goes away. **Sequenced before Phase 7 deliberately:**
compaction rewrites how history is assembled, so building persistence afterwards means
touching the same code twice.

**Build**

```
packages/core/src/history/
  types.ts          Task = { id, workspaceRoot, title, createdAt, updatedAt, messages[] }
  store.ts          TaskStore interface: list, load, save, delete
  titles.ts         derive a task title from the first user message

apps/vscode/src/platform/taskStore.ts    JSON files under globalStorageUri

packages/ui/src/history/
  HistoryList.tsx   past tasks, newest first; open / delete
```

Follows the §15 pattern: core owns the format and the interface, the host supplies the
path. Storage is per workspace so another project's tasks don't appear in this one's list.

**Design decisions to settle here, not improvise**

- **Persist the full transcript; compact only what is *sent*.** Phase 7's compaction must
  not destroy stored history — the user should still be able to read what actually
  happened, even after the model's view of it has been summarised.
- **Large tool results are already spilled to disk** by `agent/truncate.ts`. History
  references those handles rather than duplicating the content, and deleting a task
  deletes its stored results too.
- **Everything written goes through `redact()`** (§15). Tool output can echo secrets —
  a command that prints an env var, a config file read back. Persisting a transcript
  turns a transient leak into one on disk.
- **`readFiles` is NOT restored on resume.** The read-before-edit constraint (§6) is
  deliberately session-scoped; a resumed task must re-read a file before editing it.
  Restoring that set would quietly weaken the invariant across a restart.

**Done when**

- A conversation survives closing the sidebar, reloading the window, and restarting VS Code
- Past tasks are listed newest-first with a readable title, and reopening one restores the
  full transcript including tool calls and their results
- Deleting a task removes its transcript *and* its spilled tool results
- Tasks are scoped per workspace
- Resuming a task and immediately asking for an edit is refused until the file is re-read
- Nothing secret-shaped is present in the stored files

**Verify**

Run a task that reads files and runs commands, restart VS Code entirely, reopen it, and
confirm the transcript is intact. Then grep the stored files for the API key and for
`Bearer` — there must be no hits.

> **Done, except the VS Code restart itself.** The save → reload → render → delete cycle
> was driven against real files on disk (19/19 checks), including the secret grep. That
> grep found a real hole: spilled tool results were not redacted, only transcripts. Fixed
> at the write boundary — see CLAUDE.md §19. The restart path, the history UI, and
> read-before-edit-after-resume still need a real Extension Host.

**Not in this phase**

Search across tasks, export/share a transcript, cross-workspace history, cloud sync.

---

## Phase 7 — Anthropic and Gemini, images, context management

**Goal:** provider breadth and long-session survival.

**Build**

```
packages/core/src/providers/
  anthropic.ts       Messages API
  gemini.ts          generateContent

packages/core/src/context/
  compact.ts         history summarisation
  supersede.ts       drop stale reads
  budget.ts          per-request token accounting

packages/ui/src/
  Attachments.tsx    image paste/drop
  TokenBar.tsx       system / tools / history / results + cache hit rate
```

**Done when**

- All three adapters work behind the same interface; DeepSeek works as an OpenAI preset
- Tool schemas translate correctly per provider (this is where silent failures live)
- Images attach and reach vision-capable models; the UI hides attachment when the selected
  model lacks vision per the metadata table
- Compaction triggers past threshold, never mid-tool-call, and preserves paths, commands,
  and decisions
- Superseded file reads are dropped from history
- Token bar shows a live breakdown and cache hit rate
- Tool definitions remain byte-stable within a session (verify cache hits stay high)

**Verify**

Run a 40-turn session and watch the token bar. If cache hit rate collapses, something is
mutating the prefix — find it.

> **Done, and the prefix check was made automatic.** Watching the token bar is a slow,
> indirect signal, so `agent/prefixStability.test.ts` asserts the property directly across
> all three adapters — three turns must produce a byte-identical tool block, and Anthropic's
> `system` / Gemini's `systemInstruction` must not drift. The live 40-turn run is still
> worth doing once, but a regression now fails in CI instead of showing up as a bill.
>
> **Still unverified:** live Anthropic and Gemini endpoints. Both adapters are covered by
> mock-stream tests built from the documented event shapes; neither has been run against the
> real service.

**Added mid-phase at the user's request:** `@`-mentions for files and folders
(`context/mentions.ts` plus composer autocomplete), and file/image attachment in the input
field. Mentions are resolved host-side and appended to the user's message — not a tool,
because the user chose the path, but still subject to `confine()` and the deny list since
the path is user-typed text. Roo's other mention kinds (problems, terminal output, git
diff, URLs) are **not** built; revisit if they are actually wanted.

---

## Phase 8 — Release

**Goal:** other people can install it.

**Build**

README with an honest capabilities-and-limits section, CONTRIBUTING, icon, Changesets
release workflow, publish to Marketplace and Open VSX, `.vsix` artifact attached to
GitHub releases for air-gapped installs.

**Done when**

- Clean install on a fresh machine configures and runs using only the UI
- The network-isolated CI job passes: full session (chat, tools, MCP) with no route out
- README states plainly: no sandboxing, no protection against same-user processes, what
  the security boundary does and does not cover
- Dependabot green; no secrets in any published artifact

**Verify**

Install the `.vsix` on a second machine and configure from scratch, without touching a
config file by hand.

---

## Phase 8b — Vector stores and semantic retrieval

**Goal:** the model can search an indexed codebase, and search skill and tool documentation,
against a user-configured vector database.

**Added 2026-08-09 at the user's request, reversing three recorded decisions** — §6's
"no semantic/embedding codebase search", §12's "semantic retrieval over tool descriptions is
out", and §18's row on both. The reasons those decisions were made are still written down;
see CLAUDE.md §18 for what changed and why the user overrode them. Sequenced after release
because none of it is needed for v1 and Phase 7's context management is the more urgent
problem for long sessions.

### The prompt-cache constraint, and how this design respects it

§12's objection to retrieval over tool descriptions was never "retrieval is useless" — it
was that **tool definitions sit at the front of the prompt, so varying them per turn
invalidates the cache prefix and every message after it.** That is still true, so retrieval
here is exposed as **tools the model calls**, not as dynamic tool definitions:

- `search_codebase` and `search_docs` are ordinary tools in the `read` group. Their results
  arrive as tool results, mid-conversation, where they cost nothing at the prefix.
- The set of *available* tools stays byte-stable for a whole session. If retrieval is ever
  used to decide **which** tools load, that resolves at a mode or session boundary only —
  exactly the carve-out §12 already allows.

This is the reconciliation that makes the feature safe to build. **Do not "improve" it into
per-turn tool-definition selection** — that reintroduces precisely the cost §12 measured.

### Build

```
packages/core/src/rag/
  types.ts        VectorStore: ensureCollection, upsert, query, deleteByFilter
                  VectorDocument = { id, text, metadata, vector }
  embedder.ts     Embedder interface + an OpenAI-compatible /embeddings client
  chunk.ts        line-window chunking with overlap; symbol-aware is a later refinement
  indexer.ts      walk -> chunk -> embed -> upsert, driven by a content-hash manifest
  registry.ts     resolves which configured store backs which collection

packages/core/src/rag/stores/
  opensearch.ts   knn_vector mapping; REST; HTTP basic auth
  qdrant.ts       REST; api-key header
  chroma.ts       REST

packages/core/src/tools/
  searchCodebase.ts   read group
  searchDocs.ts       read group; skills + built-in and MCP tool documentation

packages/ui/src/settings/
  IndexingTab.tsx     store definitions, per-collection assignment, Test Connection,
                      index status and a manual reindex
```

**Invariant 2 rules out the official clients.** `@opensearch-project/opensearch`,
`@qdrant/js-client-rest`, and `chromadb` all carry their own HTTP stacks, and all outbound
traffic goes through core's `HttpClient`. All three databases are plain REST, so these are
thin hand-written clients — not a workaround, the required design.

### Config

Named stores, then a per-collection assignment, so one database can back several
collections without repeating credentials:

```jsonc
{
  "vectorStores": {
    "corp-search": { "kind": "opensearch", "url": "", "usernameRef": "...", "passwordRef": "..." },
    "local-qdrant": { "kind": "qdrant", "url": "", "apiKeyRef": "..." }
  },
  "embedder": { "baseUrl": "", "model": "", "apiKeyRef": "...", "dimensions": 1536 },
  "collections": {
    "codebase": { "store": "local-qdrant", "enabled": false },
    "skills":   { "store": "corp-search",  "enabled": false },
    "toolDocs": { "store": "corp-search",  "enabled": false }
  }
}
```

Defaults are **kinds, not endpoints** — Qdrant for `codebase`, OpenSearch for `skills` and
`toolDocs`, as requested. Every URL ships empty; invariant 3 is unchanged. Everything ships
`enabled: false`.

### Security — read this before starting

**Indexing sends the entire codebase to an embedding endpoint.** That is a larger egress
than anything Light Code does today, and it punches a hole in §3's boundary statement, which
promised the only hosts contacted are the model gateway and MCP servers. §3 is updated in
the same commit as this phase.

- **`vectorStores`, `embedder`, and `collections` are user-scope only (invariant 5).** A
  workspace that could set `embedder.baseUrl` would exfiltrate every file you indexed to an
  attacker's endpoint the moment you opened the repo. This is the same threat invariant 5
  already closes for `profiles`, and it is sharper here because the payload is source code.
  **`mcpServers` is deliberately *not* on that list; this is, and the difference is that an
  MCP server still passes through the approval gate while indexing does not.**
- **Indexing honours `.gitignore`, the tool deny list, and `certDir`.** Anything
  `read_file` may not read must never be embedded — otherwise the deny list is bypassed by
  a different route.
- Store credentials and the embedder key are `SecretStorage` refs, never literals (§15).
- The manifest and any cached vectors live in global storage, not the workspace — a cache,
  and not something to commit.
- **Opt-in, off by default**, with an explicit first-run confirmation naming the endpoint
  the code will be sent to.

### Done when

- A user can define stores, assign a collection to each, and Test Connection reports which
  step failed (reach store → authenticate → embed a probe → query) — same shape as §10's
- `search_codebase` returns ranked chunks with file paths and line ranges
- `search_docs` returns skill and tool documentation, including MCP tool descriptions
- Re-indexing after an edit updates only the changed files; deleting a file removes its
  vectors
- A file excluded by `.gitignore` or the deny list is never embedded
- An unreachable store degrades to a clear tool error and the session continues — never a
  blocked turn, the same "never a hard dependency" rule as the model dropdown (§9)
- Tool definitions remain byte-stable across a session with retrieval enabled

### Verify

Index this repository against a local Qdrant in Docker and a local OpenSearch, and confirm
`search_codebase` finds a symbol by description rather than by name. Point the embedder at a
local endpoint and confirm with a proxy that **no file content leaves for any other host**.
Put a secret in a gitignored file and confirm it is never embedded. Then capture the request
bodies for two consecutive turns and diff the tool-definition block — it must be identical.

### Not in this phase

Reranking, hybrid keyword+vector fusion, symbol-aware chunking, multi-workspace shared
indexes, or embedding the conversation history.

---

## Phase 9 — Python tools and skills

**Goal:** the model can learn and extend itself. This is the differentiator, and the
sharpest security surface — see `CLAUDE.md` §13 before starting.

Split across two sessions: worker and registry first, then create/update/delete and skills.

**Build**

```
packages/core/src/python/
  uv.ts             resolve uv; venv layout (Windows: Scripts/)
  worker.ts         persistent process, JSON-RPC, reload, timeout, killTree
  registry.ts       generated .registry.json, content-hash pinned
  schema.ts         pydantic-derived JSON Schema
  validate.ts       ast.parse → import → schema, before registration
  tools.ts          create / update / delete, all approval-gated

packages/core/src/skills/
  index.ts          frontmatter parse; name+description into system prompt only

packages/ui/src/settings/PythonTab.tsx
worker/main.py      the Python side
```

**Done when**

- A tool created in chat is validated, registered, and callable in the same session
- A syntax error returns the traceback to the model, and nothing is registered
- Create/update approval shows the full source diff
- Hash mismatch on load is refused and surfaced loudly
- Provider API keys are absent from the worker environment (assert it in a test)
- Worker timeout kills the full process tree on Windows
- Skills contribute only name + description to the prompt; bodies load via `read_file`
- Skill writes are approval-gated
- `dynamicTools: "off"` fully disables the feature; it is off by default

**Verify**

Write a test asserting the worker's environment contains no key-shaped values. Confirm a
tool file edited outside Light Code fails its hash check.

---

## Phase 9b — Scheduled prompts and background sessions

**Goal:** a prompt runs on a cron-like schedule without the user present, each run lands in
its own reviewable session, and the user is notified when something needs attention.

Requested during Phase 3. Placed after release deliberately: it depends on Phase 4 (modes),
Phase 6b (session persistence), and optionally Phase 5 (MCP), it isn't needed for v1 to
ship, and it is the second-sharpest security surface in the project after Python tools —
it deserves its own attention rather than being rushed in before Phase 8. Movable earlier
if daily use demands it, but not before Phase 6b.

**Build**

```
packages/core/src/schedule/
  types.ts          Schedule = { id, name, cron, prompt, mode, enabled, lastRun }
  cron.ts           parse + next-fire-time. Use a vetted parser; do not hand-roll
  runner.ts         fires a schedule into a fresh Task, headless
  autonomy.ts       the restricted permission set for unattended runs

packages/core/src/tools/notify.ts        toast notification tool
apps/vscode/src/platform/notifier.ts     vscode.window.show*Message

packages/ui/src/settings/SchedulesTab.tsx   list, add, edit, enable/disable, run-now
```

### Unattended approval — the core design problem

§8 says *"Per-invocation by default. All auto-approve toggles ship off."* A scheduled run
has nobody to approve anything, so it cannot inherit the interactive model. It gets a
**restricted autonomous mode** instead, built on the Phase 4 modes mechanism rather than a
second parallel one:

- Each schedule names a mode. The default is **read-only** — `read` + `always` groups
  only. No `edit`, no `command`, no `mcp`.
- Widening it (allowing edits, shell, or MCP/browser) is **per schedule, explicit, and
  warned about in the UI** — never a global "auto-approve everything" switch.
- Command auto-approve stays unavailable on Windows (§8) — that restriction does not
  get quietly lifted just because the run is unattended.
- Every autonomous run is written to the audit log (§15) with its mode and tool calls.

### The combination that must be called out

Browser/MCP access + unattended execution + edit or command tools is a direct
**prompt-injection → code-execution** path: a scheduled job fetches a page, the page
contains instructions, the model acts on them with nobody watching. The UI must say this
plainly when a schedule is granted anything beyond read-only, and the default must never
be the dangerous combination.

**Done when**

- A schedule fires on time, runs headless, and produces a normal reviewable session in the
  Phase 6b history, labelled as scheduled rather than interactive
- The default mode for a new schedule is read-only, and widening it shows an explicit warning
- A scheduled run cannot use a tool outside its mode, verified by a test, not by inspection
- The notify tool raises a VS Code toast; clicking it opens that run's session
- Schedules survive a VS Code restart and do not double-fire after one
- A run that overruns its next fire time does not start a second concurrent run
- Disabling a schedule stops it firing without deleting its history
- Failures notify rather than dying silently — an unattended error nobody sees is the
  worst outcome here
- Every autonomous run appears in the audit log with the mode it ran under

**Verify**

Set a one-minute schedule, close the panel, and confirm it still fires and records a
session. Then give a schedule a prompt that tries to use a tool outside its mode and
confirm the run refuses rather than escalating.

**Not in this phase**

Schedules that trigger on file/git events rather than time, chaining one schedule's output
into another, sharing schedules across machines.

---

## Phase 10 — Node host and browser UI (deferred)

Do not start until Phase 8 has shipped and had real use.

`CLAUDE.md` §14 has the full specification, including the localhost security requirements.
Build those **with** the server, not before it and not after.

The port should be a new `apps/host` entry point over unchanged `packages/core` and
`packages/ui`. **If it turns out to need changes in core, that is a bug in the Phase 1
interfaces** — fix the interface rather than forking the logic.

---

## Risk notes

Things most likely to go wrong, and where.

- **`apply_diff` matching** (Phase 3) — the highest-consequence code in the project. Take
  the extra session. Do not add fuzzy matching under pressure.
- **Windows process trees** (Phase 3) — orphaned processes are easy to miss in development
  and very visible to users.
- **MCP schema translation** (Phase 5) — fails silently. Test tool-calling against every
  provider, not just one.
- **Prompt cache stability** (Phase 7) — easy to break accidentally by sorting a map or
  including a timestamp in the prefix. The token bar is how you catch it.
- **Python worker environment** (Phase 9) — key leakage here is a genuine exfiltration
  primitive, not a theoretical one.
- **Persisted transcripts** (Phase 6b) — writing conversations to disk turns any secret
  that leaked into tool output from a transient exposure into a durable one. The
  redaction pass is the whole defence; test it with a real key, not a placeholder.
- **Unattended runs** (Phase 9b) — the approval model assumes a human is present, and a
  schedule removes that assumption. The failure isn't a crash, it's a scheduled job
  quietly doing the wrong thing for a week. Read-only by default is the safety net;
  resist widening it for convenience.

## Deliberately not built

Recorded so they don't get reintroduced by accident: browser automation, semantic codebase
search, MCP resources/prompts/sampling, custom modes, fuzzy diff matching, telemetry, a
fetch tool, `insert_content`, mode-switching and subtask tools.

"No browser automation" means Light Code ships no browser tool and no bundled browser
server — raised and settled during Phase 3. A user who wants browser control configures a
Chrome DevTools MCP server themselves, like any other MCP server; that needs no support
from us beyond the Phase 5 client.
