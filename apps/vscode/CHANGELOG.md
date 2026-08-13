# light-code-vscode

## 0.11.0

### Minor Changes

- da05798: The 25-step limit is now adjustable, and says what to do when it trips.

  Settings → Approvals → **Maximum steps per message** (1–500, default 25). The limit exists so
  a model looping on a failing edit stops costing money, not to cut short real work — so a long
  refactor is a good reason to raise it.

  Hitting it never loses anything, and the message now says so: the transcript is intact and
  another message ("continue") carries on from where it stopped. Previously it read
  "Stopped after reaching the maximum of 25 steps", which sounds like a crash.

  CLAUDE.md has described this as configurable since the first phase. It was not; the loop
  accepted the option and nothing ever passed it.

## 0.10.1

### Patch Changes

- fad091b: Fix indexing rejecting documents, and let you name the index.

  **"failed to parse field [vector] of type [knn_vector] … preview of field's value: null"** —
  the vector check confirmed the response was an array of the right length but never that its
  elements were numbers. `JSON.stringify([1, NaN, 3])` is `[1,null,3]`, so a single bad float
  arrived as a null and the whole document was rejected, with an error pointing at the mapping
  when the mapping was fine. Every element is now checked, and the failure names the model, the
  position, and where to look.

  **A width mismatch is now caught up front.** A vector field's dimension is fixed when the
  index is created, so pointing a differently-sized embedding model at an existing index used
  to fail on every single write with a mapping error that never said why. It now refuses
  immediately and tells you to change the width back or use a different index name.

  **The index name is yours to choose** (Settings → Search). Leave it blank and one is derived
  from the workspace path — collision-free, but nobody looking at a shared cluster can tell
  whose `light-code-a3f2…` it is. It is also how you move to a new index after changing
  embedding model, since the old one's width cannot be altered.

## 0.10.0

### Minor Changes

- b97db9c: Python tools now use your project's virtualenv and can install dependencies.

  **It finds the venv you already have.** If the workspace contains `.venv`, `venv`, `.env` or
  `env` with a working interpreter, that is what tools run in — and the tab says so, including
  whether uv created it. That matters because your project's environment is where your internal
  libraries are already installed; a private one would be empty, and a tool importing a company
  package would fail in a way that looks like a bug rather than a missing install. A private
  venv is still created if the project has none, and `python.venvPath` overrides both.

  The tradeoff is stated in the tab rather than hidden: reusing the project venv means a tool's
  dependencies are installed _into your project's environment_.

  **PEP 723 dependencies actually install now.** Previously the model was told to declare them
  and nothing ever installed them, so a tool needing a library failed on an `ImportError` that
  pointed nowhere useful. Dependencies are installed before validation, so a failure names the
  package and the index it was looked for on, and the model is told not to retry unchanged.

  **Package index is configurable** — point it at your internal mirror to make company packages
  installable and avoid reaching public PyPI at all. There is also an offline switch that
  refuses the network entirely.

  The path to `uv` now has a Browse button.

- 5b8cdec: Teach it once and it keeps the note: skills.

  Explain an internal library, a house convention, or a gotcha specific to your codebase, and
  the model now offers to record it as a **skill** — a markdown file in
  `.lightcode/skills/`. Next conversation it already knows, and when it later learns something
  that contradicts a skill it offers to update that one rather than writing a near-duplicate.

  **Only the one-line description enters the prompt.** Bodies are read on demand with the
  ordinary `read_file`, so a skill costs a handful of tokens whether it is three lines or three
  hundred — write as much detail as the subject deserves: package names, import paths,
  signatures, a worked example.

  It asks before writing, and the approval shows the exact markdown, because a skill is prose
  the model injects into its own future context. They live in your workspace as plain files, so
  they land in git and get reviewed like anything else.

  Particularly useful with Python tools: describe your internal SDKs once, and tools it writes
  afterwards use them properly instead of reaching for whatever it knows from training.

## 0.9.0

### Minor Changes

- The model can write its own Python tools (Settings → Python, off by default).

  Ask it to write a tool and it produces a Python file with a `run` function; the parameter
  schema and description are derived from the type hints and docstring, so there is no
  metadata to keep in sync. Once approved it becomes `py__your_tool`, callable from your next
  message onward.

  **You approve the source, not just the call.** Every create and update shows the full diff of
  the actual file first — and the approval is pinned to a hash of exactly those bytes, so a
  file changed afterwards, by anything, is refused and reported rather than loaded. A `.py`
  appearing in the tools directory that was never approved does not load either, which matters
  because that directory is inside your workspace and a cloned repo could contain one.

  Tools live in `.lightcode/tools/` so they land in git and get reviewed like any other code.
  The shared virtualenv is created by `uv`, outside the workspace. Provider API keys are never
  passed into the Python environment — a test plants five key-shaped variables and asserts none
  survive. A tool that hangs is stopped at its timeout and its whole process tree killed.

  There is no sandbox: a tool runs with your privileges, exactly as a shell command does.

## 0.8.1

### Patch Changes

- ed22037: Fix "Save embedder" appearing to do nothing, and list the provider's models.

  **Save embedder gave no sign it had worked.** The form resynced to the values it had just
  sent, so a successful save looked identical to no save at all — and when a field was
  incomplete the button was simply disabled, which looks identical to a broken one. The host
  now confirms the write, the button shows "Saved.", and a disabled button names the field
  that is missing rather than staying silent.

  **The embedding model is now a dropdown.** Choosing a provider fetches its catalogue
  immediately, using the profile's stored credentials and TLS. Free-text entry stays, always:
  a gateway that publishes no catalogue — or publishes one that omits its embedding models —
  is common, so the list is a convenience layered over the field rather than a gate in front
  of it. When there is no catalogue, the reason is shown next to the field.

## 0.8.0

### Minor Changes

- 399aa57: Search your codebase by meaning, not just by exact text.

  Settings → Search gains **Codebase indexing**: pick a provider profile to embed with, name
  an embedding model and its vector width, and press **Index workspace**. The model then gets
  a `search_codebase` tool that answers questions like "where do we decide to retry" when the
  code actually says `shouldAttemptAgain` — the query ripgrep cannot serve.

  It supplements `search_files`, it does not replace it. A vector search misses _silently_,
  returning plausible neighbours rather than nothing, so both the tool description and every
  result say the hits are approximate and must be read before being relied on.

  **Indexing is the largest egress in the product, and the UI says so before you press the
  button** — naming the embedding endpoint your code will be sent to and the index it lands
  in. It only ever runs from that button; the model cannot start it.

  What is never sent: anything gitignored, anything on the tool deny list, `.env`, lockfiles,
  binaries, files over 1MB, and anything outside the indexable file types. The rule is that
  anything `read_file` may not read must never be embedded, or indexing becomes a second route
  around the deny list — with the payload going to a third party rather than staying local.

  Reruns are incremental via a content-hash manifest, so only changed files are re-embedded.
  Changing the model, its width or the chunk shape reindexes everything, because vectors from
  two different models cannot be compared and mixing them silently produces confident nonsense.

## 0.7.1

### Patch Changes

- 3803c18: Internal: the chat bridge moved from the extension into core, behind a `HostServices` seam,
  so the new Node server (`npx light-code`) runs the same code. No behaviour change to the
  extension — `apps/vscode` is now ~400 lines of activation, webview plumbing and three VS
  Code-specific platform implementations.

## 0.7.0

### Minor Changes

- 8e37077: Add MCP servers from a form instead of hand-writing JSON.

  Settings → MCP now has **Add server**, with fields per server type rather than a raw
  `mcpServers` blob:

  - **Python (venv)** — point at your FastMCP script and press **Detect**. Light Code looks on
    disk for the interpreter, checking both `Scripts\python.exe` and `bin/python` regardless of
    platform, and searching `.venv`, `venv`, `env` and `.env` beside the script and one level
    up. What it finds lands in an ordinary editable **Python interpreter** field, so overriding
    it for a conda environment or a system Python is just typing over it. That field is what
    actually runs, so an unusual layout is never rewritten behind your back.
  - **npm package** — the package name. `-y` is always passed, because without it `npx` waits
    on a confirmation prompt that nothing inside an extension host can answer, and the server
    appears to hang rather than to ask.
  - **Command** and **HTTP** for anything else.

  The transport is not something you pick — it follows the type, and the server list and form
  both label it. A command is stdio; a URL is Streamable HTTP.

  Every path field has a **Browse** button opening a native picker, here and in Settings →
  Network: the script, the virtualenv folder, the interpreter, the working directory, and the
  CA, certificate, key and PFX. Each stays typeable, since a UNC share or a path already on
  the clipboard is not something a picker handles well.

  Environment variables and headers get key/value rows, with the `${secret:NAME}` reference
  form spelled out inline. Arguments are one per line, so a path containing a space needs no
  quoting. The exact command line that will be spawned is shown as you type — the same
  ground-truth principle as the approval prompt.

  The JSON editor is still there, now behind **Edit as JSON**, and the stored format is
  unchanged: a config pasted from another MCP client still works, and yours still pastes out.
  Servers can also be renamed and deleted from the list.

### Patch Changes

- a232250: Fix OpenSearch settings appearing not to save, and explain truncated log results.

  **A failed save looked exactly like a successful one.** The connection form closed the
  instant Save was pressed, before the host had written anything, and any error was routed to
  a banner that only the chat view rendered — so a rejected save closed the form, discarded
  what you typed, and said nothing. Three fixes: errors now render in every view, the form
  stays open until the host confirms the write reached disk, and the numeric limits show their
  allowed range and flag an out-of-range value in place. The most likely trigger was raising
  "Maximum results" past its ceiling of 100, which failed validation invisibly.

  **Truncated log messages are now explained and adjustable.** Long field values were cut at
  500 characters with a bare `…`, which reads as "the message ends here" — so the model
  reported the logs as truncated without being able to say why or do anything about it. The
  cut is now labelled with the full length, the result names which fields were affected and
  what to do, and **Longest field value** in Settings → Search makes the limit configurable
  (50–20,000). Worth raising for a log index whose messages carry stack traces: unlike the
  overall result cap, this cut cannot be recovered with `read_tool_result`.

  Every query limit also has a tooltip explaining what it protects against and what raising or
  lowering it costs.

## 0.6.0

### Minor Changes

- Configure your CA and client certificate once, in Settings → Network.

  Until now a corporate root had to be entered separately for each provider profile, each
  search cluster, and again inside the Apigee block — three chances to miss one and get an
  opaque "could not be verified" from whichever you forgot. There is now one **Network** tab
  holding the CA, the client certificate and key (or a PFX bundle) and its passphrase, plus
  the certificate directory that relative filenames resolve against — which was previously
  only reachable by hand-editing the config file.

  Everything outbound uses it: the gateway, the Apigee token endpoint, OpenSearch, and the
  embedder.

  Individual connections can still override, and the rules are deliberate:

  - **An extra CA on a profile is added to the global one**, never a replacement — so
    configuring one unusual gateway cannot cost you the root that makes everything else work.
  - **A connection supplying its own client certificate supplies the key with it.** The two
    are taken as a pair, so you can never end up presenting one certificate with another's
    key.
  - **A connection can re-enable certificate verification you switched off globally**, not
    only disable it.

  The global client certificate is presented to every connection that does not supply its
  own. That is a genuine choice rather than a convenience — a certificate identifies you to
  whatever you connect to — and it is the default because a corporate machine typically has
  one certificate for all internal services. Set `useGlobalClientCertificate: false` on a
  connection to withhold it from that endpoint.

  Existing configs keep working unchanged; per-connection CA settings are read exactly as
  before.

- 60a53cc: Search OpenSearch indexes your organisation already runs.

  Settings → Search takes multiple named connections, since different environments run
  different clusters. Each has its own credentials, an optional default index, and its own
  CA file or skip-verify setting for a cluster behind an intercepting proxy. Test Connection
  reports the cluster name and version, and the index dropdown lists what is actually there —
  with free-text entry always available, because `_cat/indices` is often denied to an account
  that can still search perfectly well.

  **Read-only, structurally.** The client the model uses exposes no write method at all, and
  its one request helper refuses anything but `GET` and `POST` to `_search`. Nothing the model
  does can create, change or delete anything in a cluster.

  Search tools are offered only while a connection is active, so the tool set stays stable
  within a session and search is off unless you turn it on.

  Embedding-based codebase search is not in this release; this is the half that needs no
  embedder and sends no source code anywhere.

- 817cd17: Queue messages mid-turn, and a working indicator.

  - **Type while it works.** Sending during a turn queues the message instead of being
    refused. The queue is visible above the input and each entry can be removed before it is
    used. The model picks them up at the next step boundary, so it sees them while still
    working rather than after it has finished.
  - **A working indicator.** Animated, with elapsed seconds once a reply takes more than a
    few, and it names what is happening — "Thinking" versus "Running search_files". It gets
    out of the way as soon as text starts streaming, since the words are their own evidence
    of progress.

  Also fixes two latent provider bugs the queue exposed: a user message following a tool
  result, or two user messages in a row, produced consecutive user turns that Anthropic and
  Gemini both reject. Both adapters now merge them.

### Patch Changes

- aa0f834: Guard rails so the model cannot run an expensive query against a production cluster.

  It already could not change anything — the client has no write path — but a _read_ can
  still hurt. Every query now carries a per-shard timeout, an early-termination cap, and a
  bounded hit count instead of an exact total that forces a full traversal. An unbounded
  query against an index with a date field is limited to the last 24 hours, and the tool
  result says so, so a document outside that window reads as a bounded search rather than
  missing data.

  A wildcard matching more than five indexes is refused with the count, and `*` or `_all` is
  refused outright. The model's requested result count is a ceiling request, not a grant: the
  connection's cap wins.

  All five limits are editable per connection in Settings → Search, since only you know what
  your cluster can take.

## 0.4.0

### Minor Changes

- 1223986: Profile selector in the composer, a Claude CLI expert, and the assistant knows which model it is.

  - **Switch provider from the chat.** A selector under the input shows the profile and model
    answering the next message, so changing it no longer means a trip to Settings.
  - **Ask "what model are you?" and get the truth.** The system prompt now states the
    configured model and profile. Models otherwise answer from training data, which is wrong
    behind a gateway that renames things — and was wrong for a DeepSeek deployment during
    development.
  - **Claude as a consulting expert** (Settings → Expert, off by default). Your everyday model
    can call `ask_expert` for planning a multi-file change, diagnosing a bug it has already
    failed to fix, or weighing two designs. Each consultation appears in the transcript with
    its cost.

    The expert is **read-only**: it can read and search the workspace to gather its own
    context, but cannot edit files or run commands. Everything that changes the workspace
    still goes through Light Code's tools and your approval. Any tool it asks for and is
    refused is reported alongside its answer rather than hidden.

- c580c0c: First release.

  A minimal agentic coding assistant: sidebar chat, nine built-in tools, and an autonomous
  multi-step loop with approval between steps.

  - **Providers:** OpenAI-compatible, Anthropic Messages, and Google Gemini, as named
    profiles you can switch between. Presets prefill a base URL; every field stays editable,
    and nothing is contacted until you save one.
  - **Corporate gateways:** mutual TLS with client certificates, OAuth client-credentials
    token exchange, custom CA bundles, and a Test Connection button that reports which of
    load-certs / get-token / list-models failed.
  - **Approval shows ground truth** — the literal command, the real computed diff. "Always
    allow" is exact-match, byte for byte.
  - **Checkpoints:** a shadow-git snapshot before the first edit, so a task can be undone in
    one click without touching your own repository.
  - **MCP** over stdio and Streamable HTTP, with per-server and per-tool controls.
  - **Task history** that survives closing the panel, reloading the window, and restarting.
  - **`@` mentions** for files and folders, image attachments for vision-capable models, and
    a visible context budget with cache hit rate.

  No telemetry, no update checks, no default endpoints.

- b8a2633: See what the model is thinking, and tell expert-influenced work apart.

  - **Reasoning traces are shown.** Where a provider exposes them — DeepSeek and Qwen's
    `reasoning_content`, Anthropic's `thinking`, Gemini's thought parts — they stream into a
    collapsed "Thinking…" block above the answer. They are never fed back as assistant
    content on the next turn.
  - **Icons instead of repeated labels.** Assistant and user messages, tool status, and the
    provider list actions now use icons with the wording as a tooltip. Approve and Deny stay
    as words on purpose — a security decision should not depend on recognising a glyph.
  - **Expert-influenced work is marked.** The consultation itself carries an expert icon, and
    so does anything the model did afterwards with that advice in context.
  - **The composer is one aligned field.** The input and its buttons share a border and grow
    with the text instead of the input sitting at a fixed height beside taller buttons.
  - **Dropdown popups follow the theme.** Every `<option>` is styled, so lists no longer open
    white against a dark editor.
  - **The expert model is a dropdown** of tier aliases (Opus / Sonnet / Haiku), with free text
    still available for a specific id.

### Patch Changes

- 662a361: Fixes from the first real corporate deployment.

  - **Add a CA certificate to any profile.** Previously a CA could only be supplied inside
    the Apigee mutual-TLS block, so an ordinary API-key profile behind a TLS-intercepting
    proxy had no way to trust the gateway and simply could not connect. Settings → Providers →
    Edit → Connection security now takes a CA file path for every auth type.
  - **"Skip certificate verification"**, per profile and off by default, for when exporting
    the internal root is not practical. The UI states plainly that this lets anyone on the
    path read and modify the traffic, including the API key. Supplying the CA is the fix.
  - **Qwen and Gemma are now recognised**, including gateway-renamed ids like
    `internal-qwen3-coder-480b`. Token counts for those models were falling back to a
    conservative 32k guess and were wrong.
  - **Context window, image support, and tool support are editable inline** under the model
    field. They were always overridable, but buried behind a disclosure inside Advanced where
    nobody found them.
  - **Pasting a screenshot works.** It silently did nothing whenever the model was not
    recognised as vision-capable — which is most models behind a gateway, since the id is
    renamed. The attach button is always offered now, and an unrecognised model gets a note
    pointing at the override instead of silence.
  - **The model list loads by itself** once the base URL and credential are set, rather than
    waiting for the Refresh button. It fires on blur, never mid-typing, so a partly-typed URL
    never receives your API key.

- 061cd63: Asking the model to consult Claude now actually consults Claude.

  With the expert enabled, "can you say hello to Claude?" got "I don't have a way to
  communicate with other AI assistants" — the tool was available and offered, but the
  guidance to spend sparingly had talked the model out of a direct instruction, and it
  reported that choice as an inability.

  An explicit request now overrides the frugality rules: it is your money and your decision.
  If the model does decide against consulting on its own initiative, it has to say it chose
  not to and why, rather than claiming it cannot.

  The `expert` badge in the composer also no longer hides itself when no provider profile has
  loaded, so whether the expert is live is visible without opening Settings.

- a1b2083: Support VS Code 1.84 and later, down from 1.102.

  The floor was a policy choice — "roughly a year old" at the time it was set — not an API
  requirement, and it was quietly excluding people who had not updated recently. The newest
  API the extension touches is `SecretStorage` (1.53), so lowering it costs nothing. 1.84 is
  the same floor Roo Code's final release used.

  `@types/vscode` is pinned to match, which is what makes using a too-new API a compile error
  rather than a runtime failure on someone else's machine.
