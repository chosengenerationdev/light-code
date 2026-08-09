# Light Code

A minimal agentic coding assistant for VS Code. Chat, a small set of built-in tools,
configurable LLM providers, MCP integration — and deliberately nothing else.

**No telemetry, ever. No default endpoints.** A fresh install contacts nothing until you
configure a provider.

---

## What it does

- **Chat in the sidebar**, with an autonomous multi-step agent loop — one tool call per
  step, your approval between steps, until the task is done.
- **Nine tools:** read files, list files, search (ripgrep), write, apply a diff, run a
  shell command, use an MCP tool, ask a follow-up, and finish.
- **Any provider you can reach.** OpenAI-compatible, Anthropic Messages, and Google Gemini,
  behind named profiles you can switch between. Presets prefill a base URL; every field
  stays editable.
- **Corporate gateways are a first-class case:** mutual TLS with client certificates,
  OAuth client-credentials token exchange, custom CA bundles, and a Test Connection button
  that tells you *which* step failed.
- **MCP servers** over stdio or Streamable HTTP, with per-server and per-tool controls.
- **Approval that shows ground truth** — the literal command, the computed diff — never the
  model's description of what it intends to do.
- **Checkpoints.** A shadow-git snapshot before the first edit of a task, so you can undo
  everything in one click. Your own git repository is never touched.
- **Task history.** Conversations survive closing the panel, reloading the window, and
  restarting VS Code.
- **`@` mentions** to attach a file or folder, and image attachments for vision-capable
  models.
- **A context budget you can see:** system prompt, tool definitions, conversation, and tool
  results, with cache hit rate.

## What it deliberately does not do

Minimalism is the point, not a stage it will grow out of:

- No browser automation. If you want it, configure a Chrome DevTools MCP server yourself.
- No semantic codebase search yet — planned, opt-in, and off by default when it lands.
- No telemetry, no update checks, no remote assets, no analytics of any kind.
- No cloud account, no sign-in, no hosted component.

---

## Getting started

1. Install the extension and click the Light Code icon in the Activity Bar.
2. Open Settings (the icon in the panel header) → **Providers** → **Add Provider**.
3. Pick a preset, paste an API key, choose a model, and **Save**.
4. Start chatting.

Everything is configured through the panel. You never need to hand-edit a file, though you
can — the settings UI and the config file share one schema, so both fail the same way.

### Where things are stored

| What | Where |
|---|---|
| Config | The extension's global storage, or `.lightcode/config.json` for workspace scope |
| Secrets | VS Code `SecretStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux) |
| Conversations | Global storage, per workspace |

API keys, certificate passphrases, and OAuth secrets are stored as *references*. The config
file only ever holds a pointer, never a value — so exporting your config to share a working
gateway setup is safe by construction rather than by redaction.

---

## Security

Read this before using it anywhere sensitive.

### The boundary

> Light Code makes no network connection you have not configured. It ships with zero default
> endpoints, no telemetry, no update checks, and no remote assets. The only hosts it
> contacts are the model gateway, the MCP servers, and — if you enable indexing — the vector
> store and embedding endpoint named in your config.

### What is *outside* that boundary

**Light Code does not sandbox anything it runs on your instruction.** Shell commands, MCP
servers, and (later) Python tools execute with your full user privileges, with access to
your files, your network, and your environment. This is the same trust model as running the
command yourself in a terminal.

**It does not protect you from another process running as the same user.** Anything that can
read your VS Code storage can read your config. Secrets go to the OS keychain, which raises
the bar, but a process running as you is not an attacker this can defend against.

We would rather say this plainly than imply protection that does not exist.

### What it does defend against

- **A hostile repository cannot repoint your credentials.** Provider profiles, the active
  profile, certificate directories, and approval settings are user-scope only, and are
  ignored if found in a workspace config file. Cloning a repo cannot make Light Code talk to
  someone else's gateway, nor pre-approve its own shell commands.
- **Approval shows ground truth.** The prompt renders the literal command and the real
  computed diff, so a model cannot describe one action and perform another.
- **"Always allow" is exact-match, byte for byte.** Allowing `npm test` allows exactly
  `npm test`. `npm test; rm -rf /` is a different string and still prompts. There is no
  pattern or prefix matching, deliberately — a parsing bug in one would auto-approve a
  chained destructive command.
- **The model must read a file before editing it**, which eliminates a class of hallucinated
  edits.
- **Certificate and key files must live outside the workspace**, and their paths are on a
  hard deny list for every file-reading tool.
- **Secrets are write-only across the UI boundary.** The interface can ask whether a secret
  is set; it can never read one back.

Reporting a vulnerability: see [SECURITY.md](SECURITY.md).

---

## Building from source

Requires Node 20+ and pnpm.

```bash
pnpm install --ignore-scripts   # --ignore-scripts is deliberate; see CLAUDE.md invariant 4
pnpm build
pnpm test
pnpm package                    # produces a .vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). [CLAUDE.md](CLAUDE.md) is the durable record of
design decisions and the reasons behind them — read it before proposing a change to
anything it covers.

## Credits

Built greenfield, using the archived [Roo Code](https://github.com/RooCodeInc/Roo-Code)
(Apache-2.0) as a frozen reference for proven formats and patterns — notably the
search/replace diff format that models are heavily trained on. Not a fork, and no code
copied without attribution.

## License

MIT.
