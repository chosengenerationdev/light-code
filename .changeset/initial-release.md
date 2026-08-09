---
'light-code-vscode': minor
---

First release.

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
