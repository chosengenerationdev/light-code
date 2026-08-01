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
  windows.ts       command auto-approve disabled on win32

packages/ui/src/settings/ApprovalsTab.tsx
packages/ui/src/settings/ModesTab.tsx
packages/ui/src/ModeSelector.tsx      in the chat header
```

**Done when**

- Switching to Ask mode removes edit and command tools from the system prompt entirely
- Auto-approve toggles all default off and persist per category
- "Always allow" scopes to tool + workspace, is visible in the UI, and is revocable
- Command auto-approve is absent from the UI on Windows, with an explanatory note

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
  tls.ts             agent construction; ca / NODE_EXTRA_CA_CERTS

packages/core/src/providers/models.ts      list models; local metadata table

packages/ui/src/settings/
  AdvancedAuthSection.tsx
  ModelSelect.tsx        dropdown + free text + refresh
  TestConnection.tsx     reports which of three steps failed
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

## Deliberately not built

Recorded so they don't get reintroduced by accident: browser automation, semantic codebase
search, MCP resources/prompts/sampling, custom modes, fuzzy diff matching, telemetry, a
fetch tool, `insert_content`, mode-switching and subtask tools.
