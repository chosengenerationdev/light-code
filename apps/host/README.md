# Light Code

A minimal agentic coding assistant, served to your browser from a local Node server.

Same agent as the [Light Code VS Code extension](https://marketplace.visualstudio.com/items?itemName=ChosenGeneration.light-code-vscode),
same config format, no editor required.

```bash
npx @chosengeneration/light-code
```

That starts a server on `127.0.0.1`, opens your browser, and works in the current folder.

```bash
npx @chosengeneration/light-code --workspace /path/to/repo
npx @chosengeneration/light-code --port 7100 --no-open
npx @chosengeneration/light-code --help
```

## What it does

A chat UI with a small set of agent tools and nothing else:

- **Read and search** — `read_file`, `list_files`, `search_files` (ripgrep-backed)
- **Edit** — `write_to_file` and `apply_diff`, with a computed diff shown before anything
  is written
- **Run commands** — in a real shell, one approval at a time
- **MCP tools** — stdio and Streamable HTTP servers, each tool individually toggleable
- **Ask a stronger model** — optional; consults the Claude CLI read-only for hard problems

Any OpenAI-compatible, Anthropic, or Gemini endpoint. Several named profiles, switchable
from the composer. Mutual-TLS and client-credentials auth for corporate gateways.

## What it does not do

No telemetry, no update checks, no remote assets, and **no default endpoints** — a fresh
install contacts nothing until you configure a provider. Every host it ever talks to is one
you typed in.

It does **not** sandbox the code it runs. Shell commands, MCP servers and anything else the
agent executes on your instruction run with your privileges, exactly as if you had typed
them. The approval gate is what stands between the model and your machine; there is no
second layer behind it.

## Security

Loopback is not a security boundary — any page you have open can send requests to
`127.0.0.1`. So the session is protected properly:

- Bound to the literal `127.0.0.1`, never `localhost`
- A single-use launch token in the URL fragment, exchanged for a session token that only
  ever travels in an `Authorization` header — never a cookie, which is what CSRF exploits
- `Origin` and `Host` checked on every request, for CSRF and DNS rebinding respectively
- A strict CSP whose `connect-src 'self'` and `img-src 'self' data:` stop model output from
  exfiltrating your screen through an image URL

Config, secrets and history live under your OS application-data directory, per user.
**Secrets are stored in an owner-only file, not an OS keychain** — the extension gets
DPAPI/Keychain through VS Code, the server has no equivalent without a native module, and
the UI says which backend is active rather than implying the stronger one.

## Hosting it for a team

Possible, and the identity seam is built — but **read
[docs/hosting.md](https://github.com/chosengenerationdev/light-code/blob/main/docs/hosting.md)
first.** The agent runs commands as the *service account*, so single sign-on gives you
attribution and per-user storage but not privilege isolation. Until there is one OS account
or container per session, a shared deployment is only appropriate where every user is
already trusted with everything every other user can reach.

## Licence

MIT.
