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

## Setting it up

For a laptop, the command above is the whole setup: open the browser, add a provider in
**Settings → Providers**, start typing. The rest of this section is for a server, in the
order the pieces actually depend on each other.

### 1. Check the banner

Everything the server worked out about its environment is printed when it starts, and it is
worth reading once — it is the cheapest diagnosis you will get.

```
Light Code 0.44.0
  workspace  /srv/work
  data       /home/svc/.local/share/light-code
  listening  http://127.0.0.1:7100
  proxy      HTTPS_PROXY=http://proxy.corp:3128, NO_PROXY=.corp.internal
  user       identity from whoami.py — emp0042
  secrets    creds.py — values stored as tool:<name> are fetched from it
```

### 2. If your egress goes through a proxy

Nothing to configure: `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and `NO_PROXY` are honoured,
with curl's rules for `NO_PROXY` and loopback never proxied. The banner shows the route.

This matters more than it sounds. Node's HTTP stack does *not* read these variables by
default, so a server whose every other program reaches the gateway can have Light Code alone
sit there — a proxied network drops a direct connection rather than refusing it, and a
dropped connection waits for the operating system, which takes minutes. If you have ever
seen a spinner that never resolves while `curl` works fine, that was this.

### 3. Tell it who the user is (optional)

By default a local server has one user and files everything under one directory. If your
environment has a library that knows who is logged in, write a function:

```python
# whoami.py
def run():
    return "emp0042"
```

```bash
light-code --identity-tool whoami.py --identity-python python3
```

Settings, secrets and task history are then filed under whatever it returns. It runs once at
startup, before any session, and if it fails the server still starts and the banner says
why — these functions reach libraries that are not always up, and a server that will not
come back is worse than one that comes back explaining itself.

It must return a non-empty string. `None` is refused rather than turned into a user called
`None`, and anything a library prints on import is ignored rather than mistaken for the
answer.

### 4. Tell it where credentials come from (optional)

Same shape, taking a name:

```python
# creds.py
def run(name):
    entry = corporate_vault.lookup(name)
    return {"username": entry.user, "password": entry.secret}
```

```bash
light-code --credential-tool creds.py
```

Now, anywhere Light Code asks for a secret, store the string `tool:<name>` instead of the
secret itself:

| You type | It fetches |
| --- | --- |
| `tool:gateway` | the whole value, or `password`/`secret`/`token`/`value`/`key` from a dict |
| `tool:opensearch#username` | that field exactly |
| `tool:opensearch#password` | that field exactly |

The secrets file then holds only the *names* of things to go and ask for. Values are fetched
when they are used and cached for a few seconds, so rotating one in your vault reaches the
next request without anything here being cleared.

**The assistant cannot call this function.** It is a source of secrets, reached only by the
code that was already allowed to resolve one — a tool the model could call would put your
password in the transcript.

### 5. Add a provider

**Settings → Providers.** Any OpenAI-compatible, Anthropic or Gemini endpoint. Several named
profiles, switchable from the composer. Mutual-TLS and client-credentials auth for corporate
gateways, and a **Test Connection** button that reports *which* step failed — certificates,
token, or listing models.

If you configured a credential function, put `tool:<name>` in the API key field.

### 6. Optional extras

- **Expert** — set one of your profiles as a second opinion the assistant can consult on hard
  problems. Any model you have configured; there is nothing to install.
- **Search** — an OpenSearch, Qdrant or Chroma connection for indexing a codebase or
  documentation.
- **Python tools** — off by default. Read §13 of the project's CLAUDE.md before enabling it:
  it makes the *body* of a tool model-authored.

## What it does

A chat UI with a small set of agent tools and nothing else:

- **Read and search** — `read_file`, `list_files`, `search_files` (ripgrep-backed)
- **Edit** — `write_to_file` and `apply_diff`, with a computed diff shown before anything
  is written
- **Run commands** — in a real shell, one approval at a time
- **MCP tools** — stdio and Streamable HTTP servers, each tool individually toggleable
- **Ask a stronger model** — optional; consults a provider profile you have configured

## What it does not do

No telemetry, no update checks, no remote assets, and **no default endpoints** — a fresh
install contacts nothing until you configure a provider. Every host it ever talks to is one
you typed in.

It does **not** sandbox the code it runs. Shell commands, MCP servers and anything else the
agent executes on your instruction run with your privileges, exactly as if you had typed
them. The approval gate is what stands between the model and your machine; there is no
second layer behind it.

The Excel and Outlook integration, and the indexed-mail search, are in the **VS Code
extension only**. They attach to applications running on somebody's desktop, which a server
has no route to.

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
the UI says which backend is active rather than implying the stronger one. A credential
function (step 4) avoids the question entirely, since nothing is stored.

## Hosting it for a team

Possible, and the identity seam is built — but **read
[docs/hosting.md](https://github.com/chosengenerationdev/light-code/blob/main/docs/hosting.md)
first.** The agent runs commands as the *service account*, so single sign-on gives you
attribution and per-user storage but not privilege isolation. Until there is one OS account
or container per session, a shared deployment is only appropriate where every user is
already trusted with everything every other user can reach.

## Licence

MIT.
