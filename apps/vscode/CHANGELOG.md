# light-code-vscode

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
